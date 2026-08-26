import { describe, expect, it } from 'vitest'
import type { DocumentImportDraft } from '@remind-me/contracts'
import { buildDocumentWeekPreview } from './document-week-preview'

function courseDraft(
  id: string,
  sectionCode: string,
  weekdays: Array<'monday' | 'tuesday' | 'wednesday' | 'friday'>,
  startDate: string,
  startTime: string,
  component: 'primary-section' | 'linked-section'
): DocumentImportDraft {
  return {
    id,
    kind: 'event',
    form: {
      id: null,
      calendarId: 'calendar:local',
      title: 'Data Structures',
      description: `Course: CS 251 · Section: ${sectionCode}`,
      location: 'Research Center',
      startDate,
      startTime,
      endDate: startDate,
      endTime: startTime === '14:00' ? '14:50' : '13:50',
      timezone: 'America/Chicago',
      allDay: false,
      recurrence: {
        frequency: 'weekly',
        interval: 1,
        byWeekday: weekdays,
        byMonthDay: [],
        end: { kind: 'until', date: '2026-12-04' }
      }
    },
    schedule: {
      courseCode: 'CS 251',
      sectionCode,
      crn: sectionCode === 'AL3' ? '42499' : '42651',
      creditHours: sectionCode === 'AL3' ? 4 : 0,
      component,
      termStartDate: '2026-08-24',
      termEndDate: '2026-12-04',
      weekdays,
      verification: 'layout-and-planscan'
    }
  } as unknown as DocumentImportDraft
}

describe('document week preview', () => {
  it('expands one M/W/F series into three visible meetings and preserves its linked section', () => {
    const preview = buildDocumentWeekPreview([
      courseDraft(
        'draft:lecture',
        'AL3',
        ['monday', 'wednesday', 'friday'],
        '2026-08-24',
        '14:00',
        'primary-section'
      ),
      courseDraft('draft:linked', 'ABM', ['tuesday'], '2026-08-25', '12:00', 'linked-section')
    ])

    expect(preview).toMatchObject({
      seriesCount: 2,
      meetingCount: 4,
      courseCount: 1,
      scheduleSeriesCount: 2
    })
    expect(preview.days.find((day) => day.weekday === 'monday')?.items[0]).toMatchObject({
      sectionCode: 'AL3',
      component: 'primary-section'
    })
    expect(preview.days.find((day) => day.weekday === 'tuesday')?.items[0]).toMatchObject({
      sectionCode: 'ABM',
      component: 'linked-section'
    })
    expect(preview.days.find((day) => day.weekday === 'friday')?.items).toHaveLength(1)
  })
})
