import { describe, expect, it } from 'vitest'
import {
  documentAnalysisSchema,
  documentExtractionSchema,
  documentFallbackRequestSchema,
  type DocumentExtraction,
  type DocumentExtractionMethod,
  type DocumentTextBlock,
  type DocumentWord
} from '@remind-me/contracts'
import {
  applyDocumentFallbackResponse,
  buildDocumentFallbackRequests,
  planDocumentExtraction,
  type DocumentPlanningContext
} from './document-planner'
import { validateDocumentFallbackResponse } from './document-fallback'

function scheduleGapExtraction(method: DocumentExtractionMethod): DocumentExtraction {
  const lines = [
    'August 24, 2026 - December 4, 2026',
    'Meeting days: M W F',
    'Instructor: Ada Lovelace',
    'Department of Computer Science',
    'Fall term information',
    'Office hours by appointment',
    'Required materials',
    'Attendance policy',
    'Grading details',
    'Academic integrity',
    'Course resources',
    'Room 410',
    'CS 251 Lab',
    '1:00 PM - 1:50 PM'
  ]
  const words: DocumentWord[] = []
  const blocks: DocumentTextBlock[] = lines.map((text, index) => {
    const boundingBox = {
      x: index >= 11 ? 0.56 : 0.08,
      y: 0.05 + index * 0.055,
      width: index >= 11 ? 0.34 : 0.44,
      height: 0.03
    }
    const wordId = `word:1:${index}`
    words.push({
      id: wordId,
      lineId: `line:1:${index}`,
      page: 1,
      text,
      boundingBox,
      confidence: method === 'ocr' ? 0.91 : 1,
      method
    })
    return {
      id: `block:1:${index}`,
      page: 1,
      text,
      boundingBox,
      confidence: method === 'ocr' ? 0.91 : 1,
      method,
      wordIds: [wordId]
    }
  })
  return documentExtractionSchema.parse({
    source: {
      id: `document:${method}`,
      kind: method === 'ocr' ? 'image' : 'pdf',
      displayName: method === 'ocr' ? 'schedule.png' : 'schedule.pdf',
      mediaType: method === 'ocr' ? 'image/png' : 'application/pdf',
      byteLength: 4096,
      sha256: (method === 'ocr' ? 'd' : 'c').repeat(64)
    },
    pages: [
      {
        page: 1,
        width: 612,
        height: 792,
        rotation: 0,
        extraction: method,
        nativeCharacterCount: method === 'native-text' ? lines.join('').length : 0,
        thumbnailDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
        words,
        blocks
      }
    ],
    warnings: [],
    processingDurationMs: 40
  })
}

function context(selectionId: string): DocumentPlanningContext {
  return {
    selectionId,
    nowUtc: '2026-08-27T14:00:00.000Z',
    localDate: '2026-08-27',
    timezone: 'America/Chicago',
    locale: 'en-US',
    defaultCalendarId: 'calendar:local',
    defaultEventDurationMinutes: 60,
    events: [],
    reminders: []
  }
}

function twoItemExtraction(): DocumentExtraction {
  const lines = [
    'August 28, 2026',
    'CS 251 Lab',
    '1:00 PM - 1:50 PM',
    'Room 410',
    'August 29, 2026',
    'Calculus III Discussion',
    '2:00 PM - 2:50 PM',
    'Room 311'
  ]
  const words: DocumentWord[] = []
  const blocks = lines.map((text, index): DocumentTextBlock => {
    const boundingBox = { x: 0.1, y: 0.06 + index * 0.09, width: 0.6, height: 0.04 }
    const wordId = `word:bulk:${index}`
    words.push({
      id: wordId,
      lineId: `line:bulk:${index}`,
      page: 1,
      text,
      boundingBox,
      confidence: 1,
      method: 'native-text'
    })
    return {
      id: `block:bulk:${index}`,
      page: 1,
      text,
      boundingBox,
      confidence: 1,
      method: 'native-text',
      wordIds: [wordId]
    }
  })
  return documentExtractionSchema.parse({
    source: {
      id: 'document:bulk',
      kind: 'pdf',
      displayName: 'two-events.pdf',
      mediaType: 'application/pdf',
      byteLength: 2048,
      sha256: 'e'.repeat(64)
    },
    pages: [
      {
        page: 1,
        width: 612,
        height: 792,
        rotation: 0,
        extraction: 'native-text',
        nativeCharacterCount: lines.join('').length,
        thumbnailDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
        words,
        blocks
      }
    ],
    warnings: [],
    processingDurationMs: 25
  })
}

function recoveredGroup() {
  return {
    titleBlockIds: ['block:1:12'],
    dateBlockId: 'block:1:0',
    timeBlockId: 'block:1:13',
    locationBlockId: 'block:1:11',
    recurrenceBlockId: 'block:1:1',
    descriptionBlockIds: []
  }
}

describe('optional document coverage fallback', () => {
  it.each(['native-text', 'ocr'] as const)(
    'recovers one evidence-backed repeating class from a missed %s layout',
    (method) => {
      const extraction = scheduleGapExtraction(method)
      const planningContext = context(extraction.source.id)
      const deterministic = planDocumentExtraction(extraction, planningContext)
      expect(deterministic.drafts).toHaveLength(0)

      const requests = buildDocumentFallbackRequests(deterministic)
      expect(requests).toHaveLength(1)
      const response = validateDocumentFallbackResponse(requests[0]!, {
        groups: [recoveredGroup()]
      })
      expect(response).not.toBeNull()

      const recovered = applyDocumentFallbackResponse(
        deterministic,
        requests[0]!,
        response!,
        planningContext
      )
      expect(recovered.drafts).toHaveLength(1)
      expect(recovered.drafts[0]).toMatchObject({
        kind: 'event',
        attention: 'check-evidence',
        form: {
          title: 'CS 251 Lab',
          location: 'Room 410',
          startDate: '2026-08-24',
          startTime: '13:00',
          endTime: '13:50',
          recurrence: {
            frequency: 'weekly',
            byWeekday: ['monday', 'wednesday', 'friday'],
            end: { kind: 'until', date: '2026-12-04' }
          }
        },
        schedule: {
          courseCode: 'CS 251',
          component: 'laboratory',
          weekdays: ['monday', 'wednesday', 'friday'],
          verification: 'fallback-grouping'
        },
        importIdentity: {
          semanticKind: 'class-event'
        }
      })
      expect(recovered.drafts[0]!.warnings.join(' ')).toContain(
        'optional local model grouped exact extracted fields'
      )
    }
  )

  it('rejects unknown block IDs, claimed core anchors, and invented untimed items', () => {
    const extraction = scheduleGapExtraction('native-text')
    const deterministic = planDocumentExtraction(extraction, context(extraction.source.id))
    const request = buildDocumentFallbackRequests(deterministic)[0]!
    expect(
      validateDocumentFallbackResponse(request, {
        groups: [{ ...recoveredGroup(), titleBlockIds: ['block:hallucinated'] }]
      })
    ).toBeNull()

    const claimedRequest = documentFallbackRequestSchema.parse({
      ...request,
      blocks: request.blocks.map((block) => ({
        ...block,
        claimed: block.id === 'block:1:0' || block.id === 'block:1:13'
      }))
    })
    expect(
      validateDocumentFallbackResponse(claimedRequest, { groups: [recoveredGroup()] })
    ).toBeNull()

    expect(
      validateDocumentFallbackResponse(request, {
        groups: [{ ...recoveredGroup(), timeBlockId: null }]
      })
    ).toBeNull()
  })

  it('adds multiple distinct fallback groups while merging repeated model groupings', () => {
    const extraction = twoItemExtraction()
    const planningContext = context(extraction.source.id)
    const alreadyParsed = planDocumentExtraction(extraction, planningContext)
    expect(alreadyParsed.drafts).toHaveLength(2)
    expect(buildDocumentFallbackRequests(alreadyParsed)).toHaveLength(0)
    const uncovered = documentAnalysisSchema.parse({
      ...alreadyParsed,
      drafts: [],
      repairSession: null,
      duplicateCandidateCount: 0,
      existingCalendarDuplicateCount: 0,
      likelyDuplicateCount: 0,
      protectedDistinctCount: 0,
      plannerWarnings: []
    })
    const request = buildDocumentFallbackRequests(uncovered)[0]!
    const firstGroup = {
      titleBlockIds: ['block:bulk:1'],
      dateBlockId: 'block:bulk:0',
      timeBlockId: 'block:bulk:2',
      locationBlockId: 'block:bulk:3',
      recurrenceBlockId: null,
      descriptionBlockIds: []
    }
    const secondGroup = {
      titleBlockIds: ['block:bulk:5'],
      dateBlockId: 'block:bulk:4',
      timeBlockId: 'block:bulk:6',
      locationBlockId: 'block:bulk:7',
      recurrenceBlockId: null,
      descriptionBlockIds: []
    }
    const response = validateDocumentFallbackResponse(request, {
      groups: [firstGroup, secondGroup]
    })!
    const recovered = applyDocumentFallbackResponse(uncovered, request, response, planningContext)
    expect(recovered.drafts.map((draft) => draft.form.title)).toEqual([
      'CS 251 Lab',
      'Calculus III Discussion'
    ])

    const repeated = validateDocumentFallbackResponse(request, {
      groups: [firstGroup, { ...firstGroup, descriptionBlockIds: ['block:bulk:1'] }]
    })!
    const deduplicated = applyDocumentFallbackResponse(
      uncovered,
      request,
      repeated,
      planningContext
    )
    expect(deduplicated.drafts).toHaveLength(1)
    expect(deduplicated.duplicateCandidateCount).toBe(1)
  })

  it('leaves the deterministic analysis byte-for-byte equivalent on an invalid response', () => {
    const extraction = scheduleGapExtraction('ocr')
    const planningContext = context(extraction.source.id)
    const deterministic = planDocumentExtraction(extraction, planningContext)
    const request = buildDocumentFallbackRequests(deterministic)[0]!
    const forgedResponse = {
      groups: [{ ...recoveredGroup(), dateBlockId: 'block:missing' }],
      requestId: request.requestId,
      page: request.page,
      modelId: 'qwen3-1.7b-q4' as const,
      hasMutationAuthority: false as const
    }
    expect(
      applyDocumentFallbackResponse(
        deterministic,
        request,
        forgedResponse as never,
        planningContext
      )
    ).toEqual(deterministic)
  })
})
