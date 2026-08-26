'use strict'

const parentPort = process.parentPort
if (!parentPort) throw new Error('ASR worker must run as an Electron utility process')

let sherpa = null
let recognizer = null
let recognizerKey = null
let liveStream = null

function post(message) {
  parentPort.postMessage(message)
}

function progress(jobId, stage, value, message) {
  post({ type: 'progress', jobId, stage, progress: value, message })
}

function assertRequest(request) {
  if (!request || typeof request !== 'object') throw new Error('Invalid ASR request')
  if (typeof request.jobId !== 'string' || request.jobId.length === 0) {
    throw new Error('ASR request is missing a job ID')
  }
  if (['stream-chunk', 'stream-finish', 'stream-cancel'].includes(request.type)) return
  if (typeof request.runtimeEntry !== 'string' || !request.model) {
    throw new Error('ASR runtime configuration is missing')
  }
}

function loadRecognizer(request) {
  const model = request.model
  const key = JSON.stringify([
    request.runtimeEntry,
    model.encoder,
    model.decoder,
    model.joiner,
    model.tokens
  ])
  if (recognizer && recognizerKey === key) return

  if (recognizer) {
    recognizer.free()
    recognizer = null
    recognizerKey = null
  }

  progress(request.jobId, 'loading-runtime', 0.08, 'Opening the offline speech engine…')
  sherpa = require(request.runtimeEntry)
  progress(request.jobId, 'loading-model', 0.2, 'Warming the compact English model…')
  recognizer = sherpa.createOnlineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: model.encoder,
        decoder: model.decoder,
        joiner: model.joiner
      },
      tokens: model.tokens,
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
  recognizerKey = key
}

function decodeSamples(request, samples, sampleRate) {
  const startedAt = performance.now()
  const stream = recognizer.createStream()
  try {
    progress(request.jobId, 'transcribing', 0.48, 'Listening back on this device…')
    const boundaryPadding = Math.round(sampleRate * 0.5)
    const paddedSamples = new Float32Array(samples.length + boundaryPadding * 2)
    paddedSamples.set(samples, boundaryPadding)
    stream.acceptWaveform(sampleRate, paddedSamples)
    stream.inputFinished()
    progress(request.jobId, 'transcribing', 0.7, 'Turning speech into words…')
    let decodeSteps = 0
    while (recognizer.isReady(stream)) {
      recognizer.decode(stream)
      decodeSteps += 1
      if (decodeSteps > 100000) throw new Error('ASR decode did not converge')
    }
    progress(request.jobId, 'finalizing', 0.92, 'Polishing the editable transcript…')
    const result = recognizer.getResult(stream)
    return {
      rawText: typeof result.text === 'string' ? result.text.trim() : '',
      logProbabilities: Array.isArray(result.ys_probs) ? result.ys_probs : [],
      processingDurationMs: Math.max(0, Math.round(performance.now() - startedAt))
    }
  } finally {
    stream.free()
  }
}

function decodeReady(stream) {
  let decodeSteps = 0
  while (recognizer.isReady(stream)) {
    recognizer.decode(stream)
    decodeSteps += 1
    if (decodeSteps > 100000) throw new Error('ASR decode did not converge')
  }
}

function streamStart(request) {
  if (liveStream) throw new Error('Another live transcription is already active')
  loadRecognizer(request)
  const stream = recognizer.createStream()
  const leadingPadding = new Float32Array(Math.round(request.sampleRate * 0.35))
  stream.acceptWaveform(request.sampleRate, leadingPadding)
  decodeReady(stream)
  liveStream = {
    jobId: request.jobId,
    stream,
    sampleRate: request.sampleRate,
    sampleCount: 0,
    startedAt: performance.now(),
    lastText: ''
  }
  post({ type: 'stream-started', jobId: request.jobId, engineVersion: sherpa.version })
}

function streamAppend(request) {
  if (!liveStream || liveStream.jobId !== request.jobId) {
    throw new Error('The live transcription session is not active')
  }
  if (!(request.samples instanceof ArrayBuffer) || request.samples.byteLength === 0) {
    throw new Error('The live speech chunk is empty')
  }
  if (request.samples.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
    throw new Error('Live speech chunks must be Float32 PCM')
  }
  const samples = new Float32Array(request.samples)
  liveStream.stream.acceptWaveform(liveStream.sampleRate, samples)
  liveStream.sampleCount += samples.length
  decodeReady(liveStream.stream)
  const result = recognizer.getResult(liveStream.stream)
  const text = typeof result.text === 'string' ? result.text.trim() : ''
  if (text && text !== liveStream.lastText) {
    liveStream.lastText = text
    post({ type: 'partial-result', jobId: request.jobId, rawText: text })
  }
  post({ type: 'stream-chunk-result', jobId: request.jobId, acceptedSamples: samples.length })
}

function streamFinish(request) {
  if (!liveStream || liveStream.jobId !== request.jobId) {
    throw new Error('The live transcription session is not active')
  }
  const active = liveStream
  liveStream = null
  try {
    active.stream.acceptWaveform(
      active.sampleRate,
      new Float32Array(Math.round(active.sampleRate * 0.5))
    )
    active.stream.inputFinished()
    decodeReady(active.stream)
    const result = recognizer.getResult(active.stream)
    const rawText = typeof result.text === 'string' ? result.text.trim() : ''
    if (!rawText)
      throw new Error('No speech was detected. Try speaking a little closer to the microphone.')
    post({
      type: 'transcription-result',
      jobId: request.jobId,
      rawText,
      logProbabilities: Array.isArray(result.ys_probs) ? result.ys_probs : [],
      audioDurationMs: Math.max(1, Math.round((active.sampleCount / active.sampleRate) * 1000)),
      processingDurationMs: Math.max(0, Math.round(performance.now() - active.startedAt))
    })
  } finally {
    active.stream.free()
  }
}

function streamCancel(request) {
  if (!liveStream || liveStream.jobId !== request.jobId) return
  liveStream.stream.free()
  liveStream = null
  post({ type: 'stream-cancelled', jobId: request.jobId })
}

function samplesFromRequest(request) {
  if (!(request.samples instanceof ArrayBuffer)) throw new Error('ASR samples are invalid')
  if (request.samples.byteLength === 0 || request.samples.byteLength > 1920000) {
    throw new Error('ASR sample buffer is outside the supported duration')
  }
  if (request.samples.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
    throw new Error('ASR samples must be Float32 PCM')
  }
  return {
    samples: new Float32Array(request.samples),
    sampleRate: request.sampleRate,
    audioDurationMs: Math.round(
      (request.samples.byteLength / Float32Array.BYTES_PER_ELEMENT / request.sampleRate) * 1000
    )
  }
}

function samplesFromWave(request) {
  if (!sherpa || typeof request.wavePath !== 'string') throw new Error('Smoke audio is missing')
  const wave = sherpa.readWave(request.wavePath)
  return {
    samples: wave.samples,
    sampleRate: wave.sampleRate,
    audioDurationMs: Math.round((wave.samples.length / wave.sampleRate) * 1000)
  }
}

function handle(request) {
  assertRequest(request)
  if (request.type === 'stream-start') {
    streamStart(request)
    return
  }
  if (request.type === 'stream-chunk') {
    streamAppend(request)
    return
  }
  if (request.type === 'stream-finish') {
    streamFinish(request)
    return
  }
  if (request.type === 'stream-cancel') {
    streamCancel(request)
    return
  }
  loadRecognizer(request)
  if (request.type === 'warm') {
    post({
      type: 'warm-result',
      jobId: request.jobId,
      engineVersion: sherpa.version
    })
    return
  }
  if (request.type !== 'transcribe' && request.type !== 'transcribe-wave') {
    throw new Error(`Unsupported ASR request type: ${String(request.type)}`)
  }

  const audio =
    request.type === 'transcribe' ? samplesFromRequest(request) : samplesFromWave(request)
  const result = decodeSamples(request, audio.samples, audio.sampleRate)
  if (!result.rawText)
    throw new Error('No speech was detected. Try speaking a little closer to the microphone.')
  post({
    type: 'transcription-result',
    jobId: request.jobId,
    audioDurationMs: audio.audioDurationMs,
    ...result
  })
}

parentPort.on('message', (event) => {
  const request = event.data
  setImmediate(() => {
    try {
      handle(request)
    } catch (error) {
      post({
        type: 'error',
        jobId: request && typeof request.jobId === 'string' ? request.jobId : 'unknown',
        message: error instanceof Error ? error.message : 'Offline transcription failed'
      })
    }
  })
})

process.once('exit', () => {
  if (liveStream) liveStream.stream.free()
  if (recognizer) recognizer.free()
})
