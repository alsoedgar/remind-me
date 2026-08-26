import { maximumVoiceDurationSeconds, voiceSampleRate } from '@remind-me/contracts'

export interface VoiceRecorderCallbacks {
  onLevel: (level: number) => void
  onDuration: (durationMs: number) => void
  onMaximumDuration: () => void
  onChunk?: (samples: Float32Array) => void
}

export interface RecordedVoice {
  samples: Float32Array
  durationMs: number
}

function rootMeanSquare(samples: Float32Array): number {
  if (samples.length === 0) return 0
  let energy = 0
  for (const sample of samples) energy += sample * sample
  return Math.sqrt(energy / samples.length)
}

export function resamplePcm(
  samples: Float32Array,
  sourceSampleRate: number,
  targetSampleRate = voiceSampleRate
): Float32Array {
  if (sourceSampleRate === targetSampleRate) return new Float32Array(samples)
  if (samples.length === 0 || sourceSampleRate <= 0 || targetSampleRate <= 0) {
    return new Float32Array()
  }
  const targetLength = Math.max(
    1,
    Math.round(samples.length * (targetSampleRate / sourceSampleRate))
  )
  const output = new Float32Array(targetLength)
  const scale = sourceSampleRate / targetSampleRate
  for (let index = 0; index < targetLength; index += 1) {
    const position = index * scale
    const leftIndex = Math.min(samples.length - 1, Math.floor(position))
    const rightIndex = Math.min(samples.length - 1, leftIndex + 1)
    const fraction = position - leftIndex
    const left = samples[leftIndex] ?? 0
    const right = samples[rightIndex] ?? left
    output[index] = left + (right - left) * fraction
  }
  return output
}

function frameLevels(samples: Float32Array, frameSize: number): number[] {
  const levels: number[] = []
  for (let offset = 0; offset < samples.length; offset += frameSize) {
    levels.push(
      rootMeanSquare(samples.subarray(offset, Math.min(samples.length, offset + frameSize)))
    )
  }
  return levels
}

/** Removes DC/rumble, trims empty edges, and applies bounded gain without retaining audio. */
export function preprocessVoicePcm(samples: Float32Array): Float32Array {
  if (samples.length === 0) return samples
  let mean = 0
  for (const sample of samples) mean += Number.isFinite(sample) ? sample : 0
  mean /= samples.length

  const filtered = new Float32Array(samples.length)
  let previousInput = 0
  let previousOutput = 0
  let peak = 0
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index] ?? 0
    const input = Math.max(-1, Math.min(1, (Number.isFinite(sample) ? sample : 0) - mean))
    const output = input - previousInput + 0.995 * previousOutput
    filtered[index] = output
    previousInput = input
    previousOutput = output
    peak = Math.max(peak, Math.abs(output))
  }

  const frameSize = Math.round(voiceSampleRate * 0.02)
  const levels = frameLevels(filtered, frameSize)
  const sortedLevels = [...levels].sort((left, right) => left - right)
  const noiseFloor = sortedLevels[Math.floor(sortedLevels.length * 0.2)] ?? 0
  const activityThreshold = Math.max(0.004, Math.min(0.06, noiseFloor * 2.4))
  const firstActiveFrame = levels.findIndex((level) => level >= activityThreshold)
  let lastActiveFrame = -1
  for (let index = levels.length - 1; index >= 0; index -= 1) {
    if ((levels[index] ?? 0) >= activityThreshold) {
      lastActiveFrame = index
      break
    }
  }

  let trimmed = filtered
  if (firstActiveFrame >= 0 && lastActiveFrame >= firstActiveFrame) {
    const padding = Math.round(voiceSampleRate * 0.16)
    const start = Math.max(0, firstActiveFrame * frameSize - padding)
    const end = Math.min(filtered.length, (lastActiveFrame + 1) * frameSize + padding)
    trimmed = filtered.slice(start, end)
  }

  if (peak < 0.02 || peak >= 0.88) return trimmed
  const gain = Math.min(3.2, 0.82 / peak)
  if (gain <= 1.05) return trimmed
  const normalized = new Float32Array(trimmed.length)
  for (let index = 0; index < trimmed.length; index += 1) {
    normalized[index] = Math.max(-1, Math.min(1, (trimmed[index] ?? 0) * gain))
  }
  return normalized
}

function mergeChunks(chunks: readonly Float32Array[]): Float32Array {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0)
  const samples = new Float32Array(length)
  let offset = 0
  for (const chunk of chunks) {
    samples.set(chunk, offset)
    offset += chunk.length
  }
  return samples
}

export class VoiceRecorder {
  private stream: MediaStream | null = null
  private audioContext: AudioContext | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private worklet: AudioWorkletNode | null = null
  private silentGain: GainNode | null = null
  private readonly chunks: Float32Array[] = []
  private startedAt = 0
  private durationTimer: ReturnType<typeof setInterval> | null = null
  private liveChunkTimer: ReturnType<typeof setInterval> | null = null
  private readonly liveChunks: Float32Array[] = []
  private liveChunkCallback: ((samples: Float32Array) => void) | null = null
  private maximumTimer: ReturnType<typeof setTimeout> | null = null
  private flushResolver: (() => void) | null = null
  private stopped = false

  async start(callbacks: VoiceRecorderCallbacks): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone capture is not available on this device')
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      video: false
    })
    if (this.stopped) {
      this.stopTracks()
      return
    }

    this.audioContext = new AudioContext({
      latencyHint: 'interactive',
      sampleRate: voiceSampleRate
    })
    await this.audioContext.audioWorklet.addModule(
      new URL('/audio-capture-worklet.js', window.location.href).toString()
    )
    this.source = this.audioContext.createMediaStreamSource(this.stream)
    this.worklet = new AudioWorkletNode(this.audioContext, 'remind-me-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1]
    })
    this.silentGain = this.audioContext.createGain()
    this.silentGain.gain.value = 0
    this.worklet.port.onmessage = (event: MessageEvent<unknown>) => {
      if (event.data instanceof ArrayBuffer) {
        const samples = new Float32Array(event.data)
        this.chunks.push(samples)
        this.liveChunks.push(samples)
        callbacks.onLevel(Math.min(1, rootMeanSquare(samples) * 8))
      } else if (
        event.data &&
        typeof event.data === 'object' &&
        'type' in event.data &&
        event.data.type === 'flushed'
      ) {
        this.flushResolver?.()
        this.flushResolver = null
      }
    }
    this.source.connect(this.worklet)
    this.worklet.connect(this.silentGain)
    this.silentGain.connect(this.audioContext.destination)
    await this.audioContext.resume()

    this.startedAt = performance.now()
    this.liveChunkCallback = callbacks.onChunk ?? null
    if (this.liveChunkCallback) {
      this.liveChunkTimer = setInterval(() => this.emitLiveChunk(), 420)
    }
    this.durationTimer = setInterval(() => {
      callbacks.onDuration(Math.round(performance.now() - this.startedAt))
    }, 100)
    this.maximumTimer = setTimeout(callbacks.onMaximumDuration, maximumVoiceDurationSeconds * 1000)
  }

  private emitLiveChunk(): void {
    if (!this.liveChunkCallback || this.liveChunks.length === 0) return
    const pending = mergeChunks(this.liveChunks.splice(0))
    const sourceSampleRate = this.audioContext?.sampleRate ?? voiceSampleRate
    const resampled = resamplePcm(pending, sourceSampleRate)
    if (resampled.length > 0) this.liveChunkCallback(resampled)
  }

  private async flush(): Promise<void> {
    if (!this.worklet) return
    await new Promise<void>((resolveFlush) => {
      const fallback = setTimeout(resolveFlush, 250)
      this.flushResolver = () => {
        clearTimeout(fallback)
        resolveFlush()
      }
      this.worklet?.port.postMessage({ type: 'flush' })
    })
  }

  async stop(): Promise<RecordedVoice> {
    if (this.stopped) throw new Error('Voice recorder has already stopped')
    this.stopped = true
    await this.flush()
    this.emitLiveChunk()
    const sourceSampleRate = this.audioContext?.sampleRate ?? voiceSampleRate
    const durationMs = this.startedAt ? Math.round(performance.now() - this.startedAt) : 0
    const merged = mergeChunks(this.chunks)
    this.cleanup()
    const resampled = resamplePcm(merged, sourceSampleRate)
    return { samples: preprocessVoicePcm(resampled), durationMs }
  }

  cancel(): void {
    if (this.stopped) return
    this.stopped = true
    this.chunks.length = 0
    this.liveChunks.length = 0
    this.cleanup()
  }

  private stopTracks(): void {
    for (const track of this.stream?.getTracks() ?? []) track.stop()
    this.stream = null
  }

  private cleanup(): void {
    if (this.durationTimer) clearInterval(this.durationTimer)
    if (this.maximumTimer) clearTimeout(this.maximumTimer)
    if (this.liveChunkTimer) clearInterval(this.liveChunkTimer)
    this.durationTimer = null
    this.maximumTimer = null
    this.liveChunkTimer = null
    this.liveChunkCallback = null
    this.source?.disconnect()
    this.worklet?.disconnect()
    this.silentGain?.disconnect()
    this.stopTracks()
    void this.audioContext?.close()
    this.source = null
    this.worklet = null
    this.silentGain = null
    this.audioContext = null
  }
}
