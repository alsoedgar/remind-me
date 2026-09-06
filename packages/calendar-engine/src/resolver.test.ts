import { describe, expect, it } from 'vitest'
import { calendarIRDraftSchema } from '@remind-me/contracts'
import { dryRunCalendarCommand } from './dry-run'
import { resolveCalendarIR, resolveTemporalWindow, resolveLocalDateTime } from './resolver'
import type { CalendarState, ResolverContext } from './types'

const context: ResolverContext = {
  nowUtc: '2026-01-12T15:00:00.000Z',
  localDate: '2026-01-12',
  timezone: 'America/Chicago',
  utcOffsetMinutes: -360,
  defaultCalendarId: 'calendar:local',
  defaultEventDurationMinutes: 60
}

const emptyState: CalendarState = { events: [], reminders: [] }

describe('calendar contract engine', () => {
  it('asks about skipped and repeated clock times instead of silently shifting an event', () => {
    expect(() => resolveLocalDateTime('2026-03-08', '02:30', 'America/Chicago')).toThrow(
      'clock change'
    )
    expect(() => resolveLocalDateTime('2026-11-01', '01:30', 'America/Chicago')).toThrow(
      'clock change'
    )
    expect(resolveLocalDateTime('2026-03-08', '03:30', 'America/Chicago')).toBe(
      '2026-03-08T08:30:00.000Z'
    )
  })
  it('rejects an all-day range ending before it begins', () => {
    expect(() =>
      resolveTemporalWindow(
        {
          start: { date: { kind: 'absolute', date: '2026-09-10' }, time: null },
          end: { date: { kind: 'absolute', date: '2026-09-08' }, time: null },
          allDay: true,
          timezone: 'America/Chicago'
        },
        context
      )
    ).toThrow('end date')
  })
  it('resolves and dry-runs a relative event creation', () => {
    const draft = calendarIRDraftSchema.parse({
      version: '0.1',
      requestId: 'create-call',
      operation: 'event.create',
      selection: null,
      fields: {
        title: { value: 'Call Mom', sourceSpan: { start: 0, end: 8 }, evidenceIds: [] },
        description: null,
        location: null,
        when: {
          value: {
            start: { date: { kind: 'relative-day', offset: 1 }, time: '18:00' },
            end: null,
            allDay: false,
            timezone: 'America/Chicago'
          },
          sourceSpan: { start: 9, end: 22 },
          evidenceIds: []
        },
        reminderOffsetMinutes: null,
        status: null
      },
      recurrence: null,
      scope: 'single',
      references: [],
      ambiguities: [],
      risk: 'low',
      confidence: 0.99,
      evidence: []
    })

    const resolved = resolveCalendarIR(draft, context)
    expect(resolved.fields.startUtc).toBe('2026-01-14T00:00:00.000Z')
    expect(resolved.fields.endUtc).toBe('2026-01-14T01:00:00.000Z')

    const result = dryRunCalendarCommand(resolved, emptyState, context)
    expect(result.mutationCount).toBe(1)
    expect(result.state.events[0]?.title).toBe('Call Mom')
  })

  it('does not mutate state for availability queries', () => {
    const draft = calendarIRDraftSchema.parse({
      version: '0.1',
      requestId: 'availability',
      operation: 'calendar.availability',
      selection: null,
      fields: {
        title: null,
        description: null,
        location: null,
        when: {
          value: {
            start: { date: { kind: 'relative-day', offset: 1 }, time: '13:00' },
            end: { date: { kind: 'relative-day', offset: 1 }, time: '16:00' },
            allDay: false,
            timezone: 'America/Chicago'
          },
          sourceSpan: null,
          evidenceIds: []
        },
        reminderOffsetMinutes: null,
        status: null
      },
      recurrence: null,
      scope: 'single',
      references: [],
      ambiguities: [],
      risk: 'read',
      confidence: 0.98,
      evidence: []
    })

    const result = dryRunCalendarCommand(resolveCalendarIR(draft, context), emptyState, context)
    expect(result.state).toEqual(emptyState)
    expect(result.mutationCount).toBe(0)
    expect(result.summary).toContain('free')
  })
})
