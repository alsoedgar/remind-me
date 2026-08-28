import { describe, expect, it } from 'vitest'
import {
  documentExtractionSchema,
  type DocumentExtraction,
  type DocumentExtractionMethod,
  type DocumentTextBlock,
  type DocumentWord
} from '@remind-me/contracts'
import { planDocumentExtraction } from './document-planner'
import { applyDocumentRepairResponse, validateDocumentRepairResponse } from './document-repair'
import { contentFromPositionedWords, type PositionedDocumentWord } from './document-text-layout'

function extraction(method: DocumentExtractionMethod, confidence = 1): DocumentExtraction {
  const texts = [
    'August 26, 2026',
    'Project kickoff',
    '9:00 AM - 10:00 AM',
    'Location: Studio A',
    'August 28, 2026',
    'Design review',
    '2:00 PM - 3:30 PM',
    'Location: Reading Room',
    'Reminder: Submit portfolio',
    'Due August 30, 2026 at 6:00 PM'
  ]
  const words: DocumentWord[] = []
  const blocks: DocumentTextBlock[] = texts.map((text, index) => {
    const lineId = `line:1:${index}`
    const wordId = `word:1:${index}`
    words.push({
      id: wordId,
      lineId,
      page: 1,
      text,
      boundingBox: { x: 0.1, y: 0.05 + index * 0.075, width: 0.7, height: 0.04 },
      confidence,
      method
    })
    return {
      id: `block:1:${index}`,
      page: 1,
      text,
      boundingBox: { x: 0.1, y: 0.05 + index * 0.075, width: 0.7, height: 0.04 },
      confidence,
      method,
      wordIds: [wordId]
    }
  })
  return documentExtractionSchema.parse({
    source: {
      id: 'document:test',
      kind: method === 'ocr' ? 'image' : 'pdf',
      displayName: method === 'ocr' ? 'plan.png' : 'plan.pdf',
      mediaType: method === 'ocr' ? 'image/png' : 'application/pdf',
      byteLength: 2048,
      sha256: 'a'.repeat(64)
    },
    pages: [
      {
        page: 1,
        width: 612,
        height: 792,
        rotation: 0,
        extraction: method,
        nativeCharacterCount: method === 'native-text' ? 160 : 0,
        thumbnailDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
        words,
        blocks
      }
    ],
    warnings: [],
    processingDurationMs: 420
  })
}

function lineDocumentExtraction(
  pages: readonly (readonly string[])[],
  shaCharacter = 'c'
): DocumentExtraction {
  const extractedPages = pages.map((lines, pageIndex) => {
    const page = pageIndex + 1
    const words: DocumentWord[] = []
    const blocks: DocumentTextBlock[] = lines.map((text, index) => {
      const lineId = `line:${page}:${index}`
      const wordId = `word:${page}:${index}`
      const boundingBox = { x: 0.1, y: 0.05 + index * 0.065, width: 0.76, height: 0.028 }
      words.push({
        id: wordId,
        lineId,
        page,
        text,
        boundingBox,
        confidence: 1,
        method: 'native-text'
      })
      return {
        id: `block:${page}:${index}`,
        page,
        text,
        boundingBox,
        confidence: 1,
        method: 'native-text',
        wordIds: [wordId]
      }
    })
    return {
      page,
      width: 612,
      height: 792,
      rotation: 0 as const,
      extraction: 'native-text' as const,
      nativeCharacterCount: lines.reduce((total, line) => total + line.length, 0),
      thumbnailDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
      words,
      blocks
    }
  })
  return documentExtractionSchema.parse({
    source: {
      id: 'document:syllabus',
      kind: 'pdf',
      displayName: 'syllabus.pdf',
      mediaType: 'application/pdf',
      byteLength: 4096,
      sha256: shaCharacter.repeat(64)
    },
    pages: extractedPages,
    warnings: [],
    processingDurationMs: 120
  })
}

function crossRowPlanScanExtraction(): DocumentExtraction {
  const base = lineDocumentExtraction(
    [
      [
        'August 26, 2026',
        'Project kickoff',
        '9:00 AM - 10:00 AM',
        'August 28, 2026',
        'Design review',
        '2:00 PM - 3:00 PM',
        'Location: Reading Room'
      ]
    ],
    'e'
  )
  const blocks = base.pages[0]!.blocks
  const makeSpan = (
    id: string,
    block: DocumentTextBlock,
    role: 'title' | 'date' | 'time' | 'location'
  ) => ({
    id,
    blockId: block.id,
    page: block.page,
    role,
    text: block.text,
    start: 0,
    end: block.text.length,
    wordIds: block.wordIds,
    boundingBox: block.boundingBox,
    confidence: 0.97
  })
  const title = blocks[1]!
  const date = blocks[0]!
  const time = blocks[2]!
  const borrowedLocation = blocks[6]!
  const spans = [
    makeSpan('span:cross-row:title', title, 'title'),
    makeSpan('span:cross-row:date', date, 'date'),
    makeSpan('span:cross-row:time', time, 'time'),
    makeSpan('span:cross-row:location', borrowedLocation, 'location')
  ]
  return documentExtractionSchema.parse({
    ...base,
    planScan: {
      modelId: 'planscan-adversarial',
      modelVersion: '0.1.0',
      architecture: 'SpatialHashGraph',
      parameterCount: 5_242_880,
      quantization: 'INT8',
      documentType: 'schedule',
      documentTypeConfidence: 0.98,
      blockPredictions: [],
      spans,
      relations: [],
      groups: [
        {
          id: 'group:cross-row',
          page: 1,
          kind: 'event',
          confidence: 0.98,
          titleSpanId: spans[0]!.id,
          dateSpanId: spans[1]!.id,
          timeSpanId: spans[2]!.id,
          locationSpanId: spans[3]!.id,
          descriptionSpanIds: [],
          recurrenceSpanId: null,
          evidenceBlockIds: [title.id, date.id, time.id, borrowedLocation.id]
        }
      ],
      processingDurationMs: 5,
      warnings: []
    }
  })
}

function repairablePlanScanDisagreementExtraction(): DocumentExtraction {
  const extraction = crossRowPlanScanExtraction()
  const planScan = extraction.planScan!
  const group = planScan.groups[0]!
  return documentExtractionSchema.parse({
    ...extraction,
    planScan: {
      ...planScan,
      groups: [
        {
          ...group,
          kind: 'reminder',
          locationSpanId: null,
          evidenceBlockIds: group.evidenceBlockIds.slice(0, 3)
        }
      ]
    }
  })
}

function syllabusExtraction(): DocumentExtraction {
  return lineDocumentExtraction([
    [
      'CS 199 COURSE SYLLABUS',
      'Fall 2026 - sanitized evaluation fixture',
      'Weekly lecture',
      'August 24, 2026 - December 4, 2026',
      'Every Monday and Wednesday',
      '10:00 AM - 10:50 AM',
      'Location: Room 201',
      'Course practices',
      'Bring questions, take breaks, and keep a private copy of your work.'
    ],
    [
      'KEY DATES',
      'Review dates and times before adding them',
      'September 28, 2026',
      'Midterm exam',
      '10:00 AM - 10:50 AM',
      'Location: Room 201',
      'Reminder: Submit final project',
      'Due October 30, 2026 at 11:59 PM',
      'Asynchronous reflection',
      'Available November 2, 2026',
      'ARR - no fixed meeting time'
    ]
  ])
}

interface ScheduleRow {
  title: string
  course: string
  creditHours: string
  crn: string
  dateRange: string
  weekdays: string | null
  time: string | null
  location: string
}

const scheduleRows: readonly ScheduleRow[] = [
  {
    title: 'Culture and Food',
    course: 'HN 202 0',
    creditHours: '2.0',
    crn: '26950',
    dateRange: '08/24/2026 - 12/04/2026',
    weekdays: null,
    time: null,
    location: 'Chicago, Online Section, ARR'
  },
  {
    title: 'Jazz History',
    course: 'MUS 114 0',
    creditHours: '3.0',
    crn: '34708',
    dateRange: '08/24/2026 - 12/04/2026',
    weekdays: null,
    time: null,
    location: 'Chicago, Online Section, ARR'
  },
  {
    title: 'Data Structures',
    course: 'CS 251 AL3',
    creditHours: '4.0',
    crn: '42499',
    dateRange: '08/24/2026 - 12/04/2026',
    weekdays: 'M, W, F',
    time: '02:00 PM - 02:50 PM',
    location: 'Chicago, Research Center, 1426'
  },
  {
    title: 'Data Structures',
    course: 'CS 251 ABM',
    creditHours: '0.0',
    crn: '42651',
    dateRange: '08/24/2026 - 12/04/2026',
    weekdays: 'Tuesday',
    time: '12:00 PM - 01:50 PM',
    location: 'Chicago, Research Center, 2405'
  },
  {
    title: 'Programming Practicum',
    course: 'CS 211 AAH',
    creditHours: '0.0',
    crn: '42655',
    dateRange: '08/24/2026 - 12/04/2026',
    weekdays: 'Thursday',
    time: '12:00 PM - 01:50 PM',
    location: 'Chicago, Research Center, 2405'
  },
  {
    title: 'Calculus III',
    course: 'MATH 210 SL',
    creditHours: '3.0',
    crn: '42915',
    dateRange: '08/24/2026 - 12/04/2026',
    weekdays: 'MWF',
    time: '01:00 PM - 01:50 PM',
    location: 'Chicago, Addams Hall, 311'
  },
  {
    title: 'Calculus III',
    course: 'MATH 210 SD',
    creditHours: '0.0',
    crn: '42916',
    dateRange: '08/24/2026 - 12/04/2026',
    weekdays: 'Tuesday',
    time: '02:00 PM - 02:50 PM',
    location: 'Chicago, Stevenson Hall, 216'
  },
  {
    title: 'Applied Linear Algebra',
    course: 'MATH 218 0',
    creditHours: '3.0',
    crn: '50627',
    dateRange: '08/24/2026 - 12/04/2026',
    weekdays: 'M W F',
    time: '12:00 PM - 12:50 PM',
    location: 'Chicago, Engineering South, 130'
  },
  {
    title: 'Programming Practicum',
    course: 'CS 211 AS4',
    creditHours: '3.0',
    crn: '50786',
    dateRange: '08/24/2026 - 12/04/2026',
    weekdays: 'W/F',
    time: '03:00 PM - 03:50 PM',
    location: 'Chicago, Research Center, 1426'
  }
]

function addPositionedText(
  words: PositionedDocumentWord[],
  text: string,
  x: number,
  y: number,
  confidence: number
): void {
  let offset = x
  for (const token of text.split(/\s+/u)) {
    const width = Math.max(0.008, token.length * 0.0052)
    words.push({
      text: token,
      confidence,
      boundingBox: { x: offset, y, width, height: 0.012 }
    })
    offset += width + 0.004
  }
}

function tableScheduleExtraction(
  method: DocumentExtractionMethod,
  confidence = 1,
  rows: readonly ScheduleRow[] = scheduleRows
): DocumentExtraction {
  const positioned: PositionedDocumentWord[] = []
  addPositionedText(positioned, '8/22/26, 1:11 PM', 0.04, 0.02, confidence)
  addPositionedText(positioned, 'Banner', 0.55, 0.02, confidence)
  addPositionedText(positioned, 'Title', 0.05, 0.08, confidence)
  addPositionedText(positioned, 'Course Details', 0.26, 0.08, confidence)
  addPositionedText(positioned, 'Meeting Times', 0.58, 0.08, confidence)
  rows.forEach((row, index) => {
    const y = 0.12 + index * 0.085
    addPositionedText(positioned, row.title, 0.05, y, confidence)
    addPositionedText(positioned, row.course, 0.26, y, confidence)
    addPositionedText(positioned, row.creditHours, 0.39, y, confidence)
    addPositionedText(positioned, row.crn, 0.49, y, confidence)
    addPositionedText(positioned, row.dateRange, 0.58, y, confidence)
    if (row.weekdays) addPositionedText(positioned, row.weekdays, 0.58, y + 0.017, confidence)
    if (row.time) addPositionedText(positioned, row.time, 0.58, y + 0.034, confidence)
    addPositionedText(positioned, row.location, 0.58, y + (row.time ? 0.051 : 0.017), confidence)
  })
  const content = contentFromPositionedWords(positioned, 1, method, 'schedule')
  return documentExtractionSchema.parse({
    source: {
      id: 'document:schedule-table',
      kind: method === 'ocr' ? 'image' : 'pdf',
      displayName: method === 'ocr' ? 'schedule.png' : 'schedule.pdf',
      mediaType: method === 'ocr' ? 'image/png' : 'application/pdf',
      byteLength: 4096,
      sha256: 'b'.repeat(64)
    },
    pages: [
      {
        page: 1,
        width: 612,
        height: 792,
        rotation: 0,
        extraction: method,
        nativeCharacterCount: method === 'native-text' ? 1_200 : 0,
        thumbnailDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
        ...content
      }
    ],
    warnings: [],
    processingDurationMs: 500
  })
}

function positionedImageExtraction(
  positioned: readonly PositionedDocumentWord[],
  name: string,
  shaCharacter: string
): DocumentExtraction {
  const content = contentFromPositionedWords(positioned, 1, 'ocr', name)
  return documentExtractionSchema.parse({
    source: {
      id: `document:${name}`,
      kind: 'image',
      displayName: `${name}.png`,
      mediaType: 'image/png',
      byteLength: 4096,
      sha256: shaCharacter.repeat(64)
    },
    pages: [
      {
        page: 1,
        width: 1400,
        height: 1000,
        rotation: 0,
        extraction: 'ocr',
        nativeCharacterCount: 0,
        thumbnailDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
        ...content
      }
    ],
    warnings: [],
    processingDurationMs: 500
  })
}

function calendarGridExtraction(): DocumentExtraction {
  const positioned: PositionedDocumentWord[] = []
  addPositionedText(positioned, 'SEPTEMBER 2026', 0.06, 0.03, 0.96)
  ;['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'].forEach((weekday, index) => {
    addPositionedText(positioned, weekday, 0.07 + index * 0.13, 0.11, 0.96)
  })
  addPositionedText(positioned, '30', 0.07, 0.2, 0.92)
  addPositionedText(positioned, '31', 0.07 + 0.13, 0.2, 0.92)
  addPositionedText(positioned, '1', 0.07 + 2 * 0.13, 0.2, 0.96)
  addPositionedText(positioned, '6', 0.07, 0.34, 0.96)
  addPositionedText(positioned, '8', 0.07 + 2 * 0.13, 0.34, 0.96)
  addPositionedText(positioned, 'Team sync', 0.07 + 2 * 0.13, 0.37, 0.95)
  addPositionedText(positioned, '9:00 AM', 0.07 + 2 * 0.13, 0.4, 0.95)
  addPositionedText(positioned, 'Studio A', 0.07 + 2 * 0.13, 0.43, 0.95)
  addPositionedText(positioned, '14', 0.07 + 1 * 0.13, 0.48, 0.96)
  addPositionedText(positioned, 'Dentist', 0.07 + 1 * 0.13, 0.51, 0.96)
  addPositionedText(positioned, '3:30 PM', 0.07 + 1 * 0.13, 0.54, 0.96)
  addPositionedText(positioned, 'Clinic 4', 0.07 + 1 * 0.13, 0.57, 0.96)
  addPositionedText(positioned, '25', 0.07 + 5 * 0.13, 0.62, 0.96)
  addPositionedText(positioned, 'Reminder:', 0.07 + 5 * 0.13, 0.65, 0.96)
  addPositionedText(positioned, 'Rent due', 0.07 + 5 * 0.13, 0.68, 0.96)
  addPositionedText(positioned, '5:00 PM', 0.07 + 5 * 0.13, 0.71, 0.96)
  return positionedImageExtraction(positioned, 'month-grid', 'c')
}

function flyerExtraction(): DocumentExtraction {
  const positioned: PositionedDocumentWord[] = []
  addPositionedText(positioned, 'River Park', 0.1, 0.15, 0.96)
  addPositionedText(positioned, 'Night Market', 0.1, 0.17, 0.96)
  addPositionedText(positioned, 'September 5, 2026', 0.1, 0.26, 0.96)
  addPositionedText(positioned, '5:00 PM - 9:00 PM', 0.1, 0.34, 0.95)
  addPositionedText(positioned, 'River Park Pavilion', 0.1, 0.42, 0.95)
  return positionedImageExtraction(positioned, 'event-flyer', 'd')
}

const context = {
  selectionId: 'document:test',
  nowUtc: '2026-08-24T15:00:00.000Z',
  localDate: '2026-08-24',
  timezone: 'America/Chicago',
  locale: 'en-US',
  defaultCalendarId: 'calendar:local',
  defaultEventDurationMinutes: 60,
  events: [],
  reminders: []
} as const

describe('document planner', () => {
  it('turns native PDF lines into evidence-backed, editable batch proposals', () => {
    const planned = planDocumentExtraction(extraction('native-text'), context)
    expect(planned.drafts.map((draft) => [draft.kind, draft.form.title])).toEqual([
      ['event', 'Project kickoff'],
      ['event', 'Design review'],
      ['reminder', 'Submit portfolio']
    ])
    expect(planned.drafts).toHaveLength(3)
    const first = planned.drafts[0]
    expect(first?.kind).toBe('event')
    if (first?.kind !== 'event') throw new Error('Expected an event draft')
    expect(first.form).toMatchObject({
      startDate: '2026-08-26',
      startTime: '09:00',
      endTime: '10:00',
      location: 'Studio A'
    })
    const evidenceIds = new Set(first.proposal.evidence.map((item) => item.id))
    expect(first.fieldEvidence.title.every((id) => evidenceIds.has(id))).toBe(true)
    expect(first.fieldEvidence.when.every((id) => evidenceIds.has(id))).toBe(true)
    expect(first.fieldEvidence.location.every((id) => evidenceIds.has(id))).toBe(true)
    expect(first.fieldConfidence).toMatchObject({ title: 1, when: 1, location: 1 })
    expect(first.proposal.evidence.every((item) => item.sourceKind === 'pdf')).toBe(true)
    expect(first.semanticRecord).toMatchObject({
      kind: 'event',
      startDate: '2026-08-26',
      endDate: '2026-08-26',
      startTime: '09:00',
      endTime: '10:00',
      timeBasis: 'source-range',
      timezoneOrigin: 'calendar-default',
      dateOrigin: 'absolute-source'
    })
    expect(
      Object.values(first.semanticRecord.evidence)
        .flat()
        .every((id) => first.semanticRecord.sourceBlockIds.includes(id))
    ).toBe(true)
  })

  it('flags lower-confidence OCR while preserving the same proposals and evidence', () => {
    const planned = planDocumentExtraction(extraction('ocr', 0.71), context)
    expect(planned.drafts).toHaveLength(3)
    expect(planned.drafts.every((draft) => draft.attention === 'check-evidence')).toBe(true)
    expect(
      planned.drafts.every((draft) => draft.warnings.some((warning) => /OCR/iu.test(warning)))
    ).toBe(true)
    expect(planned.drafts[0]?.proposal.evidence[0]?.sourceKind).toBe('image')
    expect(planned.drafts[0]?.fieldConfidence.when).toBeCloseTo(0.71)
  })

  it('removes terminal OCR stop noise without changing the evidence text', () => {
    const input = extraction('ocr')
    const titleBlock = input.pages[0]?.blocks[5]
    const titleWord = input.pages[0]?.words[5]
    if (!titleBlock || !titleWord) throw new Error('Expected the OCR title evidence')
    titleBlock.text = 'Design review.'
    titleWord.text = 'Design review.'

    const planned = planDocumentExtraction(input, context)
    const designReview = planned.drafts.find((draft) => draft.form.title === 'Design review')
    expect(designReview?.form.title).toBe('Design review')
    expect(designReview?.sourceText).toContain('Design review.')
  })

  it('reconstructs term-bounded syllabus meetings and counts no-fixed-time items', () => {
    const planned = planDocumentExtraction(syllabusExtraction(), context)

    expect(planned.drafts.map((draft) => [draft.kind, draft.form.title])).toEqual([
      ['event', 'Weekly lecture'],
      ['event', 'Midterm exam'],
      ['reminder', 'Submit final project']
    ])
    expect(planned.skippedCandidateCount).toBe(1)
    expect(planned.skippedItems).toHaveLength(1)
    expect(planned.skippedItems[0]).toMatchObject({
      page: 2,
      category: 'no-fixed-time',
      title: 'Asynchronous reflection'
    })
    expect(planned.skippedItems[0]?.evidenceIds.length).toBeGreaterThan(0)
    const lecture = planned.drafts.find(
      (draft) => draft.kind === 'event' && draft.form.title === 'Weekly lecture'
    )
    if (lecture?.kind !== 'event') throw new Error('Expected the weekly lecture event')
    expect(lecture.form).toMatchObject({
      startDate: '2026-08-24',
      startTime: '10:00',
      endTime: '10:50',
      location: 'Room 201',
      recurrence: {
        frequency: 'weekly',
        byWeekday: ['monday', 'wednesday'],
        end: { kind: 'until', date: '2026-12-04' }
      }
    })
    expect(lecture.schedule).toMatchObject({
      courseCode: 'CS 199',
      sectionCode: null,
      crn: null,
      component: 'lecture',
      termStartDate: '2026-08-24',
      termEndDate: '2026-12-04',
      weekdays: ['monday', 'wednesday']
    })
    expect(lecture.form.description).toContain('Course: CS 199 · Lecture')
    expect(lecture.fieldEvidence.description).toContain('block:1:0')
    expect(
      planned.plannerWarnings.some((warning) =>
        /1 syllabus item.*no fixed meeting time/iu.test(warning)
      )
    ).toBe(true)
  })

  it('carries course identity across syllabus pages and preserves the meeting component', () => {
    const planned = planDocumentExtraction(
      lineDocumentExtraction(
        [
          ['CS 240 Course Syllabus', 'Fall 2026'],
          [
            'Laboratory',
            'August 25, 2026 - December 4, 2026',
            'Every Tuesday',
            '2:00 PM - 3:50 PM',
            'Location: Engineering Lab 4'
          ]
        ],
        'd'
      ),
      context
    )

    expect(planned.drafts).toHaveLength(1)
    const laboratory = planned.drafts[0]
    if (laboratory?.kind !== 'event') throw new Error('Expected the laboratory event')
    expect(laboratory.schedule).toMatchObject({
      courseCode: 'CS 240',
      component: 'laboratory',
      weekdays: ['tuesday'],
      termEndDate: '2026-12-04'
    })
    expect(laboratory.proposal.evidence.some((item) => item.page === 1)).toBe(true)
    expect(laboratory.proposal.evidence.some((item) => item.page === 2)).toBe(true)
  })

  it('reconstructs recurring course rows and refuses to invent asynchronous meetings', () => {
    const planned = planDocumentExtraction(tableScheduleExtraction('native-text'), context)
    expect(planned.drafts).toHaveLength(7)
    expect(
      planned.drafts.map((draft) =>
        draft.kind === 'event'
          ? {
              title: draft.form.title,
              startDate: draft.form.startDate,
              startTime: draft.form.startTime,
              endTime: draft.form.endTime,
              weekdays: draft.form.recurrence?.byWeekday,
              until:
                draft.form.recurrence?.end.kind === 'until' ? draft.form.recurrence.end.date : null
            }
          : null
      )
    ).toEqual([
      {
        title: 'Data Structures',
        startDate: '2026-08-24',
        startTime: '14:00',
        endTime: '14:50',
        weekdays: ['monday', 'wednesday', 'friday'],
        until: '2026-12-04'
      },
      {
        title: 'Data Structures',
        startDate: '2026-08-25',
        startTime: '12:00',
        endTime: '13:50',
        weekdays: ['tuesday'],
        until: '2026-12-04'
      },
      {
        title: 'Programming Practicum',
        startDate: '2026-08-27',
        startTime: '12:00',
        endTime: '13:50',
        weekdays: ['thursday'],
        until: '2026-12-04'
      },
      {
        title: 'Calculus III',
        startDate: '2026-08-24',
        startTime: '13:00',
        endTime: '13:50',
        weekdays: ['monday', 'wednesday', 'friday'],
        until: '2026-12-04'
      },
      {
        title: 'Calculus III',
        startDate: '2026-08-25',
        startTime: '14:00',
        endTime: '14:50',
        weekdays: ['tuesday'],
        until: '2026-12-04'
      },
      {
        title: 'Applied Linear Algebra',
        startDate: '2026-08-24',
        startTime: '12:00',
        endTime: '12:50',
        weekdays: ['monday', 'wednesday', 'friday'],
        until: '2026-12-04'
      },
      {
        title: 'Programming Practicum',
        startDate: '2026-08-26',
        startTime: '15:00',
        endTime: '15:50',
        weekdays: ['wednesday', 'friday'],
        until: '2026-12-04'
      }
    ])
    expect(
      planned.plannerWarnings.some((warning) => /2 schedule rows.*no fixed/iu.test(warning))
    ).toBe(true)
    expect(planned.skippedItems.map((item) => item.title)).toEqual([
      'Culture and Food',
      'Jazz History'
    ])
    expect(planned.skippedItems.every((item) => item.category === 'no-fixed-time')).toBe(true)
    expect(
      planned.drafts.every(
        (draft) => draft.kind === 'event' && draft.form.endDate === draft.form.startDate
      )
    ).toBe(true)
    expect(
      planned.drafts[0]?.kind === 'event' ? planned.drafts[0].form.description : null
    ).toContain('Course: CS 251 · Section: AL3 · CRN: 42499')
    expect(planned.drafts[0]?.schedule).toMatchObject({
      courseCode: 'CS 251',
      sectionCode: 'AL3',
      crn: '42499',
      creditHours: 4,
      component: 'primary-section',
      weekdays: ['monday', 'wednesday', 'friday']
    })
    expect(planned.drafts[1]?.schedule).toMatchObject({
      courseCode: 'CS 251',
      sectionCode: 'ABM',
      crn: '42651',
      creditHours: 0,
      component: 'linked-section',
      weekdays: ['tuesday']
    })
    expect(
      planned.drafts.reduce(
        (total, draft) => total + (draft.form.recurrence?.byWeekday.length ?? 1),
        0
      )
    ).toBe(14)
  })

  it('surfaces a likely class duplicate for explicit review instead of silently dropping it', () => {
    const firstPass = planDocumentExtraction(tableScheduleExtraction('native-text'), context)
    const first = firstPass.drafts[0]
    if (first?.kind !== 'event') throw new Error('Expected a class event')
    const secondPass = planDocumentExtraction(tableScheduleExtraction('native-text'), {
      ...context,
      events: [
        {
          id: 'event:already-imported',
          calendarId: 'calendar:local',
          title: first.form.title,
          description: first.form.description,
          location: first.form.location,
          startUtc: first.resolved.fields.startUtc!,
          endUtc: first.resolved.fields.endUtc!,
          timezone: first.form.timezone,
          allDay: first.form.allDay,
          recurrence: first.form.recurrence,
          status: 'active',
          provenance: 'import',
          createdAt: '2026-08-24T15:00:00.000Z',
          updatedAt: '2026-08-24T15:00:00.000Z'
        }
      ]
    })

    expect(secondPass.drafts).toHaveLength(7)
    expect(secondPass.existingCalendarDuplicateCount).toBe(0)
    expect(secondPass.likelyDuplicateCount).toBe(1)
    expect(
      secondPass.drafts.find((draft) => draft.schedule?.crn === '42499')?.reconciliation
    ).toMatchObject({ state: 'likely-duplicate', recommendedSelected: false })
  })

  it('recognizes an exact source-row reimport and keeps it visible but locked out', () => {
    const firstPass = planDocumentExtraction(tableScheduleExtraction('native-text'), context)
    const first = firstPass.drafts[0]
    if (first?.kind !== 'event') throw new Error('Expected a class event')
    const secondPass = planDocumentExtraction(tableScheduleExtraction('native-text'), {
      ...context,
      events: [
        {
          id: 'event:source-row',
          calendarId: 'calendar:local',
          title: first.form.title,
          description: first.form.description,
          location: first.form.location,
          startUtc: first.resolved.fields.startUtc!,
          endUtc: first.resolved.fields.endUtc!,
          timezone: first.form.timezone,
          allDay: first.form.allDay,
          recurrence: first.form.recurrence,
          status: 'active',
          provenance: 'import',
          importIdentity: first.importIdentity,
          createdAt: '2026-08-24T15:00:00.000Z',
          updatedAt: '2026-08-24T15:00:00.000Z'
        }
      ]
    })

    expect(secondPass.drafts).toHaveLength(7)
    expect(secondPass.existingCalendarDuplicateCount).toBe(1)
    expect(
      secondPass.drafts.find((draft) => draft.schedule?.crn === '42499')?.reconciliation
    ).toMatchObject({ state: 'same-source', recommendedSelected: false })
  })

  it('protects a similar class when its CRN or component identifies a distinct section', () => {
    const firstPass = planDocumentExtraction(tableScheduleExtraction('native-text'), context)
    const first = firstPass.drafts[0]
    if (first?.kind !== 'event') throw new Error('Expected a class event')
    const secondPass = planDocumentExtraction(tableScheduleExtraction('native-text'), {
      ...context,
      events: [
        {
          id: 'event:different-component',
          calendarId: 'calendar:local',
          title: first.form.title,
          description: first.form.description
            .replace('CRN: 42499', 'CRN: 99999')
            .replace('Primary section', 'Laboratory'),
          location: first.form.location,
          startUtc: first.resolved.fields.startUtc!,
          endUtc: first.resolved.fields.endUtc!,
          timezone: first.form.timezone,
          allDay: first.form.allDay,
          recurrence: first.form.recurrence,
          status: 'active',
          provenance: 'import',
          createdAt: '2026-08-24T15:00:00.000Z',
          updatedAt: '2026-08-24T15:00:00.000Z'
        }
      ]
    })

    expect(secondPass.protectedDistinctCount).toBe(1)
    expect(
      secondPass.drafts.find((draft) => draft.schedule?.crn === '42499')?.reconciliation
    ).toMatchObject({ state: 'protected-distinct', recommendedSelected: true })
  })

  it('keeps lecture and laboratory rows separate even when their days and times match', () => {
    const shared = {
      dateRange: '08/24/2026 - 12/04/2026',
      weekdays: 'M/W/F',
      time: '09:00 AM - 09:50 AM',
      location: 'Science Hall 101'
    }
    const planned = planDocumentExtraction(
      tableScheduleExtraction('native-text', 1, [
        {
          ...shared,
          title: 'General Chemistry Lecture',
          course: 'CHEM 101 L1',
          creditHours: '3.0',
          crn: '61001'
        },
        {
          ...shared,
          title: 'General Chemistry Laboratory',
          course: 'CHEM 101 B1',
          creditHours: '0.0',
          crn: '61002'
        }
      ]),
      context
    )

    expect(planned.drafts).toHaveLength(2)
    expect(planned.drafts.map((draft) => draft.schedule?.component)).toEqual([
      'lecture',
      'laboratory'
    ])
    expect(planned.drafts.map((draft) => draft.schedule?.crn)).toEqual(['61001', '61002'])
  })

  it('uses the same geometry reconstruction for OCR schedule images', () => {
    const planned = planDocumentExtraction(tableScheduleExtraction('ocr', 0.77), context)
    expect(planned.drafts).toHaveLength(7)
    expect(planned.drafts.every((draft) => draft.attention === 'check-evidence')).toBe(true)
    expect(
      planned.drafts.every((draft) =>
        draft.proposal.evidence.every((item) => item.sourceKind === 'image')
      )
    ).toBe(true)
  })

  it('links month-grid cell text to the correct visible dates and locations', () => {
    const planned = planDocumentExtraction(calendarGridExtraction(), context)
    expect(planned.skippedCandidateCount).toBe(0)
    expect(
      planned.drafts.map((draft) => ({
        kind: draft.kind,
        title: draft.form.title,
        date: draft.kind === 'event' ? draft.form.startDate : draft.form.dueDate,
        time: draft.kind === 'event' ? draft.form.startTime : draft.form.dueTime,
        location: draft.kind === 'event' ? draft.form.location : null
      }))
    ).toEqual([
      {
        kind: 'event',
        title: 'Team sync',
        date: '2026-09-08',
        time: '09:00',
        location: 'Studio A'
      },
      {
        kind: 'event',
        title: 'Dentist',
        date: '2026-09-14',
        time: '15:30',
        location: 'Clinic 4'
      },
      {
        kind: 'reminder',
        title: 'Rent due',
        date: '2026-09-25',
        time: '17:00',
        location: null
      }
    ])
    expect(
      planned.plannerWarnings.some((warning) => /Calendar layout rules linked 3/iu.test(warning))
    ).toBe(true)
  })

  it('joins stacked flyer headings and keeps an unlabelled venue', () => {
    const planned = planDocumentExtraction(flyerExtraction(), context)
    expect(planned.drafts).toHaveLength(1)
    const draft = planned.drafts[0]
    expect(draft?.kind).toBe('event')
    if (draft?.kind !== 'event') throw new Error('Expected a flyer event')
    expect(draft.form).toMatchObject({
      title: 'River Park Night Market',
      startDate: '2026-09-05',
      startTime: '17:00',
      endTime: '21:00',
      location: 'River Park Pavilion'
    })
    expect(draft.fieldEvidence.title).toHaveLength(2)
    expect(draft.fieldEvidence.location).toHaveLength(1)
  })

  it('does not infer recurrence from a title that merely contains “weekly”', () => {
    const planned = planDocumentExtraction(
      lineDocumentExtraction([
        [
          'September 2, 2026',
          'Weekly planning meeting',
          '9:00 AM - 10:00 AM',
          'Location: Studio B (PDT)'
        ]
      ]),
      context
    )

    expect(planned.drafts).toHaveLength(1)
    expect(planned.drafts[0]?.semanticRecord.recurrence).toBeNull()
    expect(planned.drafts[0]?.semanticRecord).toMatchObject({
      timezone: 'America/Los_Angeles',
      timezoneOrigin: 'document'
    })
    expect(planned.drafts[0]?.semanticRecord.evidence.timezone).toHaveLength(1)
    expect(planned.drafts[0]?.form.recurrence).toBeNull()
  })

  it('fails closed for invalid source dates and reversed same-day times', () => {
    const invalidDate = planDocumentExtraction(
      lineDocumentExtraction([['February 30, 2026', 'Impossible review', '9:00 AM - 10:00 AM']]),
      context
    )
    const reversedTime = planDocumentExtraction(
      lineDocumentExtraction([['September 1, 2026', 'Retro', '3:00 PM - 2:00 PM']], 'f'),
      context
    )

    expect(invalidDate.drafts).toHaveLength(0)
    expect(reversedTime.drafts).toHaveLength(0)
    expect(
      [...invalidDate.drafts, ...reversedTime.drafts].some((draft) =>
        draft.kind === 'event' ? draft.form.startDate === context.localDate : false
      )
    ).toBe(false)
  })

  it('rejects cross-row PlanScan leakage before it can suppress deterministic fallback', () => {
    const planned = planDocumentExtraction(crossRowPlanScanExtraction(), context)
    const events = planned.drafts.filter((draft) => draft.kind === 'event')

    expect(events.map((draft) => draft.form.title)).toEqual(['Project kickoff', 'Design review'])
    expect(events[0]?.form.location).toBe('')
    expect(events[1]?.form.location).toBe('Reading Room')
    expect(
      planned.plannerWarnings.some((warning) => /semantic safety gate withheld 1/iu.test(warning))
    ).toBe(true)
  })

  it('exposes parser disagreements only as source-backed repair candidates', () => {
    const planned = planDocumentExtraction(repairablePlanScanDisagreementExtraction(), context)
    const session = planned.repairSession

    expect(session).not.toBeNull()
    expect(session?.request).toMatchObject({
      reason: 'parser-disagreement',
      disagreements: [
        {
          reason: 'parser-disagreement',
          candidates: [{ origin: 'planscan' }, { origin: 'rules' }]
        }
      ]
    })
    expect(session?.alternatives).toHaveLength(2)
    expect(
      session?.request.disagreements[0]?.candidates.every((candidate) =>
        candidate.citations.every(
          (citation) => citation.text.length === citation.end - citation.start
        )
      )
    ).toBe(true)
    expect(planned.plannerWarnings.some((warning) => /parser disagreement/iu.test(warning))).toBe(
      true
    )

    const disagreement = session?.request.disagreements[0]
    const ruleCandidate = disagreement?.candidates.find((candidate) => candidate.origin === 'rules')
    const response =
      session && disagreement && ruleCandidate
        ? validateDocumentRepairResponse(session.request, {
            decisions: [
              {
                disagreementId: disagreement.id,
                candidateId: ruleCandidate.id,
                citations: ruleCandidate.citations,
                rationale: 'The quoted source row supports the deterministic candidate.'
              }
            ]
          })
        : null
    expect(response).not.toBeNull()
    const repaired = response ? applyDocumentRepairResponse(planned, response) : planned
    expect(repaired.drafts.some((draft) => draft.id === ruleCandidate?.draftId)).toBe(true)
    expect(
      repaired.plannerWarnings.some((warning) =>
        /nothing is saved until you confirm/iu.test(warning)
      )
    ).toBe(true)
  })

  it('withholds a recurring course row whose printed term bounds are reversed', () => {
    const planned = planDocumentExtraction(
      tableScheduleExtraction('native-text', 1, [
        {
          title: 'Unsafe term row',
          course: 'CS 299 L1',
          creditHours: '3.0',
          crn: '69999',
          dateRange: '12/04/2026 - 08/24/2026',
          weekdays: 'M W F',
          time: '10:00 AM - 10:50 AM',
          location: 'Science Hall 100'
        }
      ]),
      context
    )

    expect(planned.drafts).toHaveLength(0)
    expect(planned.skippedCandidateCount).toBeGreaterThan(0)
  })
})
