import { z } from 'zod'

export const contractVersionSchema = z.literal('0.1')

export const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/)

export const isoInstantSchema = z.string().datetime({ offset: true })

export const localDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const [year, month, day] = value.split('-').map(Number)
    if (year === undefined || month === undefined || day === undefined) return false
    const candidate = new Date(Date.UTC(year, month - 1, day))
    return (
      candidate.getUTCFullYear() === year &&
      candidate.getUTCMonth() === month - 1 &&
      candidate.getUTCDate() === day
    )
  }, 'Invalid calendar date')

export const localTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)

export const ianaTimeZoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value }).format()
      return true
    } catch {
      return false
    }
  }, 'Invalid IANA timezone')

export const localeSchema = z.string().min(2).max(35)

export const sourceSpanSchema = z
  .object({
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative()
  })
  .strict()
  .superRefine((span, context) => {
    if (span.end <= span.start) {
      context.addIssue({
        code: 'custom',
        message: 'Source span end must be greater than start',
        path: ['end']
      })
    }
  })

export type SourceSpan = z.infer<typeof sourceSpanSchema>
