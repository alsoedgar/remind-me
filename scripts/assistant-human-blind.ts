import { createHash } from 'node:crypto'
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import ts from 'typescript'
import { z } from 'zod'
import {
  assistantContaminationSourcePaths,
  assistantEvaluationScenarioSchema,
  assistantSuiteManifestSchema,
  type AssistantEvaluationScenario,
  type AssistantSuiteManifest
} from './assistant-evaluation-contract'

const pseudonymSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{7,63}$/u)

export function humanBlindScenarioQualityIssues(scenario: AssistantEvaluationScenario): string[] {
  const issues: string[] = []
  if (!scenario.id.startsWith('human.')) {
    issues.push('Independent human-blind scenario IDs must use the human. namespace')
  }
  if (scenario.source !== 'user-reported') {
    issues.push('Independent human-blind scenarios must use user-reported provenance')
  }
  const expectations = scenario.turns.map((turn) => turn.expect)
  const hasValues = (values: readonly unknown[] | undefined): boolean =>
    Boolean(values && values.length > 0)
  const hasStateValues = (value: Record<string, unknown> | undefined): boolean =>
    Boolean(value && Object.keys(value).length > 0)
  const hasGroundedExpectation = scenario.turns.some((turn) => {
    const expectation = turn.expect
    return (
      hasValues(expectation.textAll) ||
      hasValues(expectation.textAny) ||
      hasValues(expectation.textNone) ||
      (expectation.relatedEventMin ?? 0) > 0 ||
      (expectation.relatedReminderMin ?? 0) > 0 ||
      expectation.proposalKind !== undefined ||
      expectation.proposalOperation !== undefined ||
      expectation.proposalItemCount !== undefined ||
      hasValues(expectation.proposalItemKinds) ||
      hasValues(expectation.proposalTitlesAll) ||
      hasValues(expectation.proposalDatesAll) ||
      hasValues(expectation.proposalTimesAll) ||
      hasValues(expectation.proposalEndDatesAll) ||
      hasValues(expectation.proposalEndTimesAll) ||
      hasValues(expectation.proposalLocationsAll) ||
      hasValues(expectation.proposalDetailsAll) ||
      hasValues(expectation.proposalWeekdaysAll) ||
      hasValues(expectation.proposalFrequenciesAll) ||
      expectation.calendarState !== undefined ||
      expectation.activeProposal !== undefined ||
      expectation.proposalTransition !== undefined ||
      expectation.bulkScope !== undefined ||
      expectation.bulkEventCount !== undefined ||
      expectation.bulkReminderCount !== undefined ||
      hasStateValues(expectation.state) ||
      hasStateValues(turn.postState)
    )
  })
  if (!hasGroundedExpectation) {
    issues.push('A human-blind scenario needs at least one grounded semantic assertion')
  }
  if (
    scenario.category === 'single-action' &&
    expectations.some((expectation) => expectation.responseKinds.includes('preview')) &&
    !expectations.some((expectation) => expectation.proposalItemCount === 1)
  ) {
    issues.push('A previewing single-action scenario must assert exactly one proposal item')
  }
  if (
    scenario.category === 'multi-action' &&
    !expectations.some((expectation) => (expectation.proposalItemCount ?? 0) >= 2)
  ) {
    issues.push('A multi-action scenario must assert at least two proposal items')
  }
  if (scenario.category === 'multi-turn' && scenario.turns.length < 2) {
    issues.push('A multi-turn scenario must contain at least two authored turns')
  }
  if (
    scenario.category === 'mutation' &&
    !expectations.some(
      (expectation) =>
        expectation.proposalKind !== undefined || expectation.proposalOperation !== undefined
    )
  ) {
    issues.push('A mutation scenario must assert the proposed mutation operation')
  }
  if (
    scenario.category === 'bulk' &&
    !expectations.some(
      (expectation) =>
        expectation.bulkScope !== undefined &&
        (expectation.bulkEventCount !== undefined || expectation.bulkReminderCount !== undefined)
    )
  ) {
    issues.push('A bulk scenario must assert its scope and selected item counts')
  }
  if (
    ['conversation', 'memory', 'open-dialogue', 'query'].includes(scenario.category) &&
    !expectations.some(
      (expectation) =>
        hasValues(expectation.textAll) ||
        hasValues(expectation.textAny) ||
        (expectation.relatedEventMin ?? 0) > 0 ||
        (expectation.relatedReminderMin ?? 0) > 0
    )
  ) {
    issues.push('Conversational and query scenarios must assert grounded answer content')
  }
  return issues
}

export const humanBlindCollectionRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    protocolVersion: z.literal('1.0'),
    recordId: z.string().regex(/^hb-[a-z0-9][a-z0-9-]{7,63}$/u),
    participantId: pseudonymSchema,
    consent: z
      .object({
        consentRecordId: pseudonymSchema,
        collectedAt: z.string().datetime(),
        evaluationUse: z.literal(true),
        publicRelease: z.literal(true),
        withdrawn: z.literal(false),
        withdrawalClosesAt: z.string().datetime()
      })
      .strict(),
    independence: z
      .object({
        participantAuthoredRequests: z.literal(true),
        shownTrainingExamples: z.literal(false),
        shownEvaluationExamples: z.literal(false),
        modelOutputSeenBeforeAuthorship: z.literal(false),
        developerRewroteParticipantLanguage: z.literal(false)
      })
      .strict(),
    privacy: z
      .object({
        syntheticCalendarFactsOnly: z.literal(true),
        containsRealCalendarExport: z.literal(false),
        obviousPiiReviewPassed: z.literal(true)
      })
      .strict(),
    annotation: z
      .object({
        annotatorIds: z.array(pseudonymSchema).min(2).max(5),
        completedAt: z.string().datetime(),
        independentPassesCompleted: z.literal(true),
        annotatedBeforeModelOutput: z.literal(true),
        consensusReached: z.literal(true)
      })
      .strict(),
    scenario: assistantEvaluationScenarioSchema
  })
  .strict()
  .superRefine((record, context) => {
    for (const message of humanBlindScenarioQualityIssues(record.scenario)) {
      context.addIssue({
        code: 'custom',
        path: ['scenario'],
        message
      })
    }
    if (record.annotation.annotatorIds.includes(record.participantId)) {
      context.addIssue({
        code: 'custom',
        path: ['annotation', 'annotatorIds'],
        message: 'A participant cannot annotate their own scenario'
      })
    }
    if (new Set(record.annotation.annotatorIds).size !== record.annotation.annotatorIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['annotation', 'annotatorIds'],
        message: 'Annotator IDs must be distinct'
      })
    }
    const collectedAt = Date.parse(record.consent.collectedAt)
    const annotatedAt = Date.parse(record.annotation.completedAt)
    const closesAt = Date.parse(record.consent.withdrawalClosesAt)
    if (annotatedAt < collectedAt) {
      context.addIssue({
        code: 'custom',
        path: ['annotation', 'completedAt'],
        message: 'Annotation cannot predate collection'
      })
    }
    if (closesAt < collectedAt) {
      context.addIssue({
        code: 'custom',
        path: ['consent', 'withdrawalClosesAt'],
        message: 'The withdrawal window cannot close before collection'
      })
    }
  })

export type HumanBlindCollectionRecord = z.infer<typeof humanBlindCollectionRecordSchema>

export interface HumanBlindPolicy {
  minimumScenarios: number
  minimumParticipants: number
  maximumScenariosPerParticipant: number
  minimumOutOfDomain: number
  minimumNoisyLanguage: number
  nearDuplicateThreshold: number
  categoryMinimums: Partial<Record<AssistantEvaluationScenario['category'], number>>
}

export const phase8HumanBlindPolicy: HumanBlindPolicy = {
  minimumScenarios: 2_000,
  minimumParticipants: 100,
  maximumScenariosPerParticipant: 40,
  minimumOutOfDomain: 200,
  minimumNoisyLanguage: 200,
  nearDuplicateThreshold: 0.9,
  categoryMinimums: {
    'single-action': 200,
    'multi-action': 200,
    mutation: 200,
    bulk: 100,
    query: 200,
    'multi-turn': 200,
    conversation: 150,
    memory: 100,
    ambiguity: 150,
    safety: 150,
    'open-dialogue': 150
  }
}

export interface ContaminationSource {
  path: string
  sha256: string
  surfaces: string[]
}

export interface LanguageSeparationAudit {
  exactInternalDuplicates: number
  nearInternalDuplicates: number
  exactContaminationMatches: number
  nearContaminationMatches: number
}

export interface HumanBlindAudit {
  readyToFreeze: boolean
  blockers: string[]
  scenarios: number
  turns: number
  participants: number
  annotators: number
  outOfDomain: number
  noisyLanguage: number
  categoryCounts: Record<string, number>
  exactInternalDuplicates: number
  nearInternalDuplicates: number
  exactContaminationMatches: number
  nearContaminationMatches: number
  contaminationSources: Array<{ path: string; sha256: string }>
}

const obviousPiiPatterns: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: 'email address', pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu },
  { label: 'web address', pattern: /\bhttps?:\/\/\S+|\bwww\.\S+/iu },
  { label: 'US Social Security number', pattern: /\b\d{3}-\d{2}-\d{4}\b/u },
  {
    label: 'long account or payment number',
    pattern: /\b(?:\d[ -]?){13,19}\b/u
  },
  {
    label: 'phone number',
    pattern: /(?:\+?1[ .-]?)?(?:\(\d{3}\)|\d{3})[ .-]\d{3}[ .-]\d{4}\b/u
  }
]

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function normalized(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[‘’]/gu, "'")
    .replace(/<[^>]+>/gu, ' <slot> ')
    .replace(/[^a-z0-9'<>]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

function tokenSet(value: string): Set<string> {
  return new Set(normalized(value).split(/\s+/u).filter(Boolean))
}

export function tokenJaccard(left: string, right: string): number {
  const leftTokens = tokenSet(left)
  const rightTokens = tokenSet(right)
  return tokenSetJaccard(leftTokens, rightTokens)
}

function tokenSetJaccard(
  leftTokens: ReadonlySet<string>,
  rightTokens: ReadonlySet<string>
): number {
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0
  let intersection = 0
  for (const token of leftTokens) if (rightTokens.has(token)) intersection += 1
  return intersection / (leftTokens.size + rightTokens.size - intersection)
}

function nearCandidateIndexes(
  inputTokens: ReadonlySet<string>,
  tokenOwners: ReadonlyMap<string, readonly number[]>,
  candidateTokenSets: readonly ReadonlySet<string>[],
  threshold: number
): Set<number> {
  if (inputTokens.size === 0) return new Set()
  const minimumCandidateTokens = Math.ceil(inputTokens.size * threshold)
  const maximumCandidateTokens = Math.floor(inputTokens.size / threshold)
  const maximumMissingTokens = inputTokens.size - minimumCandidateTokens
  const pivots = [...inputTokens]
    .sort(
      (left, right) => (tokenOwners.get(left)?.length ?? 0) - (tokenOwners.get(right)?.length ?? 0)
    )
    .slice(0, maximumMissingTokens + 1)
  const candidates = new Set<number>()
  for (const pivot of pivots) {
    for (const index of tokenOwners.get(pivot) ?? []) {
      const candidate = candidateTokenSets[index]
      if (
        candidate &&
        candidate.size >= minimumCandidateTokens &&
        candidate.size <= maximumCandidateTokens
      ) {
        candidates.add(index)
      }
    }
  }
  return candidates
}

const languageSurfaceKeys = new Set([
  'text',
  'template',
  'paraphrase',
  'paraphrases',
  'utterance',
  'utterances',
  'request',
  'requests'
])

function languageSurface(value: string): string | null {
  const text = value.trim()
  return text.length >= 2 && text.length <= 2_000 && /[a-z]{2}/iu.test(text) ? text : null
}

function collectSurfaceStrings(value: unknown, result: string[], key = ''): void {
  if (typeof value === 'string') {
    const text = languageSurfaceKeys.has(key) ? languageSurface(value) : null
    if (text) result.push(text)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectSurfaceStrings(item, result, key)
    return
  }
  if (value && typeof value === 'object') {
    for (const [childKey, item] of Object.entries(value)) {
      collectSurfaceStrings(item, result, childKey)
    }
  }
}

function surfacesFromTypeScript(contents: string, path: string): string[] {
  const source = ts.createSourceFile(path, contents, ts.ScriptTarget.Latest, true)
  const surfaces: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)) {
      const text = languageSurface(node.text)
      if (text) surfaces.push(text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return [...new Set(surfaces)]
}

function collectStrings(value: unknown, result: string[]): void {
  if (typeof value === 'string') {
    result.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, result)
    return
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, result)
  }
}

function surfacesFromContents(contents: string, path: string): string[] {
  if (/\.tsx?$/u.test(path)) return surfacesFromTypeScript(contents, path)
  const values: unknown[] = path.endsWith('.jsonl')
    ? contents
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as unknown)
    : [JSON.parse(contents) as unknown]
  const surfaces: string[] = []
  for (const value of values) collectSurfaceStrings(value, surfaces)
  return [...new Set(surfaces.map((surface) => surface.trim()))]
}

export async function loadContaminationSources(workspace: string): Promise<ContaminationSource[]> {
  return Promise.all(
    assistantContaminationSourcePaths.map(async (path) => {
      let contents: string
      try {
        contents = await readFile(resolve(workspace, path), 'utf8')
      } catch (error) {
        if (path.startsWith('ml/remindcore/.generated/')) {
          throw new Error(`Missing contamination source ${path}; run pnpm remindcore:generate`, {
            cause: error
          })
        }
        throw error
      }
      return { path, sha256: sha256(contents), surfaces: surfacesFromContents(contents, path) }
    })
  )
}

export function parseHumanBlindCollection(contents: string): HumanBlindCollectionRecord[] {
  const records = contents
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return humanBlindCollectionRecordSchema.parse(JSON.parse(line))
      } catch (error) {
        throw new Error(
          `Invalid human-blind collection record on line ${index + 1}: ${error instanceof Error ? error.message : 'unknown validation error'}`,
          { cause: error }
        )
      }
    })
  const ids = records.map((record) => record.recordId)
  if (new Set(ids).size !== ids.length) throw new Error('Human-blind record IDs must be unique')
  const scenarioIds = records.map((record) => record.scenario.id)
  if (new Set(scenarioIds).size !== scenarioIds.length) {
    throw new Error('Human-blind scenario IDs must be unique')
  }
  const consentOwners = new Map<string, string>()
  const participantConsents = new Map<string, string>()
  for (const record of records) {
    const existingOwner = consentOwners.get(record.consent.consentRecordId)
    if (existingOwner && existingOwner !== record.participantId) {
      throw new Error('One consent record cannot belong to multiple participants')
    }
    consentOwners.set(record.consent.consentRecordId, record.participantId)
    const serializedConsent = JSON.stringify(record.consent)
    const existingConsent = participantConsents.get(record.participantId)
    if (existingConsent && existingConsent !== serializedConsent) {
      throw new Error('Each participant must use one consistent consent record')
    }
    participantConsents.set(record.participantId, serializedConsent)
  }
  return records
}

function scenarioTexts(record: HumanBlindCollectionRecord): string[] {
  return record.scenario.turns.map((turn) => turn.text)
}

export function auditLanguageSeparation(
  humanTexts: readonly string[],
  contaminationSources: readonly ContaminationSource[],
  nearDuplicateThreshold: number
): LanguageSeparationAudit {
  if (nearDuplicateThreshold <= 0 || nearDuplicateThreshold > 1) {
    throw new Error('The near-duplicate threshold must be greater than zero and at most one')
  }
  const normalizedOwners = new Map<string, number>()
  const normalizedHumanTexts = humanTexts.map(normalized)
  const humanTokenSets = humanTexts.map(tokenSet)
  const humanTokenOwners = new Map<string, number[]>()
  let exactInternalDuplicates = 0
  let nearInternalDuplicates = 0
  for (const [index, key] of normalizedHumanTexts.entries()) {
    const prior = normalizedOwners.get(key) ?? 0
    if (prior > 0) exactInternalDuplicates += 1
    normalizedOwners.set(key, prior + 1)
    const tokens = humanTokenSets[index] ?? new Set<string>()
    const candidates = nearCandidateIndexes(
      tokens,
      humanTokenOwners,
      humanTokenSets,
      nearDuplicateThreshold
    )
    for (const candidateIndex of candidates) {
      if (key === normalizedHumanTexts[candidateIndex]) continue
      const candidateTokens = humanTokenSets[candidateIndex]
      if (candidateTokens && tokenSetJaccard(tokens, candidateTokens) >= nearDuplicateThreshold) {
        nearInternalDuplicates += 1
      }
    }
    for (const token of tokens) {
      const owners = humanTokenOwners.get(token)
      if (owners) owners.push(index)
      else humanTokenOwners.set(token, [index])
    }
  }

  const allContaminationSurfaces = contaminationSources.flatMap((source) => source.surfaces)
  const normalizedContamination = new Set(allContaminationSurfaces.map(normalized))
  const contaminationTokenSets = allContaminationSurfaces.map(tokenSet)
  const contaminationTokenOwners = new Map<string, number[]>()
  for (const [index, tokens] of contaminationTokenSets.entries()) {
    for (const token of tokens) {
      const owners = contaminationTokenOwners.get(token)
      if (owners) owners.push(index)
      else contaminationTokenOwners.set(token, [index])
    }
  }
  let exactContaminationMatches = 0
  let nearContaminationMatches = 0
  for (const text of humanTexts) {
    if (normalizedContamination.has(normalized(text))) {
      exactContaminationMatches += 1
      continue
    }
    const humanTokens = tokenSet(text)
    const candidateIndexes = nearCandidateIndexes(
      humanTokens,
      contaminationTokenOwners,
      contaminationTokenSets,
      nearDuplicateThreshold
    )
    const nearMatch = [...candidateIndexes].some((index) => {
      const candidateTokens = contaminationTokenSets[index]
      return Boolean(
        candidateTokens && tokenSetJaccard(humanTokens, candidateTokens) >= nearDuplicateThreshold
      )
    })
    if (nearMatch) {
      nearContaminationMatches += 1
    }
  }
  return {
    exactInternalDuplicates,
    nearInternalDuplicates,
    exactContaminationMatches,
    nearContaminationMatches
  }
}

function piiFindings(records: readonly HumanBlindCollectionRecord[]): string[] {
  const findings: string[] = []
  for (const record of records) {
    const surfaces: string[] = []
    collectStrings(record.scenario, surfaces)
    for (const text of surfaces) {
      for (const detector of obviousPiiPatterns) {
        if (detector.pattern.test(text))
          findings.push(`${record.recordId}: possible ${detector.label}`)
      }
    }
  }
  return [...new Set(findings)]
}

export function auditHumanBlindCollection(
  records: readonly HumanBlindCollectionRecord[],
  contaminationSources: readonly ContaminationSource[],
  options: { now?: Date; policy?: HumanBlindPolicy } = {}
): HumanBlindAudit {
  const now = options.now ?? new Date()
  const policy = options.policy ?? phase8HumanBlindPolicy
  const blockers: string[] = []
  const participantCounts = new Map<string, number>()
  const annotators = new Set<string>()
  const categoryCounts: Record<string, number> = {}
  let turns = 0
  let outOfDomain = 0
  let noisyLanguage = 0
  for (const record of records) {
    participantCounts.set(
      record.participantId,
      (participantCounts.get(record.participantId) ?? 0) + 1
    )
    for (const annotator of record.annotation.annotatorIds) annotators.add(annotator)
    categoryCounts[record.scenario.category] = (categoryCounts[record.scenario.category] ?? 0) + 1
    turns += record.scenario.turns.length
    if (!record.scenario.inDomain) outOfDomain += 1
    if (record.scenario.tags.some((tag) => /(?:asr|noise|ocr|spacing|typo)/iu.test(tag))) {
      noisyLanguage += 1
    }
    if (Date.parse(record.consent.withdrawalClosesAt) > now.getTime()) {
      blockers.push(`${record.recordId}: consent withdrawal window is still open`)
    }
  }
  if (records.length < policy.minimumScenarios) {
    blockers.push(`Need ${policy.minimumScenarios} scenarios; found ${records.length}`)
  }
  if (participantCounts.size < policy.minimumParticipants) {
    blockers.push(
      `Need ${policy.minimumParticipants} participants; found ${participantCounts.size}`
    )
  }
  for (const [participantId, count] of participantCounts) {
    if (count > policy.maximumScenariosPerParticipant) {
      blockers.push(
        `${participantId} supplied ${count} scenarios; maximum is ${policy.maximumScenariosPerParticipant}`
      )
    }
  }
  if (outOfDomain < policy.minimumOutOfDomain) {
    blockers.push(`Need ${policy.minimumOutOfDomain} out-of-domain scenarios; found ${outOfDomain}`)
  }
  if (noisyLanguage < policy.minimumNoisyLanguage) {
    blockers.push(
      `Need ${policy.minimumNoisyLanguage} noisy-language scenarios; found ${noisyLanguage}`
    )
  }
  for (const [category, minimum] of Object.entries(policy.categoryMinimums)) {
    const count = categoryCounts[category] ?? 0
    if (minimum !== undefined && count < minimum) {
      blockers.push(`Need ${minimum} ${category} scenarios; found ${count}`)
    }
  }
  blockers.push(...piiFindings(records))

  const humanTexts = records.flatMap(scenarioTexts)
  const languageSeparation = auditLanguageSeparation(
    humanTexts,
    contaminationSources,
    policy.nearDuplicateThreshold
  )
  const {
    exactInternalDuplicates,
    nearInternalDuplicates,
    exactContaminationMatches,
    nearContaminationMatches
  } = languageSeparation
  if (exactInternalDuplicates > 0) {
    blockers.push(`Found ${exactInternalDuplicates} exact duplicate participant turns`)
  }
  if (nearInternalDuplicates > 0) {
    blockers.push(`Found ${nearInternalDuplicates} near-duplicate participant turns`)
  }

  if (exactContaminationMatches > 0) {
    blockers.push(`Found ${exactContaminationMatches} exact training/evaluation collisions`)
  }
  if (nearContaminationMatches > 0) {
    blockers.push(`Found ${nearContaminationMatches} near training/evaluation collisions`)
  }

  return {
    readyToFreeze: blockers.length === 0,
    blockers,
    scenarios: records.length,
    turns,
    participants: participantCounts.size,
    annotators: annotators.size,
    outOfDomain,
    noisyLanguage,
    categoryCounts,
    exactInternalDuplicates,
    nearInternalDuplicates,
    exactContaminationMatches,
    nearContaminationMatches,
    contaminationSources: contaminationSources.map(({ path, sha256: digest }) => ({
      path,
      sha256: digest
    }))
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function pathInside(parent: string, candidate: string): boolean {
  const relativePath = relative(parent, candidate)
  return relativePath !== '' && !relativePath.startsWith(`..${sep}`) && relativePath !== '..'
}

function pathAtOrInside(parent: string, candidate: string): boolean {
  return resolve(parent) === resolve(candidate) || pathInside(resolve(parent), resolve(candidate))
}

export interface FreezeHumanBlindOptions {
  workspace: string
  sourcePath: string
  outputDirectory: string
  suiteVersion: string
  modelLockPath: string
  protocolPath: string
  force?: boolean
  now?: Date
  policy?: HumanBlindPolicy
}

export async function freezeHumanBlindCollection(options: FreezeHumanBlindOptions): Promise<{
  manifest: Extract<AssistantSuiteManifest, { independentHumanBlind: true }>
  audit: HumanBlindAudit
}> {
  const workspace = resolve(options.workspace)
  const allowedOutputRoot = resolve(workspace, 'evals/assistant/human-blind/releases')
  const outputDirectory = resolve(options.outputDirectory)
  if (!pathInside(allowedOutputRoot, outputDirectory)) {
    throw new Error(`Freeze output must be a child of ${allowedOutputRoot}`)
  }
  const sourcePath = resolve(options.sourcePath)
  const defaultSourcePath = resolve(workspace, 'evals/assistant/human-blind/collection.local.jsonl')
  const localPrivateRoot = resolve(workspace, 'evals/assistant/human-blind/local-private')
  if (
    pathAtOrInside(workspace, sourcePath) &&
    sourcePath !== defaultSourcePath &&
    !pathInside(localPrivateRoot, sourcePath)
  ) {
    throw new Error(
      `A workspace-owned raw collection must stay at ${defaultSourcePath} or under ${localPrivateRoot}`
    )
  }
  const sourceContents = await readFile(sourcePath, 'utf8')
  const records = parseHumanBlindCollection(sourceContents)
  const contaminationSources = await loadContaminationSources(workspace)
  const auditOptions: { now?: Date; policy?: HumanBlindPolicy } = {}
  if (options.now) auditOptions.now = options.now
  if (options.policy) auditOptions.policy = options.policy
  const audit = auditHumanBlindCollection(records, contaminationSources, auditOptions)
  if (!audit.readyToFreeze) {
    throw new Error(`Human-blind collection is not ready:\n- ${audit.blockers.join('\n- ')}`)
  }

  const scenarios = records
    .map((record) => record.scenario)
    .sort((left, right) => left.id.localeCompare(right.id))
  const suiteContents = `${scenarios.map((scenario) => JSON.stringify(scenario)).join('\n')}\n`
  const suitePath = resolve(outputDirectory, 'scenarios.jsonl')
  const manifestPath = resolve(outputDirectory, 'manifest.json')
  if (!options.force && ((await pathExists(suitePath)) || (await pathExists(manifestPath)))) {
    throw new Error(
      'The target release already exists; choose a new version or pass --force explicitly'
    )
  }

  const modelLockPath = resolve(options.modelLockPath)
  const protocolPath = resolve(options.protocolPath)
  if (modelLockPath !== resolve(workspace, 'models/manifest.json')) {
    throw new Error('Phase 8 must lock the canonical models/manifest.json inventory')
  }
  if (protocolPath !== resolve(workspace, 'evals/assistant/human-blind/protocol-v1.md')) {
    throw new Error('Phase 8 must bind evals/assistant/human-blind/protocol-v1.md')
  }
  const modelLockContents = await readFile(modelLockPath)
  const protocolContents = await readFile(protocolPath)
  const relativeSuitePath = relative(workspace, suitePath).replaceAll('\\', '/')
  const manifest = assistantSuiteManifestSchema.parse({
    schemaVersion: 1,
    suiteVersion: options.suiteVersion,
    path: relativeSuitePath,
    sha256: sha256(suiteContents),
    scenarios: scenarios.length,
    turns: scenarios.reduce((total, scenario) => total + scenario.turns.length, 0),
    trainingExcluded: true,
    independentHumanBlind: true,
    frozen: true,
    collectionProtocol: {
      version: '1.0',
      path: relative(workspace, protocolPath).replaceAll('\\', '/'),
      sha256: sha256(protocolContents)
    },
    sourceCollectionSha256: sha256(sourceContents),
    frozenAt: (options.now ?? new Date()).toISOString(),
    participantCount: audit.participants,
    annotatorCount: audit.annotators,
    publicReleaseConsent: true,
    withdrawalWindowClosed: true,
    twoAnnotatorConsensus: true,
    annotationQualityPassed: true,
    syntheticCalendarFactsOnly: true,
    piiReviewPassed: true,
    modelLockedBeforeEvaluation: true,
    modelLock: {
      path: relative(workspace, modelLockPath).replaceAll('\\', '/'),
      sha256: sha256(modelLockContents)
    },
    contaminationAudit: {
      exactMatches: 0,
      nearMatches: 0,
      threshold: (options.policy ?? phase8HumanBlindPolicy).nearDuplicateThreshold,
      sources: audit.contaminationSources
    }
  })
  if (!manifest.independentHumanBlind) throw new Error('Expected a human-blind manifest')

  await mkdir(outputDirectory, { recursive: true })
  const writeFlag = options.force ? 'w' : 'wx'
  await Promise.all([
    writeFile(suitePath, suiteContents, { encoding: 'utf8', flag: writeFlag }),
    writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: 'utf8',
      flag: writeFlag
    })
  ])
  return { manifest, audit }
}

async function walkCodeFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    if (entry.name === '__pycache__' || entry.name.startsWith('.')) continue
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await walkCodeFiles(path)))
    else if (/\.(?:cjs|json|mjs|py|ts)$/u.test(entry.name)) files.push(path)
  }
  return files
}

export async function assertHumanBlindTrainingBoundary(workspace: string): Promise<void> {
  const root = resolve(workspace)
  const candidates = [
    ...(await walkCodeFiles(resolve(root, 'ml'))),
    resolve(root, 'scripts/build-assistant-corpus.ts'),
    resolve(root, 'apps/desktop/scripts/qwen-teacher-generate.mjs')
  ]
  const forbidden = [/evals[\\/]assistant[\\/]human-blind/iu, /human-blind\.local\.jsonl/iu]
  const violations: string[] = []
  for (const path of candidates) {
    const contents = await readFile(path, 'utf8')
    if (forbidden.some((pattern) => pattern.test(contents))) {
      violations.push(relative(root, path).replaceAll('\\', '/'))
    }
  }
  if (violations.length > 0) {
    throw new Error(
      `Training code references the sealed human-blind path: ${violations.join(', ')}`
    )
  }
}

export async function loadAndAuditHumanBlindCollection(
  workspace: string,
  sourcePath: string,
  options: { now?: Date; policy?: HumanBlindPolicy } = {}
): Promise<HumanBlindAudit> {
  const contents = await readFile(sourcePath, 'utf8')
  const records = parseHumanBlindCollection(contents)
  const contaminationSources = await loadContaminationSources(workspace)
  return auditHumanBlindCollection(records, contaminationSources, options)
}
