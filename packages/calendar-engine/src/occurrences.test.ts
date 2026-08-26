import { describe, expect, it } from 'vitest'
import type { EventEntity } from '@remind-me/contracts'
import { expandEventOccurrences, findOccurrenceConflicts } from './occurrences'

function event(overrides: Partial<EventEntity> = {}): EventEntity {
  return {
    id: 'event:dst',
    calendarId: 'calendar:local',
    title: 'Morning routine',
    description: '',
    location: '',
    startUtc: '2026-03-07T15:00:00.000Z',
    endUtc: '2026-03-07T16:00:00.000Z',
    timezone: 'America/Chicago',
    allDay: false,
    recurrence: {
      frequency: 'daily',
      interval: 1,
      byWeekday: [],
      byMonthDay: [],
      end: { kind: 'count', count: 3 }
    },
    status: 'active',
    provenance: 'manual',
    createdAt: '2026-03-01T12:00:00.000Z',
    updatedAt: '2026-03-01T12:00:00.000Z',
    ...overrides
  }
}

describe('recurring event expansion', () => {
  it('preserves local wall time across the spring DST transition', () => {
    const occurrences = expandEventOccurrences(
      event(),
      '2026-03-07T00:00:00.000Z',
      '2026-03-11T00:00:00.000Z'
    )

    expect(occurrences.map((occurrence) => occurrence.startUtc)).toEqual([
      '2026-03-07T15:00:00.000Z',
      '2026-03-08T14:00:00.000Z',
      '2026-03-09T14:00:00.000Z'
    ])
  })

  it('removes recurrence exceptions and reports overlapping occurrences', () => {
    const recurringEvent = event()
    const exceptions = [
      {
        id: 'exception:one',
        parentEventId: recurringEvent.id,
        originalDate: '2026-03-08',
        kind: 'cancelled' as const,
        replacementEventId: null,
        createdAt: '2026-03-01T12:00:00.000Z'
      }
    ]
    const occurrences = expandEventOccurrences(
      recurringEvent,
      '2026-03-07T00:00:00.000Z',
      '2026-03-11T00:00:00.000Z',
      exceptions
    )
    expect(occurrences).toHaveLength(2)

    const conflicts = findOccurrenceConflicts(
      [recurringEvent],
      '2026-03-09T14:30:00.000Z',
      '2026-03-09T14:45:00.000Z',
      exceptions
    )
    expect(conflicts.map((conflict) => conflict.originalDate)).toEqual(['2026-03-09'])
  })

  it('preserves morning wall time across the fall DST transition', () => {
    const occurrences = expandEventOccurrences(
      event({
        startUtc: '2026-10-31T14:00:00.000Z',
        endUtc: '2026-10-31T15:00:00.000Z'
      }),
      '2026-10-31T00:00:00.000Z',
      '2026-11-04T00:00:00.000Z'
    )

    expect(occurrences.map((occurrence) => occurrence.startUtc)).toEqual([
      '2026-10-31T14:00:00.000Z',
      '2026-11-01T15:00:00.000Z',
      '2026-11-02T15:00:00.000Z'
    ])
  })

  it('supports last-day-of-month recurrence and count limits', () => {
    const occurrences = expandEventOccurrences(
      event({
        startUtc: '2026-01-31T15:00:00.000Z',
        endUtc: '2026-01-31T16:00:00.000Z',
        recurrence: {
          frequency: 'monthly',
          interval: 1,
          byWeekday: [],
          byMonthDay: [-1],
          end: { kind: 'count', count: 3 }
        }
      }),
      '2026-01-01T00:00:00.000Z',
      '2026-05-01T00:00:00.000Z'
    )

    expect(occurrences.map((occurrence) => occurrence.originalDate)).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31'
    ])
  })

  it('uses selected weekly days exactly, even when the anchor is on another weekday', () => {
    const anchoredMonday = event({
      startUtc: '2026-08-24T14:00:00.000Z',
      endUtc: '2026-08-24T15:00:00.000Z',
      recurrence: {
        frequency: 'weekly',
        interval: 1,
        byWeekday: ['tuesday', 'thursday'],
        byMonthDay: [],
        end: { kind: 'count', count: 4 }
      }
    })
    expect(
      expandEventOccurrences(
        anchoredMonday,
        '2026-08-24T00:00:00.000Z',
        '2026-09-05T00:00:00.000Z'
      ).map((occurrence) => occurrence.originalDate)
    ).toEqual(['2026-08-25', '2026-08-27', '2026-09-01', '2026-09-03'])
  })

  it('anchors multi-week rules to calendar weeks', () => {
    const occurrences = expandEventOccurrences(
      event({
        startUtc: '2026-01-07T15:00:00.000Z',
        endUtc: '2026-01-07T16:00:00.000Z',
        recurrence: {
          frequency: 'weekly',
          interval: 2,
          byWeekday: ['monday', 'wednesday'],
          byMonthDay: [],
          end: { kind: 'count', count: 4 }
        }
      }),
      '2026-01-01T00:00:00.000Z',
      '2026-02-10T00:00:00.000Z'
    )

    expect(occurrences.map((occurrence) => occurrence.originalDate)).toEqual([
      '2026-01-07',
      '2026-01-19',
      '2026-01-21',
      '2026-02-02'
    ])
  })

  it('treats an interval beginning exactly at event end as free', () => {
    const conflicts = findOccurrenceConflicts(
      [event({ recurrence: null })],
      '2026-03-07T16:00:00.000Z',
      '2026-03-07T17:00:00.000Z'
    )
    expect(conflicts).toEqual([])
  })
})
