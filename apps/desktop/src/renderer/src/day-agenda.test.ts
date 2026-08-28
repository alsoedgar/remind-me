import { describe, expect, it } from 'vitest'
import { dayAgendaItems, type DayAgendaOccurrence, type DayAgendaReminder } from './day-agenda'

function occurrence(index: number, date = '2026-08-28'): DayAgendaOccurrence {
  const hour = String(8 + index).padStart(2, '0')
  return {
    occurrenceId: `occurrence:${index}`,
    eventId: `event:${index}`,
    title: `Plan ${index}`,
    description: '',
    location: index % 2 ? 'Library' : '',
    startUtc: `${date}T${hour}:00:00.000Z`,
    endUtc: `${date}T${hour}:30:00.000Z`,
    timezone: 'UTC',
    allDay: false,
    originalDate: date,
    recurring: false
  }
}

describe('complete day agenda projection', () => {
  it('returns every event for a dense day instead of applying a display cap', () => {
    const occurrences = Array.from({ length: 9 }, (_, index) => occurrence(index))

    expect(dayAgendaItems(occurrences, [], '2026-08-28')).toHaveLength(9)
  })

  it('orders events and active reminders together and excludes other dates', () => {
    const reminders: DayAgendaReminder[] = [
      {
        id: 'reminder:midday',
        title: 'Submit notes',
        notes: '',
        dueAtUtc: '2026-08-28T09:30:00.000Z',
        timezone: 'UTC',
        status: 'active'
      },
      {
        id: 'reminder:done',
        title: 'Already done',
        notes: '',
        dueAtUtc: '2026-08-28T08:30:00.000Z',
        timezone: 'UTC',
        status: 'completed'
      },
      {
        id: 'reminder:tomorrow',
        title: 'Tomorrow',
        notes: '',
        dueAtUtc: '2026-08-29T08:30:00.000Z',
        timezone: 'UTC',
        status: 'active'
      }
    ]

    expect(
      dayAgendaItems([occurrence(0), occurrence(2), occurrence(1)], reminders, '2026-08-28').map(
        (item) => `${item.kind}:${item.id}`
      )
    ).toEqual([
      'event:occurrence:0',
      'event:occurrence:1',
      'reminder:reminder:midday',
      'event:occurrence:2'
    ])
  })
})
