import { z } from 'zod'
import {
  identifierSchema,
  ianaTimeZoneSchema,
  isoInstantSchema,
  localDateSchema,
  localTimeSchema
} from './common'
import {
  calendarEntitySchema,
  eventEntitySchema,
  preferencesEntitySchema,
  recurrenceExceptionEntitySchema,
  reminderEntitySchema
} from './entities'
import { calendarOperationSchema } from './calendar-ir'
import { recurrenceRuleSchema } from './recurrence'

export const eventFormSchema = z
  .object({
    id: identifierSchema.nullable(),
    calendarId: identifierSchema.nullable(),
    title: z.string().trim().min(1).max(1_000),
    description: z.string().max(10_000),
    location: z.string().max(1_000),
    startDate: localDateSchema,
    startTime: localTimeSchema.nullable(),
    endDate: localDateSchema,
    endTime: localTimeSchema.nullable(),
    timezone: ianaTimeZoneSchema,
    allDay: z.boolean(),
    recurrence: recurrenceRuleSchema.nullable()
  })
  .strict()
  .superRefine((form, context) => {
    if (!form.allDay && (form.startTime === null || form.endTime === null)) {
      context.addIssue({
        code: 'custom',
        message: 'Timed events require start and end times',
        path: ['startTime']
      })
      return
    }
    const start = `${form.startDate}T${form.startTime ?? '00:00'}`
    const end = `${form.endDate}T${form.endTime ?? '23:59'}`
    if (end <= start) {
      context.addIssue({
        code: 'custom',
        message: 'Event end must be after start',
        path: ['endDate']
      })
    }
  })

export const reminderFormSchema = z
  .object({
    id: identifierSchema.nullable(),
    calendarId: identifierSchema.nullable(),
    title: z.string().trim().min(1).max(1_000),
    notes: z.string().max(10_000),
    dueDate: localDateSchema.nullable(),
    dueTime: localTimeSchema.nullable(),
    timezone: ianaTimeZoneSchema,
    recurrence: recurrenceRuleSchema.nullable()
  })
  .strict()
  .superRefine((form, context) => {
    const hasDate = form.dueDate !== null
    const hasTime = form.dueTime !== null
    if (hasDate !== hasTime) {
      context.addIssue({
        code: 'custom',
        message: 'A reminder needs both a due date and time, or neither',
        path: hasDate ? ['dueTime'] : ['dueDate']
      })
    }
    if (!hasDate && form.recurrence !== null) {
      context.addIssue({
        code: 'custom',
        message: 'A repeating reminder needs a due date',
        path: ['recurrence']
      })
    }
  })

export const eventOccurrenceSchema = z
  .object({
    occurrenceId: identifierSchema,
    eventId: identifierSchema,
    calendarId: identifierSchema,
    title: z.string().min(1).max(1_000),
    description: z.string().max(10_000),
    location: z.string().max(1_000),
    startUtc: isoInstantSchema,
    endUtc: isoInstantSchema,
    timezone: ianaTimeZoneSchema,
    allDay: z.boolean(),
    originalDate: localDateSchema,
    recurring: z.boolean()
  })
  .strict()

export const calendarSnapshotRequestSchema = z
  .object({
    rangeStartUtc: isoInstantSchema,
    rangeEndUtc: isoInstantSchema
  })
  .strict()
  .superRefine((range, context) => {
    if (Date.parse(range.rangeEndUtc) <= Date.parse(range.rangeStartUtc)) {
      context.addIssue({
        code: 'custom',
        message: 'Snapshot range end must be after start',
        path: ['rangeEndUtc']
      })
    }
  })

export const calendarSnapshotSchema = z
  .object({
    calendars: z.array(calendarEntitySchema),
    events: z.array(eventEntitySchema),
    occurrences: z.array(eventOccurrenceSchema),
    reminders: z.array(reminderEntitySchema),
    preferences: preferencesEntitySchema,
    canUndo: z.boolean(),
    generatedAt: isoInstantSchema
  })
  .strict()

export const mutationReceiptSchema = z
  .object({
    actionId: identifierSchema,
    operation: calendarOperationSchema,
    summary: z.string().min(1).max(2_000),
    undoable: z.boolean(),
    createdAt: isoInstantSchema
  })
  .strict()

export const calendarMutationResultSchema = z
  .object({
    snapshot: calendarSnapshotSchema,
    receipt: mutationReceiptSchema
  })
  .strict()

export const entityIdRequestSchema = z.object({ id: identifierSchema }).strict()

export const calendarBatchItemSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('event-save'), form: eventFormSchema }).strict(),
  z.object({ kind: z.literal('event-delete'), id: identifierSchema }).strict(),
  z.object({ kind: z.literal('reminder-save'), form: reminderFormSchema }).strict(),
  z.object({ kind: z.literal('reminder-complete'), id: identifierSchema }).strict(),
  z.object({ kind: z.literal('reminder-delete'), id: identifierSchema }).strict()
])

export const calendarBatchApplyRequestSchema = z
  .object({
    items: z.array(calendarBatchItemSchema).min(1).max(50),
    summary: z.string().trim().min(1).max(2_000),
    range: calendarSnapshotRequestSchema
  })
  .strict()

export const availabilityRequestSchema = calendarSnapshotRequestSchema.extend({
  excludeEventId: identifierSchema.nullable()
})
export const availabilityResultSchema = z
  .object({
    free: z.boolean(),
    conflicts: z.array(eventOccurrenceSchema),
    summary: z.string().min(1).max(2_000)
  })
  .strict()

export const calendarDataFormatSchema = z.enum(['json', 'ics'])
export const dataExportRequestSchema = z.object({ format: calendarDataFormatSchema }).strict()
export const dataExportResultSchema = z
  .object({
    cancelled: z.boolean(),
    filePath: z.string().nullable(),
    eventCount: z.number().int().nonnegative(),
    reminderCount: z.number().int().nonnegative()
  })
  .strict()

export const dataImportRequestSchema = calendarSnapshotRequestSchema
export const dataImportResultSchema = z
  .object({
    cancelled: z.boolean(),
    filePath: z.string().nullable(),
    format: calendarDataFormatSchema.nullable(),
    eventCount: z.number().int().nonnegative(),
    reminderCount: z.number().int().nonnegative(),
    skippedCount: z.number().int().nonnegative(),
    snapshot: calendarSnapshotSchema.nullable()
  })
  .strict()

export const dataDeleteAllRequestSchema = z
  .object({
    confirmation: z.literal('DELETE'),
    range: calendarSnapshotRequestSchema
  })
  .strict()
export const dataDeleteAllResultSchema = z
  .object({
    deletedAt: isoInstantSchema,
    eventCount: z.number().int().nonnegative(),
    reminderCount: z.number().int().nonnegative(),
    conversationCount: z.number().int().nonnegative(),
    actionCount: z.number().int().nonnegative(),
    recoveryCopiesDeleted: z.number().int().nonnegative(),
    snapshot: calendarSnapshotSchema
  })
  .strict()

export const calendarBackupSchema = z
  .object({
    format: z.literal('remind-me-backup'),
    formatVersion: z.literal(1),
    contractVersion: z.literal('0.1'),
    exportedAt: isoInstantSchema,
    calendars: z.array(calendarEntitySchema),
    events: z.array(eventEntitySchema),
    reminders: z.array(reminderEntitySchema),
    recurrenceExceptions: z.array(recurrenceExceptionEntitySchema),
    preferences: preferencesEntitySchema
  })
  .strict()

export type EventForm = z.infer<typeof eventFormSchema>
export type ReminderForm = z.infer<typeof reminderFormSchema>
export type CalendarBatchItem = z.infer<typeof calendarBatchItemSchema>
export type CalendarBatchApplyRequest = z.infer<typeof calendarBatchApplyRequestSchema>
export type EventOccurrence = z.infer<typeof eventOccurrenceSchema>
export type CalendarSnapshotRequest = z.infer<typeof calendarSnapshotRequestSchema>
export type CalendarSnapshot = z.infer<typeof calendarSnapshotSchema>
export type MutationReceipt = z.infer<typeof mutationReceiptSchema>
export type CalendarMutationResult = z.infer<typeof calendarMutationResultSchema>
export type AvailabilityResult = z.infer<typeof availabilityResultSchema>
export type AvailabilityRequest = z.infer<typeof availabilityRequestSchema>
export type CalendarBackup = z.infer<typeof calendarBackupSchema>
export type DataExportResult = z.infer<typeof dataExportResultSchema>
export type DataImportResult = z.infer<typeof dataImportResultSchema>
export type DataDeleteAllResult = z.infer<typeof dataDeleteAllResultSchema>
