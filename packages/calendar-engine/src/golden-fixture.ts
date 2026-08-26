import { z } from 'zod'
import { calendarIRDraftSchema, calendarIRResolvedSchema } from '@remind-me/contracts'
import { calendarStateSchema, dryRunResultSchema, resolverContextSchema } from './types'

export const goldenFixtureSchema = z
  .object({
    schemaVersion: z.literal('0.1'),
    id: z.string().regex(/^golden-\d{3}$/),
    category: z.enum([
      'event-create',
      'event-duplicate',
      'event-update',
      'event-move',
      'event-delete',
      'reminder-create',
      'reminder-update',
      'reminder-complete',
      'reminder-delete',
      'availability',
      'calendar-query',
      'assistant-safety',
      'import-proposal',
      'edge-case'
    ]),
    tags: z.array(z.string().min(1)).min(1),
    utterance: z.string().min(1).max(2_000),
    locale: z.string().min(2).max(35),
    timezone: z.string().min(1).max(64),
    context: resolverContextSchema,
    initialState: calendarStateSchema,
    draft: calendarIRDraftSchema,
    expectedResolved: calendarIRResolvedSchema,
    expectedDryRun: dryRunResultSchema
  })
  .strict()

export type GoldenFixture = z.infer<typeof goldenFixtureSchema>
