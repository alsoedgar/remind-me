import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { freemem } from 'node:os'
import { resolve } from 'node:path'
import { utilityProcess, type UtilityProcess } from 'electron'
import {
  flexModelChatRequestSchema,
  flexModelChatResponseSchema,
  flexModelPlanSchema,
  flexModelPlanContextSchema,
  flexModelProgressEventSchema,
  flexModelRequestMetricsSchema,
  flexModelStatusSchema,
  type FlexModelChatRequest,
  type FlexModelPlan,
  type FlexModelPlanContext,
  type FlexModelProgressEvent,
  type FlexModelRequestMetrics,
  type FlexModelStatus
} from '@remind-me/contracts'
import { currentFlexModelRuntimeProfile, type FlexModelRuntimeProfile } from './flex-model-profile'

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
}

type RuntimeState = 'idle' | 'downloading' | 'loading' | 'ready' | 'error'

export interface FlexModelRuntimePaths {
  workerEntry: string
  runtimeEntry: string
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

interface WorkerErrorResult {
  type: 'error'
  jobId: string
  message: string
}

type WorkerResult = WorkerPlanResult | WorkerChatResult | WorkerErrorResult

interface ActiveWorkerJob {
  jobId: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
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
  private inferenceQueue: Promise<void> = Promise.resolve()
  private verifiedSignature: string | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private child: UtilityProcess | null = null
  private childPromise: Promise<UtilityProcess> | null = null
  private activeWorkerJob: ActiveWorkerJob | null = null
  private activeProfile: FlexModelRuntimeProfile | null = null
  private lastRequest: FlexModelRequestMetrics | null = null

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
    const profile = this.activeProfile ?? currentFlexModelRuntimeProfile()
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

  async plan(text: string, contextValue: FlexModelPlanContext): Promise<FlexModelPlan | null> {
    if (!text.trim() || text.length > 2_000) return null
    const planContext = flexModelPlanContextSchema.parse(contextValue)
    const status = await this.getStatus()
    // `enabled` is reported only when the complete pinned model is present. Do
    // not permanently lock inference after a transient worker error: the next
    // request gets one clean, serialized retry and can recover without a
    // reinstall or application restart.
    if (!status.enabled) return null

    let resolvePlan: (value: FlexModelPlan | null) => void = () => undefined
    const result = new Promise<FlexModelPlan | null>((resolveResult) => {
      resolvePlan = resolveResult
    })
    this.inferenceQueue = this.inferenceQueue
      .catch(() => undefined)
      .then(async () => resolvePlan(await this.infer(text, planContext)))
      .catch(() => resolvePlan(null))
    return await result
  }

  async chat(inputValue: FlexModelChatRequest): Promise<string | null> {
    const input = flexModelChatRequestSchema.parse(inputValue)
    const status = await this.getStatus()
    if (!status.enabled) return null

    let resolveResponse: (value: string | null) => void = () => undefined
    const result = new Promise<string | null>((resolveResult) => {
      resolveResponse = resolveResult
    })
    this.inferenceQueue = this.inferenceQueue
      .catch(() => undefined)
      .then(async () => resolveResponse(await this.inferChat(input)))
      .catch(() => resolveResponse(null))
    return await result
  }

  async unload(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    const activeJob = this.activeWorkerJob
    if (activeJob) {
      clearTimeout(activeJob.timeout)
      this.activeWorkerJob = null
      activeJob.reject(new Error('The local language process was stopped.'))
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

  private async infer(text: string, context: FlexModelPlanContext): Promise<FlexModelPlan | null> {
    try {
      await this.verifyInstalledModel()
      this.runtimeState = 'loading'
      const raw = await this.runWorker({ type: 'plan', text, context })
      this.runtimeState = 'ready'
      this.lastError = null
      this.scheduleIdleUnload()
      const candidate = raw as { actions?: Array<{ operation?: string }> }
      if (candidate.actions?.some((action) => action.operation === 'assistant.unsupported')) {
        return null
      }
      return flexModelPlanSchema.parse(raw)
    } catch (error) {
      this.lastError = errorMessage(error)
      this.runtimeState = 'error'
      await this.unload()
      return null
    }
  }

  private async inferChat(input: FlexModelChatRequest): Promise<string | null> {
    try {
      await this.verifyInstalledModel()
      this.runtimeState = 'loading'
      const raw = await this.runWorker({ type: 'chat', input })
      this.runtimeState = 'ready'
      this.lastError = null
      this.scheduleIdleUnload()
      return flexModelChatResponseSchema.parse(raw).text
    } catch (error) {
      this.lastError = errorMessage(error)
      this.runtimeState = 'error'
      await this.unload()
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
    if (result.type !== 'plan-result' && result.type !== 'chat-result' && result.type !== 'error')
      return
    clearTimeout(active.timeout)
    this.activeWorkerJob = null
    if (result.type === 'plan-result' || result.type === 'chat-result') {
      const parsedMetrics = flexModelRequestMetricsSchema.safeParse(result.metrics)
      if (parsedMetrics.success) this.lastRequest = parsedMetrics.data
    }
    if (result.type === 'error')
      active.reject(new Error(result.message ?? 'Local inference failed.'))
    else if (result.type === 'plan-result')
      active.resolve((result as Partial<WorkerPlanResult>).plan)
    else active.resolve((result as Partial<WorkerChatResult>).response)
  }

  private async runWorker(
    request:
      | { type: 'plan'; text: string; context: FlexModelPlanContext }
      | { type: 'chat'; input: FlexModelChatRequest }
  ): Promise<unknown> {
    if (this.activeWorkerJob) throw new Error('Another local language request is already running.')
    const runtimeProfile = this.activeProfile ?? currentFlexModelRuntimeProfile()
    this.activeProfile = runtimeProfile
    const child = await this.ensureChild()
    const jobId = `flex:${randomUUID()}`
    return await new Promise((resolvePlan, rejectPlan) => {
      const timeout = setTimeout(() => {
        if (this.activeWorkerJob?.jobId !== jobId) return
        this.activeWorkerJob = null
        const currentChild = this.child
        this.child = null
        currentChild?.kill()
        rejectPlan(new Error('Local model inference timed out.'))
      }, runtimeProfile.requestTimeoutMs)
      this.activeWorkerJob = { jobId, resolve: resolvePlan, reject: rejectPlan, timeout }
      child.postMessage({
        ...request,
        jobId,
        runtimeEntry: this.paths.runtimeEntry,
        modelPath: this.modelPath,
        runtimeProfile
      })
    })
  }

  private scheduleIdleUnload(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    const profile = this.activeProfile ?? currentFlexModelRuntimeProfile()
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

  private async loadPersistedState(): Promise<void> {
    if (this.enabled !== null) return
    try {
      const parsed = JSON.parse(await readFile(this.statePath, 'utf8')) as Partial<PersistedState>
      this.enabled = parsed.enabled === true
    } catch {
      this.enabled = false
    }
  }

  private async persistState(): Promise<void> {
    await mkdir(this.modelDirectory, { recursive: true })
    await writeFile(this.statePath, `${JSON.stringify({ enabled: Boolean(this.enabled) })}\n`, {
      encoding: 'utf8'
    })
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
