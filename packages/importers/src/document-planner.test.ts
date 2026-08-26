import { describe, expect, it } from 'vitest'
import {
  documentExtractionSchema,
  type DocumentExtraction,
  type DocumentExtractionMethod,
  type DocumentTextBlock,
  type DocumentWord
} from '@remind-me/contracts'
import { planDocumentExtraction } from './document-planner'
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
    expect(first.proposal.evidence.every((item) => item.sourceKind === 'pdf')).toBe(true)
  })

  it('flags lower-confidence OCR while preserving the same proposals and evidence', () => {
    const planned = planDocumentExtraction(extraction('ocr', 0.71), context)
    expect(planned.drafts).toHaveLength(3)
    expect(planned.drafts.every((draft) => draft.attention === 'check-evidence')).toBe(true)
    expect(
      planned.drafts.every((draft) => draft.warnings.some((warning) => /OCR/iu.test(warning)))
    ).toBe(true)
    expect(planned.drafts[0]?.proposal.evidence[0]?.sourceKind).toBe('image')
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

  it('withholds an exact class series that is already in the local calendar', () => {
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

    expect(secondPass.drafts).toHaveLength(6)
    expect(secondPass.existingCalendarDuplicateCount).toBe(1)
    expect(secondPass.drafts.some((draft) => draft.schedule?.crn === '42499')).toBe(false)
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
})
