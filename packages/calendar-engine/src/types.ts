import { z } from 'zod'
import {
  eventEntitySchema,
  ianaTimeZoneSchema,
  isoInstantSchema,
  localDateSchema,
  reminderEntitySchema
} from '@remind-me/contracts'

export const resolverContextSchema = z
  .object({
    nowUtc: isoInstantSchema,
    localDate: localDateSchema,
    timezone: ianaTimeZoneSchema,
    utcOffsetMinutes: z.number().int().min(-840).max(840),
    defaultCalendarId: z.string().min(1).max(128),
    defaultEventDurationMinutes: z.number().int().positive().max(1_440)
  })
  .strict()

export const calendarStateSchema = z
  .object({
    events: z.array(eventEntitySchema),
    reminders: z.array(reminderEntitySchema)
  })
  .strict()

export const dryRunResultSchema = z
  .object({
    accepted: z.boolean(),
    state: calendarStateSchema,
    mutationCount: z.number().int().nonnegative(),
    affectedIds: z.array(z.string()),
    summary: z.string().min(1),
    requiresConfirmation: z.boolean()
  })
  .strict()

export type ResolverContext = z.infer<typeof resolverContextSchema>
export type CalendarState = z.infer<typeof calendarStateSchema>
export type DryRunResult = z.infer<typeof dryRunResultSchema>
