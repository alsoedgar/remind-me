import { z } from 'zod'
import { documentPageSchema, responseStyleSchema } from '@remind-me/contracts'

export const releaseProbeSuiteSchema = z
  .object({
    schemaVersion: z.literal(1),
    contractVersion: z.literal('0.1'),
    generatedFrom: z.string().min(1),
    planner: z
      .array(
        z
          .object({
            text: z.string().min(1).max(500),
            expectedOperation: z.string().min(1).max(64),
            expectedEligibleForAssistance: z.boolean()
          })
          .strict()
      )
      .min(2)
      .max(12),
    speaker: z
      .object({
        requestId: z.string().min(1).max(128),
        speechAct: z.string().min(1).max(64),
        facts: z
          .array(
            z
              .object({
                key: z.string().regex(/^[A-Z][A-Z0-9_]*$/u),
                kind: z.enum(['date', 'time', 'title', 'count', 'text']),
                placeholder: z.string().regex(/^<[A-Z][A-Z0-9_]*>$/u),
                value: z.string().min(1).max(500)
              })
              .strict()
          )
          .min(1)
          .max(8),
        style: responseStyleSchema,
        recentReplies: z.array(z.string().max(2_000)).max(20),
        expectedCandidateCount: z.number().int().min(1).max(10)
      })
      .strict(),
    document: z
      .object({
        page: documentPageSchema,
        expectedDocumentType: z.string().min(1).max(64),
        expectedGroupTitles: z.array(z.string().min(1).max(500)).min(1).max(12)
      })
      .strict()
  })
  .strict()

export type ReleaseProbeSuite = z.infer<typeof releaseProbeSuiteSchema>
