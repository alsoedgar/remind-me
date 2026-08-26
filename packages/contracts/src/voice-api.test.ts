import { describe, expect, it } from 'vitest'
import {
  maximumVoicePcmBytes,
  voiceProgressEventSchema,
  voiceStreamChunkRequestSchema,
  voiceStreamStartRequestSchema,
  voiceTranscriptionRequestSchema
} from './voice-api'

describe('voice IPC contracts', () => {
  it('accepts bounded 16 kHz Float32 PCM and rejects oversized or malformed buffers', () => {
    expect(
      voiceTranscriptionRequestSchema.parse({
        jobId: 'voice:test',
        sampleRate: 16_000,
        samples: new Float32Array(16_000).buffer
      }).samples.byteLength
    ).toBe(64_000)

    expect(() =>
      voiceTranscriptionRequestSchema.parse({
        jobId: 'voice:test',
        sampleRate: 16_000,
        samples: new ArrayBuffer(maximumVoicePcmBytes + 4)
      })
    ).toThrow(/30 seconds/u)
    expect(() =>
      voiceTranscriptionRequestSchema.parse({
        jobId: 'voice:test',
        sampleRate: 16_000,
        samples: new ArrayBuffer(3)
      })
    ).toThrow(/Float32/u)
  })

  it('accepts bounded live chunks and carries an optional interim transcript', () => {
    expect(
      voiceStreamStartRequestSchema.parse({ jobId: 'voice:live', sampleRate: 16_000 })
    ).toEqual({ jobId: 'voice:live', sampleRate: 16_000 })
    expect(
      voiceStreamChunkRequestSchema.parse({
        jobId: 'voice:live',
        samples: new Float32Array(6_400).buffer
      }).samples.byteLength
    ).toBe(25_600)
    expect(
      voiceProgressEventSchema.parse({
        jobId: 'voice:live',
        stage: 'transcribing',
        progress: 0.4,
        message: 'Transcribing live…',
        partialText: 'Schedule the lab tomorrow'
      }).partialText
    ).toBe('Schedule the lab tomorrow')
  })

  it('bounds worker progress before it crosses into the renderer', () => {
    expect(
      voiceProgressEventSchema.parse({
        jobId: 'voice:test',
        stage: 'transcribing',
        progress: 0.65,
        message: 'Turning speech into words…'
      }).progress
    ).toBe(0.65)
    expect(() =>
      voiceProgressEventSchema.parse({
        jobId: 'voice:test',
        stage: 'transcribing',
        progress: 1.2,
        message: 'Invalid'
      })
    ).toThrow()
  })
})
