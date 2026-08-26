import { describe, expect, it } from 'vitest'
import {
  documentBoundingBoxSchema,
  documentExtractionSchema,
  documentProgressEventSchema,
  documentSelectionSchema,
  documentSelectResponseSchema
} from './document-api'

function validSelection() {
  return {
    source: {
      id: 'document:test',
      kind: 'pdf' as const,
      displayName: 'schedule.pdf',
      mediaType: 'application/pdf' as const,
      byteLength: 4,
      sha256: 'b'.repeat(64)
    },
    bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer
  }
}

describe('document IPC contracts', () => {
  it('accepts an opaque source and matching in-memory bytes', () => {
    expect(documentSelectionSchema.parse(validSelection()).source.displayName).toBe('schedule.pdf')
  })

  it('rejects changed byte lengths and filesystem paths', () => {
    const mismatched = validSelection()
    mismatched.source.byteLength = 5
    expect(documentSelectionSchema.safeParse(mismatched).success).toBe(false)

    expect(
      documentSelectionSchema.safeParse({
        ...validSelection(),
        source: { ...validSelection().source, path: 'C:\\private\\schedule.pdf' }
      }).success
    ).toBe(false)
  })

  it('keeps evidence boxes inside normalized page bounds', () => {
    expect(
      documentBoundingBoxSchema.safeParse({ x: 0.9, y: 0.2, width: 0.2, height: 0.1 }).success
    ).toBe(false)
  })

  it('requires cancelled selections and returned bytes to be mutually exclusive', () => {
    expect(
      documentSelectResponseSchema.safeParse({ cancelled: true, selection: validSelection() })
        .success
    ).toBe(false)
    expect(documentSelectResponseSchema.parse({ cancelled: true, selection: null }).cancelled).toBe(
      true
    )
  })

  it('bounds progress and page counters before they reach the UI', () => {
    expect(
      documentProgressEventSchema.safeParse({
        stage: 'recognizing',
        progress: 1.1,
        message: 'Reading page 21',
        currentPage: 21,
        totalPages: 21
      }).success
    ).toBe(false)
  })

  it('rejects PlanScan spans that are not exact projections of source evidence', () => {
    const sourceBlock = {
      id: 'block:1:0',
      page: 1,
      text: 'August 26, 2026',
      boundingBox: { x: 0.1, y: 0.1, width: 0.4, height: 0.04 },
      confidence: 1,
      method: 'native-text' as const,
      wordIds: ['word:1:0']
    }
    expect(
      documentExtractionSchema.safeParse({
        source: validSelection().source,
        pages: [
          {
            page: 1,
            width: 612,
            height: 792,
            rotation: 0,
            extraction: 'native-text',
            nativeCharacterCount: sourceBlock.text.length,
            thumbnailDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
            words: [
              {
                id: 'word:1:0',
                lineId: 'line:1:0',
                page: 1,
                text: sourceBlock.text,
                boundingBox: sourceBlock.boundingBox,
                confidence: 1,
                method: 'native-text'
              }
            ],
            blocks: [sourceBlock]
          }
        ],
        planScan: {
          modelId: 'planscan-test',
          modelVersion: '0.1.0',
          architecture: 'SpatialHashGraph',
          parameterCount: 5_242_880,
          quantization: 'INT8',
          documentType: 'schedule',
          documentTypeConfidence: 0.9,
          blockPredictions: [
            {
              blockId: sourceBlock.id,
              page: 1,
              blockRole: 'plan-field',
              entityRole: 'date',
              roleConfidence: 0.9,
              qualityConfidence: 0.9
            }
          ],
          spans: [
            {
              id: 'span:date',
              blockId: sourceBlock.id,
              page: 1,
              role: 'date',
              text: 'September 99, 2026',
              start: 0,
              end: sourceBlock.text.length,
              wordIds: sourceBlock.wordIds,
              boundingBox: sourceBlock.boundingBox,
              confidence: 0.9
            }
          ],
          relations: [],
          groups: [],
          processingDurationMs: 4,
          warnings: []
        },
        warnings: [],
        processingDurationMs: 4
      }).success
    ).toBe(false)
  })
})
