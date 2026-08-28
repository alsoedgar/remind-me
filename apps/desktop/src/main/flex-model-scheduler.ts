import { performance } from 'node:perf_hooks'
import type {
  FlexModelJobStatus,
  FlexModelQueueSnapshot,
  FlexModelWorkload
} from '@remind-me/contracts'

const MAX_QUEUED_JOBS = 64
const MAX_DOCUMENT_PREEMPTIONS = 2

const workloadPriority: Record<FlexModelWorkload, number> = {
  chat: 0,
  plan: 1,
  'document-repair': 2,
  'document-fallback': 3
}

function isForeground(workload: FlexModelWorkload): boolean {
  return workload === 'chat' || workload === 'plan'
}

function isDocument(workload: FlexModelWorkload): boolean {
  return workload === 'document-repair' || workload === 'document-fallback'
}

export class FlexModelJobCancelledError extends Error {
  override readonly name = 'FlexModelJobCancelledError'

  constructor(message = 'The local model request was cancelled.') {
    super(message)
  }
}

export class FlexModelJobPreemptedError extends Error {
  override readonly name = 'FlexModelJobPreemptedError'

  constructor() {
    super('The background local-model job yielded to a foreground request.')
  }
}

export function isFlexModelCancellation(error: unknown): boolean {
  return (
    error instanceof FlexModelJobCancelledError ||
    (error instanceof Error && error.name === 'FlexModelJobCancelledError')
  )
}

export function isFlexModelPreemption(error: unknown): boolean {
  return (
    error instanceof FlexModelJobPreemptedError ||
    (error instanceof Error && error.name === 'FlexModelJobPreemptedError')
  )
}

export interface FlexModelScheduledRunContext {
  signal: AbortSignal
  queueWaitMs: number
}

export interface FlexModelScheduleRequest<T> {
  workload: FlexModelWorkload
  cancellationId?: string
  onStatus?: (status: FlexModelJobStatus) => void
  run: (context: FlexModelScheduledRunContext) => Promise<T>
}

interface QueuedJob<T> {
  sequence: number
  workload: FlexModelWorkload
  cancellationId: string | undefined
  onStatus: ((status: FlexModelJobStatus) => void) | undefined
  run: FlexModelScheduleRequest<T>['run']
  resolve: (value: T) => void
  reject: (error: Error) => void
  enqueuedAt: number
  controller: AbortController
  cancelled: boolean
  preempted: boolean
  preemptions: number
}

type StoredJob = QueuedJob<unknown>

export class FlexModelScheduler {
  private readonly pending: StoredJob[] = []
  private active: StoredJob | null = null
  private pumping = false
  private sequence = 0

  enqueue<T>(request: FlexModelScheduleRequest<T>): Promise<T> {
    if (this.pending.length >= MAX_QUEUED_JOBS) {
      return Promise.reject(new Error('The local model queue is full.'))
    }
    if (
      request.cancellationId &&
      (this.active?.cancellationId === request.cancellationId ||
        this.pending.some((job) => job.cancellationId === request.cancellationId))
    ) {
      return Promise.reject(new Error('That local model request is already queued.'))
    }

    const result = new Promise<T>((resolve, reject) => {
      const job: QueuedJob<T> = {
        sequence: this.sequence++,
        workload: request.workload,
        cancellationId: request.cancellationId,
        onStatus: request.onStatus,
        run: request.run,
        resolve,
        reject,
        enqueuedAt: performance.now(),
        controller: new AbortController(),
        cancelled: false,
        preempted: false,
        preemptions: 0
      }
      this.pending.push(job as StoredJob)
      this.sortPending()
      this.preemptDocumentForForeground(job as StoredJob)
      this.emitPendingStatuses()
      void this.pump()
    })
    return result
  }

  cancel(cancellationId: string): boolean {
    const pendingIndex = this.pending.findIndex((job) => job.cancellationId === cancellationId)
    if (pendingIndex >= 0) {
      const [job] = this.pending.splice(pendingIndex, 1)
      if (!job) return false
      job.cancelled = true
      const error = new FlexModelJobCancelledError()
      job.controller.abort(error)
      this.emitStatus(job, 'cancelled', 0)
      job.reject(error)
      this.emitPendingStatuses()
      return true
    }

    if (this.active?.cancellationId !== cancellationId) return false
    this.active.cancelled = true
    const error = new FlexModelJobCancelledError()
    this.emitStatus(this.active, 'cancelled', 0)
    this.active.controller.abort(error)
    return true
  }

  cancelAll(message = 'The local language process was stopped.'): void {
    const pending = this.pending.splice(0)
    for (const job of pending) {
      job.cancelled = true
      const error = new FlexModelJobCancelledError(message)
      job.controller.abort(error)
      this.emitStatus(job, 'cancelled', 0)
      job.reject(error)
    }
    if (this.active && !this.active.controller.signal.aborted) {
      this.active.cancelled = true
      const error = new FlexModelJobCancelledError(message)
      this.emitStatus(this.active, 'cancelled', 0)
      this.active.controller.abort(error)
    }
    this.emitPendingStatuses()
  }

  snapshot(): FlexModelQueueSnapshot {
    return {
      activeWorkload: this.active?.workload ?? null,
      queuedJobs: this.pending.length,
      foregroundQueued: this.pending.filter((job) => isForeground(job.workload)).length,
      documentQueued: this.pending.filter((job) => isDocument(job.workload)).length
    }
  }

  private sortPending(): void {
    this.pending.sort(
      (left, right) =>
        workloadPriority[left.workload] - workloadPriority[right.workload] ||
        left.sequence - right.sequence
    )
  }

  private preemptDocumentForForeground(incoming: StoredJob): void {
    const active = this.active
    if (
      !active ||
      !isForeground(incoming.workload) ||
      !isDocument(active.workload) ||
      active.cancelled ||
      active.preempted ||
      active.preemptions >= MAX_DOCUMENT_PREEMPTIONS ||
      active.controller.signal.aborted
    ) {
      return
    }
    active.preempted = true
    active.preemptions += 1
    active.controller.abort(new FlexModelJobPreemptedError())
  }

  private emitStatus(
    job: StoredJob,
    phase: FlexModelJobStatus['phase'],
    queuePosition: number
  ): void {
    try {
      job.onStatus?.({
        workload: job.workload,
        phase,
        queuePosition,
        queuedJobs: this.pending.length,
        canCancel: Boolean(job.cancellationId) && phase !== 'cancelled'
      })
    } catch {
      // UI progress must never interrupt local inference.
    }
  }

  private emitPendingStatuses(): void {
    for (const [index, job] of this.pending.entries()) {
      this.emitStatus(job, 'queued', index + 1)
    }
  }

  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      while (this.pending.length > 0) {
        const job = this.pending.shift()
        if (!job) continue
        if (job.cancelled) continue
        this.active = job
        this.emitPendingStatuses()
        this.emitStatus(job, 'loading', 0)
        try {
          const value = await job.run({
            signal: job.controller.signal,
            queueWaitMs: Math.max(0, Math.round(performance.now() - job.enqueuedAt))
          })
          if (job.cancelled) job.reject(new FlexModelJobCancelledError())
          else job.resolve(value)
        } catch (error) {
          if (job.preempted && !job.cancelled) {
            job.preempted = false
            job.controller = new AbortController()
            job.enqueuedAt = performance.now()
            this.pending.push(job)
            this.sortPending()
          } else {
            job.reject(error instanceof Error ? error : new Error(String(error)))
          }
        } finally {
          this.active = null
          this.emitPendingStatuses()
        }
      }
    } finally {
      this.pumping = false
      if (this.pending.length > 0) void this.pump()
    }
  }
}
