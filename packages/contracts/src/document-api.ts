import { z } from 'zod'
import { calendarIRDraftSchema, calendarIRResolvedSchema } from './calendar-ir'
import {
  calendarMutationResultSchema,
  calendarSnapshotRequestSchema,
  eventFormSchema,
  reminderFormSchema
} from './calendar-api'
import { identifierSchema, localDateSchema } from './common'
import { weekdaySchema } from './recurrence'

export const maximumDocumentBytes = 25 * 1024 * 1024
export const maximumDocumentPages = 20
export const maximumDocumentImagePixels = 25_000_000
export const maximumDocumentWords = 12_000
export const maximumDocumentCharacters = 200_000
export const maximumDocumentDrafts = 50

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

export const documentScheduleMetadataSchema = z
  .object({
    courseCode: z.string().trim().min(1).max(80),
    sectionCode: z.string().trim().min(1).max(80).nullable(),
    crn: z.string().trim().min(1).max(80).nullable(),
    creditHours: z.number().min(0).max(100).nullable(),
    component: z.enum([
      'lecture',
      'lecture-discussion',
      'laboratory',
      'laboratory-discussion',
      'discussion',
      'seminar',
      'studio',
      'clinical',
      'practicum',
      'primary-section',
      'linked-section',
      'class-meeting'
    ]),
    termStartDate: localDateSchema,
    termEndDate: localDateSchema,
    weekdays: z.array(weekdaySchema).min(1).max(7),
    verification: z.enum(['layout', 'layout-and-planscan'])
  })
  .strict()

const documentDraftBaseShape = {
  id: identifierSchema,
  page: z.number().int().positive().max(maximumDocumentPages),
  confidence: z.number().min(0).max(1),
  attention: z.enum(['ready', 'check-evidence']),
  sourceText: z.string().trim().min(1).max(10_000),
  proposal: calendarIRDraftSchema,
  resolved: calendarIRResolvedSchema,
  schedule: documentScheduleMetadataSchema.nullable(),
  fieldEvidence: documentFieldEvidenceSchema,
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

export const documentAnalysisSchema = z
  .object({
    selectionId: identifierSchema,
    extraction: documentExtractionSchema,
    drafts: z.array(documentImportDraftSchema).max(maximumDocumentDrafts),
    skippedCandidateCount: z.number().int().nonnegative(),
    duplicateCandidateCount: z.number().int().nonnegative(),
    existingCalendarDuplicateCount: z.number().int().nonnegative(),
    plannerWarnings: z.array(z.string().trim().min(1).max(500)).max(50)
  })
  .strict()

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
      form: eventFormSchema.refine((form) => form.id === null, 'Imports cannot overwrite events')
    })
    .strict(),
  z
    .object({
      draftId: identifierSchema,
      kind: z.literal('reminder'),
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
export type DocumentScheduleMetadata = z.infer<typeof documentScheduleMetadataSchema>
export type DocumentImportDraft = z.infer<typeof documentImportDraftSchema>
export type DocumentAnalysis = z.infer<typeof documentAnalysisSchema>
export type DocumentProgressEvent = z.infer<typeof documentProgressEventSchema>
export type DocumentSelection = z.infer<typeof documentSelectionSchema>
export type ReviewedDocumentItem = z.infer<typeof reviewedDocumentItemSchema>
export type DocumentCommitRequest = z.infer<typeof documentCommitRequestSchema>
