import { z } from 'zod'
import { calendarIRDraftSchema, calendarIRResolvedSchema } from './calendar-ir'
import {
  calendarMutationResultSchema,
  calendarSnapshotRequestSchema,
  eventFormSchema,
  reminderFormSchema
} from './calendar-api'
import { ianaTimeZoneSchema, identifierSchema, localDateSchema, localTimeSchema } from './common'
import { recurrenceRuleSchema, weekdaySchema } from './recurrence'
import {
  documentImportIdentitySchema,
  documentImportSourceIdentitySchema,
  documentReconciliationSchema,
  documentScheduleComponentSchema
} from './document-identity'

export const maximumDocumentBytes = 25 * 1024 * 1024
export const maximumDocumentPages = 20
export const maximumDocumentImagePixels = 25_000_000
export const maximumDocumentWords = 12_000
export const maximumDocumentCharacters = 200_000
export const maximumDocumentDrafts = 50
export const maximumDocumentReviewImageCharacters = 6_500_000
export const maximumDocumentRepairDisagreements = 8
export const maximumDocumentFallbackBlocks = 18
export const maximumDocumentFallbackGroups = 8

export const documentSourceKindSchema = z.enum(['pdf', 'image'])
export const documentExtractionMethodSchema = z.enum(['native-text', 'ocr'])

export const planScanBlockRoleSchema = z.enum([
  'heading',
  'plan-title',
  'plan-field',
  'description',
  'metadata',
  'decorative',
  'other'
])

export const planScanEntityRoleSchema = z.enum([
  'title',
  'date',
  'time',
  'location',
  'description',
  'reminder-cue',
  'recurrence',
  'other'
])

export const planScanRelationTypeSchema = z.enum([
  'none',
  'same-plan',
  'title-field',
  'date-time',
  'field-detail',
  'sequence'
])

export const planScanDocumentTypeSchema = z.enum([
  'schedule',
  'syllabus',
  'invitation',
  'flyer',
  'itinerary',
  'rotation',
  'table',
  'screenshot'
])

export const documentBoundingBoxSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().positive().max(1),
    height: z.number().positive().max(1)
  })
  .strict()
  .superRefine((box, context) => {
    if (box.x + box.width > 1.001) {
      context.addIssue({
        code: 'custom',
        message: 'Bounding box exceeds page width',
        path: ['width']
      })
    }
    if (box.y + box.height > 1.001) {
      context.addIssue({
        code: 'custom',
        message: 'Bounding box exceeds page height',
        path: ['height']
      })
    }
  })

export const documentSourceSchema = z
  .object({
    id: identifierSchema,
    kind: documentSourceKindSchema,
    displayName: z.string().trim().min(1).max(500),
    mediaType: z.enum(['application/pdf', 'image/png', 'image/jpeg', 'image/webp']),
    byteLength: z.number().int().positive().max(maximumDocumentBytes),
    sha256: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict()

export const documentWordSchema = z
  .object({
    id: identifierSchema,
    lineId: identifierSchema,
    page: z.number().int().positive().max(maximumDocumentPages),
    text: z.string().trim().min(1).max(200),
    boundingBox: documentBoundingBoxSchema,
    confidence: z.number().min(0).max(1),
    method: documentExtractionMethodSchema
  })
  .strict()

export const documentTextBlockSchema = z
  .object({
    id: identifierSchema,
    page: z.number().int().positive().max(maximumDocumentPages),
    text: z.string().trim().min(1).max(2_000),
    boundingBox: documentBoundingBoxSchema,
    confidence: z.number().min(0).max(1),
    method: documentExtractionMethodSchema,
    wordIds: z.array(identifierSchema).min(1).max(200)
  })
  .strict()

export const documentPageSchema = z
  .object({
    page: z.number().int().positive().max(maximumDocumentPages),
    width: z.number().positive().max(100_000),
    height: z.number().positive().max(100_000),
    rotation: z.number().int().min(0).max(359),
    extraction: z.enum(['native-text', 'ocr', 'mixed']),
    nativeCharacterCount: z.number().int().nonnegative().max(maximumDocumentCharacters),
    thumbnailDataUrl: z
      .string()
      .max(750_000)
      .regex(/^data:image\/(?:jpeg|png);base64,[a-zA-Z0-9+/]+=*$/),
    reviewImageDataUrl: z
      .string()
      .max(maximumDocumentReviewImageCharacters)
      .regex(/^data:image\/(?:jpeg|png);base64,[a-zA-Z0-9+/]+=*$/)
      .optional(),
    words: z.array(documentWordSchema).max(5_000),
    blocks: z.array(documentTextBlockSchema).max(1_000)
  })
  .strict()

export const planScanBlockPredictionSchema = z
  .object({
    blockId: identifierSchema,
    page: z.number().int().positive().max(maximumDocumentPages),
    blockRole: planScanBlockRoleSchema,
    entityRole: planScanEntityRoleSchema,
    roleConfidence: z.number().min(0).max(1),
    qualityConfidence: z.number().min(0).max(1)
  })
  .strict()

export const planScanSpanSchema = z
  .object({
    id: identifierSchema,
    blockId: identifierSchema,
    page: z.number().int().positive().max(maximumDocumentPages),
    role: planScanEntityRoleSchema.exclude(['other']),
    text: z.string().trim().min(1).max(2_000),
    start: z.number().int().nonnegative().max(2_000),
    end: z.number().int().positive().max(2_000),
    wordIds: z.array(identifierSchema).min(1).max(200),
    boundingBox: documentBoundingBoxSchema,
    confidence: z.number().min(0).max(1)
  })
  .strict()
  .refine((span) => span.end > span.start, {
    message: 'PlanScan span end must follow its start',
    path: ['end']
  })

export const planScanRelationSchema = z
  .object({
    id: identifierSchema,
    page: z.number().int().positive().max(maximumDocumentPages),
    fromSpanId: identifierSchema,
    toSpanId: identifierSchema,
    type: planScanRelationTypeSchema.exclude(['none']),
    confidence: z.number().min(0).max(1)
  })
  .strict()

export const planScanGroupSchema = z
  .object({
    id: identifierSchema,
    page: z.number().int().positive().max(maximumDocumentPages),
    kind: z.enum(['event', 'reminder']),
    confidence: z.number().min(0).max(1),
    titleSpanId: identifierSchema,
    dateSpanId: identifierSchema,
    timeSpanId: identifierSchema.nullable(),
    locationSpanId: identifierSchema.nullable(),
    descriptionSpanIds: z.array(identifierSchema).max(8),
    recurrenceSpanId: identifierSchema.nullable(),
    evidenceBlockIds: z.array(identifierSchema).min(1).max(20)
  })
  .strict()

export const planScanAnalysisSchema = z
  .object({
    modelId: z.string().trim().min(1).max(200),
    modelVersion: z.string().trim().min(1).max(50),
    architecture: z.string().trim().min(1).max(200),
    parameterCount: z.number().int().positive(),
    quantization: z.string().trim().min(1).max(100),
    documentType: planScanDocumentTypeSchema,
    documentTypeConfidence: z.number().min(0).max(1),
    blockPredictions: z.array(planScanBlockPredictionSchema).max(1_000),
    spans: z.array(planScanSpanSchema).max(2_000),
    relations: z.array(planScanRelationSchema).max(4_000),
    groups: z.array(planScanGroupSchema).max(maximumDocumentDrafts),
    processingDurationMs: z.number().int().nonnegative().max(3_600_000),
    warnings: z.array(z.string().trim().min(1).max(500)).max(20)
  })
  .strict()

export const documentExtractionSchema = z
  .object({
    source: documentSourceSchema,
    pages: z.array(documentPageSchema).min(1).max(maximumDocumentPages),
    planScan: planScanAnalysisSchema.nullable().default(null),
    warnings: z.array(z.string().trim().min(1).max(500)).max(50),
    processingDurationMs: z.number().int().nonnegative().max(3_600_000)
  })
  .strict()
  .superRefine((extraction, context) => {
    const wordCount = extraction.pages.reduce((total, page) => total + page.words.length, 0)
    if (wordCount > maximumDocumentWords) {
      context.addIssue({
        code: 'custom',
        message: 'Document has too many extracted words',
        path: ['pages']
      })
    }
    const characterCount = extraction.pages.reduce(
      (total, page) =>
        total + page.blocks.reduce((pageTotal, block) => pageTotal + block.text.length, 0),
      0
    )
    if (characterCount > maximumDocumentCharacters) {
      context.addIssue({
        code: 'custom',
        message: 'Document has too much extracted text',
        path: ['pages']
      })
    }

    const planScan = extraction.planScan
    if (!planScan) return
    const blocks = new Map(
      extraction.pages.flatMap((page) => page.blocks.map((block) => [block.id, block] as const))
    )
    const words = new Map(
      extraction.pages.flatMap((page) => page.words.map((word) => [word.id, word] as const))
    )
    const spans = new Map(planScan.spans.map((span) => [span.id, span] as const))
    for (const prediction of planScan.blockPredictions) {
      const block = blocks.get(prediction.blockId)
      if (!block || block.page !== prediction.page) {
        context.addIssue({
          code: 'custom',
          message: 'PlanScan prediction references an unknown source block',
          path: ['planScan', 'blockPredictions']
        })
      }
    }
    for (const span of planScan.spans) {
      const block = blocks.get(span.blockId)
      const exactText = block?.text.slice(span.start, span.end)
      if (
        !block ||
        block.page !== span.page ||
        exactText !== span.text ||
        span.wordIds.some((id) => !words.has(id) || !block.wordIds.includes(id))
      ) {
        context.addIssue({
          code: 'custom',
          message: 'PlanScan span is not an exact projection of source evidence',
          path: ['planScan', 'spans']
        })
      }
    }
    for (const relation of planScan.relations) {
      const from = spans.get(relation.fromSpanId)
      const to = spans.get(relation.toSpanId)
      if (!from || !to || from.page !== relation.page || to.page !== relation.page) {
        context.addIssue({
          code: 'custom',
          message: 'PlanScan relation references unknown or cross-page evidence',
          path: ['planScan', 'relations']
        })
      }
    }
    for (const group of planScan.groups) {
      const requiredIds = [group.titleSpanId, group.dateSpanId]
      const optionalIds = [group.timeSpanId, group.locationSpanId, group.recurrenceSpanId].filter(
        (id): id is string => id !== null
      )
      const allSpanIds = [...requiredIds, ...optionalIds, ...group.descriptionSpanIds]
      const groupSpans = allSpanIds.map((id) => spans.get(id))
      if (
        groupSpans.some((span) => !span || span.page !== group.page) ||
        group.evidenceBlockIds.some((id) => !blocks.has(id))
      ) {
        context.addIssue({
          code: 'custom',
          message: 'PlanScan group does not resolve to same-page source evidence',
          path: ['planScan', 'groups']
        })
      }
    }
  })

export const documentFieldEvidenceSchema = z
  .object({
    title: z.array(identifierSchema).min(1).max(16),
    when: z.array(identifierSchema).min(1).max(16),
    location: z.array(identifierSchema).max(16),
    description: z.array(identifierSchema).max(16)
  })
  .strict()

export const documentFieldConfidenceSchema = z
  .object({
    title: z.number().min(0).max(1),
    when: z.number().min(0).max(1),
    location: z.number().min(0).max(1).nullable(),
    description: z.number().min(0).max(1).nullable()
  })
  .strict()

export const documentSkippedItemSchema = z
  .object({
    id: identifierSchema,
    page: z.number().int().positive().max(maximumDocumentPages),
    category: z.enum(['no-fixed-time', 'missing-required-fields']),
    title: z.string().trim().min(1).max(1_000),
    reason: z.string().trim().min(1).max(500),
    sourceText: z.string().trim().min(1).max(10_000),
    evidenceIds: z.array(identifierSchema).min(1).max(32),
    confidence: z.number().min(0).max(1)
  })
  .strict()

export const documentRepairEvidenceRoleSchema = z.enum([
  'title',
  'date',
  'time',
  'location',
  'description',
  'recurrence'
])

export const documentRepairCitationSchema = z
  .object({
    blockId: identifierSchema,
    page: z.number().int().positive().max(maximumDocumentPages),
    role: documentRepairEvidenceRoleSchema,
    text: z.string().trim().min(1).max(2_000),
    start: z.number().int().nonnegative().max(2_000),
    end: z.number().int().positive().max(2_000)
  })
  .strict()
  .refine((citation) => citation.end > citation.start, {
    message: 'Document repair citation end must follow its start',
    path: ['end']
  })

export const documentRepairCandidateSchema = z
  .object({
    id: identifierSchema,
    origin: z.enum(['rules', 'planscan']),
    draftId: identifierSchema,
    kind: z.enum(['event', 'reminder']),
    title: z.string().trim().min(1).max(1_000),
    when: z.string().trim().min(1).max(500),
    location: z.string().trim().max(1_000),
    recurrence: z.string().trim().max(500),
    citations: z.array(documentRepairCitationSchema).min(2).max(24)
  })
  .strict()

export const documentRepairDisagreementSchema = z
  .object({
    id: identifierSchema,
    reason: z.literal('parser-disagreement'),
    activeCandidateId: identifierSchema,
    candidates: z.array(documentRepairCandidateSchema).min(2).max(4)
  })
  .strict()
  .superRefine((disagreement, context) => {
    const candidateIds = new Set(disagreement.candidates.map((candidate) => candidate.id))
    if (candidateIds.size !== disagreement.candidates.length) {
      context.addIssue({
        code: 'custom',
        message: 'Document repair candidate IDs must be unique',
        path: ['candidates']
      })
    }
    if (!candidateIds.has(disagreement.activeCandidateId)) {
      context.addIssue({
        code: 'custom',
        message: 'Active document repair candidate is unknown',
        path: ['activeCandidateId']
      })
    }
  })

export const documentRepairRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    selectionId: identifierSchema,
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    reason: z.literal('parser-disagreement'),
    disagreements: z
      .array(documentRepairDisagreementSchema)
      .min(1)
      .max(maximumDocumentRepairDisagreements)
  })
  .strict()
  .superRefine((request, context) => {
    const disagreementIds = new Set(request.disagreements.map((item) => item.id))
    if (disagreementIds.size !== request.disagreements.length) {
      context.addIssue({
        code: 'custom',
        message: 'Document repair disagreement IDs must be unique',
        path: ['disagreements']
      })
    }
    if (JSON.stringify(request).length > 40_000) {
      context.addIssue({
        code: 'custom',
        message: 'Document repair request exceeds the compact local-model context',
        path: ['disagreements']
      })
    }
  })

export const documentRepairDecisionSchema = z
  .object({
    disagreementId: identifierSchema,
    candidateId: identifierSchema.nullable(),
    citations: z.array(documentRepairCitationSchema).max(24),
    rationale: z.string().trim().min(1).max(500)
  })
  .strict()
  .superRefine((decision, context) => {
    if (decision.candidateId !== null && decision.citations.length < 2) {
      context.addIssue({
        code: 'custom',
        message: 'A repair choice must quote at least two source spans',
        path: ['citations']
      })
    }
    if (decision.candidateId === null && decision.citations.length > 0) {
      context.addIssue({
        code: 'custom',
        message: 'A withheld repair cannot attach candidate evidence',
        path: ['citations']
      })
    }
  })

export const documentRepairModelOutputSchema = z
  .object({
    decisions: z.array(documentRepairDecisionSchema).min(1).max(maximumDocumentRepairDisagreements)
  })
  .strict()

export const documentRepairResponseSchema = documentRepairModelOutputSchema
  .extend({
    modelId: z.literal('qwen3-1.7b-q4'),
    hasMutationAuthority: z.literal(false)
  })
  .strict()

export const documentFallbackBlockSchema = z
  .object({
    id: identifierSchema,
    page: z.number().int().positive().max(maximumDocumentPages),
    text: z.string().trim().min(1).max(700),
    boundingBox: documentBoundingBoxSchema,
    confidence: z.number().min(0).max(1),
    method: documentExtractionMethodSchema,
    claimed: z.boolean()
  })
  .strict()

export const documentFallbackRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    requestId: identifierSchema,
    selectionId: identifierSchema,
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    reason: z.literal('coverage-gap'),
    page: z.number().int().positive().max(maximumDocumentPages),
    blocks: z.array(documentFallbackBlockSchema).min(1).max(maximumDocumentFallbackBlocks)
  })
  .strict()
  .superRefine((request, context) => {
    const ids = new Set(request.blocks.map((block) => block.id))
    if (ids.size !== request.blocks.length) {
      context.addIssue({
        code: 'custom',
        message: 'Document fallback block IDs must be unique',
        path: ['blocks']
      })
    }
    if (request.blocks.some((block) => block.page !== request.page)) {
      context.addIssue({
        code: 'custom',
        message: 'A document fallback window cannot cross pages',
        path: ['blocks']
      })
    }
    if (request.blocks.every((block) => block.claimed)) {
      context.addIssue({
        code: 'custom',
        message: 'A document fallback window needs unclaimed source evidence',
        path: ['blocks']
      })
    }
    if (JSON.stringify(request).length > 14_000) {
      context.addIssue({
        code: 'custom',
        message: 'Document fallback request exceeds the compact local-model context',
        path: ['blocks']
      })
    }
  })

export const documentFallbackGroupSchema = z
  .object({
    titleBlockIds: z.array(identifierSchema).min(1).max(3),
    dateBlockId: identifierSchema,
    timeBlockId: identifierSchema.nullable(),
    locationBlockId: identifierSchema.nullable(),
    recurrenceBlockId: identifierSchema.nullable(),
    descriptionBlockIds: z.array(identifierSchema).max(4)
  })
  .strict()
  .superRefine((group, context) => {
    if (new Set(group.titleBlockIds).size !== group.titleBlockIds.length) {
      context.addIssue({
        code: 'custom',
        message: 'Document fallback title block IDs must be unique',
        path: ['titleBlockIds']
      })
    }
    if (new Set(group.descriptionBlockIds).size !== group.descriptionBlockIds.length) {
      context.addIssue({
        code: 'custom',
        message: 'Document fallback description block IDs must be unique',
        path: ['descriptionBlockIds']
      })
    }
  })

export const documentFallbackModelOutputSchema = z
  .object({
    groups: z.array(documentFallbackGroupSchema).min(1).max(maximumDocumentFallbackGroups)
  })
  .strict()

export const documentFallbackResponseSchema = documentFallbackModelOutputSchema
  .extend({
    requestId: identifierSchema,
    page: z.number().int().positive().max(maximumDocumentPages),
    modelId: z.literal('qwen3-1.7b-q4'),
    hasMutationAuthority: z.literal(false)
  })
  .strict()

export const documentScheduleMetadataSchema = z
  .object({
    courseCode: z.string().trim().min(1).max(80),
    sectionCode: z.string().trim().min(1).max(80).nullable(),
    crn: z.string().trim().min(1).max(80).nullable(),
    creditHours: z.number().min(0).max(100).nullable(),
    component: documentScheduleComponentSchema,
    termStartDate: localDateSchema,
    termEndDate: localDateSchema,
    weekdays: z.array(weekdaySchema).min(1).max(7),
    verification: z.enum(['layout', 'layout-and-planscan', 'fallback-grouping'])
  })
  .strict()

export const documentPlanRecordEvidenceSchema = z
  .object({
    title: z.array(identifierSchema).min(1).max(16),
    date: z.array(identifierSchema).min(1).max(16),
    time: z.array(identifierSchema).max(16),
    timezone: z.array(identifierSchema).max(16),
    location: z.array(identifierSchema).max(16),
    recurrence: z.array(identifierSchema).max(16),
    course: z.array(identifierSchema).max(16),
    description: z.array(identifierSchema).max(16)
  })
  .strict()

export const documentPlanRecordSchema = z
  .object({
    version: z.literal('0.1'),
    kind: z.enum(['event', 'reminder']),
    page: z.number().int().positive().max(maximumDocumentPages),
    title: z.string().trim().min(1).max(1_000),
    description: z.string().max(10_000),
    allDay: z.boolean(),
    startDate: localDateSchema,
    endDate: localDateSchema.nullable(),
    startTime: localTimeSchema.nullable(),
    endTime: localTimeSchema.nullable(),
    timeBasis: z.enum(['all-day', 'source-instant', 'source-range', 'default-duration']),
    timezone: ianaTimeZoneSchema,
    timezoneOrigin: z.enum(['document', 'calendar-default']),
    location: z.string().trim().max(1_000),
    recurrence: recurrenceRuleSchema.nullable(),
    schedule: documentScheduleMetadataSchema.nullable(),
    dateOrigin: z.enum(['absolute-source', 'relative-source']),
    sourceBlockIds: z.array(identifierSchema).min(1).max(32),
    evidence: documentPlanRecordEvidenceSchema
  })
  .strict()
  .superRefine((record, context) => {
    const knownEvidence = new Set(record.sourceBlockIds)
    if (knownEvidence.size !== record.sourceBlockIds.length) {
      context.addIssue({ code: 'custom', message: 'Source block IDs must be unique' })
    }
    for (const [field, ids] of Object.entries(record.evidence)) {
      if (new Set(ids).size !== ids.length) {
        context.addIssue({
          code: 'custom',
          message: `${field} evidence IDs must be unique`,
          path: ['evidence', field]
        })
      }
      if (ids.some((id) => !knownEvidence.has(id))) {
        context.addIssue({
          code: 'custom',
          message: `${field} references evidence outside this plan record`,
          path: ['evidence', field]
        })
      }
    }

    if (record.endDate !== null && record.endDate < record.startDate) {
      context.addIssue({
        code: 'custom',
        message: 'Document plan end date cannot precede its start date',
        path: ['endDate']
      })
    }
    if (
      record.endDate === record.startDate &&
      record.startTime !== null &&
      record.endTime !== null &&
      record.endTime <= record.startTime
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Same-day document plan end time must follow its start time',
        path: ['endTime']
      })
    }
    if (record.allDay) {
      if (record.startTime !== null || record.endTime !== null || record.timeBasis !== 'all-day') {
        context.addIssue({
          code: 'custom',
          message: 'All-day document plans cannot contain clock times',
          path: ['timeBasis']
        })
      }
    } else if (record.startTime === null || record.timeBasis === 'all-day') {
      context.addIssue({
        code: 'custom',
        message: 'Timed document plans require a source-backed start time',
        path: ['startTime']
      })
    } else if (record.evidence.time.length === 0) {
      context.addIssue({
        code: 'custom',
        message: 'Timed document plans require source time evidence',
        path: ['evidence', 'time']
      })
    }
    if (
      record.kind === 'event' &&
      (record.endDate === null || (!record.allDay && record.endTime === null))
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Timed document events require an end date and time',
        path: ['endTime']
      })
    }
    if (record.kind === 'reminder' && (record.endDate !== null || record.endTime !== null)) {
      context.addIssue({
        code: 'custom',
        message: 'Document reminders cannot contain an event end',
        path: ['endTime']
      })
    }
    if (record.kind === 'reminder' && record.allDay) {
      context.addIssue({
        code: 'custom',
        message: 'Imported reminders require an explicit source time',
        path: ['startTime']
      })
    }
    if (record.kind === 'event' && record.timeBasis === 'source-instant') {
      context.addIssue({
        code: 'custom',
        message: 'Document events cannot use reminder-only instant timing',
        path: ['timeBasis']
      })
    }
    if (
      record.kind === 'reminder' &&
      record.timeBasis !== 'source-instant' &&
      record.timeBasis !== 'all-day'
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Document reminders cannot use an event duration',
        path: ['timeBasis']
      })
    }
    if (record.location && record.evidence.location.length === 0) {
      context.addIssue({
        code: 'custom',
        message: 'Document locations require source evidence',
        path: ['evidence', 'location']
      })
    }
    if (record.description && record.evidence.description.length === 0) {
      context.addIssue({
        code: 'custom',
        message: 'Document descriptions require source evidence',
        path: ['evidence', 'description']
      })
    }
    if (record.timezoneOrigin === 'document' && record.evidence.timezone.length === 0) {
      context.addIssue({
        code: 'custom',
        message: 'Document timezones require source evidence',
        path: ['evidence', 'timezone']
      })
    }
    if (record.recurrence && record.evidence.recurrence.length === 0) {
      context.addIssue({
        code: 'custom',
        message: 'Document recurrence requires source evidence',
        path: ['evidence', 'recurrence']
      })
    }
    if (record.recurrence?.end.kind === 'until' && record.recurrence.end.date < record.startDate) {
      context.addIssue({
        code: 'custom',
        message: 'Document recurrence cannot end before its first occurrence',
        path: ['recurrence', 'end']
      })
    }

    const schedule = record.schedule
    if (!schedule) return
    if (record.kind !== 'event') {
      context.addIssue({
        code: 'custom',
        message: 'Course schedules must compile to calendar events',
        path: ['kind']
      })
    }
    if (record.evidence.course.length === 0) {
      context.addIssue({
        code: 'custom',
        message: 'Course identity requires source evidence',
        path: ['evidence', 'course']
      })
    }
    if (schedule.termEndDate < schedule.termStartDate) {
      context.addIssue({
        code: 'custom',
        message: 'Schedule term end cannot precede its start',
        path: ['schedule', 'termEndDate']
      })
    }
    if (new Set(schedule.weekdays).size !== schedule.weekdays.length) {
      context.addIssue({
        code: 'custom',
        message: 'Schedule weekdays must be unique',
        path: ['schedule', 'weekdays']
      })
    }
    if (record.startDate < schedule.termStartDate || record.startDate > schedule.termEndDate) {
      context.addIssue({
        code: 'custom',
        message: 'First occurrence falls outside the source term bounds',
        path: ['startDate']
      })
    }
    if (record.endDate !== null && record.endDate > schedule.termEndDate) {
      context.addIssue({
        code: 'custom',
        message: 'Occurrence end falls outside the source term bounds',
        path: ['endDate']
      })
    }
    if (
      !record.recurrence ||
      record.recurrence.frequency !== 'weekly' ||
      record.recurrence.interval !== 1 ||
      record.recurrence.byMonthDay.length !== 0 ||
      new Set(record.recurrence.byWeekday).size !== record.recurrence.byWeekday.length ||
      record.recurrence.end.kind !== 'until' ||
      record.recurrence.end.date !== schedule.termEndDate ||
      record.recurrence.byWeekday.length !== schedule.weekdays.length ||
      schedule.weekdays.some((weekday) => !record.recurrence?.byWeekday.includes(weekday))
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Course schedule recurrence must exactly match its source term and weekdays',
        path: ['recurrence']
      })
    }
  })

const documentDraftBaseShape = {
  id: identifierSchema,
  page: z.number().int().positive().max(maximumDocumentPages),
  confidence: z.number().min(0).max(1),
  attention: z.enum(['ready', 'check-evidence']),
  sourceText: z.string().trim().min(1).max(10_000),
  proposal: calendarIRDraftSchema,
  resolved: calendarIRResolvedSchema,
  semanticRecord: documentPlanRecordSchema,
  importIdentity: documentImportIdentitySchema,
  reconciliation: documentReconciliationSchema,
  schedule: documentScheduleMetadataSchema.nullable(),
  fieldEvidence: documentFieldEvidenceSchema,
  fieldConfidence: documentFieldConfidenceSchema,
  warnings: z.array(z.string().trim().min(1).max(500)).max(20)
} as const

export const documentImportDraftSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        ...documentDraftBaseShape,
        kind: z.literal('event'),
        form: eventFormSchema.refine(
          (form) => form.id === null,
          'Imported drafts must create events'
        )
      })
      .strict(),
    z
      .object({
        ...documentDraftBaseShape,
        kind: z.literal('reminder'),
        form: reminderFormSchema.refine(
          (form) => form.id === null,
          'Imported drafts must create reminders'
        )
      })
      .strict()
  ])
  .superRefine((draft, context) => {
    const expectedOperation = draft.kind === 'event' ? 'event.create' : 'reminder.create'
    if (
      draft.proposal.operation !== expectedOperation ||
      draft.resolved.operation !== expectedOperation
    ) {
      context.addIssue({
        code: 'custom',
        message: `Document ${draft.kind} draft has an incompatible operation`,
        path: ['proposal', 'operation']
      })
    }
  })

export const documentRepairAlternativeSchema = z
  .object({
    candidateId: identifierSchema,
    draft: documentImportDraftSchema
  })
  .strict()

export const documentRepairSessionSchema = z
  .object({
    request: documentRepairRequestSchema,
    alternatives: z
      .array(documentRepairAlternativeSchema)
      .min(2)
      .max(maximumDocumentRepairDisagreements * 4)
  })
  .strict()

export const documentAnalysisSchema = z
  .object({
    selectionId: identifierSchema,
    extraction: documentExtractionSchema,
    drafts: z.array(documentImportDraftSchema).max(maximumDocumentDrafts),
    repairSession: documentRepairSessionSchema.nullable().default(null),
    skippedItems: z.array(documentSkippedItemSchema).max(maximumDocumentDrafts * 2),
    skippedCandidateCount: z.number().int().nonnegative(),
    duplicateCandidateCount: z.number().int().nonnegative(),
    existingCalendarDuplicateCount: z.number().int().nonnegative(),
    likelyDuplicateCount: z.number().int().nonnegative(),
    protectedDistinctCount: z.number().int().nonnegative(),
    plannerWarnings: z.array(z.string().trim().min(1).max(500)).max(50)
  })
  .strict()
  .superRefine((analysis, context) => {
    const knownBlocks = new Set(
      analysis.extraction.pages.flatMap((page) => page.blocks.map((block) => block.id))
    )
    const blocks = new Map(
      analysis.extraction.pages.flatMap((page) =>
        page.blocks.map((block) => [block.id, block] as const)
      )
    )
    if (analysis.repairSession) {
      const { request, alternatives } = analysis.repairSession
      if (
        request.selectionId !== analysis.selectionId ||
        request.sourceSha256 !== analysis.extraction.source.sha256
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Document repair session does not belong to this source',
          path: ['repairSession', 'request']
        })
      }
      const alternativesById = new Map(
        alternatives.map((alternative) => [alternative.candidateId, alternative] as const)
      )
      const candidates = request.disagreements.flatMap((item) => item.candidates)
      if (
        alternativesById.size !== alternatives.length ||
        candidates.some((candidate) => {
          const alternative = alternativesById.get(candidate.id)
          return (
            !alternative ||
            alternative.draft.id !== candidate.draftId ||
            alternative.draft.kind !== candidate.kind ||
            alternative.draft.importIdentity.sourceSha256 !== request.sourceSha256
          )
        })
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Document repair candidates do not resolve to local draft alternatives',
          path: ['repairSession', 'alternatives']
        })
      }
      for (const [disagreementIndex, disagreement] of request.disagreements.entries()) {
        for (const [candidateIndex, candidate] of disagreement.candidates.entries()) {
          for (const [citationIndex, citation] of candidate.citations.entries()) {
            const block = blocks.get(citation.blockId)
            if (
              !block ||
              block.page !== citation.page ||
              block.text.slice(citation.start, citation.end) !== citation.text
            ) {
              context.addIssue({
                code: 'custom',
                message: 'Document repair citation is not an exact source projection',
                path: [
                  'repairSession',
                  'request',
                  'disagreements',
                  disagreementIndex,
                  'candidates',
                  candidateIndex,
                  'citations',
                  citationIndex
                ]
              })
            }
          }
        }
      }
    }
    for (const [index, item] of analysis.skippedItems.entries()) {
      if (new Set(item.evidenceIds).size !== item.evidenceIds.length) {
        context.addIssue({
          code: 'custom',
          message: 'Skipped item evidence IDs must be unique',
          path: ['skippedItems', index, 'evidenceIds']
        })
      }
      if (item.evidenceIds.some((id) => !knownBlocks.has(id))) {
        context.addIssue({
          code: 'custom',
          message: 'Skipped item evidence must resolve to this document',
          path: ['skippedItems', index, 'evidenceIds']
        })
      }
    }
    for (const [index, draft] of analysis.drafts.entries()) {
      if (draft.importIdentity.sourceSha256 !== analysis.extraction.source.sha256) {
        context.addIssue({
          code: 'custom',
          message: 'Document draft identity does not belong to this source',
          path: ['drafts', index, 'importIdentity', 'sourceSha256']
        })
      }
      if ((draft.schedule !== null) !== (draft.importIdentity.semanticKind === 'class-event')) {
        context.addIssue({
          code: 'custom',
          message: 'Document draft schedule does not match its semantic identity kind',
          path: ['drafts', index, 'importIdentity', 'semanticKind']
        })
      }
    }
  })

export const documentProgressEventSchema = z
  .object({
    stage: z.enum([
      'validating',
      'extracting-native',
      'rendering',
      'loading-ocr',
      'recognizing',
      'planning',
      'complete',
      'cancelled'
    ]),
    progress: z.number().min(0).max(1),
    message: z.string().trim().min(1).max(500),
    currentPage: z.number().int().positive().max(maximumDocumentPages).nullable(),
    totalPages: z.number().int().positive().max(maximumDocumentPages).nullable()
  })
  .strict()

const documentArrayBufferSchema = z.custom<ArrayBuffer>(
  (value) => typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer,
  'Expected document bytes as an ArrayBuffer'
)

export const documentSelectionSchema = z
  .object({
    source: documentSourceSchema,
    bytes: documentArrayBufferSchema
  })
  .strict()
  .superRefine((selection, context) => {
    if (selection.bytes.byteLength !== selection.source.byteLength) {
      context.addIssue({ code: 'custom', message: 'Document byte length changed', path: ['bytes'] })
    }
  })

export const documentSelectRequestSchema = z.object({}).strict()
export const documentSelectResponseSchema = z
  .object({
    cancelled: z.boolean(),
    selection: documentSelectionSchema.nullable()
  })
  .strict()
  .superRefine((response, context) => {
    if (response.cancelled === (response.selection !== null)) {
      context.addIssue({
        code: 'custom',
        message: 'Cancelled document selections cannot contain bytes',
        path: ['selection']
      })
    }
  })

export const reviewedDocumentItemSchema = z.discriminatedUnion('kind', [
  z
    .object({
      draftId: identifierSchema,
      kind: z.literal('event'),
      sourceIdentity: documentImportSourceIdentitySchema,
      schedule: documentScheduleMetadataSchema.nullable(),
      form: eventFormSchema.refine((form) => form.id === null, 'Imports cannot overwrite events')
    })
    .strict(),
  z
    .object({
      draftId: identifierSchema,
      kind: z.literal('reminder'),
      sourceIdentity: documentImportSourceIdentitySchema,
      schedule: z.null(),
      form: reminderFormSchema.refine(
        (form) => form.id === null,
        'Imports cannot overwrite reminders'
      )
    })
    .strict()
])

export const documentCommitRequestSchema = z
  .object({
    selectionId: identifierSchema,
    items: z.array(reviewedDocumentItemSchema).min(1).max(maximumDocumentDrafts),
    range: calendarSnapshotRequestSchema
  })
  .strict()
  .superRefine((request, context) => {
    const ids = new Set(request.items.map((item) => item.draftId))
    if (ids.size !== request.items.length) {
      context.addIssue({
        code: 'custom',
        message: 'Reviewed draft IDs must be unique',
        path: ['items']
      })
    }
    const sourceRows = new Set(
      request.items.map(
        (item) => `${item.sourceIdentity.sourceSha256}:${item.sourceIdentity.sourceRowId}`
      )
    )
    if (sourceRows.size !== request.items.length) {
      context.addIssue({
        code: 'custom',
        message: 'Reviewed document source rows must be unique',
        path: ['items']
      })
    }
  })

export const documentCommitResponseSchema = calendarMutationResultSchema
export const documentDiscardRequestSchema = z.object({ selectionId: identifierSchema }).strict()
export const documentDiscardResponseSchema = z.object({ discarded: z.boolean() }).strict()

export type DocumentSourceKind = z.infer<typeof documentSourceKindSchema>
export type DocumentExtractionMethod = z.infer<typeof documentExtractionMethodSchema>
export type DocumentBoundingBox = z.infer<typeof documentBoundingBoxSchema>
export type PlanScanBlockRole = z.infer<typeof planScanBlockRoleSchema>
export type PlanScanEntityRole = z.infer<typeof planScanEntityRoleSchema>
export type PlanScanRelationType = z.infer<typeof planScanRelationTypeSchema>
export type PlanScanDocumentType = z.infer<typeof planScanDocumentTypeSchema>
export type PlanScanBlockPrediction = z.infer<typeof planScanBlockPredictionSchema>
export type PlanScanSpan = z.infer<typeof planScanSpanSchema>
export type PlanScanRelation = z.infer<typeof planScanRelationSchema>
export type PlanScanGroup = z.infer<typeof planScanGroupSchema>
export type PlanScanAnalysis = z.infer<typeof planScanAnalysisSchema>
export type DocumentSource = z.infer<typeof documentSourceSchema>
export type DocumentWord = z.infer<typeof documentWordSchema>
export type DocumentTextBlock = z.infer<typeof documentTextBlockSchema>
export type DocumentPage = z.infer<typeof documentPageSchema>
export type DocumentExtraction = z.infer<typeof documentExtractionSchema>
export type DocumentFieldEvidence = z.infer<typeof documentFieldEvidenceSchema>
export type DocumentFieldConfidence = z.infer<typeof documentFieldConfidenceSchema>
export type DocumentSkippedItem = z.infer<typeof documentSkippedItemSchema>
export type DocumentScheduleMetadata = z.infer<typeof documentScheduleMetadataSchema>
export type DocumentPlanRecordEvidence = z.infer<typeof documentPlanRecordEvidenceSchema>
export type DocumentPlanRecord = z.infer<typeof documentPlanRecordSchema>
export type DocumentImportDraft = z.infer<typeof documentImportDraftSchema>
export type DocumentRepairCitation = z.infer<typeof documentRepairCitationSchema>
export type DocumentRepairCandidate = z.infer<typeof documentRepairCandidateSchema>
export type DocumentRepairDisagreement = z.infer<typeof documentRepairDisagreementSchema>
export type DocumentRepairRequest = z.infer<typeof documentRepairRequestSchema>
export type DocumentRepairDecision = z.infer<typeof documentRepairDecisionSchema>
export type DocumentRepairModelOutput = z.infer<typeof documentRepairModelOutputSchema>
export type DocumentRepairResponse = z.infer<typeof documentRepairResponseSchema>
export type DocumentRepairSession = z.infer<typeof documentRepairSessionSchema>
export type DocumentFallbackBlock = z.infer<typeof documentFallbackBlockSchema>
export type DocumentFallbackRequest = z.infer<typeof documentFallbackRequestSchema>
export type DocumentFallbackGroup = z.infer<typeof documentFallbackGroupSchema>
export type DocumentFallbackModelOutput = z.infer<typeof documentFallbackModelOutputSchema>
export type DocumentFallbackResponse = z.infer<typeof documentFallbackResponseSchema>
export type DocumentAnalysis = z.infer<typeof documentAnalysisSchema>
export type DocumentProgressEvent = z.infer<typeof documentProgressEventSchema>
export type DocumentSelection = z.infer<typeof documentSelectionSchema>
export type ReviewedDocumentItem = z.infer<typeof reviewedDocumentItemSchema>
export type DocumentCommitRequest = z.infer<typeof documentCommitRequestSchema>
