import { describe, expect, it } from 'vitest'
import type { EventEntity, ReminderEntity } from '@remind-me/contracts'
import { exportIcs, importIcs } from './ics'

const event: EventEntity = {
  id: 'event:roundtrip',
  calendarId: 'calendar:local',
  title: 'Weekend retreat',
  description: 'Bring notes, snacks, and a charger.',
  location: 'Cabin',
  startUtc: '2026-03-07T06:00:00.000Z',
  endUtc: '2026-03-10T05:00:00.000Z',
  timezone: 'America/Chicago',
  allDay: true,
  recurrence: {
    frequency: 'yearly',
    interval: 1,
    byWeekday: [],
    byMonthDay: [],
    end: { kind: 'count', count: 3 }
  },
  status: 'active',
  provenance: 'manual',
  createdAt: '2026-01-01T12:00:00.000Z',
  updatedAt: '2026-01-02T12:00:00.456Z'
}

const reminder: ReminderEntity = {
  id: 'reminder:roundtrip',
  calendarId: 'calendar:local',
  title: 'Pack for retreat',
  notes: 'Use the checklist.',
  dueAtUtc: '2026-03-06T23:00:00.000Z',
  timezone: 'America/Chicago',
  recurrence: null,
  status: 'active',
  completedAt: null,
  provenance: 'manual',
  createdAt: '2026-01-01T12:00:00.000Z',
  updatedAt: '2026-01-02T12:00:00.000Z'
}

describe('ICS import and export', () => {
  it('round-trips events, reminders, all-day ranges, and recurrence', () => {
    const ics = exportIcs([event], [reminder])
    expect(ics).toContain('BEGIN:VEVENT')
    expect(ics).toContain('BEGIN:VTODO')
    expect(ics).toContain('RRULE:FREQ=YEARLY;INTERVAL=1;COUNT=3')
    expect(ics).toContain('DTSTAMP:20260102T120000Z')
    expect(ics).not.toContain('.456Z')

    const imported = importIcs(ics, {
      defaultCalendarId: 'calendar:local',
      defaultTimezone: 'America/Chicago',
      now: '2026-01-03T12:00:00.000Z'
    })

    expect(imported.skippedCount).toBe(0)
    expect(imported.events).toHaveLength(1)
    expect(imported.reminders).toHaveLength(1)
    expect(imported.events[0]).toMatchObject({
      title: event.title,
      startUtc: event.startUtc,
      endUtc: event.endUtc,
      timezone: event.timezone,
      allDay: true,
      recurrence: event.recurrence
    })
    expect(imported.reminders[0]).toMatchObject({
      title: reminder.title,
      dueAtUtc: reminder.dueAtUtc,
      timezone: reminder.timezone
    })
  })

  it('resolves external TZID wall time independently of the device timezone', () => {
    const imported = importIcs(
      [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'BEGIN:VEVENT',
        'DTSTART;TZID=America/Chicago:20260308T090000',
        'DTEND;TZID=America/Chicago:20260308T100000',
        'SUMMARY:DST breakfast',
        'END:VEVENT',
        'END:VCALENDAR',
        ''
      ].join('\r\n'),
      {
        defaultCalendarId: 'calendar:local',
        defaultTimezone: 'America/Los_Angeles',
        now: '2026-01-03T12:00:00.000Z'
      }
    )

    expect(imported.skippedCount).toBe(0)
    expect(imported.events[0]).toMatchObject({
      timezone: 'America/Chicago',
      startUtc: '2026-03-08T14:00:00.000Z',
      endUtc: '2026-03-08T15:00:00.000Z'
    })
  })
})
