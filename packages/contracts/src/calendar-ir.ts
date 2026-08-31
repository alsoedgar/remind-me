import { z } from 'zod'
import {
  contractVersionSchema,
  identifierSchema,
  ianaTimeZoneSchema,
  isoInstantSchema,
  localDateSchema,
  localTimeSchema,
  sourceSpanSchema
} from './common'
import { recurrenceRuleSchema, weekdaySchema } from './recurrence'

export const calendarOperationSchema = z.enum([
  'event.create',
  'event.duplicate',
  'event.update',
  'event.move',
  'event.delete',
  'reminder.create',
  'reminder.update',
  'reminder.complete',
  'reminder.delete',
  'calendar.list',
  'calendar.search',
  'calendar.availability',
  'calendar.conflicts',
  'assistant.clarify',
  'assistant.reject',
  'assistant.unsupported',
  'import.propose'
])

export const actionScopeSchema = z.enum(['single', 'occurrence', 'future', 'series'])
export const riskLevelSchema = z.enum(['read', 'low', 'medium', 'high', 'destructive'])

export const evidenceSchema = z
  .object({
    id: identifierSchema,
    sourceKind: z.enum(['text', 'voice', 'image', 'pdf', 'calendar', 'dialogue']),
    sourceId: identifierSchema.nullable(),
    page: z.number().int().positive().nullable(),
    boundingBox: z
      .object({
        x: z.number().min(0).max(1),
        y: z.number().min(0).max(1),
        width: z.number().positive().max(1),
        height: z.number().positive().max(1)
      })
      .strict()
      .nullable(),
    text: z.string().max(2_000),
    sourceSpan: sourceSpanSchema.nullable()
  })
  .strict()

export const sourcedTextSchema = z
  .object({
    value: z.string().min(1).max(1_000),
    sourceSpan: sourceSpanSchema.nullable(),
    evidenceIds: z.array(identifierSchema).max(32)
  })
  .strict()

export const sourcedNumberSchema = z
  .object({
    value: z.number().finite(),
    sourceSpan: sourceSpanSchema.nullable(),
    evidenceIds: z.array(identifierSchema).max(32)
  })
  .strict()

export const temporalAnchorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('absolute'), date: localDateSchema }).strict(),
  z
    .object({ kind: z.literal('relative-day'), offset: z.number().int().min(-3_650).max(3_650) })
    .strict(),
  z
    .object({
      kind: z.literal('weekday'),
      weekday: weekdaySchema,
      relation: z.enum(['this', 'next'])
    })
    .strict(),
  z.object({ kind: z.literal('verbatim'), text: z.string().min(1).max(200) }).strict()
])

export const temporalPointSchema = z
  .object({
    date: temporalAnchorSchema,
    time: localTimeSchema.nullable()
  })
  .strict()

export const temporalWindowSchema = z
  .object({
    start: temporalPointSchema,
    end: temporalPointSchema.nullable(),
    allDay: z.boolean(),
    timezone: ianaTimeZoneSchema.nullable()
  })
  .strict()
  .superRefine((window, context) => {
    if (!window.allDay && window.start.time === null) {
      context.addIssue({
        code: 'custom',
        message: 'Timed windows require a start time',
        path: ['start', 'time']
      })
    }
  })

export const sourcedTemporalWindowSchema = z
  .object({
    value: temporalWindowSchema,
    sourceSpan: sourceSpanSchema.nullable(),
    evidenceIds: z.array(identifierSchema).max(32)
  })
  .strict()

export const calendarSelectionSchema = z
  .object({
    eventIds: z.array(identifierSchema).max(100),
    reminderIds: z.array(identifierSchema).max(100),
    query: sourcedTextSchema.nullable()
  })
  .strict()

export const calendarIRFieldsSchema = z
  .object({
    title: sourcedTextSchema.nullable(),
    description: sourcedTextSchema.nullable(),
    location: sourcedTextSchema.nullable(),
    when: sourcedTemporalWindowSchema.nullable(),
    reminderOffsetMinutes: sourcedNumberSchema.nullable(),
    status: z.enum(['active', 'completed', 'cancelled']).nullable()
  })
  .strict()

export const referenceSchema = z
  .object({
    kind: z.enum(['event', 'reminder', 'calendar', 'turn']),
    text: z.string().min(1).max(500),
    candidateIds: z.array(identifierSchema).max(20),
    sourceSpan: sourceSpanSchema.nullable()
  })
  .strict()

export const ambiguitySchema = z
  .object({
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
    message: z.string().min(1).max(500),
    options: z.array(z.string().min(1).max(500)).max(10),
    sourceSpan: sourceSpanSchema.nullable()
  })
  .strict()

const selectionOrReferenceOperations = new Set([
  'event.duplicate',
  'event.update',
  'event.move',
  'event.delete',
  'reminder.update',
  'reminder.complete',
  'reminder.delete'
])

export const calendarIRDraftSchema = z
  .object({
    version: contractVersionSchema,
    requestId: identifierSchema,
    operation: calendarOperationSchema,
    selection: calendarSelectionSchema.nullable(),
    fields: calendarIRFieldsSchema,
    recurrence: recurrenceRuleSchema.nullable(),
    scope: actionScopeSchema,
    references: z.array(referenceSchema).max(20),
    ambiguities: z.array(ambiguitySchema).max(20),
    risk: riskLevelSchema,
    confidence: z.number().min(0).max(1),
    evidence: z.array(evidenceSchema).max(100)
  })
  .strict()
  .superRefine((draft, context) => {
    if (
      draft.operation === 'event.create' &&
      (draft.fields.title === null || draft.fields.when === null)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'event.create requires title and when',
        path: ['fields']
      })
    }
    if (draft.operation === 'reminder.create' && draft.fields.title === null) {
      context.addIssue({
        code: 'custom',
        message: 'reminder.create requires a title',
        path: ['fields']
      })
    }
    if (
      draft.operation === 'reminder.create' &&
      draft.recurrence !== null &&
      draft.fields.when === null
    ) {
      context.addIssue({
        code: 'custom',
        message: 'a repeating reminder requires a due date',
        path: ['fields', 'when']
      })
    }
    if (draft.operation === 'event.move' && draft.fields.when === null) {
      context.addIssue({
        code: 'custom',
        message: 'event.move requires when',
        path: ['fields', 'when']
      })
    }
    if (draft.operation === 'calendar.availability' && draft.fields.when === null) {
      context.addIssue({
        code: 'custom',
        message: 'calendar.availability requires when',
        path: ['fields', 'when']
      })
    }
    if (
      selectionOrReferenceOperations.has(draft.operation) &&
      draft.selection === null &&
      draft.references.length === 0
    ) {
      context.addIssue({
        code: 'custom',
        message: `${draft.operation} requires a selection or reference`,
        path: ['selection']
      })
    }
    if (draft.operation === 'assistant.clarify' && draft.ambiguities.length === 0) {
      context.addIssue({
        code: 'custom',
        message: 'assistant.clarify requires at least one ambiguity',
        path: ['ambiguities']
      })
    }
  })

export const resolvedCalendarFieldsSchema = z
  .object({
    title: z.string().min(1).max(1_000).nullable(),
    description: z.string().max(10_000).nullable(),
    location: z.string().max(1_000).nullable(),
    startUtc: isoInstantSchema.nullable(),
    endUtc: isoInstantSchema.nullable(),
    dueAtUtc: isoInstantSchema.nullable(),
    rangeStartUtc: isoInstantSchema.nullable(),
    rangeEndUtc: isoInstantSchema.nullable(),
    timezone: ianaTimeZoneSchema.nullable(),
    allDay: z.boolean().nullable(),
    reminderOffsetMinutes: z.number().int().min(0).max(525_600).nullable(),
    status: z.enum(['active', 'completed', 'cancelled']).nullable()
  })
  .strict()

export const calendarIRResolvedSchema = z
  .object({
    version: contractVersionSchema,
    requestId: identifierSchema,
    operation: calendarOperationSchema,
    selection: calendarSelectionSchema.nullable(),
    fields: resolvedCalendarFieldsSchema,
    recurrence: recurrenceRuleSchema.nullable(),
    scope: actionScopeSchema,
    risk: riskLevelSchema,
    confidence: z.number().min(0).max(1),
    requiresConfirmation: z.boolean(),
    evidence: z.array(evidenceSchema).max(100),
    resolvedAt: isoInstantSchema
  })
  .strict()

export type CalendarOperation = z.infer<typeof calendarOperationSchema>
export type ActionScope = z.infer<typeof actionScopeSchema>
export type RiskLevel = z.infer<typeof riskLevelSchema>
export type CalendarIRDraft = z.infer<typeof calendarIRDraftSchema>
export type CalendarIRResolved = z.infer<typeof calendarIRResolvedSchema>
export type TemporalAnchor = z.infer<typeof temporalAnchorSchema>
export type TemporalWindow = z.infer<typeof temporalWindowSchema>
