import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { normalizeVoiceTranscript } from './index'

interface WaveData {
  sampleRate: number
  samples: Float32Array
}

interface OnlineStream {
  acceptWaveform: (sampleRate: number, samples: Float32Array) => void
  inputFinished: () => void
  free: () => void
}

interface OnlineRecognizer {
  createStream: () => OnlineStream
  isReady: (stream: OnlineStream) => boolean
  decode: (stream: OnlineStream) => void
  getResult: (stream: OnlineStream) => { text: string }
  free: () => void
}

interface SherpaRuntime {
  createOnlineRecognizer: (config: unknown) => OnlineRecognizer
  readWave: (path: string) => WaveData
}

const require = createRequire(import.meta.url)
const modelRoot = fileURLToPath(
  new URL('../../../models/asr/sherpa-onnx-streaming-zipformer-en-20M-2023-02-17/', import.meta.url)
)
const encoder = fileURLToPath(
  new URL(
    '../../../models/asr/sherpa-onnx-streaming-zipformer-en-20M-2023-02-17/encoder-epoch-99-avg-1.int8.onnx',
    import.meta.url
  )
)

describe.skipIf(!existsSync(encoder))('bundled offline ASR', () => {
  let sherpa: SherpaRuntime
  let recognizer: OnlineRecognizer

  beforeAll(() => {
    sherpa = require('sherpa-onnx') as SherpaRuntime
    recognizer = sherpa.createOnlineRecognizer({
      featConfig: { sampleRate: 16_000, featureDim: 80 },
      modelConfig: {
        transducer: {
          encoder,
          decoder: `${modelRoot}decoder-epoch-99-avg-1.onnx`,
          joiner: `${modelRoot}joiner-epoch-99-avg-1.int8.onnx`
        },
        tokens: `${modelRoot}tokens.txt`,
        numThreads: 1,
        provider: 'cpu',
        debug: 0,
        modelType: '',
        modelingUnit: '',
        bpeVocab: ''
      },
      decodingMethod: 'modified_beam_search',
      maxActivePaths: 4,
      enableEndpoint: 0
    })
  })

  afterAll(() => recognizer.free())

  function transcribe(samples: Float32Array, sampleRate: number): string {
    const stream = recognizer.createStream()
    try {
      const padding = Math.round(sampleRate * 0.5)
      const padded = new Float32Array(samples.length + padding * 2)
      padded.set(samples, padding)
      stream.acceptWaveform(sampleRate, padded)
      stream.inputFinished()
      while (recognizer.isReady(stream)) recognizer.decode(stream)
      return recognizer.getResult(stream).text.trim()
    } finally {
      stream.free()
    }
  }

  function transcribeWave(relativePath: string): string {
    const wave = sherpa.readWave(fileURLToPath(new URL(relativePath, import.meta.url)))
    return transcribe(wave.samples, wave.sampleRate)
  }

  it('recognizes the pinned upstream clean-install fixture', () => {
    const transcript = transcribeWave(
      '../../../models/asr/sherpa-onnx-streaming-zipformer-en-20M-2023-02-17/test_wavs/0.wav'
    )
    expect(transcript).toContain('THE YELLOW LAMPS WOULD LIGHT UP')
  })

  it('retains the key phrase under deterministic broadband background noise', () => {
    const wave = sherpa.readWave(`${modelRoot}test_wavs/0.wav`)
    let randomState = 42
    const noisy = Float32Array.from(wave.samples, (sample) => {
      randomState = (1_664_525 * randomState + 1_013_904_223) >>> 0
      const noise = ((randomState / 4_294_967_296) * 2 - 1) * 0.018
      return Math.max(-1, Math.min(1, sample + noise))
    })
    expect(transcribe(noisy, wave.sampleRate)).toContain('THE YELLOW LAMPS WOULD LIGHT UP')
  })

  it('recognizes calendar time language across two synthetic speaking profiles', () => {
    const reminder = normalizeVoiceTranscript(
      transcribeWave('../../../fixtures/audio/reminder-zira.wav')
    )
    const focus = normalizeVoiceTranscript(
      transcribeWave('../../../fixtures/audio/focus-david.wav')
    )
    expect(reminder).toBe('Remind me to call mary tomorrow at 6 pm')
    expect(focus).toBe('Block focus time next friday from 2 pm to 4 pm')
  })

  it('recognizes real Irish-English calendar and time expressions', () => {
    const transcript = normalizeVoiceTranscript(
      transcribeWave('../../../fixtures/audio/openslr83/irm_02484_00844235202.wav')
    )
    expect(transcript).toContain('Before that on april')
    expect(transcript).toContain('at 10:30')
    expect(transcript).toContain("rob's birthday gathering")
  })
})
