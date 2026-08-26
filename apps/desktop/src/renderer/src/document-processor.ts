import {
  documentExtractionSchema,
  documentProgressEventSchema,
  type DocumentExtraction,
  type DocumentProgressEvent,
  type DocumentSelection
} from '@remind-me/contracts'

interface WorkerProgressMessage {
  type: 'progress'
  progress: unknown
}

interface WorkerResultMessage {
  type: 'result'
  extraction: unknown
}

interface WorkerErrorMessage {
  type: 'error'
  message: string
}

type WorkerMessage = WorkerProgressMessage | WorkerResultMessage | WorkerErrorMessage

export class DocumentProcessingCancelledError extends Error {
  constructor() {
    super('Document processing was cancelled')
    this.name = 'DocumentProcessingCancelledError'
  }
}

function isWorkerMessage(value: unknown): value is WorkerMessage {
  if (!value || typeof value !== 'object') return false
  const candidate = value as { type?: unknown }
  return ['progress', 'result', 'error'].includes(String(candidate.type))
}

export class LocalDocumentProcessor {
  private worker: Worker | null = null
  private rejectPending: ((error: Error) => void) | null = null
  private timeout: ReturnType<typeof setTimeout> | null = null

  analyze(
    selection: DocumentSelection,
    onProgress: (progress: DocumentProgressEvent) => void
  ): Promise<DocumentExtraction> {
    if (this.worker) throw new Error('A document is already being processed')
    const worker = new Worker(new URL('./workers/document-processing.worker.ts', import.meta.url), {
      type: 'module',
      name: 'remind-me-document-processing'
    })
    this.worker = worker
    return new Promise<DocumentExtraction>((resolve, reject) => {
      this.rejectPending = reject
      this.timeout = setTimeout(
        () => {
          this.fail(new Error('Local document processing timed out. Try a smaller file.'))
        },
        5 * 60 * 1_000
      )
      worker.onmessage = (event: MessageEvent<unknown>) => {
        if (!isWorkerMessage(event.data)) return
        if (event.data.type === 'progress') {
          const parsed = documentProgressEventSchema.safeParse(event.data.progress)
          if (parsed.success) onProgress(parsed.data)
          return
        }
        if (event.data.type === 'error') {
          this.fail(new Error(event.data.message || 'Local document processing failed'))
          return
        }
        try {
          const extraction = documentExtractionSchema.parse(event.data.extraction)
          this.complete()
          resolve(extraction)
        } catch (error) {
          this.fail(error instanceof Error ? error : new Error('Document output was invalid'))
        }
      }
      worker.onerror = () =>
        this.fail(new Error('The isolated document worker stopped unexpectedly.'))
      const bytes = selection.bytes
      worker.postMessage({ type: 'analyze', selection }, [bytes])
    })
  }

  private clear(): void {
    if (this.timeout) clearTimeout(this.timeout)
    this.timeout = null
    this.rejectPending = null
    this.worker?.terminate()
    this.worker = null
  }

  private complete(): void {
    this.clear()
  }

  private fail(error: Error): void {
    const reject = this.rejectPending
    this.clear()
    reject?.(error)
  }

  cancel(): boolean {
    if (!this.worker) return false
    this.fail(new DocumentProcessingCancelledError())
    return true
  }

  dispose(): void {
    if (this.worker) this.fail(new DocumentProcessingCancelledError())
  }
}
