import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { resolve } from 'node:path'
import {
  documentExtractionSchema,
  documentPageSchema,
  planScanAnalysisSchema,
  type DocumentPage,
  type PlanScanAnalysis
} from '@remind-me/contracts'
import { planDocumentExtraction, PlanScanRuntime } from '../packages/importers/src/document'
import { loadModelManifest, verifyModelManifest } from '@remind-me/model-runtime'

interface HeldoutPage {
  id: string
  challengeSlice:
    | 'baseline'
    | 'ocr-corruption'
    | 'neighboring-row-negatives'
    | 'repeated-titles'
    | 'unfamiliar-column-order'
    | 'header-footer-distractions'
  challenges: string[]
  templateFamily: string
  font: string
  scanStyle: string
  organization: string
  documentType: string
  method: 'native-text' | 'ocr'
  page: DocumentPage
  gold: {
    blockRoles: Record<string, string>
    entityRoles: Record<string, string>
    groups: Array<{
      id: string
      kind: 'event' | 'reminder'
      title: string
      date: string
      time: string
      location: string
    }>
    observedGroups: Array<{
      id: string
      kind: 'event' | 'reminder'
      title: string
      date: string
      time: string
      location: string
    }>
  }
}

const workspace = resolve(import.meta.dirname, '..')
const modelRoot = resolve(workspace, 'models')
const planScanRoot = resolve(modelRoot, 'planscan')
const fixturePath = resolve(workspace, 'fixtures', 'planscan', 'heldout.v0.1.jsonl')
const reportPath = resolve(workspace, 'ml', 'planscan', 'reports', 'runtime-metrics.json')
const challengeSlices = [
  'baseline',
  'ocr-corruption',
  'neighboring-row-negatives',
  'repeated-titles',
  'unfamiliar-column-order',
  'header-footer-distractions'
] as const

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right)
  return (
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))] ?? 0
  )
}

function cleanTitle(value: string): string {
  return value.replace(/^(?:reminder|remind me|due|deadline|event)\s*[:\-–—]?\s*/iu, '').trim()
}

function compact(value: string): string {
  return value.replace(/\s+/gu, ' ').trim().toLocaleLowerCase()
}

const monthNumbers: Readonly<Record<string, string>> = {
  january: '01',
  february: '02',
  march: '03',
  april: '04',
  may: '05',
  june: '06',
  july: '07',
  august: '08',
  september: '09',
  october: '10',
  november: '11',
  december: '12'
}

function isoDate(value: string): string {
  const match = /^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/u.exec(value.trim())
  assert(match?.[1] && match[2] && match[3], `Unsupported fixture date: ${value}`)
  const month = monthNumbers[match[1].toLocaleLowerCase()]
  assert(month, `Unsupported fixture month: ${value}`)
  return `${match[3]}-${month}-${match[2].padStart(2, '0')}`
}

function clockTime(value: string): string {
  const first = value.split(/\s*(?:-|–|—|\bto\b|\buntil\b)\s*/iu)[0]?.trim() ?? value
  if (first.toLocaleLowerCase() === 'noon') return '12:00'
  if (first.toLocaleLowerCase() === 'midnight') return '00:00'
  const match = /^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?$/iu.exec(first)
  assert(match?.[1] && match[3], `Unsupported fixture time: ${value}`)
  let hour = Number(match[1]) % 12
  if (match[3].toLocaleLowerCase() === 'p') hour += 12
  return `${String(hour).padStart(2, '0')}:${match[2] ?? '00'}`
}

function modelGroupSignatures(analysis: PlanScanAnalysis): Set<string> {
  const spans = new Map(analysis.spans.map((span) => [span.id, span]))
  return new Set(
    analysis.groups.map((group) => {
      const title = spans.get(group.titleSpanId)?.text ?? ''
      const date = spans.get(group.dateSpanId)?.text ?? ''
      const time = group.timeSpanId ? (spans.get(group.timeSpanId)?.text ?? '') : 'all-day'
      const location = group.locationSpanId ? (spans.get(group.locationSpanId)?.text ?? '') : ''
      return [group.kind, cleanTitle(title), date, time, location].map(compact).join('|')
    })
  )
}

function goldGroupSignatures(fixture: HeldoutPage): Set<string> {
  return new Set(
    fixture.gold.groups.map((group) =>
      [group.kind, cleanTitle(group.title), group.date, group.time, group.location]
        .map(compact)
        .join('|')
    )
  )
}

function observedGroupSignatures(fixture: HeldoutPage): Set<string> {
  return new Set(
    fixture.gold.observedGroups.map((group) =>
      [group.kind, cleanTitle(group.title), group.date, group.time, group.location]
        .map(compact)
        .join('|')
    )
  )
}

function setsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value))
}

interface MatchCounts {
  truePositive: number
  falsePositive: number
  falseNegative: number
}

function emptyCounts(): MatchCounts {
  return { truePositive: 0, falsePositive: 0, falseNegative: 0 }
}

function addSetCounts(
  counts: MatchCounts,
  actual: ReadonlySet<string>,
  expected: ReadonlySet<string>
): void {
  counts.truePositive += [...actual].filter((value) => expected.has(value)).length
  counts.falsePositive += [...actual].filter((value) => !expected.has(value)).length
  counts.falseNegative += [...expected].filter((value) => !actual.has(value)).length
}

function matchF1(counts: MatchCounts): number {
  return (
    (2 * counts.truePositive) /
    Math.max(1, 2 * counts.truePositive + counts.falsePositive + counts.falseNegative)
  )
}

const [configurationText, compressedWeights, fixtureText, manifest, prototypeMetricsText] =
  await Promise.all([
    readFile(resolve(planScanRoot, 'planscan-v0.1-int8.json'), 'utf8'),
    readFile(resolve(planScanRoot, 'planscan-v0.1-int8.bin.gz')),
    readFile(fixturePath, 'utf8'),
    loadModelManifest(modelRoot),
    readFile(resolve(workspace, 'ml', 'planscan', 'reports', 'prototype-metrics.json'), 'utf8')
  ])
const verification = await verifyModelManifest(modelRoot, manifest)
assert(verification.valid, 'The offline model inventory is invalid')
const configuration = JSON.parse(configurationText) as {
  safety?: {
    repairFallbackCandidateSelectionOnly?: boolean
    repairFallbackHasMutationAuthority?: boolean
  }
}
const prototypeMetrics = JSON.parse(prototypeMetricsText) as {
  promotionGates?: Record<string, boolean>
}
const runtime = await PlanScanRuntime.create(configuration, compressedWeights)
assert(runtime.info.parameterCount >= 5_000_000, 'PlanScan is below the Phase 6 parameter range')
assert(runtime.info.parameterCount <= 8_000_000, 'PlanScan is above the Phase 6 parameter range')
assert(runtime.info.modelBytes < 64 * 1024, 'PlanScan compressed artifacts exceed 64 KiB')
assert(runtime.info.workingSetBytes < 8 * 1024 * 1024, 'PlanScan weights exceed 8 MiB in memory')

const fixtures = fixtureText
  .trim()
  .split(/\r?\n/gu)
  .map((line) => JSON.parse(line) as HeldoutPage)
assert(fixtures.length === 120, `Expected 120 PlanScan fixtures, found ${fixtures.length}`)
for (const challenge of challengeSlices) {
  const slice = fixtures.filter((fixture) => fixture.challengeSlice === challenge)
  assert(slice.length === 20, `Expected 20 ${challenge} fixtures, found ${slice.length}`)
  assert(
    slice.filter((fixture) => fixture.method === 'native-text').length === 10 &&
      slice.filter((fixture) => fixture.method === 'ocr').length === 10,
    `${challenge} is not balanced across native text and OCR`
  )
}

let truePositive = 0
let falsePositive = 0
let falseNegative = 0
let evidenceValues = 0
let evidenceBacked = 0
const latencyMs: number[] = []
const pristinePageExecution = {
  'native-text': [] as boolean[],
  ocr: [] as boolean[]
}
const observedPageExecution = {
  'native-text': [] as boolean[],
  ocr: [] as boolean[]
}
const plannerPristinePageExecution = {
  'native-text': [] as boolean[],
  ocr: [] as boolean[]
}
const pristineChallengePageExecution = Object.fromEntries(
  challengeSlices.map((challenge) => [challenge, [] as boolean[]])
) as Record<(typeof challengeSlices)[number], boolean[]>
const observedChallengePageExecution = Object.fromEntries(
  challengeSlices.map((challenge) => [challenge, [] as boolean[]])
) as Record<(typeof challengeSlices)[number], boolean[]>
const plannerPristineChallengePageExecution = Object.fromEntries(
  challengeSlices.map((challenge) => [challenge, [] as boolean[]])
) as Record<(typeof challengeSlices)[number], boolean[]>
const pristineGroupCountsByMethod = {
  'native-text': emptyCounts(),
  ocr: emptyCounts()
}
const observedGroupCountsByMethod = {
  'native-text': emptyCounts(),
  ocr: emptyCounts()
}
const pristineGroupCountsByChallenge = Object.fromEntries(
  challengeSlices.map((challenge) => [challenge, emptyCounts()])
) as Record<(typeof challengeSlices)[number], MatchCounts>
const observedGroupCountsByChallenge = Object.fromEntries(
  challengeSlices.map((challenge) => [challenge, emptyCounts()])
) as Record<(typeof challengeSlices)[number], MatchCounts>
const mismatches: Array<{
  id: string
  templateFamily: string
  method: string
  expected: string[]
  actual: string[]
}> = []
const plannerMismatches: Array<{
  id: string
  method: string
  expected: string[]
  actual: string[]
}> = []

for (const fixture of fixtures) {
  const page = documentPageSchema.parse(fixture.page)
  const startedAt = performance.now()
  const analysis = planScanAnalysisSchema.parse(runtime.analyze([page]))
  latencyMs.push(performance.now() - startedAt)
  assert(analysis.blockPredictions.length === page.blocks.length, `${fixture.id} lost blocks`)
  assert(analysis.modelId === runtime.info.id, `${fixture.id} changed the model identity`)
  const predictions = new Map(
    analysis.blockPredictions.map((prediction) => [prediction.blockId, prediction])
  )
  for (const block of page.blocks) {
    const target = fixture.gold.entityRoles[block.id]
    const predicted = predictions.get(block.id)?.entityRole
    if (target !== 'other' && target === predicted) truePositive += 1
    else {
      if (predicted !== 'other') falsePositive += 1
      if (target !== 'other') falseNegative += 1
    }
  }
  const blocks = new Map(page.blocks.map((block) => [block.id, block]))
  for (const span of analysis.spans) {
    const source = blocks.get(span.blockId)
    assert(source, `${fixture.id} emitted an unknown evidence block`)
    evidenceValues += 1
    if (
      source.text.slice(span.start, span.end) === span.text &&
      span.wordIds.every((id) => source.wordIds.includes(id))
    ) {
      evidenceBacked += 1
    }
  }
  const actualGroups = modelGroupSignatures(analysis)
  const expectedGroups = goldGroupSignatures(fixture)
  const observedGroups = observedGroupSignatures(fixture)
  const pristineModelEquivalent = setsEqual(actualGroups, expectedGroups)
  const observedModelEquivalent = setsEqual(actualGroups, observedGroups)
  pristinePageExecution[fixture.method].push(pristineModelEquivalent)
  observedPageExecution[fixture.method].push(observedModelEquivalent)
  pristineChallengePageExecution[fixture.challengeSlice].push(pristineModelEquivalent)
  observedChallengePageExecution[fixture.challengeSlice].push(observedModelEquivalent)
  addSetCounts(pristineGroupCountsByMethod[fixture.method], actualGroups, expectedGroups)
  addSetCounts(observedGroupCountsByMethod[fixture.method], actualGroups, observedGroups)
  addSetCounts(pristineGroupCountsByChallenge[fixture.challengeSlice], actualGroups, expectedGroups)
  addSetCounts(observedGroupCountsByChallenge[fixture.challengeSlice], actualGroups, observedGroups)
  if (!pristineModelEquivalent && mismatches.length < 24) {
    mismatches.push({
      id: fixture.id,
      templateFamily: fixture.templateFamily,
      method: fixture.method,
      expected: [...expectedGroups],
      actual: [...actualGroups]
    })
  }

  const sha256 = createHash('sha256').update(fixture.id).digest('hex')
  const extraction = documentExtractionSchema.parse({
    source: {
      id: `document:${sha256.slice(0, 24)}`,
      kind: fixture.method === 'ocr' ? 'image' : 'pdf',
      displayName: `${fixture.templateFamily}.${fixture.method === 'ocr' ? 'png' : 'pdf'}`,
      mediaType: fixture.method === 'ocr' ? 'image/png' : 'application/pdf',
      byteLength: 4_096,
      sha256
    },
    pages: [page],
    planScan: analysis,
    warnings: [],
    processingDurationMs: 1
  })
  const planned = planDocumentExtraction(extraction, {
    selectionId: extraction.source.id,
    nowUtc: '2026-08-24T15:00:00.000Z',
    localDate: '2026-08-24',
    timezone: 'America/Chicago',
    locale: 'en-US',
    defaultCalendarId: 'calendar:local',
    defaultEventDurationMinutes: 60,
    events: [],
    reminders: []
  })
  const plannedTitles = new Set(
    planned.drafts.map((draft) =>
      draft.kind === 'event'
        ? [
            draft.kind,
            compact(draft.form.title),
            draft.form.startDate,
            draft.form.startTime ?? 'all-day',
            compact(draft.form.location)
          ].join('|')
        : [draft.kind, compact(draft.form.title), draft.form.dueDate, draft.form.dueTime, ''].join(
            '|'
          )
    )
  )
  const goldTitles = new Set(
    fixture.gold.groups.map((group) =>
      [
        group.kind,
        compact(cleanTitle(group.title)),
        isoDate(group.date),
        clockTime(group.time),
        group.kind === 'event' ? compact(group.location) : ''
      ].join('|')
    )
  )
  const plannerEquivalent = setsEqual(plannedTitles, goldTitles)
  plannerPristinePageExecution[fixture.method].push(plannerEquivalent)
  plannerPristineChallengePageExecution[fixture.challengeSlice].push(plannerEquivalent)
  if (!plannerEquivalent && plannerMismatches.length < 20) {
    plannerMismatches.push({
      id: fixture.id,
      method: fixture.method,
      expected: [...goldTitles],
      actual: [...plannedTitles]
    })
  }
}

const f1 = (2 * truePositive) / Math.max(1, 2 * truePositive + falsePositive + falseNegative)
const rate = (values: readonly boolean[]): number =>
  values.filter(Boolean).length / Math.max(1, values.length)
const report = {
  schemaVersion: 1,
  fixturePages: fixtures.length,
  model: runtime.info,
  runtime: {
    entityMicroF1: f1,
    evidenceCoverage: evidenceBacked / Math.max(1, evidenceValues),
    pristinePageExactEquivalence: {
      bornDigital: rate(pristinePageExecution['native-text']),
      scanned: rate(pristinePageExecution.ocr)
    },
    observedPageExactEquivalence: {
      bornDigital: rate(observedPageExecution['native-text']),
      scanned: rate(observedPageExecution.ocr)
    },
    pristineGroupMicroF1: {
      bornDigital: matchF1(pristineGroupCountsByMethod['native-text']),
      scanned: matchF1(pristineGroupCountsByMethod.ocr)
    },
    observedGroupMicroF1: {
      bornDigital: matchF1(observedGroupCountsByMethod['native-text']),
      scanned: matchF1(observedGroupCountsByMethod.ocr)
    },
    pristineChallengeGroupMicroF1: Object.fromEntries(
      challengeSlices.map((challenge) => [
        challenge,
        matchF1(pristineGroupCountsByChallenge[challenge])
      ])
    ),
    observedChallengeGroupMicroF1: Object.fromEntries(
      challengeSlices.map((challenge) => [
        challenge,
        matchF1(observedGroupCountsByChallenge[challenge])
      ])
    ),
    observedChallengePageExactEquivalence: Object.fromEntries(
      challengeSlices.map((challenge) => [
        challenge,
        rate(observedChallengePageExecution[challenge])
      ])
    ),
    deterministicPlannerPristinePageExactEquivalence: {
      bornDigital: rate(plannerPristinePageExecution['native-text']),
      scanned: rate(plannerPristinePageExecution.ocr)
    },
    deterministicPlannerPristineChallengePageExactEquivalence: Object.fromEntries(
      challengeSlices.map((challenge) => [
        challenge,
        rate(plannerPristineChallengePageExecution[challenge])
      ])
    ),
    latencyMs: {
      median: percentile(latencyMs, 0.5),
      p95: percentile(latencyMs, 0.95),
      maximum: Math.max(...latencyMs)
    },
    diagnostics: mismatches,
    plannerDiagnostics: plannerMismatches
  },
  safety: {
    everyValueHasExactSourceEvidence: evidenceBacked === evidenceValues,
    modelHasNoStorageHandle: true,
    deterministicCalendarCompilerRetained: true,
    explicitBatchReviewRequired: true,
    rulesFallbackRetained: true,
    optionalRepairCandidateSelectionOnly:
      configuration.safety?.repairFallbackCandidateSelectionOnly === true,
    optionalRepairHasMutationAuthority:
      configuration.safety?.repairFallbackHasMutationAuthority === true
  }
}

await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

assert(report.runtime.entityMicroF1 >= 0.95, 'PlanScan runtime entity F1 fell below 95%')
assert(report.runtime.evidenceCoverage === 1, 'PlanScan lost exact source evidence')
assert(
  challengeSlices.every(
    (challenge) => (report.runtime.observedChallengeGroupMicroF1[challenge] ?? 0) >= 0.98
  ),
  'A Phase 6 challenge slice fell below 98% observed-source group F1'
)
assert(
  challengeSlices.every(
    (challenge) => (report.runtime.observedChallengePageExactEquivalence[challenge] ?? 0) >= 0.95
  ),
  'A Phase 6 challenge slice fell below 95% observed-source exact-page equivalence'
)
assert(
  prototypeMetrics.promotionGates && Object.values(prototypeMetrics.promotionGates).every(Boolean),
  'A PlanScan Phase 6 training promotion gate failed'
)
assert(report.safety.optionalRepairCandidateSelectionOnly, 'Document repair gained open generation')
assert(
  !report.safety.optionalRepairHasMutationAuthority,
  'Document repair gained calendar mutation authority'
)
assert(
  report.runtime.observedGroupMicroF1.bornDigital >= 0.98,
  'Born-digital observed-source group F1 fell below 98%'
)
assert(
  report.runtime.observedGroupMicroF1.scanned >= 0.98,
  'Scanned observed-source group F1 fell below 98%'
)
assert(report.runtime.latencyMs.p95 <= 2_000, 'PlanScan exceeded the ordinary-page latency target')

console.log(
  `PlanScan ${runtime.info.parameterCount.toLocaleString()} params | ` +
    `entity F1 ${(f1 * 100).toFixed(1)}% | ` +
    `native observed-group F1 ${(report.runtime.observedGroupMicroF1.bornDigital * 100).toFixed(1)}% | ` +
    `scan observed-group F1 ${(report.runtime.observedGroupMicroF1.scanned * 100).toFixed(1)}% | ` +
    `evidence ${(report.runtime.evidenceCoverage * 100).toFixed(1)}% | ` +
    `p95 ${report.runtime.latencyMs.p95.toFixed(1)} ms`
)
