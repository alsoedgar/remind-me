import {
  documentScheduleMetadataSchema,
  identifierSchema,
  ianaTimeZoneSchema,
  localDateSchema,
  localTimeSchema,
  recurrenceRuleSchema
} from '@remind-me/contracts'
import { z } from 'zod'

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u)

export const documentEvalInputClassSchema = z.enum([
  'born-digital',
  'raster-pdf',
  'hybrid-pdf',
  'direct-image',
  'screenshot',
  'phone-photo',
  'rotated-scan'
])

export const documentEvalLayoutFamilySchema = z.enum([
  'vertical-list',
  'row-table',
  'syllabus',
  'calendar-grid',
  'itinerary-cards',
  'flyer'
])

const scheduleIdentitySchema = z
  .object({
    courseCode: z.string().trim().min(1).max(80),
    sectionCode: z.string().trim().min(1).max(80).nullable(),
    crn: z.string().trim().min(1).max(80).nullable(),
    component: documentScheduleMetadataSchema.shape.component
  })
  .strict()

const evalItemShape = {
  page: z.number().int().positive().max(100),
  kind: z.enum(['event', 'reminder']),
  title: z.string().trim().min(1).max(1_000),
  startDate: localDateSchema,
  endDate: localDateSchema.nullable(),
  startTime: localTimeSchema.nullable(),
  endTime: localTimeSchema.nullable(),
  timezone: ianaTimeZoneSchema,
  allDay: z.boolean(),
  location: z.string().trim().max(1_000).nullable(),
  recurrence: recurrenceRuleSchema.nullable(),
  schedule: scheduleIdentitySchema.nullable()
} as const

function validateItemSemantics(
  item: z.infer<typeof documentEvalGoldItemSchema>,
  context: z.RefinementCtx
): void {
  if (item.kind === 'reminder' && (item.endDate !== null || item.endTime !== null || item.allDay)) {
    context.addIssue({
      code: 'custom',
      message: 'Reminder gold rows cannot carry event-only end or all-day fields'
    })
  }
  if (item.allDay && (item.startTime !== null || item.endTime !== null)) {
    context.addIssue({ code: 'custom', message: 'All-day rows cannot carry clock times' })
  }
  if (!item.allDay && item.kind === 'event' && item.startTime === null) {
    context.addIssue({ code: 'custom', message: 'Timed event rows require a start time' })
  }
}

export const documentEvalGoldItemSchema = z
  .object({ id: identifierSchema, ...evalItemShape })
  .strict()
  .superRefine(validateItemSemantics)

export const documentEvalSkipSchema = z
  .object({
    id: identifierSchema,
    page: z.number().int().positive().max(100),
    title: z.string().trim().min(1).max(1_000),
    reason: z.enum(['no-fixed-time', 'non-calendar-content', 'cancelled', 'duplicate-source-row'])
  })
  .strict()

export const documentEvalCorpusRecordSchema = z
  .object({
    id: identifierSchema,
    sourceGroupId: identifierSchema,
    fixture: z.string().regex(/^fixtures\/documents\/[a-zA-Z0-9._-]+$/u),
    sourceKind: z.enum(['pdf', 'image']),
    mediaType: z.enum(['application/pdf', 'image/png', 'image/jpeg', 'image/webp']),
    inputClass: documentEvalInputClassSchema,
    layoutFamily: documentEvalLayoutFamilySchema,
    pageCount: z.number().int().positive().max(20),
    locale: z.literal('en-US'),
    timezone: ianaTimeZoneSchema,
    provenance: z.enum(['project-sanitized', 'consented-real', 'independent-human-blind']),
    trainingExcluded: z.literal(true),
    independentHumanBlind: z.boolean(),
    tags: z.array(z.string().trim().min(1).max(80)).min(1).max(30),
    expectedItems: z.array(documentEvalGoldItemSchema).max(50),
    expectedSkips: z.array(documentEvalSkipSchema).max(50)
  })
  .strict()
  .superRefine((record, context) => {
    if (record.independentHumanBlind !== (record.provenance === 'independent-human-blind')) {
      context.addIssue({
        code: 'custom',
        message: 'Human-blind provenance and independentHumanBlind must agree'
      })
    }
    const ids = [...record.expectedItems, ...record.expectedSkips].map((item) => item.id)
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: 'custom', message: 'Expected row IDs must be unique per fixture' })
    }
  })

export const documentEvalObservedItemSchema = z
  .object({
    id: identifierSchema,
    ...evalItemShape,
    confidence: z.number().min(0).max(1),
    attention: z.enum(['ready', 'check-evidence']),
    evidence: z
      .object({
        title: z.boolean(),
        when: z.boolean(),
        location: z.boolean(),
        description: z.boolean()
      })
      .strict()
  })
  .strict()
  .superRefine(validateItemSemantics)

export const documentEvalObservationSchema = z
  .object({
    fixtureId: identifierSchema,
    sourceSha256: sha256Schema,
    status: z.enum(['success', 'error']),
    error: z.string().trim().min(1).max(2_000).nullable(),
    pages: z.number().int().nonnegative().max(20),
    extractionMethods: z.array(z.enum(['native-text', 'ocr', 'mixed'])).max(20),
    processingDurationMs: z.number().int().nonnegative(),
    items: z.array(documentEvalObservedItemSchema).max(50),
    skippedCandidateCount: z.number().int().nonnegative(),
    duplicateCandidateCount: z.number().int().nonnegative(),
    existingCalendarDuplicateCount: z.number().int().nonnegative(),
    warnings: z.array(z.string().trim().min(1).max(1_000)).max(100)
  })
  .strict()
  .superRefine((observation, context) => {
    if (observation.status === 'error' && !observation.error) {
      context.addIssue({ code: 'custom', message: 'Failed observations require an error message' })
    }
    if (observation.status === 'success' && observation.error) {
      context.addIssue({ code: 'custom', message: 'Successful observations cannot carry an error' })
    }
  })

export const documentEvalManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    suiteVersion: z.string().regex(/^\d+\.\d+\.\d+$/u),
    corpusPath: z.literal('evals/documents/v0.1/corpus.jsonl'),
    corpusSha256: sha256Schema,
    records: z.number().int().positive(),
    sourceGroups: z.number().int().positive(),
    expectedItems: z.number().int().nonnegative(),
    expectedSkips: z.number().int().nonnegative(),
    humanBlindRecords: z.number().int().nonnegative(),
    trainingExcluded: z.literal(true),
    frozen: z.literal(true),
    fixtureDigests: z.record(z.string(), sha256Schema),
    taxonomy: z
      .object({
        inputClasses: z.record(z.string(), z.number().int().nonnegative()),
        layoutFamilies: z.record(z.string(), z.number().int().nonnegative()),
        sourceKinds: z.record(z.string(), z.number().int().nonnegative())
      })
      .strict()
  })
  .strict()

export type DocumentEvalCorpusRecord = z.infer<typeof documentEvalCorpusRecordSchema>
export type DocumentEvalGoldItem = z.infer<typeof documentEvalGoldItemSchema>
export type DocumentEvalObservedItem = z.infer<typeof documentEvalObservedItemSchema>
export type DocumentEvalObservation = z.infer<typeof documentEvalObservationSchema>
export type DocumentEvalManifest = z.infer<typeof documentEvalManifestSchema>

export interface FieldMetric {
  eligible: number
  correct: number
  accuracy: number | null
  presentExpected: number
  presentCorrect: number
  presentAccuracy: number | null
}

export interface DocumentEvalSlice {
  documents: number
  expectedItems: number
  observedItems: number
  matchedItems: number
  exactItems: number
  falsePositives: number
  falseNegatives: number
  precision: number | null
  recall: number | null
  exactPrecision: number | null
  exactRecall: number | null
  perfectDocuments: number
  perfectDocumentRate: number | null
}

export interface DocumentEvalFailure {
  fixtureId: string
  missing: string[]
  unexpected: string[]
  fieldMismatches: Array<{ expected: string; observed: string; fields: string[] }>
  expectedSkipCount: number
  observedSkipCount: number
  error: string | null
}

export interface DocumentEvaluationReport {
  schemaVersion: 1
  suiteVersion: string
  generatedAt: string
  coverage: {
    corpusDocuments: number
    scoredDocuments: number
    erroredDocuments: number
    coverage: number
    independentHumanBlindDocuments: number
  }
  overall: DocumentEvalSlice & {
    expectedSkips: number
    exactSkipCountDocuments: number
    exactSkipCountRate: number | null
    duplicateCandidatesRemoved: number
    evidenceCompleteItems: number
    evidenceCoverage: number | null
  }
  fields: Record<string, FieldMetric>
  byInputClass: Record<string, DocumentEvalSlice>
  byLayoutFamily: Record<string, DocumentEvalSlice>
  bySourceKind: Record<string, DocumentEvalSlice>
  failures: DocumentEvalFailure[]
}

const fieldNames = [
  'kind',
  'title',
  'startDate',
  'endDate',
  'startTime',
  'endTime',
  'timezone',
  'allDay',
  'location',
  'recurrence',
  'courseCode',
  'sectionCode',
  'crn',
  'component'
] as const

type FieldName = (typeof fieldNames)[number]

function normalizedText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('en-US')
}

function normalizedRecurrence(value: DocumentEvalGoldItem['recurrence']): string | null {
  if (!value) return null
  return JSON.stringify({
    ...value,
    byWeekday: [...value.byWeekday].sort(),
    byMonthDay: [...value.byMonthDay].sort((left, right) => left - right)
  })
}

function fieldValue(
  item: DocumentEvalGoldItem | DocumentEvalObservedItem,
  field: FieldName
): unknown {
  if (field === 'courseCode') return item.schedule?.courseCode ?? null
  if (field === 'sectionCode') return item.schedule?.sectionCode ?? null
  if (field === 'crn') return item.schedule?.crn ?? null
  if (field === 'component') return item.schedule?.component ?? null
  if (field === 'recurrence') return normalizedRecurrence(item.recurrence)
  const value = item[field]
  if (typeof value === 'string' && (field === 'title' || field === 'location')) {
    return normalizedText(value)
  }
  return value
}

function tokenSimilarity(left: string, right: string): number {
  const leftTokens = new Set(normalizedText(left).match(/[\p{L}\p{N}]+/gu) ?? [])
  const rightTokens = new Set(normalizedText(right).match(/[\p{L}\p{N}]+/gu) ?? [])
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length
  return intersection / new Set([...leftTokens, ...rightTokens]).size
}

function matchScore(expected: DocumentEvalGoldItem, observed: DocumentEvalObservedItem): number {
  const expectedCrn = expected.schedule?.crn
  const observedCrn = observed.schedule?.crn
  let score = 0
  if (expectedCrn && observedCrn && normalizedText(expectedCrn) === normalizedText(observedCrn)) {
    score += 60
  }
  if (
    expected.schedule?.courseCode &&
    observed.schedule?.courseCode &&
    normalizedText(expected.schedule.courseCode) === normalizedText(observed.schedule.courseCode)
  ) {
    score += 24
    if (
      expected.schedule.sectionCode &&
      observed.schedule.sectionCode &&
      normalizedText(expected.schedule.sectionCode) ===
        normalizedText(observed.schedule.sectionCode)
    ) {
      score += 16
    }
  }
  const titleSimilarity = tokenSimilarity(expected.title, observed.title)
  score += titleSimilarity * 28
  if (expected.kind === observed.kind) score += 7
  if (expected.startDate === observed.startDate) score += 9
  if (expected.startTime === observed.startTime) score += 6
  if (expected.page === observed.page) score += 2
  return score
}

interface MatchedPair {
  expected: DocumentEvalGoldItem
  observed: DocumentEvalObservedItem
}

function matchItems(
  expectedItems: readonly DocumentEvalGoldItem[],
  observedItems: readonly DocumentEvalObservedItem[]
): {
  pairs: MatchedPair[]
  missing: DocumentEvalGoldItem[]
  unexpected: DocumentEvalObservedItem[]
} {
  const candidates = expectedItems.flatMap((expected, expectedIndex) =>
    observedItems.map((observed, observedIndex) => ({
      expectedIndex,
      observedIndex,
      score: matchScore(expected, observed)
    }))
  )
  candidates.sort(
    (left, right) =>
      right.score - left.score ||
      left.expectedIndex - right.expectedIndex ||
      left.observedIndex - right.observedIndex
  )
  const usedExpected = new Set<number>()
  const usedObserved = new Set<number>()
  const pairs: MatchedPair[] = []
  for (const candidate of candidates) {
    if (candidate.score < 18) break
    if (usedExpected.has(candidate.expectedIndex) || usedObserved.has(candidate.observedIndex))
      continue
    const expected = expectedItems[candidate.expectedIndex]
    const observed = observedItems[candidate.observedIndex]
    if (!expected || !observed) continue
    usedExpected.add(candidate.expectedIndex)
    usedObserved.add(candidate.observedIndex)
    pairs.push({ expected, observed })
  }
  return {
    pairs,
    missing: expectedItems.filter((_, index) => !usedExpected.has(index)),
    unexpected: observedItems.filter((_, index) => !usedObserved.has(index))
  }
}

interface SliceAccumulator {
  documents: number
  expectedItems: number
  observedItems: number
  matchedItems: number
  exactItems: number
  falsePositives: number
  falseNegatives: number
  perfectDocuments: number
}

function emptySlice(): SliceAccumulator {
  return {
    documents: 0,
    expectedItems: 0,
    observedItems: 0,
    matchedItems: 0,
    exactItems: 0,
    falsePositives: 0,
    falseNegatives: 0,
    perfectDocuments: 0
  }
}

function safeRatio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator
}

function finalizeSlice(slice: SliceAccumulator): DocumentEvalSlice {
  return {
    ...slice,
    precision: safeRatio(slice.matchedItems, slice.observedItems),
    recall: safeRatio(slice.matchedItems, slice.expectedItems),
    exactPrecision: safeRatio(slice.exactItems, slice.observedItems),
    exactRecall: safeRatio(slice.exactItems, slice.expectedItems),
    perfectDocumentRate: safeRatio(slice.perfectDocuments, slice.documents)
  }
}

function addSlice(
  slices: Map<string, SliceAccumulator>,
  key: string,
  values: Omit<SliceAccumulator, 'documents'>
): void {
  const slice = slices.get(key) ?? emptySlice()
  slice.documents += 1
  slice.expectedItems += values.expectedItems
  slice.observedItems += values.observedItems
  slice.matchedItems += values.matchedItems
  slice.exactItems += values.exactItems
  slice.falsePositives += values.falsePositives
  slice.falseNegatives += values.falseNegatives
  slice.perfectDocuments += values.perfectDocuments
  slices.set(key, slice)
}

function finalizedRecord(slices: Map<string, SliceAccumulator>): Record<string, DocumentEvalSlice> {
  return Object.fromEntries(
    [...slices.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, finalizeSlice(value)])
  )
}

export function scoreDocumentEvaluation(
  corpusInput: readonly unknown[],
  observationInput: readonly unknown[],
  suiteVersion = '0.1.0'
): DocumentEvaluationReport {
  const corpus = corpusInput.map((record) => documentEvalCorpusRecordSchema.parse(record))
  const observations = observationInput.map((record) => documentEvalObservationSchema.parse(record))
  const observationByFixture = new Map(observations.map((record) => [record.fixtureId, record]))
  if (observationByFixture.size !== observations.length) {
    throw new Error('Document observations must have unique fixture IDs')
  }

  const overall = emptySlice()
  const byInputClass = new Map<string, SliceAccumulator>()
  const byLayoutFamily = new Map<string, SliceAccumulator>()
  const bySourceKind = new Map<string, SliceAccumulator>()
  const fields = new Map<FieldName, Omit<FieldMetric, 'accuracy' | 'presentAccuracy'>>()
  for (const field of fieldNames) {
    fields.set(field, { eligible: 0, correct: 0, presentExpected: 0, presentCorrect: 0 })
  }
  const failures: DocumentEvalFailure[] = []
  let scoredDocuments = 0
  let erroredDocuments = 0
  let expectedSkips = 0
  let exactSkipCountDocuments = 0
  let duplicateCandidatesRemoved = 0
  let evidenceCompleteItems = 0
  let evidenceEligibleItems = 0

  for (const fixture of corpus) {
    expectedSkips += fixture.expectedSkips.length
    const observation = observationByFixture.get(fixture.id)
    if (!observation || observation.status === 'error') {
      if (observation?.status === 'error') erroredDocuments += 1
      failures.push({
        fixtureId: fixture.id,
        missing: fixture.expectedItems.map((item) => item.title),
        unexpected: [],
        fieldMismatches: [],
        expectedSkipCount: fixture.expectedSkips.length,
        observedSkipCount: observation?.skippedCandidateCount ?? 0,
        error: observation?.error ?? 'No observation was supplied'
      })
      continue
    }
    scoredDocuments += 1
    duplicateCandidatesRemoved += observation.duplicateCandidateCount
    if (observation.skippedCandidateCount === fixture.expectedSkips.length) {
      exactSkipCountDocuments += 1
    }
    const matched = matchItems(fixture.expectedItems, observation.items)
    const fieldMismatches: DocumentEvalFailure['fieldMismatches'] = []
    let allFieldsCorrect = true
    let exactItems = 0
    for (const pair of matched.pairs) {
      const mismatches: string[] = []
      for (const field of fieldNames) {
        const metric = fields.get(field)!
        const expectedValue = fieldValue(pair.expected, field)
        const observedValue = fieldValue(pair.observed, field)
        metric.eligible += 1
        const present = expectedValue !== null && expectedValue !== ''
        if (present) metric.presentExpected += 1
        if (Object.is(expectedValue, observedValue)) {
          metric.correct += 1
          if (present) metric.presentCorrect += 1
        } else {
          mismatches.push(field)
          allFieldsCorrect = false
        }
      }
      evidenceEligibleItems += 1
      const evidenceComplete =
        pair.observed.evidence.title &&
        pair.observed.evidence.when &&
        (pair.expected.location === null || pair.observed.evidence.location)
      if (evidenceComplete) evidenceCompleteItems += 1
      if (mismatches.length > 0) {
        fieldMismatches.push({
          expected: pair.expected.title,
          observed: pair.observed.title,
          fields: mismatches
        })
      } else {
        exactItems += 1
      }
    }
    const perfect =
      matched.missing.length === 0 &&
      matched.unexpected.length === 0 &&
      allFieldsCorrect &&
      observation.skippedCandidateCount === fixture.expectedSkips.length
    const values = {
      expectedItems: fixture.expectedItems.length,
      observedItems: observation.items.length,
      matchedItems: matched.pairs.length,
      exactItems,
      falsePositives: matched.unexpected.length,
      falseNegatives: matched.missing.length,
      perfectDocuments: Number(perfect)
    }
    overall.documents += 1
    overall.expectedItems += values.expectedItems
    overall.observedItems += values.observedItems
    overall.matchedItems += values.matchedItems
    overall.exactItems += values.exactItems
    overall.falsePositives += values.falsePositives
    overall.falseNegatives += values.falseNegatives
    overall.perfectDocuments += values.perfectDocuments
    addSlice(byInputClass, fixture.inputClass, values)
    addSlice(byLayoutFamily, fixture.layoutFamily, values)
    addSlice(bySourceKind, fixture.sourceKind, values)
    if (!perfect) {
      failures.push({
        fixtureId: fixture.id,
        missing: matched.missing.map((item) => item.title),
        unexpected: matched.unexpected.map((item) => item.title),
        fieldMismatches,
        expectedSkipCount: fixture.expectedSkips.length,
        observedSkipCount: observation.skippedCandidateCount,
        error: null
      })
    }
  }

  const finalizedFields = Object.fromEntries(
    [...fields.entries()].map(([field, metric]) => [
      field,
      {
        ...metric,
        accuracy: safeRatio(metric.correct, metric.eligible),
        presentAccuracy: safeRatio(metric.presentCorrect, metric.presentExpected)
      }
    ])
  )
  const finalizedOverall = finalizeSlice(overall)
  return {
    schemaVersion: 1,
    suiteVersion,
    generatedAt: new Date().toISOString(),
    coverage: {
      corpusDocuments: corpus.length,
      scoredDocuments,
      erroredDocuments,
      coverage: safeRatio(scoredDocuments, corpus.length) ?? 0,
      independentHumanBlindDocuments: corpus.filter((record) => record.independentHumanBlind).length
    },
    overall: {
      ...finalizedOverall,
      expectedSkips,
      exactSkipCountDocuments,
      exactSkipCountRate: safeRatio(exactSkipCountDocuments, scoredDocuments),
      duplicateCandidatesRemoved,
      evidenceCompleteItems,
      evidenceCoverage: safeRatio(evidenceCompleteItems, evidenceEligibleItems)
    },
    fields: finalizedFields,
    byInputClass: finalizedRecord(byInputClass),
    byLayoutFamily: finalizedRecord(byLayoutFamily),
    bySourceKind: finalizedRecord(bySourceKind),
    failures
  }
}

function percentage(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`
}

export function formatDocumentEvaluationMarkdown(report: DocumentEvaluationReport): string {
  const fieldRows = Object.entries(report.fields)
    .map(
      ([field, metric]) =>
        `| ${field} | ${percentage(metric.accuracy)} | ${percentage(metric.presentAccuracy)} | ${metric.correct}/${metric.eligible} |`
    )
    .join('\n')
  const failureRows = report.failures
    .slice(0, 20)
    .map((failure) => {
      const details = [
        failure.error,
        failure.missing.length > 0 ? `missing: ${failure.missing.join(', ')}` : null,
        failure.unexpected.length > 0 ? `unexpected: ${failure.unexpected.join(', ')}` : null,
        failure.fieldMismatches.length > 0
          ? `field mismatches: ${failure.fieldMismatches.map((item) => `${item.expected} [${item.fields.join(', ')}]`).join('; ')}`
          : null,
        failure.expectedSkipCount !== failure.observedSkipCount
          ? `skip count ${failure.observedSkipCount}/${failure.expectedSkipCount}`
          : null
      ]
        .filter((value): value is string => Boolean(value))
        .join(' - ')
      return `- **${failure.fixtureId}:** ${details || 'not perfect'}`
    })
    .join('\n')
  return `# Document import baseline

Generated: ${report.generatedAt}

This report scores the real local PDF text, OCR, PlanScan, deterministic planning, and CalendarIR compilation path against the frozen, training-excluded Phase 0 corpus. Generated fixtures are regression data, not independent human-blind evidence.

## Coverage

- Documents: ${report.coverage.scoredDocuments}/${report.coverage.corpusDocuments} (${percentage(report.coverage.coverage)})
- Independent human-blind documents: ${report.coverage.independentHumanBlindDocuments}
- Expected proposals: ${report.overall.expectedItems}
- Observed proposals: ${report.overall.observedItems}

## Outcome

- Cardinality precision: ${percentage(report.overall.precision)}
- Cardinality recall: ${percentage(report.overall.recall)}
- Exact-item precision: ${percentage(report.overall.exactPrecision)}
- Exact-item recall: ${percentage(report.overall.exactRecall)}
- Perfect documents: ${report.overall.perfectDocuments}/${report.overall.documents} (${percentage(report.overall.perfectDocumentRate)})
- Evidence coverage: ${percentage(report.overall.evidenceCoverage)}
- Exact aggregate skip count: ${percentage(report.overall.exactSkipCountRate)}

## Field accuracy

| Field | All values | Present values | Correct |
| --- | ---: | ---: | ---: |
${fieldRows}

## Failures

${failureRows || '- None'}
`
}

export function countTaxonomy(
  records: readonly DocumentEvalCorpusRecord[]
): DocumentEvalManifest['taxonomy'] {
  const count = <Key extends string>(values: readonly Key[]): Record<string, number> => {
    const result: Record<string, number> = {}
    for (const value of values) result[value] = (result[value] ?? 0) + 1
    return Object.fromEntries(
      Object.entries(result).sort(([left], [right]) => left.localeCompare(right))
    )
  }
  return {
    inputClasses: count(records.map((record) => record.inputClass)),
    layoutFamilies: count(records.map((record) => record.layoutFamily)),
    sourceKinds: count(records.map((record) => record.sourceKind))
  }
}
