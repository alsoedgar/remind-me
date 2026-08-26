import { utilityProcess, type UtilityProcess } from 'electron'
import { dirname } from 'node:path'
import {
  maximumVoiceDurationSeconds,
  voiceProgressEventSchema,
  voiceRuntimeInfoSchema,
  voiceTranscriptionResultSchema,
  type VoiceProgressEvent,
  type VoiceRuntimeInfo,
  type VoiceStreamChunkRequest,
  type VoiceStreamStartRequest,
  type VoiceTranscriptionRequest,
  type VoiceTranscriptionResult
} from '@remind-me/contracts'
import {
  confidenceFromLogProbabilities,
  getSpeechRecognitionModel,
  loadModelManifest,
  normalizeVoiceTranscript,
  verifyModelManifest,
  type ModelManifest,
  type SpeechRecognitionModelFiles
} from '@remind-me/model-runtime'

export interface VoiceRuntimePaths {
  workerEntry: string
  runtimeEntry: string
  modelRoot: string
}

export const defaultVoiceIdleTimeoutMs = 2 * 60 * 1_000

interface VerifiedInstallation {
  manifest: ModelManifest
  model: SpeechRecognitionModelFiles
}

interface WorkerProgressMessage {
  type: 'progress'
  jobId: string
  stage: VoiceProgressEvent['stage']
  progress: number
  message: string
}

interface WorkerWarmResult {
  type: 'warm-result'
  jobId: string
  engineVersion: string
}

interface WorkerTranscriptionResult {
  type: 'transcription-result'
  jobId: string
  rawText: string
  logProbabilities: number[]
  audioDurationMs: number
  processingDurationMs: number
}

interface WorkerError {
  type: 'error'
  jobId: string
  message: string
}

interface WorkerStreamStarted {
  type: 'stream-started'
  jobId: string
  engineVersion: string
}

interface WorkerPartialResult {
  type: 'partial-result'
  jobId: string
  rawText: string
}

interface WorkerStreamChunkResult {
  type: 'stream-chunk-result'
  jobId: string
  acceptedSamples: number
}

interface WorkerStreamCancelled {
  type: 'stream-cancelled'
  jobId: string
}

type WorkerMessage =
  | WorkerProgressMessage
  | WorkerWarmResult
  | WorkerTranscriptionResult
  | WorkerError
  | WorkerStreamStarted
  | WorkerPartialResult
  | WorkerStreamChunkResult
  | WorkerStreamCancelled

interface ActiveJob {
  jobId: string
  kind: 'warm' | 'transcribe' | 'smoke'
  onProgress: (event: VoiceProgressEvent) => void
  resolve: (value: WorkerWarmResult | WorkerTranscriptionResult) => void
  reject: (reason: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

interface PendingJob {
  jobId: string
  onProgress: (event: VoiceProgressEvent) => void
}

interface ActiveStream {
  jobId: string
  onProgress: (event: VoiceProgressEvent) => void
  sampleCount: number
  started: boolean
  startResolve: () => void
  startReject: (reason: Error) => void
  finishResolve: ((value: WorkerTranscriptionResult) => void) | null
  finishReject: ((reason: Error) => void) | null
  timeout: ReturnType<typeof setTimeout>
}

export class VoiceCancellationError extends Error {
  constructor() {
    super('Voice transcription was cancelled')
    this.name = 'VoiceCancellationError'
  }
}

function isWorkerMessage(value: unknown): value is WorkerMessage {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<WorkerMessage>
  return typeof candidate.type === 'string' && typeof candidate.jobId === 'string'
}

export class OfflineVoiceRuntime {
  private child: UtilityProcess | null = null
  private childPromise: Promise<UtilityProcess> | null = null
  private activeJob: ActiveJob | null = null
  private activeStream: ActiveStream | null = null
  private pendingJob: PendingJob | null = null
  private readonly cancelledPendingJobIds = new Set<string>()
  private loaded = false
  private engineVersion = '1.13.6'
  private readonly installation: Promise<VerifiedInstallation>
  private idleTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly paths: VoiceRuntimePaths,
    private readonly idleTimeoutMs = defaultVoiceIdleTimeoutMs
  ) {
    this.installation = this.verifyInstallation()
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  private scheduleIdleUnload(): void {
    this.clearIdleTimer()
    if (!this.child || this.activeJob || this.activeStream || this.pendingJob) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      this.unload()
    }, this.idleTimeoutMs)
    this.idleTimer.unref?.()
  }

  unload(): boolean {
    if (this.activeJob || this.activeStream || this.pendingJob) return false
    this.clearIdleTimer()
    const child = this.child
    this.child = null
    this.childPromise = null
    this.loaded = false
    child?.kill()
    return Boolean(child)
  }

  private async verifyInstallation(): Promise<VerifiedInstallation> {
    const manifest = await loadModelManifest(this.paths.modelRoot)
    const verification = await verifyModelManifest(this.paths.modelRoot, manifest)
    if (!verification.valid) {
      const failures = verification.artifacts
        .filter((artifact) => !artifact.valid && artifact.artifact.required)
        .map((artifact) => `${artifact.artifact.id}: ${artifact.error ?? 'invalid'}`)
      throw new Error(`Offline voice model verification failed. ${failures.join('; ')}`)
    }
    return { manifest, model: getSpeechRecognitionModel(this.paths.modelRoot, manifest) }
  }

  async getInfo(): Promise<VoiceRuntimeInfo> {
    try {
      const installation = await this.installation
      return voiceRuntimeInfoSchema.parse({
        available: true,
        loaded: this.loaded,
        engine: 'sherpa-onnx-wasm',
        engineVersion: this.engineVersion || installation.manifest.runtime.version,
        modelId: installation.model.id,
        locale: installation.model.locale,
        modelBytes: installation.model.totalBytes,
        isolation: 'electron-utility-process',
        requiresNetwork: false,
        maximumDurationSeconds: maximumVoiceDurationSeconds,
        idleUnloadSeconds: Math.max(1, Math.round(this.idleTimeoutMs / 1_000)),
        unloadsWhenIdle: true,
        error: null
      })
    } catch (error) {
      return voiceRuntimeInfoSchema.parse({
        available: false,
        loaded: false,
        engine: 'sherpa-onnx-wasm',
        engineVersion: this.engineVersion,
        modelId: 'sherpa-zipformer-en-20m-int8',
        locale: 'en-US',
        modelBytes: 45_414_118,
        isolation: 'electron-utility-process',
        requiresNetwork: false,
        maximumDurationSeconds: maximumVoiceDurationSeconds,
        idleUnloadSeconds: Math.max(1, Math.round(this.idleTimeoutMs / 1_000)),
        unloadsWhenIdle: true,
        error: error instanceof Error ? error.message : 'Offline voice is unavailable'
      })
    }
  }

  private async ensureChild(): Promise<UtilityProcess> {
    if (this.child) return this.child
    if (this.childPromise) return await this.childPromise

    this.childPromise = new Promise((resolveChild, reject) => {
      const child = utilityProcess.fork(this.paths.workerEntry, [], {
        cwd: dirname(this.paths.workerEntry),
        serviceName: 'Remind Me Offline Speech',
        stdio: 'pipe'
      })
      this.child = child
      child.stdout?.on('data', (data: Buffer) => console.debug(`[voice] ${data.toString().trim()}`))
      child.stderr?.on('data', (data: Buffer) => console.error(`[voice] ${data.toString().trim()}`))
      child.on('message', (message: unknown) => this.handleWorkerMessage(message))
      child.once('spawn', () => resolveChild(child))
      child.once('exit', (code) => {
        if (this.child !== child) return
        this.child = null
        this.childPromise = null
        this.loaded = false
        if (this.activeJob) {
          this.failActiveJob(new Error(`Offline speech process exited (${code}).`))
        }
        if (this.activeStream) {
          this.failActiveStream(new Error(`Offline speech process exited (${code}).`))
        }
      })
      child.once('error', () => {
        if (this.child === child) {
          this.child = null
          this.childPromise = null
        }
        reject(new Error('Could not start the offline speech process'))
      })
    })

    try {
      return await this.childPromise
    } finally {
      this.childPromise = null
    }
  }

  private failActiveJob(error: Error): void {
    const job = this.activeJob
    if (!job) return
    clearTimeout(job.timeout)
    this.activeJob = null
    job.reject(error)
  }

  private completeActiveJob(result: WorkerWarmResult | WorkerTranscriptionResult): void {
    const job = this.activeJob
    if (!job || job.jobId !== result.jobId) return
    clearTimeout(job.timeout)
    this.activeJob = null
    job.resolve(result)
    this.scheduleIdleUnload()
  }

  private failActiveStream(error: Error): void {
    const stream = this.activeStream
    if (!stream) return
    clearTimeout(stream.timeout)
    this.activeStream = null
    if (!stream.started) stream.startReject(error)
    stream.finishReject?.(error)
    this.scheduleIdleUnload()
  }

  private completeActiveStream(result: WorkerTranscriptionResult): void {
    const stream = this.activeStream
    if (!stream || stream.jobId !== result.jobId) return
    clearTimeout(stream.timeout)
    this.activeStream = null
    stream.finishResolve?.(result)
    this.scheduleIdleUnload()
  }

  private handleWorkerMessage(value: unknown): void {
    if (!isWorkerMessage(value)) return
    const stream = this.activeStream
    if (stream && value.jobId === stream.jobId) {
      if (value.type === 'progress') {
        stream.onProgress(
          voiceProgressEventSchema.parse({
            jobId: value.jobId,
            stage: value.stage,
            progress: value.progress,
            message: value.message
          })
        )
      } else if (value.type === 'stream-started') {
        stream.started = true
        this.loaded = true
        this.engineVersion = value.engineVersion
        stream.startResolve()
      } else if (value.type === 'partial-result') {
        const partialText = normalizeVoiceTranscript(value.rawText)
        if (partialText) {
          stream.onProgress(
            voiceProgressEventSchema.parse({
              jobId: stream.jobId,
              stage: 'transcribing',
              progress: Math.min(
                0.88,
                0.24 + (stream.sampleCount / (16_000 * maximumVoiceDurationSeconds)) * 0.64
              ),
              message: 'Transcribing live on this device…',
              partialText
            })
          )
        }
      } else if (value.type === 'transcription-result') {
        this.completeActiveStream(value)
      } else if (value.type === 'error') {
        this.failActiveStream(new Error(value.message))
      }
      return
    }
    const job = this.activeJob
    if (!job || value.jobId !== job.jobId) return
    if (value.type === 'progress') {
      job.onProgress(
        voiceProgressEventSchema.parse({
          jobId: value.jobId,
          stage: value.stage,
          progress: value.progress,
          message: value.message
        })
      )
    } else if (value.type === 'error') {
      this.failActiveJob(new Error(value.message))
    } else if (value.type === 'warm-result' || value.type === 'transcription-result') {
      if (value.type === 'warm-result') {
        this.loaded = true
        this.engineVersion = value.engineVersion
      }
      this.completeActiveJob(value)
    }
  }

  private async runWorker(
    jobId: string,
    kind: ActiveJob['kind'],
    payload: Record<string, unknown>,
    onProgress: (event: VoiceProgressEvent) => void
  ): Promise<WorkerWarmResult | WorkerTranscriptionResult> {
    if (this.activeJob || this.activeStream || this.pendingJob) {
      throw new Error('Another voice request is already running')
    }
    this.clearIdleTimer()
    this.pendingJob = { jobId, onProgress }
    onProgress(
      voiceProgressEventSchema.parse({
        jobId,
        stage: 'queued',
        progress: 0.02,
        message: 'Keeping your recording on this device…'
      })
    )

    try {
      const installation = await this.installation
      if (this.cancelledPendingJobIds.has(jobId)) throw new VoiceCancellationError()
      const child = await this.ensureChild()
      if (this.cancelledPendingJobIds.has(jobId)) {
        if (this.child === child) {
          child.kill()
          this.child = null
          this.loaded = false
        }
        throw new VoiceCancellationError()
      }

      this.pendingJob = null
      return await new Promise((resolveResult, reject) => {
        const timeout = setTimeout(() => {
          this.failActiveJob(new Error('Offline transcription timed out'))
          this.child?.kill()
        }, 90_000)
        this.activeJob = {
          jobId,
          kind,
          onProgress,
          resolve: resolveResult,
          reject,
          timeout
        }
        child.postMessage({
          ...payload,
          jobId,
          runtimeEntry: this.paths.runtimeEntry,
          model: installation.model
        })
      })
    } finally {
      if (this.pendingJob?.jobId === jobId) this.pendingJob = null
      this.cancelledPendingJobIds.delete(jobId)
    }
  }

  async warm(
    jobId: string,
    onProgress: (event: VoiceProgressEvent) => void
  ): Promise<VoiceRuntimeInfo> {
    if (!this.loaded) await this.runWorker(jobId, 'warm', { type: 'warm' }, onProgress)
    else this.scheduleIdleUnload()
    return await this.getInfo()
  }

  async startStream(
    request: VoiceStreamStartRequest,
    onProgress: (event: VoiceProgressEvent) => void
  ): Promise<{ jobId: string; started: true }> {
    if (this.activeJob || this.activeStream || this.pendingJob) {
      throw new Error('Another voice request is already running')
    }
    this.clearIdleTimer()
    this.pendingJob = { jobId: request.jobId, onProgress }
    onProgress(
      voiceProgressEventSchema.parse({
        jobId: request.jobId,
        stage: 'queued',
        progress: 0.02,
        message: 'Starting private live transcription…'
      })
    )
    try {
      const installation = await this.installation
      if (this.cancelledPendingJobIds.has(request.jobId)) throw new VoiceCancellationError()
      const child = await this.ensureChild()
      if (this.cancelledPendingJobIds.has(request.jobId)) throw new VoiceCancellationError()
      this.pendingJob = null
      await new Promise<void>((resolveStart, rejectStart) => {
        const timeout = setTimeout(() => {
          child.postMessage({ type: 'stream-cancel', jobId: request.jobId })
          this.failActiveStream(new Error('Live transcription took too long to start'))
        }, 75_000)
        this.activeStream = {
          jobId: request.jobId,
          onProgress,
          sampleCount: 0,
          started: false,
          startResolve: resolveStart,
          startReject: rejectStart,
          finishResolve: null,
          finishReject: null,
          timeout
        }
        child.postMessage({
          type: 'stream-start',
          jobId: request.jobId,
          sampleRate: request.sampleRate,
          runtimeEntry: this.paths.runtimeEntry,
          model: installation.model
        })
      })
      return { jobId: request.jobId, started: true }
    } finally {
      if (this.pendingJob?.jobId === request.jobId) this.pendingJob = null
      this.cancelledPendingJobIds.delete(request.jobId)
    }
  }

  appendStream(request: VoiceStreamChunkRequest): {
    jobId: string
    acceptedSamples: number
  } {
    const stream = this.activeStream
    if (!stream || stream.jobId !== request.jobId || !stream.started || !this.child) {
      throw new Error('The live transcription session is not active')
    }
    const acceptedSamples = request.samples.byteLength / Float32Array.BYTES_PER_ELEMENT
    if (stream.sampleCount + acceptedSamples > 16_000 * maximumVoiceDurationSeconds) {
      throw new Error(`Voice recording exceeds ${maximumVoiceDurationSeconds} seconds`)
    }
    stream.sampleCount += acceptedSamples
    this.child.postMessage({
      type: 'stream-chunk',
      jobId: request.jobId,
      samples: request.samples
    })
    return { jobId: request.jobId, acceptedSamples }
  }

  async finishStream(jobId: string): Promise<VoiceTranscriptionResult> {
    const stream = this.activeStream
    if (!stream || stream.jobId !== jobId || !stream.started || !this.child) {
      throw new Error('The live transcription session is not active')
    }
    stream.onProgress(
      voiceProgressEventSchema.parse({
        jobId,
        stage: 'finalizing',
        progress: 0.9,
        message: 'Finishing the live transcript…'
      })
    )
    const raw = await new Promise<WorkerTranscriptionResult>((resolveResult, rejectResult) => {
      stream.finishResolve = resolveResult
      stream.finishReject = rejectResult
      this.child?.postMessage({ type: 'stream-finish', jobId })
    })
    const installation = await this.installation
    const text = normalizeVoiceTranscript(raw.rawText)
    if (!text)
      throw new Error('No speech was detected. Try speaking a little closer to the microphone.')
    return voiceTranscriptionResultSchema.parse({
      jobId,
      text,
      rawText: raw.rawText,
      confidence: confidenceFromLogProbabilities(raw.logProbabilities),
      audioDurationMs: raw.audioDurationMs,
      processingDurationMs: raw.processingDurationMs,
      locale: installation.model.locale,
      engine: 'sherpa-onnx-wasm',
      modelId: installation.model.id
    })
  }

  async transcribe(
    request: VoiceTranscriptionRequest,
    onProgress: (event: VoiceProgressEvent) => void
  ): Promise<VoiceTranscriptionResult> {
    const result = await this.runWorker(
      request.jobId,
      'transcribe',
      { type: 'transcribe', samples: request.samples, sampleRate: request.sampleRate },
      onProgress
    )
    if (result.type !== 'transcription-result') throw new Error('Unexpected voice worker result')
    this.loaded = true
    const installation = await this.installation
    const text = normalizeVoiceTranscript(result.rawText)
    if (!text)
      throw new Error('No speech was detected. Try speaking a little closer to the microphone.')
    onProgress(
      voiceProgressEventSchema.parse({
        jobId: request.jobId,
        stage: 'complete',
        progress: 1,
        message: 'Transcript ready to edit.'
      })
    )
    return voiceTranscriptionResultSchema.parse({
      jobId: request.jobId,
      text,
      rawText: result.rawText,
      confidence: confidenceFromLogProbabilities(result.logProbabilities),
      audioDurationMs: result.audioDurationMs,
      processingDurationMs: result.processingDurationMs,
      locale: installation.model.locale,
      engine: 'sherpa-onnx-wasm',
      modelId: installation.model.id
    })
  }

  async smokeTest(): Promise<boolean> {
    const jobId = 'voice-smoke'
    const installation = await this.installation
    const result = await this.runWorker(
      jobId,
      'smoke',
      { type: 'transcribe-wave', wavePath: installation.model.smokeAudio },
      () => undefined
    )
    return (
      result.type === 'transcription-result' && /yellow lamps would light up/iu.test(result.rawText)
    )
  }

  cancel(jobId: string): boolean {
    const job = this.activeJob
    const stream = this.activeStream
    const pending = this.pendingJob
    const progressTarget =
      job?.jobId === jobId
        ? job
        : stream?.jobId === jobId
          ? stream
          : pending?.jobId === jobId
            ? pending
            : null
    if (!progressTarget) return false
    progressTarget.onProgress(
      voiceProgressEventSchema.parse({
        jobId,
        stage: 'cancelled',
        progress: 0,
        message: 'Voice input cancelled. The recording was discarded.'
      })
    )
    if (!job || job.jobId !== jobId) {
      if (stream?.jobId === jobId) {
        this.child?.postMessage({ type: 'stream-cancel', jobId })
        clearTimeout(stream.timeout)
        this.activeStream = null
        if (!stream.started) stream.startReject(new VoiceCancellationError())
        stream.finishReject?.(new VoiceCancellationError())
        this.scheduleIdleUnload()
        return true
      }
      this.cancelledPendingJobIds.add(jobId)
      return true
    }
    this.failActiveJob(new VoiceCancellationError())
    this.clearIdleTimer()
    const child = this.child
    this.child = null
    this.loaded = false
    child?.kill()
    return true
  }

  dispose(): void {
    if (this.pendingJob) this.cancelledPendingJobIds.add(this.pendingJob.jobId)
    this.failActiveJob(new Error('Application is closing'))
    this.failActiveStream(new Error('Application is closing'))
    this.clearIdleTimer()
    this.child?.kill()
    this.child = null
    this.loaded = false
  }
}
