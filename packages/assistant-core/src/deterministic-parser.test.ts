import { describe, expect, it } from 'vitest'
import {
  eventEntitySchema,
  reminderEntitySchema,
  type EventEntity,
  type ReminderEntity
} from '@remind-me/contracts'
import { parseCalendarText, type DeterministicParserContext } from './deterministic-parser'

function event(id: string, title: string): EventEntity {
  return eventEntitySchema.parse({
    id,
    calendarId: 'calendar:local',
    title,
    description: '',
    location: '',
    startUtc: '2026-08-28T14:00:00.000Z',
    endUtc: '2026-08-28T15:00:00.000Z',
    timezone: 'America/Chicago',
    allDay: false,
    recurrence: null,
    status: 'active',
    provenance: 'manual',
    createdAt: '2026-08-20T12:00:00.000Z',
    updatedAt: '2026-08-20T12:00:00.000Z'
  })
}

function reminder(id: string, title: string): ReminderEntity {
  return reminderEntitySchema.parse({
    id,
    calendarId: 'calendar:local',
    title,
    notes: '',
    dueAtUtc: '2026-08-24T23:00:00.000Z',
    timezone: 'America/Chicago',
    recurrence: null,
    status: 'active',
    completedAt: null,
    provenance: 'manual',
    createdAt: '2026-08-20T12:00:00.000Z',
    updatedAt: '2026-08-20T12:00:00.000Z'
  })
}

function parse(
  text: string,
  options: {
    previousUserText?: string | null
    events?: EventEntity[]
    reminders?: ReminderEntity[]
    focusedEventIds?: string[]
    focusedReminderIds?: string[]
  } = {}
) {
  const context: DeterministicParserContext = {
    requestId: 'request:test',
    text,
    previousUserText: options.previousUserText ?? null,
    nowUtc: '2026-08-23T17:00:00.000Z',
    localDate: '2026-08-23',
    timezone: 'America/Chicago',
    locale: 'en-US',
    events: options.events ?? [],
    reminders: options.reminders ?? [],
    focusedEventIds: options.focusedEventIds ?? [],
    focusedReminderIds: options.focusedReminderIds ?? []
  }
  return parseCalendarText(context).draft
}

describe('deterministic calendar parser', () => {
  it.each([
    ['Remind me to call Mom tomorrow at 6 PM', 'reminder.create'],
    ['Remind me tomorrow at 6 PM to call Mom', 'reminder.create'],
    ['Remember to water plants on Monday at 8 AM', 'reminder.create'],
    ['Set a reminder for submit report on 9/2 at 10:30 AM', 'reminder.create'],
    ['Block focus time Friday from 2 PM to 4 PM', 'event.create'],
    ['Schedule lunch with Maya tomorrow at noon', 'event.create'],
    ['Lunch with Maya Friday at 1 PM', 'event.create'],
    ['Add birthday all-day on June 4', 'event.create'],
    ['What do I have today?', 'calendar.list'],
    ['What did I have yesterday?', 'calendar.list'],
    ['What was on my schedule last Monday?', 'calendar.list'],
    ["What's next?", 'calendar.list'],
    ['whats tmr?', 'calendar.list'],
    ["What's my next event?", 'calendar.list'],
    ["What's my first class today?", 'calendar.list'],
    ['Which class comes second today?', 'calendar.list'],
    ['In what room is my first class today?', 'calendar.list'],
    ['Show my upcoming events', 'calendar.list'],
    ["What's on my calendar next week?", 'calendar.list'],
    ['Show my schedule Friday', 'calendar.list'],
    ['Summarize tomorrow with details', 'calendar.list'],
    ['Walk me through Friday', 'calendar.list'],
    ['Am I free next Tuesday afternoon?', 'calendar.availability'],
    ['Is the time open tomorrow from 9 AM to 10 AM?', 'calendar.availability'],
    ['Any conflicts this week?', 'calendar.conflicts'],
    ['Find dentist', 'calendar.search'],
    ['When is team sync?', 'calendar.search'],
    ['Where is team sync?', 'calendar.search']
  ])('maps “%s” to %s', (text, operation) => {
    expect(parse(text).operation).toBe(operation)
  })

  it('extracts grounded reminder fields and a daily recurrence', () => {
    const draft = parse('Remind me to water plants tomorrow at 8 AM every day for 5 times')
    expect(draft.fields.title?.value).toBe('water plants')
    expect(draft.fields.when?.value.start.time).toBe('08:00')
    expect(draft.fields.when?.value.start.date).toEqual({ kind: 'relative-day', offset: 1 })
    expect(draft.recurrence).toEqual({
      frequency: 'daily',
      interval: 1,
      byWeekday: [],
      byMonthDay: [],
      end: { kind: 'count', count: 5 }
    })
  })

  it('understands a reminder action placed after the date and time', () => {
    const draft = parse('Remind me tomorrow at 6 PM to call Mom')
    expect(draft.fields.title?.value).toBe('call Mom')
    expect(draft.fields.when?.value.start.time).toBe('18:00')
  })

  it('extracts an explicit event range', () => {
    const draft = parse('Block focus time Friday from 2 PM to 4 PM')
    expect(draft.fields.title?.value).toBe('focus time')
    expect(draft.fields.when?.value).toMatchObject({
      start: { time: '14:00' },
      end: { time: '16:00' },
      allDay: false
    })
    expect(draft.recurrence).toBeNull()
  })

  it('only treats a named weekday as recurring when the user says every', () => {
    const once = parse('Schedule yoga Monday at 7 AM')
    const weekly = parse('Schedule yoga every Monday at 7 AM')
    expect(once.recurrence).toBeNull()
    expect(weekly.recurrence).toMatchObject({
      frequency: 'weekly',
      byWeekday: ['monday']
    })
  })

  it('parses inclusive multi-day event and schedule windows', () => {
    const eventDraft = parse('Add conference from September 2 through September 4, 2026')
    const queryDraft = parse('What do I have from Monday through Friday?')
    expect(eventDraft.operation).toBe('event.create')
    expect(eventDraft.fields.title?.value).toBe('conference')
    expect(eventDraft.fields.when?.value).toMatchObject({
      start: { date: { kind: 'absolute', date: '2026-09-02' }, time: null },
      end: { date: { kind: 'absolute', date: '2026-09-04' }, time: null },
      allDay: true
    })
    expect(queryDraft.operation).toBe('calendar.list')
    expect(queryDraft.fields.when?.value.end?.date).toEqual({
      kind: 'weekday',
      weekday: 'friday',
      relation: 'this'
    })
  })

  it('keeps past dates in the past and supports broader calendar periods', () => {
    const yesterday = parse('What did I have yesterday?')
    const lastMonday = parse('What was on my schedule last Monday?')
    const lastWeek = parse('What did I have last week?')
    const thisMonth = parse('Show my calendar this month')
    const upcoming = parse("What's next?")
    const yearlessPast = parse('What did I have on August 20?')

    expect(yesterday.fields.when?.value.start.date).toEqual({
      kind: 'relative-day',
      offset: -1
    })
    expect(lastMonday.fields.when?.value.start.date).toEqual({
      kind: 'absolute',
      date: '2026-08-17'
    })
    expect(lastWeek.fields.when?.value).toMatchObject({
      start: { date: { kind: 'absolute', date: '2026-08-10' } },
      end: { date: { kind: 'absolute', date: '2026-08-16' } }
    })
    expect(thisMonth.fields.when?.value).toMatchObject({
      start: { date: { kind: 'absolute', date: '2026-08-01' } },
      end: { date: { kind: 'absolute', date: '2026-08-31' } }
    })
    expect(upcoming.fields.when?.value).toMatchObject({
      start: { date: { kind: 'absolute', date: '2026-08-23' } },
      end: { date: { kind: 'absolute', date: '2026-09-22' } }
    })
    expect(yearlessPast.fields.when?.value.start.date).toEqual({
      kind: 'absolute',
      date: '2026-08-20'
    })
  })

  it('does not silently collapse a multi-day reminder into one due date', () => {
    const draft = parse(
      'Remind me to check the exhibit from September 2 through September 4, 2026 at 6 PM'
    )
    expect(draft.operation).toBe('assistant.clarify')
    expect(draft.ambiguities[0]?.code).toBe('unsupported-expression')
  })

  it('asks before choosing an ambiguous twelve-hour clock time', () => {
    const draft = parse('Book dinner tomorrow at 6')
    expect(draft.operation).toBe('assistant.clarify')
    expect(draft.ambiguities[0]?.code).toBe('missing-time')
  })

  it('asks for missing reminder time and missing availability date', () => {
    expect(parse('Remind me to call Mom tomorrow').ambiguities[0]?.code).toBe('missing-time')
    expect(parse('Am I free at 2 PM?').ambiguities[0]?.code).toBe('missing-date')
  })

  it('uses a short clarification reply with the previous request', () => {
    const draft = parse('at 6 PM', {
      previousUserText: 'Remind me to call Mom tomorrow'
    })
    expect(draft.operation).toBe('reminder.create')
    expect(draft.fields.title?.value).toBe('call Mom')
    expect(draft.fields.when?.value.start.time).toBe('18:00')
  })

  it('uses recent question context for short read-only follow-ups', () => {
    const schedule = parse('What about Friday?', {
      previousUserText: 'What do I have Thursday?'
    })
    const availability = parse('How about 3 PM?', {
      previousUserText: 'Am I free Friday at 2 PM?'
    })

    expect(schedule.operation).toBe('calendar.list')
    expect(schedule.fields.when?.value.start.date).toEqual({
      kind: 'weekday',
      weekday: 'friday',
      relation: 'this'
    })
    expect(availability.operation).toBe('calendar.availability')
    expect(availability.fields.when?.value.start.time).toBe('15:00')
  })

  it('retrieves event and reminder targets before mutations', () => {
    const events = [event('event:sync', 'Team sync')]
    const reminders = [reminder('reminder:plants', 'Water plants')]
    const moved = parse('Move team sync to Friday at 2 PM', { events, reminders })
    const renamed = parse('Rename team sync to planning session', { events, reminders })
    const completed = parse('Mark water plants done', { events, reminders })
    const deleted = parse('Delete team sync', { events, reminders })
    expect(moved.operation).toBe('event.move')
    expect(moved.selection?.eventIds).toEqual(['event:sync'])
    expect(renamed.operation).toBe('event.update')
    expect(renamed.fields.title?.value).toBe('planning session')
    expect(completed.operation).toBe('reminder.complete')
    expect(completed.selection?.reminderIds).toEqual(['reminder:plants'])
    expect(deleted.operation).toBe('event.delete')
  })

  it('retrieves a saved target when its words contain small typos', () => {
    const events = [event('event:sync', 'Team sync')]
    const moved = parse('Move teem sycn to Friday at 2 PM', { events })
    expect(moved.operation).toBe('event.move')
    expect(moved.selection?.eventIds).toEqual(['event:sync'])
  })

  it('preserves stored event details when a move changes only the day or only the time', () => {
    const events = [event('event:sync', 'Team sync')]
    const dayOnly = parse('Move team sync to Monday', { events })
    const timeOnly = parse('Move team sync to 4 PM', { events })

    expect(dayOnly.fields.when?.value).toMatchObject({
      start: {
        date: { kind: 'weekday', weekday: 'monday', relation: 'this' },
        time: '09:00'
      },
      end: null,
      allDay: false
    })
    expect(timeOnly.fields.when?.value).toMatchObject({
      start: { date: { kind: 'absolute', date: '2026-08-28' }, time: '16:00' },
      end: null,
      allDay: false
    })
  })

  it('duplicates events and reuses their time when only a new day is supplied', () => {
    const events = [event('event:sync', 'Team sync')]
    const duplicated = parse('Duplicate team sync to Monday', { events })
    expect(duplicated.operation).toBe('event.duplicate')
    expect(duplicated.selection?.eventIds).toEqual(['event:sync'])
    expect(duplicated.fields.when?.value).toMatchObject({
      start: { date: { kind: 'weekday', weekday: 'monday' }, time: '09:00' },
      end: { time: '10:00' }
    })
  })

  it('updates a whole series with an exact custom weekday set', () => {
    const events = [event('event:sync', 'Team sync')]
    const updated = parse(
      'Change team sync to repeat on Mondays, Wednesdays and Fridays until December 4, 2026',
      { events }
    )
    expect(updated.operation).toBe('event.update')
    expect(updated.scope).toBe('series')
    expect(updated.recurrence).toEqual({
      frequency: 'weekly',
      interval: 1,
      byWeekday: ['monday', 'wednesday', 'friday'],
      byMonthDay: [],
      end: { kind: 'until', date: '2026-12-04' }
    })
  })

  it('clarifies equally plausible targets instead of mutating both', () => {
    const draft = parse('Delete project review', {
      events: [event('event:one', 'Project review'), event('event:two', 'Project review')]
    })
    expect(draft.operation).toBe('assistant.clarify')
    expect(draft.ambiguities[0]?.code).toBe('multiple-targets')
  })

  it('resolves singular dialogue references only through an explicit focused entity', () => {
    const events = [event('event:review', 'Design review')]
    const read = parse('Where is it?', {
      events,
      focusedEventIds: ['event:review']
    })
    expect(read.operation).toBe('calendar.search')
    expect(read.selection?.eventIds).toEqual(['event:review'])

    const move = parse('Move that one to Monday at 3 PM', {
      events,
      focusedEventIds: ['event:review']
    })
    expect(move.operation).toBe('event.move')
    expect(move.selection?.eventIds).toEqual(['event:review'])

    const stale = parse('Where is it?', { events })
    expect(stale.operation).toBe('assistant.clarify')
    expect(stale.ambiguities[0]?.code).toBe('unclear-reference')
  })

  it('clarifies a singular pronoun when several recent items remain in focus', () => {
    const events = [event('event:review', 'Design review'), event('event:sync', 'Project sync')]
    const draft = parse('Delete it', {
      events,
      focusedEventIds: events.map((candidate) => candidate.id)
    })
    expect(draft.operation).toBe('assistant.clarify')
    expect(draft.ambiguities[0]).toMatchObject({
      code: 'multiple-targets',
      options: ['Design review', 'Project sync']
    })
  })

  it('clarifies recurring scope and accepts an explicit whole-series request', () => {
    const weeklyYoga = {
      ...event('event:yoga', 'Yoga'),
      recurrence: {
        frequency: 'weekly' as const,
        interval: 1,
        byWeekday: ['friday' as const],
        byMonthDay: [],
        end: { kind: 'never' as const }
      }
    }
    const unclear = parse('Delete yoga', { events: [weeklyYoga] })
    const series = parse('Delete yoga the entire series', { events: [weeklyYoga] })
    expect(unclear.operation).toBe('assistant.clarify')
    expect(unclear.ambiguities[0]?.code).toBe('unclear-scope')
    expect(series.operation).toBe('event.delete')
    expect(series.scope).toBe('series')
  })

  it('rejects requests outside the local calendar domain', () => {
    expect(parse('Write me a poem about summer').operation).toBe('assistant.unsupported')
  })
})
