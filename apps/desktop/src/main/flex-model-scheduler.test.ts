import { describe, expect, it } from 'vitest'
import type { FlexModelJobStatus } from '@remind-me/contracts'
import { FlexModelScheduler, isFlexModelCancellation } from './flex-model-scheduler'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('flexible-model workload scheduler', () => {
  it('runs foreground chat before queued document work', async () => {
    const scheduler = new FlexModelScheduler()
    const gate = deferred()
    const order: string[] = []
    const activePlan = scheduler.enqueue({
      workload: 'plan',
      run: async () => {
        order.push('plan:start')
        await gate.promise
        order.push('plan:end')
        return 'plan'
      }
    })
    const document = scheduler.enqueue({
      workload: 'document-fallback',
      run: async () => {
        order.push('document')
        return 'document'
      }
    })
    const chat = scheduler.enqueue({
      workload: 'chat',
      run: async () => {
        order.push('chat')
        return 'chat'
      }
    })

    gate.resolve()
    await expect(Promise.all([activePlan, document, chat])).resolves.toEqual([
      'plan',
      'document',
      'chat'
    ])
    expect(order).toEqual(['plan:start', 'plan:end', 'chat', 'document'])
  })

  it('lets an active document job yield and resume after foreground chat', async () => {
    const scheduler = new FlexModelScheduler()
    const order: string[] = []
    let attempts = 0
    const document = scheduler.enqueue({
      workload: 'document-repair',
      run: async ({ signal }) => {
        attempts += 1
        order.push(attempts === 1 ? 'document:start' : 'document:resume')
        if (attempts > 1) return 'document'
        return await new Promise<string>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(signal.reason instanceof Error ? signal.reason : new Error('aborted')),
            { once: true }
          )
        })
      }
    })
    const chat = scheduler.enqueue({
      workload: 'chat',
      run: async () => {
        order.push('chat')
        return 'chat'
      }
    })

    await expect(Promise.all([document, chat])).resolves.toEqual(['document', 'chat'])
    expect(attempts).toBe(2)
    expect(order).toEqual(['document:start', 'chat', 'document:resume'])
  })

  it('cancels active work cooperatively and reports the stopped phase', async () => {
    const scheduler = new FlexModelScheduler()
    const statuses: FlexModelJobStatus[] = []
    const running = scheduler.enqueue({
      workload: 'chat',
      cancellationId: 'assistant-stream:test',
      onStatus: (status) => statuses.push(status),
      run: async ({ signal }) =>
        await new Promise<string>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(signal.reason instanceof Error ? signal.reason : new Error('aborted')),
            { once: true }
          )
        })
    })

    expect(scheduler.cancel('assistant-stream:test')).toBe(true)
    await expect(running).rejects.toSatisfy(isFlexModelCancellation)
    expect(statuses.some((status) => status.phase === 'cancelled')).toBe(true)
    expect(scheduler.snapshot()).toEqual({
      activeWorkload: null,
      queuedJobs: 0,
      foregroundQueued: 0,
      documentQueued: 0
    })
  })
})
