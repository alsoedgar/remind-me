import { z } from 'zod'
import { contractVersionSchema, identifierSchema } from './common'

export const responseStyleSchema = z
  .object({
    warmth: z.number().min(0).max(1),
    brevity: z.number().min(0).max(1),
    formality: z.number().min(0).max(1),
    humor: z.number().min(0).max(1),
    emoji: z.number().min(0).max(1),
    contractions: z.boolean(),
    proactivity: z.number().min(0).max(1)
  })
  .strict()

export const responseSpeechActSchema = z.enum([
  'proposal',
  'creation-confirmed',
  'update-confirmed',
  'deletion-confirmed',
  'completion-confirmed',
  'availability-answer',
  'schedule-summary',
  'next-item-answer',
  'item-details-answer',
  'empty-schedule-answer',
  'conversation-answer',
  'conversation-clarification',
  'memory-answer',
  'undo-confirmed',
  'proposal-rejected',
  'clarification',
  'conflict-warning',
  'runtime-unavailable',
  'offline-fact-limit',
  'policy-boundary',
  'unsupported',
  'error'
])

export const protectedPlaceholderSchema = z.string().regex(/^<[A-Z][A-Z0-9_]*>$/)

export const responseFactSchema = z
  .object({
    key: identifierSchema,
    kind: z.enum(['title', 'date', 'time', 'timezone', 'location', 'count', 'status', 'text']),
    placeholder: protectedPlaceholderSchema,
    value: z.string().min(1).max(2_000),
    evidenceIds: z.array(identifierSchema).max(32)
  })
  .strict()

export const responsePlanSchema = z
  .object({
    version: contractVersionSchema,
    requestId: identifierSchema,
    speechAct: responseSpeechActSchema,
    facts: z.array(responseFactSchema).max(50),
    style: responseStyleSchema,
    fallbackTemplate: z.string().min(1).max(4_000),
    recentReplyFingerprints: z.array(z.string().min(1).max(128)).max(20)
  })
  .strict()
  .superRefine((plan, context) => {
    const placeholders = plan.facts.map((fact) => fact.placeholder)
    if (new Set(placeholders).size !== placeholders.length) {
      context.addIssue({
        code: 'custom',
        message: 'Fact placeholders must be unique',
        path: ['facts']
      })
    }
    for (const [index, fact] of plan.facts.entries()) {
      if (!plan.fallbackTemplate.includes(fact.placeholder)) {
        context.addIssue({
          code: 'custom',
          message: `Fallback template is missing ${fact.placeholder}`,
          path: ['facts', index, 'placeholder']
        })
      }
    }
  })

export type ResponseStyle = z.infer<typeof responseStyleSchema>
export type ResponseSpeechAct = z.infer<typeof responseSpeechActSchema>
export type ResponsePlan = z.infer<typeof responsePlanSchema>
