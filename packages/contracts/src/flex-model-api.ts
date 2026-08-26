import { z } from 'zod'
import { calendarOperationSchema } from './calendar-ir'
import { assistantProfileSchema } from './entities'
import { responseStyleSchema } from './response-plan'

export const flexModelIdSchema = z.literal('qwen3-1.7b-q4')

export const flexModelStateSchema = z.enum([
  'not-installed',
  'downloading',
  'installed',
  'loading',
  'ready',
  'error'
])

export const flexModelRuntimeProfileSchema = z
  .object({
    id: z.enum(['compact', 'balanced', 'performance']),
    label: z.string().min(1).max(80),
    backend: z.enum(['cpu', 'metal']),
    threads: z.number().int().min(1).max(64),
    contextSize: z.number().int().min(2_048).max(32_768),
    sequences: z.number().int().min(1).max(2),
    batchSize: z.number().int().min(128).max(1_024),
    maxChatTokens: z.number().int().min(32).max(512),
    idleUnloadSeconds: z.number().int().min(30).max(3_600),
    requestTimeoutSeconds: z.number().int().min(30).max(300)
  })
  .strict()

export const flexModelRequestMetricsSchema = z
  .object({
    workload: z.enum(['plan', 'chat']),
    elapsedMs: z.number().int().nonnegative().max(300_000),
    inputTokens: z.number().int().nonnegative().max(32_768),
    outputTokens: z.number().int().nonnegative().max(4_096),
    tokenLimit: z.number().int().positive().max(4_096),
    stopReason: z.string().min(1).max(80),
    inputTruncated: z.boolean(),
    coldStart: z.boolean()
  })
  .strict()

export const flexModelStatusSchema = z
  .object({
    modelId: flexModelIdSchema,
    displayName: z.literal('Qwen3 1.7B Q4'),
    state: flexModelStateSchema,
    enabled: z.boolean(),
    installedBytes: z.number().int().nonnegative(),
    downloadBytes: z.number().int().positive(),
    progress: z.number().min(0).max(1),
    license: z.literal('Apache-2.0'),
    runtime: z.literal('node-llama-cpp'),
    networkRequiredForInstall: z.literal(true),
    networkRequiredAfterInstall: z.literal(false),
    profile: flexModelRuntimeProfileSchema,
    lastRequest: flexModelRequestMetricsSchema.nullable(),
    error: z.string().max(2_000).nullable()
  })
  .strict()

export const flexModelProgressEventSchema = z
  .object({
    status: flexModelStatusSchema,
    message: z.string().min(1).max(500)
  })
  .strict()

export const flexModelInstallRequestSchema = z.object({}).strict()
export const flexModelCancelRequestSchema = z.object({}).strict()
export const flexModelRemoveRequestSchema = z.object({}).strict()
export const flexModelSetEnabledRequestSchema = z.object({ enabled: z.boolean() }).strict()

export const flexModelCalendarOperationSchema = calendarOperationSchema.exclude([
  'assistant.clarify',
  'assistant.reject',
  'assistant.unsupported',
  'import.propose'
])

export const flexModelPlanContextSchema = z
  .object({
    currentLocalDateTime: z.string().min(1).max(100),
    timezone: z.string().min(1).max(100),
    locale: z.string().min(1).max(100),
    dialogueContext: z.string().max(6_000).optional()
  })
  .strict()

/**
 * A flexible model may classify exact excerpts, but it cannot invent calendar fields.
 * Every string is checked against the original request before it reaches the parser.
 */
export const flexModelActionSchema = z
  .object({
    sourceText: z.string().min(1).max(2_000),
    operation: flexModelCalendarOperationSchema,
    titleText: z.string().min(1).max(500).nullable().optional(),
    targetText: z.string().min(1).max(500).nullable().optional(),
    descriptionText: z.string().min(1).max(2_000).nullable().optional(),
    locationText: z.string().min(1).max(500).nullable().optional(),
    whenText: z.string().min(1).max(500).nullable().optional(),
    normalizedWhenText: z.string().min(1).max(200).nullable().optional(),
    recurrenceText: z.string().min(1).max(500).nullable().optional(),
    normalizedRecurrenceText: z.string().min(1).max(200).nullable().optional()
  })
  .strict()

export const flexModelPlanSchema = z
  .object({
    actions: z.array(flexModelActionSchema).min(1).max(8)
  })
  .strict()

export const flexModelChatTurnSchema = z
  .object({
    role: z.enum(['user', 'assistant']),
    text: z.string().trim().min(1).max(4_000)
  })
  .strict()

export const flexModelChatRequestSchema = z
  .object({
    text: z.string().trim().min(1).max(4_000),
    turns: z.array(flexModelChatTurnSchema).max(8),
    calendarContext: z.string().max(8_000),
    currentLocalDateTime: z.string().min(1).max(100),
    timezone: z.string().min(1).max(100),
    profile: assistantProfileSchema,
    style: responseStyleSchema
  })
  .strict()

export const flexModelChatResponseSchema = z
  .object({ text: z.string().trim().min(1).max(8_000) })
  .strict()

export type FlexModelStatus = z.infer<typeof flexModelStatusSchema>
export type FlexModelRuntimeProfileStatus = z.infer<typeof flexModelRuntimeProfileSchema>
export type FlexModelRequestMetrics = z.infer<typeof flexModelRequestMetricsSchema>
export type FlexModelProgressEvent = z.infer<typeof flexModelProgressEventSchema>
export type FlexModelAction = z.infer<typeof flexModelActionSchema>
export type FlexModelPlan = z.infer<typeof flexModelPlanSchema>
export type FlexModelPlanContext = z.infer<typeof flexModelPlanContextSchema>
export type FlexModelChatRequest = z.infer<typeof flexModelChatRequestSchema>
export type FlexModelChatResponse = z.infer<typeof flexModelChatResponseSchema>
