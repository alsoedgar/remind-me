import { describe, expect, it } from 'vitest'
import {
  documentBoundingBoxSchema,
  documentCommitRequestSchema,
  documentExtractionSchema,
  documentFallbackRequestSchema,
  documentPlanRecordSchema,
  documentProgressEventSchema,
  documentSelectionSchema,
  documentSelectResponseSchema
} from './document-api'
import { documentImportIdentitySchema, documentReconciliationSchema } from './document-identity'

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

function validPlanRecord() {
  return {
    version: '0.1' as const,
    kind: 'event' as const,
    page: 1,
    title: 'Project kickoff',
    description: '',
    allDay: false,
    startDate: '2026-08-26',
    endDate: '2026-08-26',
    startTime: '09:00',
    endTime: '10:00',
    timeBasis: 'source-range' as const,
    timezone: 'America/Chicago',
    timezoneOrigin: 'calendar-default' as const,
    location: 'Studio A',
    recurrence: null,
    schedule: null,
    dateOrigin: 'absolute-source' as const,
    sourceBlockIds: ['block:title', 'block:date', 'block:time', 'block:location'],
    evidence: {
      title: ['block:title'],
      date: ['block:date'],
      time: ['block:time'],
      timezone: [],
      location: ['block:location'],
      recurrence: [],
      course: [],
      description: []
    }
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

  it('accepts a complete evidence-linked semantic plan record', () => {
    expect(documentPlanRecordSchema.parse(validPlanRecord()).title).toBe('Project kickoff')
  })

  it('rejects reversed times and evidence references borrowed from another record', () => {
    expect(
      documentPlanRecordSchema.safeParse({
        ...validPlanRecord(),
        endTime: '08:30'
      }).success
    ).toBe(false)
    expect(
      documentPlanRecordSchema.safeParse({
        ...validPlanRecord(),
        evidence: { ...validPlanRecord().evidence, location: ['block:another-row'] }
      }).success
    ).toBe(false)
    expect(
      documentPlanRecordSchema.safeParse({
        ...validPlanRecord(),
        evidence: { ...validPlanRecord().evidence, time: [] }
      }).success
    ).toBe(false)
  })

  it('rejects unsupported recurrence and occurrences outside source term bounds', () => {
    const recurrence = {
      frequency: 'weekly' as const,
      interval: 1,
      byWeekday: ['monday' as const],
      byMonthDay: [],
      end: { kind: 'until' as const, date: '2026-12-04' }
    }
    expect(
      documentPlanRecordSchema.safeParse({
        ...validPlanRecord(),
        recurrence
      }).success
    ).toBe(false)
    expect(
      documentPlanRecordSchema.safeParse({
        ...validPlanRecord(),
        startDate: '2026-12-07',
        endDate: '2026-12-07',
        recurrence,
        schedule: {
          courseCode: 'CS 199',
          sectionCode: null,
          crn: null,
          creditHours: null,
          component: 'lecture',
          termStartDate: '2026-08-24',
          termEndDate: '2026-12-04',
          weekdays: ['monday'],
          verification: 'layout'
        },
        sourceBlockIds: [...validPlanRecord().sourceBlockIds, 'block:recurrence', 'block:course'],
        evidence: {
          ...validPlanRecord().evidence,
          recurrence: ['block:recurrence'],
          course: ['block:course']
        }
      }).success
    ).toBe(false)

    const scheduleRecord = {
      ...validPlanRecord(),
      recurrence: { ...recurrence, interval: 2 },
      schedule: {
        courseCode: 'CS 199',
        sectionCode: null,
        crn: null,
        creditHours: null,
        component: 'lecture' as const,
        termStartDate: '2026-08-24',
        termEndDate: '2026-12-04',
        weekdays: ['monday' as const],
        verification: 'layout' as const
      },
      sourceBlockIds: [...validPlanRecord().sourceBlockIds, 'block:recurrence', 'block:course'],
      evidence: {
        ...validPlanRecord().evidence,
        recurrence: ['block:recurrence'],
        course: ['block:course']
      }
    }
    expect(documentPlanRecordSchema.safeParse(scheduleRecord).success).toBe(false)
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

  it('keeps class identities and reconciliation recommendations internally consistent', () => {
    expect(
      documentImportIdentitySchema.safeParse({
        sourceSha256: 'a'.repeat(64),
        sourceRowId: 'row:0000000000000001',
        semanticKind: 'class-event',
        semanticKey: 'class:0000000000000001',
        course: null
      }).success
    ).toBe(false)
    expect(
      documentReconciliationSchema.safeParse({
        state: 'likely-duplicate',
        recommendedSelected: true,
        matches: [
          {
            entityKind: 'event',
            entityId: 'event:existing',
            title: 'Project kickoff',
            detail: '2026-08-26 · 09:00–10:00',
            relationship: 'likely-semantic-overlap'
          }
        ]
      }).success
    ).toBe(false)
  })

  it('rejects a commit that repeats one stable document source row', () => {
    const sourceIdentity = {
      sourceSha256: 'a'.repeat(64),
      sourceRowId: 'row:0000000000000001'
    }
    const form = {
      id: null,
      calendarId: 'calendar:local',
      title: 'Project kickoff',
      description: '',
      location: 'Studio A',
      startDate: '2026-08-26',
      startTime: '09:00',
      endDate: '2026-08-26',
      endTime: '10:00',
      timezone: 'America/Chicago',
      allDay: false,
      recurrence: null
    }
    expect(
      documentCommitRequestSchema.safeParse({
        selectionId: 'document:test',
        items: [
          { draftId: 'draft:one', kind: 'event', sourceIdentity, schedule: null, form },
          { draftId: 'draft:two', kind: 'event', sourceIdentity, schedule: null, form }
        ],
        range: {
          rangeStartUtc: '2026-08-01T00:00:00.000Z',
          rangeEndUtc: '2026-09-01T00:00:00.000Z'
        }
      }).success
    ).toBe(false)
  })

  it('bounds fallback grouping to exact blocks from one unclaimed page window', () => {
    const request = {
      schemaVersion: 1 as const,
      requestId: 'fallback:test:1',
      selectionId: 'document:test',
      sourceSha256: 'b'.repeat(64),
      reason: 'coverage-gap' as const,
      page: 1,
      blocks: [
        {
          id: 'block:1:0',
          page: 1,
          text: 'Project kickoff — August 26, 2026 at 9:00 AM',
          boundingBox: { x: 0.1, y: 0.1, width: 0.7, height: 0.04 },
          confidence: 0.96,
          method: 'native-text' as const,
          claimed: false
        }
      ]
    }
    expect(documentFallbackRequestSchema.parse(request).blocks).toHaveLength(1)
    expect(
      documentFallbackRequestSchema.safeParse({
        ...request,
        blocks: request.blocks.map((block) => ({ ...block, page: 2 }))
      }).success
    ).toBe(false)
    expect(
      documentFallbackRequestSchema.safeParse({
        ...request,
        blocks: request.blocks.map((block) => ({ ...block, claimed: true }))
      }).success
    ).toBe(false)
  })
})
