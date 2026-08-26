import { describe, expect, it } from 'vitest'
import {
  activeWidgetReminders,
  buildWidgetWeek,
  eventsForWidgetDay,
  type WidgetOccurrence,
  type WidgetReminder
} from './widget-data'

const occurrences: WidgetOccurrence[] = [
  {
    occurrenceId: 'occurrence:later',
    eventId: 'event:later',
    title: 'Tea',
    description: 'Bring the jasmine leaves',
    location: 'Kitchen',
    startUtc: '2026-08-25T16:00:00.000Z',
    endUtc: '2026-08-25T16:30:00.000Z',
    timezone: 'UTC',
    allDay: false,
    originalDate: '2026-08-25',
    recurring: false
  },
  {
    occurrenceId: 'occurrence:first',
    eventId: 'event:first',
    title: 'Walk',
    description: '',
    location: 'Lake path',
    startUtc: '2026-08-25T09:00:00.000Z',
    endUtc: '2026-08-25T10:00:00.000Z',
    timezone: 'UTC',
    allDay: false,
    originalDate: '2026-08-25',
    recurring: true
  }
]

describe('desktop widget data', () => {
  it('builds a seven-day local strip with event markers', () => {
    const days = buildWidgetWeek('2026-08-24', occurrences, 'en-US')
    expect(days).toHaveLength(7)
    expect(days[0]).toMatchObject({ date: '2026-08-24', weekday: 'M', dayNumber: 24 })
    expect(days[1]).toMatchObject({ date: '2026-08-25', eventCount: 2 })
  })

  it('orders the selected day and active reminders chronologically', () => {
    expect(eventsForWidgetDay(occurrences, '2026-08-25').map((event) => event.title)).toEqual([
      'Walk',
      'Tea'
    ])
    const reminders: WidgetReminder[] = [
      {
        id: '2',
        title: 'Later',
        dueAtUtc: '2026-08-26T10:00:00Z',
        timezone: 'UTC',
        status: 'active'
      },
      {
        id: '1',
        title: 'Soon',
        dueAtUtc: '2026-08-25T10:00:00Z',
        timezone: 'UTC',
        status: 'active'
      },
      {
        id: '3',
        title: 'Done',
        dueAtUtc: '2026-08-24T10:00:00Z',
        timezone: 'UTC',
        status: 'completed'
      }
    ]
    expect(activeWidgetReminders(reminders).map((reminder) => reminder.title)).toEqual([
      'Soon',
      'Later'
    ])
  })
})
