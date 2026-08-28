import { describe, expect, it } from 'vitest'
import type { DocumentImportDraft, DocumentSkippedItem, Weekday } from '@remind-me/contracts'
import {
  buildDocumentChronology,
  buildDocumentMonthPreview,
  summarizeDocumentReview
} from './document-review-preview'

function draft(
  id: string,
  date: string,
  title: string,
  weekdays: Weekday[] = [],
  schedule = false
): DocumentImportDraft {
  return {
    id,
    kind: 'event',
    form: {
      id: null,
      calendarId: 'calendar:default',
      title,
      description: '',
      location: schedule ? 'SES 130' : '',
      startDate: date,
      startTime: '12:00',
      endDate: date,
      endTime: '12:50',
      timezone: 'America/Chicago',
      allDay: false,
      recurrence:
        weekdays.length > 0
          ? {
              frequency: 'weekly',
              interval: 1,
              byWeekday: weekdays,
              byMonthDay: [],
              end: { kind: 'until', date: '2026-12-04' }
            }
          : null
    },
    schedule: schedule
      ? {
          courseCode: 'MATH 210',
          sectionCode: 'L01',
          crn: '31415',
          creditHours: 4,
          component: 'lecture',
          termStartDate: '2026-08-24',
          termEndDate: '2026-12-04',
          weekdays,
          verification: 'layout'
        }
      : null
  } as unknown as DocumentImportDraft
}

const skipped: DocumentSkippedItem = {
  id: 'skipped:one',
  page: 2,
  category: 'no-fixed-time',
  title: 'Independent study',
  reason: 'No fixed time',
  sourceText: 'ARR',
  evidenceIds: ['block:arr'],
  confidence: 0.95
}

describe('document chronological and month previews', () => {
  it('keeps one-off plans on their real dates and orders series chronologically', () => {
    const chronology = buildDocumentChronology([
      draft('later', '2026-09-22', 'Later event'),
      draft('first', '2026-09-03', 'First event')
    ])
    expect(chronology.map((item) => `${item.date}:${item.title}`)).toEqual([
      '2026-09-03:First event',
      '2026-09-22:Later event'
    ])
  })

  it('expands M/W/F into each monthly occurrence without multiplying the saved series', () => {
    const classDraft = draft(
      'class',
      '2026-08-24',
      'Calculus III',
      ['monday', 'wednesday', 'friday'],
      true
    )
    const oneOff = draft('one-off', '2026-09-15', 'Advising')
    const month = buildDocumentMonthPreview([classDraft, oneOff], '2026-09')
    expect(month.occurrenceCount).toBe(14)
    expect(
      month.cells.find((cell) => cell.date === '2026-09-15')?.items.map((item) => item.title)
    ).toEqual(['Advising'])
    expect(
      month.cells.find((cell) => cell.date === '2026-09-30')?.items.map((item) => item.title)
    ).toEqual(['Calculus III'])
  })

  it('reports series, weekly meetings, courses, and explicit skipped rows independently', () => {
    const totals = summarizeDocumentReview(
      [
        draft('class', '2026-08-24', 'Calculus III', ['monday', 'wednesday', 'friday'], true),
        draft('one-off', '2026-09-15', 'Advising')
      ],
      [skipped]
    )
    expect(totals).toEqual({
      seriesCount: 2,
      weeklyMeetingCount: 3,
      courseCount: 1,
      skippedRowCount: 1,
      noFixedTimeCount: 1
    })
  })
})
