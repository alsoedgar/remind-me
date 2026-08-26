import { z } from 'zod'
import { calendarOperationSchema } from './calendar-ir'
import { identifierSchema, isoInstantSchema } from './common'

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
    operation: calendarOperationSchema.extract([
      'calendar.list',
      'calendar.search',
      'calendar.availability',
      'calendar.conflicts'
    ]),
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

export const assistantDialogueStateSchema = z
  .object({
    version: z.literal(1),
    focusedEventIds: z.array(identifierSchema).max(100),
    focusedReminderIds: z.array(identifierSchema).max(100),
    lastResultEventIds: z.array(identifierSchema).max(100),
    lastResultReminderIds: z.array(identifierSchema).max(100),
    lastQuery: assistantDialogueQuerySchema.nullable(),
    activeRange: assistantDialogueRangeSchema.nullable(),
    pendingClarification: assistantPendingClarificationSchema.nullable(),
    updatedAt: isoInstantSchema
  })
  .strict()
  .superRefine((state, context) => {
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
  })

export function emptyAssistantDialogueState(updatedAt: string): AssistantDialogueState {
  return assistantDialogueStateSchema.parse({
    version: 1,
    focusedEventIds: [],
    focusedReminderIds: [],
    lastResultEventIds: [],
    lastResultReminderIds: [],
    lastQuery: null,
    activeRange: null,
    pendingClarification: null,
    updatedAt
  })
}

export type AssistantDialogueRange = z.infer<typeof assistantDialogueRangeSchema>
export type AssistantDialogueQuery = z.infer<typeof assistantDialogueQuerySchema>
export type AssistantPendingClarification = z.infer<typeof assistantPendingClarificationSchema>
export type AssistantDialogueState = z.infer<typeof assistantDialogueStateSchema>
