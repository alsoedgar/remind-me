import { z } from 'zod'
import { calendarOperationSchema } from './calendar-ir'
import { identifierSchema, isoInstantSchema } from './common'

const assistantReadOperationSchema = calendarOperationSchema.extract([
  'calendar.list',
  'calendar.search',
  'calendar.availability',
  'calendar.conflicts'
])

export const assistantDialogueRangeSchema = z
  .object({
    rangeStartUtc: isoInstantSchema,
    rangeEndUtc: isoInstantSchema,
    timezone: z.string().trim().min(1).max(100)
  })
  .strict()
  .superRefine((range, context) => {
    if (Date.parse(range.rangeEndUtc) <= Date.parse(range.rangeStartUtc)) {
      context.addIssue({
        code: 'custom',
        message: 'Dialogue range end must be after its start',
        path: ['rangeEndUtc']
      })
    }
  })

export const assistantDialogueQuerySchema = z
  .object({
    requestId: identifierSchema,
    operation: assistantReadOperationSchema,
    sourceText: z.string().trim().min(1).max(50_000),
    rangeStartUtc: isoInstantSchema,
    rangeEndUtc: isoInstantSchema,
    queryText: z.string().trim().min(1).max(1_000).nullable(),
    answeredAt: isoInstantSchema
  })
  .strict()
  .superRefine((query, context) => {
    if (Date.parse(query.rangeEndUtc) <= Date.parse(query.rangeStartUtc)) {
      context.addIssue({
        code: 'custom',
        message: 'Dialogue query range end must be after its start',
        path: ['rangeEndUtc']
      })
    }
  })

export const assistantPendingClarificationSchema = z
  .object({
    requestId: identifierSchema,
    sourceText: z.string().trim().min(1).max(50_000),
    code: z.enum([
      'missing-date',
      'missing-time',
      'multiple-targets',
      'unclear-reference',
      'unclear-scope',
      'timezone-conflict',
      'calendar-conflict',
      'unsupported-expression'
    ]),
    message: z.string().trim().min(1).max(500),
    options: z.array(z.string().trim().min(1).max(500)).max(10),
    createdAt: isoInstantSchema
  })
  .strict()

export const assistantRequestedFieldSchema = z.enum([
  'name',
  'time',
  'start',
  'end',
  'date',
  'location',
  'duration',
  'notes',
  'recurrence',
  'details'
])

export const assistantQueryFrameItemSchema = z
  .object({
    kind: z.enum(['event', 'reminder']),
    id: identifierSchema,
    // Legacy v1 state did not retain occurrence identity. New frames always write it.
    occurrenceStart: isoInstantSchema.nullable()
  })
  .strict()

function frameItemKey(item: z.infer<typeof assistantQueryFrameItemSchema>): string {
  return `${item.kind}:${item.id}:${item.occurrenceStart ?? ''}`
}

export const assistantQueryFrameSchema = z
  .object({
    frameId: identifierSchema,
    operation: assistantReadOperationSchema,
    range: assistantDialogueRangeSchema,
    orderedItems: z.array(assistantQueryFrameItemSchema).max(200),
    selectedItems: z.array(assistantQueryFrameItemSchema).max(200),
    requestedFields: z.array(assistantRequestedFieldSchema).max(10),
    resultCursor: z.number().int().nonnegative().nullable(),
    // Index of the next selected item that has not been presented. The default
    // keeps dialogue payloads written by the first v2 implementation readable.
    continuationCursor: z.number().int().positive().max(199).nullable().default(null),
    createdAt: isoInstantSchema
  })
  .strict()
  .superRefine((frame, context) => {
    const orderedKeys = frame.orderedItems.map(frameItemKey)
    const selectedKeys = frame.selectedItems.map(frameItemKey)
    if (new Set(orderedKeys).size !== orderedKeys.length) {
      context.addIssue({
        code: 'custom',
        message: 'orderedItems must be unique by item occurrence',
        path: ['orderedItems']
      })
    }
    if (new Set(selectedKeys).size !== selectedKeys.length) {
      context.addIssue({
        code: 'custom',
        message: 'selectedItems must be unique by item occurrence',
        path: ['selectedItems']
      })
    }
    const ordered = new Set(orderedKeys)
    if (selectedKeys.some((key) => !ordered.has(key))) {
      context.addIssue({
        code: 'custom',
        message: 'selectedItems must belong to orderedItems',
        path: ['selectedItems']
      })
    }
    if (new Set(frame.requestedFields).size !== frame.requestedFields.length) {
      context.addIssue({
        code: 'custom',
        message: 'requestedFields must be unique',
        path: ['requestedFields']
      })
    }
    if (frame.resultCursor !== null && frame.resultCursor >= frame.orderedItems.length) {
      context.addIssue({
        code: 'custom',
        message: 'resultCursor must point to an ordered item',
        path: ['resultCursor']
      })
    }
    if (
      frame.continuationCursor !== null &&
      frame.continuationCursor >= frame.selectedItems.length
    ) {
      context.addIssue({
        code: 'custom',
        message: 'continuationCursor must point to the next selected item',
        path: ['continuationCursor']
      })
    }
  })

const assistantDialogueCollectionsSchema = {
  focusedEventIds: z.array(identifierSchema).max(100),
  focusedReminderIds: z.array(identifierSchema).max(100),
  lastResultEventIds: z.array(identifierSchema).max(100),
  lastResultReminderIds: z.array(identifierSchema).max(100),
  lastQuery: assistantDialogueQuerySchema.nullable(),
  activeRange: assistantDialogueRangeSchema.nullable(),
  pendingClarification: assistantPendingClarificationSchema.nullable(),
  updatedAt: isoInstantSchema
} as const

function validateUniqueIdCollections(
  state: {
    focusedEventIds: readonly string[]
    focusedReminderIds: readonly string[]
    lastResultEventIds: readonly string[]
    lastResultReminderIds: readonly string[]
  },
  context: z.RefinementCtx
): void {
  const collections = [
    ['focusedEventIds', state.focusedEventIds],
    ['focusedReminderIds', state.focusedReminderIds],
    ['lastResultEventIds', state.lastResultEventIds],
    ['lastResultReminderIds', state.lastResultReminderIds]
  ] as const
  for (const [field, ids] of collections) {
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: 'custom', message: `${field} must be unique`, path: [field] })
    }
  }
}

/** Read-only compatibility schema for dialogue payloads written before query frames. */
export const assistantDialogueStateV1Schema = z
  .object({
    version: z.literal(1),
    ...assistantDialogueCollectionsSchema
  })
  .strict()
  .superRefine(validateUniqueIdCollections)

export const assistantDialogueStateSchema = z
  .object({
    version: z.literal(2),
    ...assistantDialogueCollectionsSchema,
    queryFrames: z.array(assistantQueryFrameSchema).max(12),
    activeQueryFrameId: identifierSchema.nullable()
  })
  .strict()
  .superRefine((state, context) => {
    validateUniqueIdCollections(state, context)
    const frameIds = state.queryFrames.map((frame) => frame.frameId)
    if (new Set(frameIds).size !== frameIds.length) {
      context.addIssue({
        code: 'custom',
        message: 'query frame IDs must be unique',
        path: ['queryFrames']
      })
    }
    if (state.activeQueryFrameId !== null && !frameIds.includes(state.activeQueryFrameId)) {
      context.addIssue({
        code: 'custom',
        message: 'activeQueryFrameId must refer to a retained query frame',
        path: ['activeQueryFrameId']
      })
    }
  })

export function emptyAssistantDialogueState(updatedAt: string): AssistantDialogueState {
  return assistantDialogueStateSchema.parse({
    version: 2,
    focusedEventIds: [],
    focusedReminderIds: [],
    lastResultEventIds: [],
    lastResultReminderIds: [],
    lastQuery: null,
    activeRange: null,
    pendingClarification: null,
    queryFrames: [],
    activeQueryFrameId: null,
    updatedAt
  })
}

/** Upgrades persisted dialogue JSON without resetting conversations or calendar data. */
export function upgradeAssistantDialogueState(
  input: unknown,
  migratedAt = new Date().toISOString()
): AssistantDialogueState {
  const current = assistantDialogueStateSchema.safeParse(input)
  if (current.success) return current.data

  const legacy = assistantDialogueStateV1Schema.parse(input)
  const range = legacy.lastQuery
    ? {
        rangeStartUtc: legacy.lastQuery.rangeStartUtc,
        rangeEndUtc: legacy.lastQuery.rangeEndUtc,
        timezone: legacy.activeRange?.timezone ?? 'UTC'
      }
    : legacy.activeRange
  const resultItems = [
    ...legacy.lastResultEventIds.map((id) => ({
      kind: 'event' as const,
      id,
      occurrenceStart: null
    })),
    ...legacy.lastResultReminderIds.map((id) => ({
      kind: 'reminder' as const,
      id,
      occurrenceStart: null
    }))
  ]
  const fallbackItems = [
    ...legacy.focusedEventIds.map((id) => ({
      kind: 'event' as const,
      id,
      occurrenceStart: null
    })),
    ...legacy.focusedReminderIds.map((id) => ({
      kind: 'reminder' as const,
      id,
      occurrenceStart: null
    }))
  ]
  const orderedItems = resultItems.length > 0 ? resultItems : fallbackItems
  const orderedKeys = new Set(orderedItems.map(frameItemKey))
  const focusedItems = fallbackItems.filter((item) => orderedKeys.has(frameItemKey(item)))
  const selectedItems = focusedItems.length > 0 ? focusedItems : orderedItems
  const canCreateFrame = range !== null && range !== undefined && legacy.lastQuery !== null
  const frame = canCreateFrame
    ? assistantQueryFrameSchema.parse({
        frameId: `frame:${legacy.lastQuery?.requestId ?? 'legacy'}`,
        operation: legacy.lastQuery?.operation ?? 'calendar.list',
        range,
        orderedItems,
        selectedItems,
        requestedFields: [],
        resultCursor: null,
        continuationCursor: null,
        createdAt: legacy.lastQuery?.answeredAt ?? migratedAt
      })
    : null

  return assistantDialogueStateSchema.parse({
    ...legacy,
    version: 2,
    queryFrames: frame ? [frame] : [],
    activeQueryFrameId: frame?.frameId ?? null,
    updatedAt: migratedAt
  })
}

export type AssistantDialogueRange = z.infer<typeof assistantDialogueRangeSchema>
export type AssistantDialogueQuery = z.infer<typeof assistantDialogueQuerySchema>
export type AssistantPendingClarification = z.infer<typeof assistantPendingClarificationSchema>
export type AssistantRequestedField = z.infer<typeof assistantRequestedFieldSchema>
export type AssistantQueryFrameItem = z.infer<typeof assistantQueryFrameItemSchema>
export type AssistantQueryFrame = z.infer<typeof assistantQueryFrameSchema>
export type AssistantDialogueStateV1 = z.infer<typeof assistantDialogueStateV1Schema>
export type AssistantDialogueState = z.infer<typeof assistantDialogueStateSchema>
