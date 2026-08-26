import { z } from 'zod'
import { identifierSchema } from './common'

export const voiceSampleRate = 16_000 as const
export const maximumVoiceDurationSeconds = 30 as const
export const maximumVoicePcmBytes =
  voiceSampleRate * maximumVoiceDurationSeconds * Float32Array.BYTES_PER_ELEMENT

export const voiceRuntimeInfoSchema = z
  .object({
    available: z.boolean(),
    loaded: z.boolean(),
    engine: z.literal('sherpa-onnx-wasm'),
    engineVersion: z.string().min(1),
    modelId: z.string().min(1),
    locale: z.string().min(2).max(35),
    modelBytes: z.number().int().positive(),
    isolation: z.literal('electron-utility-process'),
    requiresNetwork: z.literal(false),
    maximumDurationSeconds: z.literal(maximumVoiceDurationSeconds),
    idleUnloadSeconds: z.number().int().positive(),
    unloadsWhenIdle: z.literal(true),
    error: z.string().max(2_000).nullable()
  })
  .strict()

export const voicePcmBufferSchema = z
  .custom<ArrayBuffer>((value) => value instanceof ArrayBuffer, 'Expected an ArrayBuffer')
  .superRefine((value, context) => {
    if (value.byteLength === 0) {
      context.addIssue({ code: 'custom', message: 'Voice recording is empty' })
    }
    if (value.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
      context.addIssue({ code: 'custom', message: 'Voice PCM must contain Float32 samples' })
    }
    if (value.byteLength > maximumVoicePcmBytes) {
      context.addIssue({ code: 'custom', message: 'Voice recording exceeds 30 seconds' })
    }
  })

export const voiceTranscriptionRequestSchema = z
  .object({
    jobId: identifierSchema,
    sampleRate: z.literal(voiceSampleRate),
    samples: voicePcmBufferSchema
  })
  .strict()

export const voiceStreamStartRequestSchema = z
  .object({ jobId: identifierSchema, sampleRate: z.literal(voiceSampleRate) })
  .strict()
export const voiceStreamStartResponseSchema = z
  .object({ jobId: identifierSchema, started: z.literal(true) })
  .strict()
export const voiceStreamChunkRequestSchema = z
  .object({ jobId: identifierSchema, samples: voicePcmBufferSchema })
  .strict()
export const voiceStreamChunkResponseSchema = z
  .object({ jobId: identifierSchema, acceptedSamples: z.number().int().positive() })
  .strict()
export const voiceStreamFinishRequestSchema = z.object({ jobId: identifierSchema }).strict()

export const voiceTranscriptionResultSchema = z
  .object({
    jobId: identifierSchema,
    text: z.string().min(1).max(50_000),
    rawText: z.string().min(1).max(50_000),
    confidence: z.number().min(0).max(1).nullable(),
    audioDurationMs: z.number().int().positive(),
    processingDurationMs: z.number().int().nonnegative(),
    locale: z.string().min(2).max(35),
    engine: z.literal('sherpa-onnx-wasm'),
    modelId: z.string().min(1)
  })
  .strict()

export const voiceProgressStageSchema = z.enum([
  'queued',
  'loading-runtime',
  'loading-model',
  'transcribing',
  'finalizing',
  'complete',
  'cancelled'
])

export const voiceProgressEventSchema = z
  .object({
    jobId: identifierSchema,
    stage: voiceProgressStageSchema,
    progress: z.number().min(0).max(1),
    message: z.string().min(1).max(200),
    partialText: z.string().max(50_000).nullable().default(null)
  })
  .strict()

export const voiceWarmRequestSchema = z.object({ jobId: identifierSchema }).strict()
export const voiceCancelRequestSchema = z.object({ jobId: identifierSchema }).strict()
export const voiceCancelResponseSchema = z
  .object({ jobId: identifierSchema, cancelled: z.boolean() })
  .strict()

export type VoiceRuntimeInfo = z.infer<typeof voiceRuntimeInfoSchema>
export type VoiceTranscriptionRequest = z.infer<typeof voiceTranscriptionRequestSchema>
export type VoiceTranscriptionResult = z.infer<typeof voiceTranscriptionResultSchema>
export type VoiceProgressEvent = z.infer<typeof voiceProgressEventSchema>
export type VoiceStreamStartRequest = z.infer<typeof voiceStreamStartRequestSchema>
export type VoiceStreamChunkRequest = z.infer<typeof voiceStreamChunkRequestSchema>
