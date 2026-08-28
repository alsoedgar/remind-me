import { z } from 'zod'
import { calendarOperationSchema } from './calendar-ir'
import { identifierSchema, isoInstantSchema } from './common'
import { assistantProfileSchema } from './entities'
import { responseStyleSchema } from './response-plan'

export const flexModelIdSchema = z.literal('qwen3-1.7b-q4')

export const flexModelWorkloadSchema = z.enum([
  'plan',
  'chat',
  'document-repair',
  'document-fallback'
])
export const flexModelBackendSchema = z.enum(['cpu', 'metal', 'cuda', 'vulkan'])
export const flexModelWarmthPolicySchema = z.enum(['memory-saver', 'automatic', 'keep-warm'])
export const flexModelAccelerationPreferenceSchema = z.enum(['auto', 'cpu'])
export const flexModelJobPhaseSchema = z.enum([
  'queued',
  'loading',
  'generating',
  'validating',
  'cancelled'
])

export const flexModelJobStatusSchema = z
  .object({
    workload: flexModelWorkloadSchema,
    phase: flexModelJobPhaseSchema,
    queuePosition: z.number().int().nonnegative().max(64),
    queuedJobs: z.number().int().nonnegative().max(64),
    canCancel: z.boolean()
  })
  .strict()

export const flexModelQueueSnapshotSchema = z
  .object({
    activeWorkload: flexModelWorkloadSchema.nullable(),
    queuedJobs: z.number().int().nonnegative().max(64),
    foregroundQueued: z.number().int().nonnegative().max(64),
    documentQueued: z.number().int().nonnegative().max(64)
  })
  .strict()

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
    backend: flexModelBackendSchema,
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
    workload: flexModelWorkloadSchema,
    elapsedMs: z.number().int().nonnegative().max(300_000),
    inputTokens: z.number().int().nonnegative().max(32_768),
    outputTokens: z.number().int().nonnegative().max(4_096),
    tokenLimit: z.number().int().positive().max(4_096),
    stopReason: z.string().min(1).max(80),
    inputTruncated: z.boolean(),
    coldStart: z.boolean(),
    queueWaitMs: z.number().int().nonnegative().max(300_000),
    timeToFirstTokenMs: z.number().int().nonnegative().max(300_000).nullable(),
    backend: flexModelBackendSchema,
    prefixCacheReused: z.boolean(),
    processRssMiB: z.number().int().nonnegative().max(32_768)
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
    warmthPolicy: flexModelWarmthPolicySchema,
    accelerationPreference: flexModelAccelerationPreferenceSchema,
    availableBackends: z.array(flexModelBackendSchema).min(1).max(4),
    queue: flexModelQueueSnapshotSchema,
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
export const flexModelConfigureRequestSchema = z
  .object({
    warmthPolicy: flexModelWarmthPolicySchema.optional(),
    accelerationPreference: flexModelAccelerationPreferenceSchema.optional()
  })
  .strict()

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

export const flexModelCalendarFactFieldSchema = z.enum([
  'title',
  'date',
  'time',
  'start',
  'end',
  'duration',
  'location',
  'notes',
  'recurrence',
  'details',
  'action',
  'status'
])

const flexModelCalendarFactFieldsSchema = z
  .object({
    title: z.string().trim().min(1).max(1_000),
    date: z.string().trim().min(1).max(300).nullable(),
    time: z.string().trim().min(1).max(300).nullable(),
    start: z.string().trim().min(1).max(300).nullable(),
    end: z.string().trim().min(1).max(300).nullable(),
    duration: z.string().trim().min(1).max(300).nullable(),
    location: z.string().trim().min(1).max(1_000).nullable(),
    notes: z.string().trim().min(1).max(500).nullable(),
    recurrence: z.string().trim().min(1).max(500).nullable(),
    details: z.string().trim().min(1).max(1_000).nullable(),
    action: z.string().trim().min(1).max(1_000).nullable(),
    status: z.string().trim().min(1).max(100).nullable()
  })
  .strict()

export const flexModelCalendarFactSchema = z
  .object({
    ref: z.string().regex(/^F(?:[1-9]|1[0-9]|2[0-4])$/u),
    factId: identifierSchema,
    entityId: identifierSchema.nullable(),
    kind: z.enum(['event', 'reminder', 'review']),
    priority: z.enum(['review', 'focused', 'range', 'nearby']),
    provenance: z.enum(['manual', 'assistant', 'import', 'review']),
    occurrenceStartUtc: isoInstantSchema.nullable(),
    fields: flexModelCalendarFactFieldsSchema
  })
  .strict()

export const flexModelCalendarFactPacketSchema = z
  .object({
    schemaVersion: z.literal(1),
    range: z
      .object({
        startUtc: isoInstantSchema,
        endUtc: isoInstantSchema,
        timezone: z.string().trim().min(1).max(100)
      })
      .strict()
      .nullable(),
    facts: z.array(flexModelCalendarFactSchema).max(24),
    truncated: z.boolean()
  })
  .strict()
  .superRefine((packet, context) => {
    const refs = packet.facts.map((fact) => fact.ref)
    if (new Set(refs).size !== refs.length) {
      context.addIssue({ code: 'custom', message: 'Calendar fact refs must be unique' })
    }
  })

export const flexModelChatFactReferenceSchema = z
  .object({
    ref: z.string().regex(/^F(?:[1-9]|1[0-9]|2[0-4])$/u),
    factId: identifierSchema,
    fields: z.array(flexModelCalendarFactFieldSchema).min(1).max(12)
  })
  .strict()
  .superRefine((reference, context) => {
    if (new Set(reference.fields).size !== reference.fields.length) {
      context.addIssue({ code: 'custom', message: 'Referenced fact fields must be unique' })
    }
  })

const flexModelChatEnvelopeShape = {
  text: z.string().trim().min(1).max(8_000),
  factRefs: z.array(flexModelChatFactReferenceSchema).max(24),
  writeClaim: z.boolean()
} as const

export const flexModelChatRequestSchema = z
  .object({
    text: z.string().trim().min(1).max(4_000),
    turns: z.array(flexModelChatTurnSchema).max(8),
    conversationSummary: z.string().max(2_000),
    calendarContext: z.string().max(8_000),
    currentLocalDateTime: z.string().min(1).max(100),
    timezone: z.string().min(1).max(100),
    profile: assistantProfileSchema,
    style: responseStyleSchema
  })
  .strict()

export const flexModelChatResponseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('answer'), ...flexModelChatEnvelopeShape }).strict(),
  z.object({ kind: z.literal('clarification'), ...flexModelChatEnvelopeShape }).strict(),
  z.object({ kind: z.literal('offline-limit'), ...flexModelChatEnvelopeShape }).strict(),
  z.object({ kind: z.literal('refusal'), ...flexModelChatEnvelopeShape }).strict()
])

export const flexModelFallbackFailureKindSchema = z.enum([
  'missing',
  'disabled',
  'timeout',
  'cancelled',
  'unavailable',
  'invalid-output'
])

export const flexModelCalendarFallbackResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('plan'), plan: flexModelPlanSchema }).strict(),
  z.object({ kind: z.literal('not-calendar') }).strict(),
  z.object({ kind: z.literal('missing') }).strict(),
  z.object({ kind: z.literal('disabled') }).strict(),
  z.object({ kind: z.literal('timeout') }).strict(),
  z.object({ kind: z.literal('cancelled') }).strict(),
  z.object({ kind: z.literal('unavailable') }).strict(),
  z.object({ kind: z.literal('invalid-output') }).strict()
])

export const flexModelGeneralFallbackResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('answer'), ...flexModelChatEnvelopeShape }).strict(),
  z.object({ kind: z.literal('clarification'), ...flexModelChatEnvelopeShape }).strict(),
  z.object({ kind: z.literal('offline-limit'), ...flexModelChatEnvelopeShape }).strict(),
  z.object({ kind: z.literal('refusal'), ...flexModelChatEnvelopeShape }).strict(),
  z.object({ kind: z.literal('missing') }).strict(),
  z.object({ kind: z.literal('disabled') }).strict(),
  z.object({ kind: z.literal('timeout') }).strict(),
  z.object({ kind: z.literal('cancelled') }).strict(),
  z.object({ kind: z.literal('unavailable') }).strict(),
  z.object({ kind: z.literal('invalid-output') }).strict()
])

export type FlexModelStatus = z.infer<typeof flexModelStatusSchema>
export type FlexModelRuntimeProfileStatus = z.infer<typeof flexModelRuntimeProfileSchema>
export type FlexModelRequestMetrics = z.infer<typeof flexModelRequestMetricsSchema>
export type FlexModelWorkload = z.infer<typeof flexModelWorkloadSchema>
export type FlexModelBackend = z.infer<typeof flexModelBackendSchema>
export type FlexModelWarmthPolicy = z.infer<typeof flexModelWarmthPolicySchema>
export type FlexModelAccelerationPreference = z.infer<typeof flexModelAccelerationPreferenceSchema>
export type FlexModelJobStatus = z.infer<typeof flexModelJobStatusSchema>
export type FlexModelQueueSnapshot = z.infer<typeof flexModelQueueSnapshotSchema>
export type FlexModelProgressEvent = z.infer<typeof flexModelProgressEventSchema>
export type FlexModelAction = z.infer<typeof flexModelActionSchema>
export type FlexModelPlan = z.infer<typeof flexModelPlanSchema>
export type FlexModelPlanContext = z.infer<typeof flexModelPlanContextSchema>
export type FlexModelChatRequest = z.infer<typeof flexModelChatRequestSchema>
export type FlexModelChatResponse = z.infer<typeof flexModelChatResponseSchema>
export type FlexModelCalendarFactField = z.infer<typeof flexModelCalendarFactFieldSchema>
export type FlexModelCalendarFact = z.infer<typeof flexModelCalendarFactSchema>
export type FlexModelCalendarFactPacket = z.infer<typeof flexModelCalendarFactPacketSchema>
export type FlexModelChatFactReference = z.infer<typeof flexModelChatFactReferenceSchema>
export type FlexModelFallbackFailureKind = z.infer<typeof flexModelFallbackFailureKindSchema>
export type FlexModelCalendarFallbackResult = z.infer<typeof flexModelCalendarFallbackResultSchema>
export type FlexModelGeneralFallbackResult = z.infer<typeof flexModelGeneralFallbackResultSchema>
