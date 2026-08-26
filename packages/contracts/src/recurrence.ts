import { z } from 'zod'
import { localDateSchema } from './common'

export const weekdaySchema = z.enum([
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday'
])

export const recurrenceFrequencySchema = z.enum(['daily', 'weekly', 'monthly', 'yearly'])

export const recurrenceEndSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('never') }).strict(),
  z.object({ kind: z.literal('count'), count: z.number().int().positive().max(10_000) }).strict(),
  z.object({ kind: z.literal('until'), date: localDateSchema }).strict()
])

export const recurrenceRuleSchema = z
  .object({
    frequency: recurrenceFrequencySchema,
    interval: z.number().int().positive().max(365),
    byWeekday: z.array(weekdaySchema).max(7),
    byMonthDay: z
      .array(
        z
          .number()
          .int()
          .min(-31)
          .max(31)
          .refine((day) => day !== 0)
      )
      .max(31),
    end: recurrenceEndSchema
  })
  .strict()

export type Weekday = z.infer<typeof weekdaySchema>
export type RecurrenceRule = z.infer<typeof recurrenceRuleSchema>
