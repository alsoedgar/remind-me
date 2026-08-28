import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { freemem } from 'node:os'
import { resolve } from 'node:path'
import { utilityProcess, type UtilityProcess } from 'electron'
import {
  flexModelChatRequestSchema,
  flexModelChatResponseSchema,
  flexModelAccelerationPreferenceSchema,
  flexModelBackendSchema,
  flexModelCalendarFallbackResultSchema,
  flexModelConfigureRequestSchema,
  flexModelGeneralFallbackResultSchema,
  flexModelJobStatusSchema,
  flexModelPlanSchema,
  flexModelPlanContextSchema,
  flexModelProgressEventSchema,
  flexModelRequestMetricsSchema,
  flexModelStatusSchema,
  flexModelWarmthPolicySchema,
  documentFallbackModelOutputSchema,
  documentFallbackRequestSchema,
  documentRepairModelOutputSchema,
  documentRepairRequestSchema,
  type FlexModelChatRequest,
  type FlexModelChatResponse,
  type FlexModelAccelerationPreference,
  type FlexModelBackend,
  type FlexModelCalendarFallbackResult,
  type FlexModelFallbackFailureKind,
  type FlexModelGeneralFallbackResult,
  type FlexModelJobStatus,
  type FlexModelPlan,
  type FlexModelPlanContext,
  type FlexModelProgressEvent,
  type FlexModelRequestMetrics,
  type FlexModelStatus,
  type FlexModelWarmthPolicy,
  type FlexModelWorkload,
  type DocumentFallbackRequest,
  type DocumentFallbackResponse,
  type DocumentRepairRequest,
  type DocumentRepairResponse
} from '@remind-me/contracts'
import {
  validateDocumentFallbackResponse,
  validateDocumentRepairResponse
} from '@remind-me/importers/document'
import { currentFlexModelRuntimeProfile, type FlexModelRuntimeProfile } from './flex-model-profile'
import {
  FlexModelJobCancelledError,
  FlexModelScheduler,
  isFlexModelCancellation,
  isFlexModelPreemption
} from './flex-model-scheduler'

const MODEL_ID = 'qwen3-1.7b-q4' as const
const MODEL_NAME = 'Qwen3 1.7B Q4' as const
const MODEL_FILE = 'Qwen3-1.7B-Q4_K_M.gguf'
const MODEL_BYTES = 1_282_439_264
const MODEL_SHA256 = 'd2387ca2dbfee2ffabce7120d3770dadca0b293052bc2f0e138fdc940d9bc7b5'
const MODEL_URL =
  'https://huggingface.co/ggml-org/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q4_K_M.gguf?download=true'
const GIBIBYTE = 1_024 * 1_024 * 1_024

function pressureAdjustedIdleUnloadMs(profile: FlexModelRuntimeProfile): number {
  // Re-check pressure after inference: a large-memory machine can still need
  // the mmap and KV cache released promptly when other applications become busy.
  if (freemem() < 3 * GIBIBYTE) return Math.min(profile.idleUnloadMs, 90_000)
  return profile.idleUnloadMs
}

interface PersistedState {
  enabled: boolean
  warmthPolicy: FlexModelWarmthPolicy
  accelerationPreference: FlexModelAccelerationPreference
}

type RuntimeState = 'idle' | 'downloading' | 'loading' | 'ready' | 'error'

function fallbackFailureFromStatus(
  status: Pick<FlexModelStatus, 'state' | 'enabled' | 'error'>,
  defaultKind: 'not-calendar' | 'invalid-output'
): FlexModelFallbackFailureKind | 'not-calendar' {
  if (status.state === 'not-installed') return 'missing'
  if (!status.enabled) return 'disabled'
  const error = status.error ?? ''
  if (/tim(?:e|ed)[ -]?out/iu.test(error)) return 'timeout'
  if (status.state === 'error' || error) {
    return /(?:invalid|parse|schema|json|expected|unrecognized|ground)/iu.test(error)
      ? 'invalid-output'
      : 'unavailable'
  }
  return defaultKind
}

export interface FlexModelRuntimePaths {
  workerEntry: string
  runtimeEntry: string
  backendManifest?: string
}

export interface FlexModelInferenceOptions {
  cancellationId?: string
  onStatus?: (status: FlexModelJobStatus) => void
}

interface WorkerPlanResult {
  type: 'plan-result'
  jobId: string
  plan: unknown
  metrics?: unknown
}

interface WorkerChatResult {
  type: 'chat-result'
  jobId: string
  response: unknown
  metrics?: unknown
}

interface WorkerChatChunk {
  type: 'chat-chunk'
  jobId: string
  text: unknown
}

interface WorkerStatusResult {
  type: 'status'
  jobId: string
  phase: 'generating' | 'validating'
}

interface WorkerCancelledResult {
  type: 'cancelled'
  jobId: string
}

interface WorkerDocumentRepairResult {
  type: 'document-repair-result'
  jobId: string
  repair: unknown
  metrics?: unknown
}

interface WorkerDocumentFallbackResult {
  type: 'document-fallback-result'
  jobId: string
  fallback: unknown
  metrics?: unknown
}

interface WorkerErrorResult {
  type: 'error'
  jobId: string
  message: string
}

type WorkerResult =
  | WorkerPlanResult
  | WorkerChatChunk
  | WorkerStatusResult
  | WorkerCancelledResult
  | WorkerChatResult
  | WorkerDocumentRepairResult
  | WorkerDocumentFallbackResult
  | WorkerErrorResult

interface ActiveWorkerJob {
  jobId: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
  onChatChunk: ((text: string) => void) | undefined
  onStatus: ((status: FlexModelJobStatus) => void) | undefined
  workload: FlexModelWorkload
  signal: AbortSignal
  removeAbortListener: () => void
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The optional model could not finish that task.'
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  )
}

async function fileSha256(path: string): Promise<string> {
  return await new Promise((resolveHash, rejectHash) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path, { highWaterMark: 4 * 1_024 * 1_024 })
    stream.on('data', (chunk) => hash.update(chunk))
    stream.once('error', rejectHash)
    stream.once('end', () => resolveHash(hash.digest('hex')))
  })
}

export class OptionalFlexModelRuntime {
  private readonly modelDirectory: string
  private readonly modelPath: string
  private readonly partialPath: string
  private readonly statePath: string
  private runtimeState: RuntimeState = 'idle'
  private enabled: boolean | null = null
  private downloadedBytes = 0
  private lastError: string | null = null
  private installController: AbortController | null = null
  private installPromise: Promise<FlexModelStatus> | null = null
  private readonly scheduler = new FlexModelScheduler()
  private verifiedSignature: string | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private child: UtilityProcess | null = null
  private childPromise: Promise<UtilityProcess> | null = null
  private activeWorkerJob: ActiveWorkerJob | null = null
  private activeProfile: FlexModelRuntimeProfile | null = null
  private lastRequest: FlexModelRequestMetrics | null = null
  private warmthPolicy: FlexModelWarmthPolicy | null = null
  private accelerationPreference: FlexModelAccelerationPreference | null = null
  private availableBackends: FlexModelBackend[] | null = null

  constructor(
    userDataPath: string,
    private readonly paths: FlexModelRuntimePaths
  ) {
    this.modelDirectory = resolve(userDataPath, 'optional-models', MODEL_ID)
    this.modelPath = resolve(this.modelDirectory, MODEL_FILE)
    this.partialPath = resolve(this.modelDirectory, `${MODEL_FILE}.part`)
    this.statePath = resolve(this.modelDirectory, 'state.json')
  }

  async getStatus(): Promise<FlexModelStatus> {
    await this.loadPersistedState()
    await this.loadAvailableBackends()
    const profile = this.activeProfile ?? this.currentProfile()
    const installedBytes = await this.installedBytes()
    const installed = installedBytes === MODEL_BYTES
    const state =
      this.runtimeState === 'downloading'
        ? 'downloading'
        : this.runtimeState === 'loading'
          ? 'loading'
          : this.runtimeState === 'ready'
            ? 'ready'
            : this.runtimeState === 'error'
              ? 'error'
              : installed
                ? 'installed'
                : 'not-installed'
    return flexModelStatusSchema.parse({
      modelId: MODEL_ID,
      displayName: MODEL_NAME,
      state,
      enabled: Boolean(this.enabled && installed),
      installedBytes: this.runtimeState === 'downloading' ? this.downloadedBytes : installedBytes,
      downloadBytes: MODEL_BYTES,
      progress:
        this.runtimeState === 'downloading'
          ? Math.min(1, this.downloadedBytes / MODEL_BYTES)
          : installed
            ? 1
            : 0,
      license: 'Apache-2.0',
      runtime: 'node-llama-cpp',
      networkRequiredForInstall: true,
      networkRequiredAfterInstall: false,
      profile: {
        id: profile.id,
        label: profile.label,
        backend: profile.backend,
        threads: profile.threads,
        contextSize: profile.contextSize,
        sequences: profile.sequences,
        batchSize: profile.batchSize,
        maxChatTokens: profile.maxChatTokens,
        idleUnloadSeconds: Math.round(pressureAdjustedIdleUnloadMs(profile) / 1_000),
        requestTimeoutSeconds: Math.round(profile.requestTimeoutMs / 1_000)
      },
      warmthPolicy: this.warmthPolicy ?? 'automatic',
      accelerationPreference: this.accelerationPreference ?? 'auto',
      availableBackends: this.availableBackends ?? ['cpu'],
      queue: this.scheduler.snapshot(),
      lastRequest: this.lastRequest,
      error: this.lastError
    })
  }

  async install(onProgress?: (event: FlexModelProgressEvent) => void): Promise<FlexModelStatus> {
    if (this.installPromise) return await this.installPromise
    this.installPromise = this.download(onProgress).finally(() => {
      this.installPromise = null
      this.installController = null
    })
    return await this.installPromise
  }

  async cancelInstall(): Promise<FlexModelStatus> {
    this.installController?.abort()
    if (this.installPromise) await this.installPromise.catch(() => undefined)
    return await this.getStatus()
  }

  async remove(): Promise<FlexModelStatus> {
    await this.cancelInstall()
    await this.unload()
    await Promise.all([
      unlink(this.modelPath).catch(() => undefined),
      unlink(this.partialPath).catch(() => undefined)
    ])
    this.enabled = false
    this.verifiedSignature = null
    this.lastRequest = null
    this.lastError = null
    this.runtimeState = 'idle'
    await this.persistState()
    return await this.getStatus()
  }

  async setEnabled(enabled: boolean): Promise<FlexModelStatus> {
    const installed = (await this.installedBytes()) === MODEL_BYTES
    if (enabled && !installed) throw new Error('Install the flexible language pack first.')
    this.enabled = enabled
    this.lastError = null
    if (!enabled) await this.unload()
    this.runtimeState = 'idle'
    await this.persistState()
    return await this.getStatus()
  }

  async configure(inputValue: unknown): Promise<FlexModelStatus> {
    const input = flexModelConfigureRequestSchema.parse(inputValue)
    await this.loadPersistedState()
    await this.loadAvailableBackends()
    const previousProfileKey = JSON.stringify(this.currentProfile())
    if (input.warmthPolicy) this.warmthPolicy = input.warmthPolicy
    if (input.accelerationPreference) {
      this.accelerationPreference = input.accelerationPreference
    }
    const nextProfileKey = JSON.stringify(this.currentProfile())
    if (previousProfileKey !== nextProfileKey) await this.unload()
    else if (this.child) this.scheduleIdleUnload()
    this.lastError = null
    await this.persistState()
    return await this.getStatus()
  }

  cancelInference(cancellationId: string): boolean {
    return this.scheduler.cancel(cancellationId)
  }

  async plan(
    text: string,
    contextValue: FlexModelPlanContext,
    options: FlexModelInferenceOptions = {}
  ): Promise<FlexModelPlan | null> {
    if (!text.trim() || text.length > 2_000) return null
    const planContext = flexModelPlanContextSchema.parse(contextValue)
    const status = await this.getStatus()
    // `enabled` is reported only when the complete pinned model is present. Do
    // not permanently lock inference after a transient worker error: the next
    // request gets one clean, serialized retry and can recover without a
    // reinstall or application restart.
    if (!status.enabled) return null

    try {
      return await this.scheduler.enqueue({
        workload: 'plan',
        ...options,
        run: async ({ signal, queueWaitMs }) =>
          await this.infer(text, planContext, signal, queueWaitMs, options.onStatus)
      })
    } catch (error) {
      if (isFlexModelCancellation(error)) throw error
      return null
    }
  }

  async planCalendar(
    text: string,
    contextValue: FlexModelPlanContext,
    options: FlexModelInferenceOptions = {}
  ): Promise<FlexModelCalendarFallbackResult> {
    try {
      const status = await this.getStatus()
      if (status.state === 'not-installed' || !status.enabled) {
        return flexModelCalendarFallbackResultSchema.parse({
          kind: fallbackFailureFromStatus(status, 'not-calendar')
        })
      }
      const plan = await this.plan(text, contextValue, options)
      if (plan) return flexModelCalendarFallbackResultSchema.parse({ kind: 'plan', plan })
      const finalStatus = await this.getStatus()
      return flexModelCalendarFallbackResultSchema.parse({
        kind: fallbackFailureFromStatus(finalStatus, 'not-calendar')
      })
    } catch (error) {
      if (isFlexModelCancellation(error)) return { kind: 'cancelled' }
      return { kind: 'invalid-output' }
    }
  }

  async chat(
    inputValue: FlexModelChatRequest,
    onChunk?: (text: string) => void,
    options: FlexModelInferenceOptions = {}
  ): Promise<string | null> {
    const response = await this.chatEnvelope(inputValue, onChunk, options)
    return response?.text ?? null
  }

  private async chatEnvelope(
    inputValue: FlexModelChatRequest,
    onChunk?: (text: string) => void,
    options: FlexModelInferenceOptions = {}
  ): Promise<FlexModelChatResponse | null> {
    const input = flexModelChatRequestSchema.parse(inputValue)
    const status = await this.getStatus()
    if (!status.enabled) return null

    try {
      return await this.scheduler.enqueue({
        workload: 'chat',
        ...options,
        run: async ({ signal, queueWaitMs }) =>
          await this.inferChat(input, signal, queueWaitMs, onChunk, options.onStatus)
      })
    } catch (error) {
      if (isFlexModelCancellation(error)) throw error
      return null
    }
  }

  async respondGeneral(
    inputValue: FlexModelChatRequest,
    onChunk?: (text: string) => void,
    options: FlexModelInferenceOptions = {}
  ): Promise<FlexModelGeneralFallbackResult> {
    try {
      const status = await this.getStatus()
      if (status.state === 'not-installed' || !status.enabled) {
        const kind = fallbackFailureFromStatus(status, 'invalid-output')
        if (kind === 'not-calendar') return { kind: 'invalid-output' }
        return flexModelGeneralFallbackResultSchema.parse({ kind })
      }
      const response = await this.chatEnvelope(inputValue, onChunk, options)
      if (response) {
        return flexModelGeneralFallbackResultSchema.parse(response)
      }
      const finalStatus = await this.getStatus()
      const kind = fallbackFailureFromStatus(finalStatus, 'invalid-output')
      if (kind === 'not-calendar') return { kind: 'invalid-output' }
      return flexModelGeneralFallbackResultSchema.parse({ kind })
    } catch (error) {
      if (isFlexModelCancellation(error)) return { kind: 'cancelled' }
      return { kind: 'invalid-output' }
    }
  }

  async repairDocument(inputValue: DocumentRepairRequest): Promise<DocumentRepairResponse | null> {
    const input = documentRepairRequestSchema.parse(inputValue)
    const status = await this.getStatus()
    if (!status.enabled) return null

    try {
      return await this.scheduler.enqueue({
        workload: 'document-repair',
        cancellationId: `document-repair:${input.selectionId}`,
        run: async ({ signal, queueWaitMs }) =>
          await this.inferDocumentRepair(input, signal, queueWaitMs)
      })
    } catch {
      return null
    }
  }

  async groupDocumentFallback(
    inputValue: DocumentFallbackRequest
  ): Promise<DocumentFallbackResponse | null> {
    const input = documentFallbackRequestSchema.parse(inputValue)
    const status = await this.getStatus()
    if (!status.enabled) return null

    try {
      return await this.scheduler.enqueue({
        workload: 'document-fallback',
        cancellationId: input.requestId,
        run: async ({ signal, queueWaitMs }) =>
          await this.inferDocumentFallback(input, signal, queueWaitMs)
      })
    } catch {
      return null
    }
  }

  async unload(cancelScheduled = true): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    if (cancelScheduled) this.scheduler.cancelAll()
    const activeJob = this.activeWorkerJob
    if (activeJob) {
      clearTimeout(activeJob.timeout)
      activeJob.removeAbortListener()
      this.activeWorkerJob = null
      activeJob.reject(new FlexModelJobCancelledError('The local language process was stopped.'))
    }
    this.child?.kill()
    this.child = null
    this.childPromise = null
    this.activeProfile = null
    if (this.runtimeState === 'ready' || this.runtimeState === 'loading') {
      this.runtimeState = 'idle'
    }
  }

  private async download(
    onProgress?: (event: FlexModelProgressEvent) => void
  ): Promise<FlexModelStatus> {
    await mkdir(this.modelDirectory, { recursive: true })
    await this.loadPersistedState()
    if ((await this.installedBytes()) === MODEL_BYTES) {
      if ((await fileSha256(this.modelPath)) === MODEL_SHA256) {
        const existing = await stat(this.modelPath)
        this.verifiedSignature = `${existing.size}:${existing.mtimeMs}`
        this.enabled = true
        this.runtimeState = 'idle'
        this.lastError = null
        await this.persistState()
        return await this.getStatus()
      }
      await unlink(this.modelPath).catch(() => undefined)
    }

    await unlink(this.partialPath).catch(() => undefined)
    await unlink(this.modelPath).catch(() => undefined)
    this.installController = new AbortController()
    this.runtimeState = 'downloading'
    this.downloadedBytes = 0
    this.lastError = null
    this.emitProgress(onProgress, 'Starting the verified model download…')

    const hash = createHash('sha256')
    const handle = await open(this.partialPath, 'wx')
    try {
      const response = await fetch(MODEL_URL, {
        method: 'GET',
        redirect: 'follow',
        signal: this.installController.signal
      })
      if (!response.ok || !response.body) {
        throw new Error(`Model host returned HTTP ${response.status}.`)
      }
      const reader = response.body.getReader()
      let nextProgressAt = 0
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        if (this.downloadedBytes + chunk.value.byteLength > MODEL_BYTES) {
          throw new Error('The model download was larger than the signed manifest allows.')
        }
        await handle.write(chunk.value)
        hash.update(chunk.value)
        this.downloadedBytes += chunk.value.byteLength
        if (this.downloadedBytes >= nextProgressAt) {
          nextProgressAt = this.downloadedBytes + 4 * 1_024 * 1_024
          this.emitProgress(onProgress, 'Downloading the flexible language pack…')
        }
      }
      await handle.sync()
      if (this.downloadedBytes !== MODEL_BYTES) {
        throw new Error(
          `The model download was incomplete (${this.downloadedBytes} of ${MODEL_BYTES} bytes).`
        )
      }
      if (hash.digest('hex') !== MODEL_SHA256) {
        throw new Error('The model checksum did not match the pinned official release.')
      }
      await handle.close()
      await rename(this.partialPath, this.modelPath)
      this.enabled = true
      this.runtimeState = 'idle'
      this.lastError = null
      const installedStats = await stat(this.modelPath)
      this.verifiedSignature = `${installedStats.size}:${installedStats.mtimeMs}`
      await this.persistState()
      const installed = await this.getStatus()
      this.emitProgress(onProgress, 'Installed. The flexible fallback now works offline.')
      return installed
    } catch (error) {
      await handle.close().catch(() => undefined)
      await unlink(this.partialPath).catch(() => undefined)
      this.downloadedBytes = 0
      this.runtimeState = isAbortError(error) ? 'idle' : 'error'
      this.lastError = isAbortError(error) ? null : errorMessage(error)
      this.emitProgress(
        onProgress,
        isAbortError(error) ? 'Download cancelled.' : 'The verified download did not complete.'
      )
      return await this.getStatus()
    }
  }

  private async infer(
    text: string,
    context: FlexModelPlanContext,
    signal: AbortSignal,
    queueWaitMs: number,
    onStatus?: (status: FlexModelJobStatus) => void
  ): Promise<FlexModelPlan | null> {
    try {
      await this.verifyInstalledModel()
      if (signal.aborted) throw signal.reason
      this.runtimeState = 'loading'
      const raw = await this.runWorker(
        { type: 'plan', text, context },
        'plan',
        signal,
        queueWaitMs,
        undefined,
        onStatus
      )
      this.runtimeState = 'ready'
      this.lastError = null
      this.scheduleIdleUnload()
      const candidate = raw as { actions?: Array<{ operation?: string }> }
      if (candidate.actions?.some((action) => action.operation === 'assistant.unsupported')) {
        return null
      }
      return flexModelPlanSchema.parse(raw)
    } catch (error) {
      if (isFlexModelCancellation(error) || isFlexModelPreemption(error)) throw error
      this.lastError = errorMessage(error)
      this.runtimeState = 'error'
      await this.unload(false)
      return null
    }
  }

  private async inferChat(
    input: FlexModelChatRequest,
    signal: AbortSignal,
    queueWaitMs: number,
    onChunk?: (text: string) => void,
    onStatus?: (status: FlexModelJobStatus) => void
  ): Promise<FlexModelChatResponse | null> {
    try {
      await this.verifyInstalledModel()
      if (signal.aborted) throw signal.reason
      this.runtimeState = 'loading'
      const raw = await this.runWorker(
        { type: 'chat', input },
        'chat',
        signal,
        queueWaitMs,
        onChunk,
        onStatus
      )
      this.runtimeState = 'ready'
      this.lastError = null
      this.scheduleIdleUnload()
      return flexModelChatResponseSchema.parse(raw)
    } catch (error) {
      if (isFlexModelCancellation(error) || isFlexModelPreemption(error)) throw error
      this.lastError = errorMessage(error)
      this.runtimeState = 'error'
      await this.unload(false)
      return null
    }
  }

  private async inferDocumentRepair(
    input: DocumentRepairRequest,
    signal: AbortSignal,
    queueWaitMs: number
  ): Promise<DocumentRepairResponse | null> {
    try {
      await this.verifyInstalledModel()
      if (signal.aborted) throw signal.reason
      this.runtimeState = 'loading'
      const decisions = []
      for (const disagreement of input.disagreements) {
        const partial: DocumentRepairRequest = {
          ...input,
          disagreements: [disagreement]
        }
        const raw = documentRepairModelOutputSchema.parse(
          await this.runWorker(
            { type: 'document-repair', request: partial },
            'document-repair',
            signal,
            queueWaitMs
          )
        )
        const validated = validateDocumentRepairResponse(partial, raw)
        if (!validated) throw new Error('The local model repair was not grounded in its source')
        decisions.push(...validated.decisions)
      }
      const response = validateDocumentRepairResponse(input, { decisions })
      if (!response) throw new Error('The combined local model repair was invalid')
      this.runtimeState = 'ready'
      this.lastError = null
      this.scheduleIdleUnload()
      return response
    } catch (error) {
      if (isFlexModelCancellation(error) || isFlexModelPreemption(error)) throw error
      this.lastError = errorMessage(error)
      this.runtimeState = 'error'
      await this.unload(false)
      return null
    }
  }

  private async inferDocumentFallback(
    input: DocumentFallbackRequest,
    signal: AbortSignal,
    queueWaitMs: number
  ): Promise<DocumentFallbackResponse | null> {
    try {
      await this.verifyInstalledModel()
      if (signal.aborted) throw signal.reason
      this.runtimeState = 'loading'
      const raw = documentFallbackModelOutputSchema.parse(
        await this.runWorker(
          { type: 'document-fallback', request: input },
          'document-fallback',
          signal,
          queueWaitMs
        )
      )
      const response = validateDocumentFallbackResponse(input, raw)
      if (!response) throw new Error('The local document fallback was not grounded in its source')
      this.runtimeState = 'ready'
      this.lastError = null
      this.scheduleIdleUnload()
      return response
    } catch (error) {
      if (isFlexModelCancellation(error) || isFlexModelPreemption(error)) throw error
      this.lastError = errorMessage(error)
      this.runtimeState = 'error'
      await this.unload(false)
      return null
    }
  }

  private async verifyInstalledModel(): Promise<void> {
    const modelStats = await stat(this.modelPath)
    if (!modelStats.isFile() || modelStats.size !== MODEL_BYTES) {
      throw new Error('The installed model file is incomplete.')
    }
    const signature = `${modelStats.size}:${modelStats.mtimeMs}`
    if (this.verifiedSignature !== signature) {
      if ((await fileSha256(this.modelPath)) !== MODEL_SHA256) {
        throw new Error('The installed model failed its SHA-256 integrity check.')
      }
      this.verifiedSignature = signature
    }
  }

  private async ensureChild(): Promise<UtilityProcess> {
    if (this.child) return this.child
    if (this.childPromise) return await this.childPromise
    this.childPromise = new Promise((resolveChild, rejectChild) => {
      const child = utilityProcess.fork(this.paths.workerEntry, [], {
        serviceName: 'Remind Me Flexible Language',
        stdio: 'pipe'
      })
      this.child = child
      child.stdout?.on('data', (data: Buffer) =>
        console.debug(`[flex-model] ${data.toString().trim()}`)
      )
      child.stderr?.on('data', (data: Buffer) =>
        console.error(`[flex-model] ${data.toString().trim()}`)
      )
      child.on('message', (message: unknown) => this.handleWorkerMessage(message))
      child.once('spawn', () => resolveChild(child))
      child.once('error', () => {
        if (this.child === child) this.child = null
        rejectChild(new Error('Could not start the optional local language process.'))
      })
      child.once('exit', (code) => {
        if (this.child !== child) return
        this.child = null
        this.childPromise = null
        this.activeProfile = null
        const active = this.activeWorkerJob
        if (active) {
          clearTimeout(active.timeout)
          active.removeAbortListener()
          this.activeWorkerJob = null
          active.reject(new Error(`The optional local language process exited (${code}).`))
        }
        if (this.runtimeState === 'ready') this.runtimeState = 'idle'
      })
    })
    try {
      return await this.childPromise
    } finally {
      this.childPromise = null
    }
  }

  private handleWorkerMessage(message: unknown): void {
    if (!message || typeof message !== 'object') return
    const result = message as Partial<WorkerResult>
    const active = this.activeWorkerJob
    if (!active || result.jobId !== active.jobId) return
    if (result.type === 'status') {
      const phase = (result as Partial<WorkerStatusResult>).phase
      const parsed = flexModelJobStatusSchema.safeParse({
        workload: active.workload,
        phase,
        queuePosition: 0,
        queuedJobs: this.scheduler.snapshot().queuedJobs,
        canCancel: true
      })
      if (parsed.success) {
        try {
          active.onStatus?.(parsed.data)
        } catch {
          // Renderer progress is best-effort.
        }
      }
      return
    }
    if (result.type === 'chat-chunk') {
      const text = (result as Partial<WorkerChatChunk>).text
      if (typeof text !== 'string' || !text || text.length > 8_000) return
      try {
        active.onChatChunk?.(text)
      } catch {
        // Renderer progress is best-effort and must never interrupt local inference.
      }
      return
    }
    if (
      result.type !== 'plan-result' &&
      result.type !== 'chat-result' &&
      result.type !== 'document-repair-result' &&
      result.type !== 'document-fallback-result' &&
      result.type !== 'cancelled' &&
      result.type !== 'error'
    )
      return
    clearTimeout(active.timeout)
    active.removeAbortListener()
    this.activeWorkerJob = null
    if (
      result.type === 'plan-result' ||
      result.type === 'chat-result' ||
      result.type === 'document-repair-result' ||
      result.type === 'document-fallback-result'
    ) {
      const parsedMetrics = flexModelRequestMetricsSchema.safeParse(result.metrics)
      if (parsedMetrics.success) this.lastRequest = parsedMetrics.data
    }
    if (result.type === 'cancelled') {
      const reason = active.signal.reason
      active.reject(reason instanceof Error ? reason : new FlexModelJobCancelledError())
    } else if (result.type === 'error')
      active.reject(new Error(result.message ?? 'Local inference failed.'))
    else if (result.type === 'plan-result')
      active.resolve((result as Partial<WorkerPlanResult>).plan)
    else if (result.type === 'chat-result')
      active.resolve((result as Partial<WorkerChatResult>).response)
    else if (result.type === 'document-repair-result')
      active.resolve((result as Partial<WorkerDocumentRepairResult>).repair)
    else active.resolve((result as Partial<WorkerDocumentFallbackResult>).fallback)
  }

  private async runWorker(
    request:
      | { type: 'plan'; text: string; context: FlexModelPlanContext }
      | { type: 'chat'; input: FlexModelChatRequest }
      | { type: 'document-repair'; request: DocumentRepairRequest }
      | { type: 'document-fallback'; request: DocumentFallbackRequest },
    workload: FlexModelWorkload,
    signal: AbortSignal,
    queueWaitMs: number,
    onChatChunk?: (text: string) => void,
    onStatus?: (status: FlexModelJobStatus) => void
  ): Promise<unknown> {
    if (this.activeWorkerJob) throw new Error('Another local language request is already running.')
    if (signal.aborted) throw signal.reason
    const runtimeProfile = this.activeProfile ?? this.currentProfile()
    this.activeProfile = runtimeProfile
    const child = await this.ensureChild()
    if (signal.aborted) throw signal.reason
    const jobId = `flex:${randomUUID()}`
    return await new Promise((resolvePlan, rejectPlan) => {
      const abortListener = (): void => {
        if (this.activeWorkerJob?.jobId !== jobId) return
        child.postMessage({ type: 'cancel', jobId })
      }
      signal.addEventListener('abort', abortListener, { once: true })
      const removeAbortListener = (): void => signal.removeEventListener('abort', abortListener)
      const timeout = setTimeout(() => {
        if (this.activeWorkerJob?.jobId !== jobId) return
        this.activeWorkerJob = null
        removeAbortListener()
        const currentChild = this.child
        this.child = null
        currentChild?.kill()
        rejectPlan(new Error('Local model inference timed out.'))
      }, runtimeProfile.requestTimeoutMs)
      this.activeWorkerJob = {
        jobId,
        resolve: resolvePlan,
        reject: rejectPlan,
        timeout,
        onChatChunk,
        onStatus,
        workload,
        signal,
        removeAbortListener
      }
      child.postMessage({
        ...request,
        jobId,
        runtimeEntry: this.paths.runtimeEntry,
        modelPath: this.modelPath,
        runtimeProfile,
        queueWaitMs
      })
      if (signal.aborted) abortListener()
    })
  }

  private scheduleIdleUnload(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    const profile = this.activeProfile ?? this.currentProfile()
    this.idleTimer = setTimeout(() => void this.unload(), pressureAdjustedIdleUnloadMs(profile))
    this.idleTimer.unref?.()
  }

  private async installedBytes(): Promise<number> {
    try {
      const file = await stat(this.modelPath)
      return file.isFile() ? file.size : 0
    } catch {
      return 0
    }
  }

  private currentProfile(): FlexModelRuntimeProfile {
    return currentFlexModelRuntimeProfile({
      ...(this.availableBackends ? { availableBackends: this.availableBackends } : {}),
      warmthPolicy: this.warmthPolicy ?? 'automatic',
      accelerationPreference: this.accelerationPreference ?? 'auto'
    })
  }

  private async loadAvailableBackends(): Promise<void> {
    if (this.availableBackends) return
    const defaults: FlexModelBackend[] =
      process.platform === 'darwin' && process.arch === 'arm64' ? ['cpu', 'metal'] : ['cpu']
    if (!this.paths.backendManifest) {
      this.availableBackends = defaults
      return
    }
    try {
      const value = JSON.parse(await readFile(this.paths.backendManifest, 'utf8')) as {
        schemaVersion?: unknown
        backends?: unknown
      }
      if (value.schemaVersion !== 1 || !Array.isArray(value.backends)) {
        throw new Error('Invalid backend manifest')
      }
      const parsed = value.backends
        .map((backend) => flexModelBackendSchema.safeParse(backend))
        .filter((result) => result.success)
        .map((result) => result.data)
      this.availableBackends = [...new Set<FlexModelBackend>(['cpu', ...parsed])]
    } catch {
      this.availableBackends = defaults
    }
  }

  private async loadPersistedState(): Promise<void> {
    if (this.enabled !== null) return
    try {
      const parsed = JSON.parse(await readFile(this.statePath, 'utf8')) as Partial<PersistedState>
      this.enabled = parsed.enabled === true
      this.warmthPolicy = flexModelWarmthPolicySchema.catch('automatic').parse(parsed.warmthPolicy)
      this.accelerationPreference = flexModelAccelerationPreferenceSchema
        .catch('auto')
        .parse(parsed.accelerationPreference)
    } catch {
      this.enabled = false
      this.warmthPolicy = 'automatic'
      this.accelerationPreference = 'auto'
    }
  }

  private async persistState(): Promise<void> {
    await mkdir(this.modelDirectory, { recursive: true })
    await writeFile(
      this.statePath,
      `${JSON.stringify({
        enabled: Boolean(this.enabled),
        warmthPolicy: this.warmthPolicy ?? 'automatic',
        accelerationPreference: this.accelerationPreference ?? 'auto'
      })}\n`,
      { encoding: 'utf8' }
    )
  }

  private emitProgress(
    listener: ((event: FlexModelProgressEvent) => void) | undefined,
    message: string
  ): void {
    if (!listener) return
    void this.getStatus().then((status) => {
      listener(flexModelProgressEventSchema.parse({ status, message }))
    })
  }
}
