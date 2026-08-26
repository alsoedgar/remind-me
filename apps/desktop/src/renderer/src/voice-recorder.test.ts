import { describe, expect, it } from 'vitest'
import { preprocessVoicePcm, resamplePcm } from './voice-recorder'

function rms(samples: Float32Array): number {
  return Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length)
}

describe('voice capture signal preparation', () => {
  it('resamples common 48 kHz microphone audio to 16 kHz without changing duration', () => {
    const input = Float32Array.from({ length: 48_000 }, (_value, index) =>
      Math.sin((2 * Math.PI * 440 * index) / 48_000)
    )
    const output = resamplePcm(input, 48_000, 16_000)
    expect(output).toHaveLength(16_000)
    expect(rms(output)).toBeGreaterThan(0.65)
  })

  it('removes empty edges and DC while preserving speech in deterministic background noise', () => {
    let randomState = 17
    const samples = Float32Array.from({ length: 48_000 }, (_value, index) => {
      randomState = (1_664_525 * randomState + 1_013_904_223) >>> 0
      const noise = ((randomState / 4_294_967_296) * 2 - 1) * 0.009
      const speech =
        index >= 16_000 && index < 32_000
          ? Math.sin((2 * Math.PI * 180 * (index - 16_000)) / 16_000) * 0.18
          : 0
      return 0.035 + noise + speech
    })
    const output = preprocessVoicePcm(samples)
    const mean = output.reduce((sum, sample) => sum + sample, 0) / output.length
    expect(output.length).toBeGreaterThan(12_000)
    expect(output.length).toBeLessThan(25_000)
    expect(Math.abs(mean)).toBeLessThan(0.01)
    expect(rms(output)).toBeGreaterThan(0.08)
  })
})
