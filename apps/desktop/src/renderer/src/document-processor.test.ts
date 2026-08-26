import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DocumentSelection } from '@remind-me/contracts'
import { DocumentProcessingCancelledError, LocalDocumentProcessor } from './document-processor'

class FakeWorker {
  static instances: FakeWorker[] = []

  onmessage: ((event: MessageEvent<unknown>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  readonly postMessage = vi.fn()
  readonly terminate = vi.fn()

  constructor() {
    FakeWorker.instances.push(this)
  }
}

function selection(): DocumentSelection {
  const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer
  return {
    source: {
      id: 'document:test',
      kind: 'pdf',
      displayName: 'cancel-test.pdf',
      mediaType: 'application/pdf',
      byteLength: bytes.byteLength,
      sha256: 'a'.repeat(64)
    },
    bytes
  }
}

describe('LocalDocumentProcessor cancellation', () => {
  beforeEach(() => {
    FakeWorker.instances = []
    vi.stubGlobal('Worker', FakeWorker)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('terminates the isolated worker and rejects the pending analysis', async () => {
    const processor = new LocalDocumentProcessor()
    const input = selection()
    const pending = processor.analyze(input, vi.fn())
    const rejection = expect(pending).rejects.toBeInstanceOf(DocumentProcessingCancelledError)
    const worker = FakeWorker.instances[0]

    expect(worker).toBeDefined()
    expect(worker?.postMessage).toHaveBeenCalledWith({ type: 'analyze', selection: input }, [
      input.bytes
    ])
    expect(processor.cancel()).toBe(true)
    await rejection
    expect(worker?.terminate).toHaveBeenCalledOnce()
    expect(processor.cancel()).toBe(false)
  })

  it('uses the same cancellation path when the owning dialog is disposed', async () => {
    const processor = new LocalDocumentProcessor()
    const pending = processor.analyze(selection(), vi.fn())
    const rejection = expect(pending).rejects.toBeInstanceOf(DocumentProcessingCancelledError)
    const worker = FakeWorker.instances[0]

    processor.dispose()
    await rejection
    expect(worker?.terminate).toHaveBeenCalledOnce()
  })
})
