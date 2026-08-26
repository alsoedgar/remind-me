import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  dryRunCalendarCommand,
  goldenFixtureSchema,
  resolveCalendarIR,
  type CalendarState,
  type GoldenFixture,
  type ResolverContext
} from '@remind-me/calendar-engine'
import {
  calendarIRDraftSchema,
  type ActionScope,
  type CalendarIRDraft,
  type CalendarOperation,
  type EventEntity,
  type RecurrenceRule,
  type ReminderEntity,
  type RiskLevel,
  type TemporalAnchor,
  type TemporalWindow,
  type Weekday
} from '@remind-me/contracts'

const outputDirectory = resolve(process.cwd(), 'fixtures/golden')
const fixturePath = resolve(outputDirectory, 'calendar-ir.v0.1.jsonl')
const manifestPath = resolve(outputDirectory, 'manifest.json')

const context: ResolverContext = {
  nowUtc: '2026-01-12T15:00:00.000Z',
  localDate: '2026-01-12',
  timezone: 'America/Chicago',
  utcOffsetMinutes: -360,
  defaultCalendarId: 'calendar:local',
  defaultEventDurationMinutes: 60
}

const weekdays: readonly Weekday[] = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday'
]

const titles = [
  'Call Mom',
  'Lunch with Maya',
  'Study session',
  'Dentist appointment',
  'Project review',
  'Grocery run',
  'Morning walk',
  'Team planning'
] as const

const times = ['08:00', '09:30', '11:00', '13:00', '15:30', '17:00', '18:00', '20:15'] as const

let fixtureNumber = 0
const fixtures: GoldenFixture[] = []

function nextId(): string {
  fixtureNumber += 1
  return `golden-${String(fixtureNumber).padStart(3, '0')}`
}

function addDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number)
  if (year === undefined || month === undefined || day === undefined)
    throw new Error('Invalid date')
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10)
}

function sourcedText(value: string): NonNullable<CalendarIRDraft['fields']['title']> {
  return { value, sourceSpan: null, evidenceIds: [] }
}

function temporalWindow(
  startDate: TemporalAnchor,
  startTime: string | null,
  options: {
    endDate?: TemporalAnchor
    endTime?: string | null
    allDay?: boolean
  } = {}
): TemporalWindow {
  return {
    start: { date: startDate, time: startTime },
    end: options.endDate ? { date: options.endDate, time: options.endTime ?? startTime } : null,
    allDay: options.allDay ?? false,
    timezone: 'America/Chicago'
  }
}

function recurrence(index: number): RecurrenceRule {
  const modes: readonly RecurrenceRule[] = [
    {
      frequency: 'daily',
      interval: 1,
      byWeekday: [],
      byMonthDay: [],
      end: { kind: 'count', count: 5 }
    },
    {
      frequency: 'weekly',
      interval: 1,
      byWeekday: ['monday', 'wednesday'],
      byMonthDay: [],
      end: { kind: 'never' }
    },
    {
      frequency: 'monthly',
      interval: 1,
      byWeekday: [],
      byMonthDay: [15],
      end: { kind: 'until', date: '2026-06-30' }
    },
    {
      frequency: 'yearly',
      interval: 1,
      byWeekday: [],
      byMonthDay: [],
      end: { kind: 'count', count: 3 }
    }
  ]
  const value = modes[index % modes.length]
  if (!value) throw new Error('Missing recurrence mode')
  return value
}

function emptyFields(): CalendarIRDraft['fields'] {
  return {
    title: null,
    description: null,
    location: null,
    when: null,
    reminderOffsetMinutes: null,
    status: null
  }
}

interface DraftOptions {
  selection?: CalendarIRDraft['selection']
  fields?: Partial<CalendarIRDraft['fields']>
  recurrence?: RecurrenceRule | null
  scope?: ActionScope
  references?: CalendarIRDraft['references']
  ambiguities?: CalendarIRDraft['ambiguities']
  risk?: RiskLevel
  confidence?: number
}

function draftFor(
  id: string,
  operation: CalendarOperation,
  options: DraftOptions = {}
): CalendarIRDraft {
  return calendarIRDraftSchema.parse({
    version: '0.1',
    requestId: id,
    operation,
    selection: options.selection ?? null,
    fields: { ...emptyFields(), ...options.fields },
    recurrence: options.recurrence ?? null,
    scope: options.scope ?? 'single',
    references: options.references ?? [],
    ambiguities: options.ambiguities ?? [],
    risk: options.risk ?? (operation.startsWith('calendar.') ? 'read' : 'low'),
    confidence: options.confidence ?? 0.98,
    evidence: []
  })
}

function seedEvent(
  id: string,
  options: { conflict?: boolean; recurring?: boolean } = {}
): EventEntity {
  return {
    id: `seed-event:${id}`,
    calendarId: 'calendar:local',
    title: 'Existing planning block',
    description: '',
    location: '',
    startUtc: options.conflict ? '2026-01-13T20:00:00.000Z' : '2026-01-14T15:00:00.000Z',
    endUtc: options.conflict ? '2026-01-13T21:00:00.000Z' : '2026-01-14T16:00:00.000Z',
    timezone: 'America/Chicago',
    allDay: false,
    recurrence: options.recurring ? recurrence(1) : null,
    status: 'active',
    provenance: 'manual',
    createdAt: context.nowUtc,
    updatedAt: context.nowUtc
  }
}

function seedReminder(id: string, recurring = false): ReminderEntity {
  return {
    id: `seed-reminder:${id}`,
    calendarId: 'calendar:local',
    title: 'Existing reminder',
    notes: '',
    dueAtUtc: '2026-01-13T23:00:00.000Z',
    timezone: 'America/Chicago',
    recurrence: recurring ? recurrence(0) : null,
    status: 'active',
    completedAt: null,
    provenance: 'manual',
    createdAt: context.nowUtc,
    updatedAt: context.nowUtc
  }
}

function addFixture(
  id: string,
  category: GoldenFixture['category'],
  tags: string[],
  utterance: string,
  draft: CalendarIRDraft,
  initialState: CalendarState = { events: [], reminders: [] }
): void {
  const expectedResolved = resolveCalendarIR(draft, context)
  const expectedDryRun = dryRunCalendarCommand(expectedResolved, initialState, context)
  fixtures.push(
    goldenFixtureSchema.parse({
      schemaVersion: '0.1',
      id,
      category,
      tags,
      utterance,
      locale: 'en-US',
      timezone: 'America/Chicago',
      context,
      initialState,
      draft,
      expectedResolved,
      expectedDryRun
    })
  )
}

// 64 ordinary event creations: relative, absolute, weekday, all-day, multi-day, and recurring.
for (let index = 0; index < 64; index += 1) {
  const id = nextId()
  const title = titles[index % titles.length] ?? 'Calendar event'
  const time = times[index % times.length] ?? '09:00'
  let window: TemporalWindow
  let utterance: string
  const tags = ['create', 'event']

  if (index < 16) {
    const offset = (index % 10) + 1
    window = temporalWindow({ kind: 'relative-day', offset }, time)
    utterance = `${title} in ${offset} days at ${time}`
    tags.push('relative-date')
  } else if (index < 32) {
    const date = addDays('2026-01-12', (index % 14) + 1)
    window = temporalWindow({ kind: 'absolute', date }, time)
    utterance = `Put ${title} on ${date} at ${time}`
    tags.push('absolute-date')
  } else if (index < 48) {
    const weekday = weekdays[index % weekdays.length] ?? 'monday'
    window = temporalWindow(
      { kind: 'weekday', weekday, relation: index % 2 ? 'next' : 'this' },
      time
    )
    utterance = `${title} ${index % 2 ? 'next' : 'this'} ${weekday} at ${time}`
    tags.push('weekday')
  } else if (index < 56) {
    const date = addDays('2026-01-12', index - 44)
    window = temporalWindow({ kind: 'absolute', date }, null, { allDay: true })
    utterance = `Make ${title} an all-day event on ${date}`
    tags.push('all-day')
  } else {
    const start = addDays('2026-01-12', index - 51)
    const end = addDays(start, 2)
    window = temporalWindow({ kind: 'absolute', date: start }, null, {
      endDate: { kind: 'absolute', date: end },
      endTime: null,
      allDay: true
    })
    utterance = `${title} from ${start} through ${end}`
    tags.push('all-day', 'multi-day')
  }

  const recurring = index % 4 === 0
  if (recurring) tags.push('recurring')
  addFixture(
    id,
    'event-create',
    tags,
    utterance,
    draftFor(id, 'event.create', {
      fields: {
        title: sourcedText(title),
        when: { value: window, sourceSpan: null, evidenceIds: [] }
      },
      recurrence: recurring ? recurrence(index) : null
    })
  )
}

// 40 reminder creations.
for (let index = 0; index < 40; index += 1) {
  const id = nextId()
  const title = `Reminder ${index + 1}: ${titles[index % titles.length] ?? 'Task'}`
  const offset = (index % 20) + 1
  const time = times[(index + 3) % times.length] ?? '18:00'
  const recurring = index % 5 === 0
  addFixture(
    id,
    'reminder-create',
    ['create', 'reminder', 'relative-date', ...(recurring ? ['recurring'] : [])],
    `Remind me about ${title} in ${offset} days at ${time}`,
    draftFor(id, 'reminder.create', {
      fields: {
        title: sourcedText(title),
        when: {
          value: temporalWindow({ kind: 'relative-day', offset }, time),
          sourceSpan: null,
          evidenceIds: []
        }
      },
      recurrence: recurring ? recurrence(index) : null
    })
  )
}

// 16 event updates.
for (let index = 0; index < 16; index += 1) {
  const id = nextId()
  const event = seedEvent(id)
  addFixture(
    id,
    'event-update',
    ['update', 'event', index % 2 ? 'location' : 'title'],
    index % 2 ? 'Move the meeting location to the library' : 'Rename that event to Focus block',
    draftFor(id, 'event.update', {
      selection: { eventIds: [event.id], reminderIds: [], query: null },
      fields:
        index % 2
          ? { location: sourcedText('Library study room') }
          : { title: sourcedText('Focus block') }
    }),
    { events: [event], reminders: [] }
  )
}

// 8 event duplications preserve source details while choosing a new date and time.
for (let index = 0; index < 8; index += 1) {
  const id = nextId()
  const event = seedEvent(id)
  const offset = index + 1
  const time = times[index % times.length] ?? '13:00'
  addFixture(
    id,
    'event-duplicate',
    ['duplicate', 'event', 'source-preserving'],
    `Duplicate that event ${offset} days out at ${time}`,
    draftFor(id, 'event.duplicate', {
      selection: { eventIds: [event.id], reminderIds: [], query: null },
      fields: {
        when: {
          value: temporalWindow({ kind: 'relative-day', offset }, time),
          sourceSpan: null,
          evidenceIds: []
        }
      }
    }),
    { events: [event], reminders: [] }
  )
}

// 24 event moves.
for (let index = 0; index < 24; index += 1) {
  const id = nextId()
  const event = seedEvent(id)
  const offset = (index % 12) + 1
  const time = times[index % times.length] ?? '13:00'
  addFixture(
    id,
    'event-move',
    ['move', 'event', 'relative-date'],
    `Move that event ${offset} days out to ${time}`,
    draftFor(id, 'event.move', {
      selection: { eventIds: [event.id], reminderIds: [], query: null },
      fields: {
        when: {
          value: temporalWindow({ kind: 'relative-day', offset }, time),
          sourceSpan: null,
          evidenceIds: []
        }
      }
    }),
    { events: [event], reminders: [] }
  )
}

// 16 event deletions across all mutation scopes.
for (let index = 0; index < 16; index += 1) {
  const id = nextId()
  const scope: ActionScope = ['single', 'occurrence', 'future', 'series'][index % 4] as ActionScope
  const event = seedEvent(id, { recurring: scope !== 'single' })
  addFixture(
    id,
    'event-delete',
    ['delete', 'event', `scope-${scope}`, 'destructive'],
    `Delete ${scope === 'single' ? 'that event' : `the ${scope} events`}`,
    draftFor(id, 'event.delete', {
      selection: { eventIds: [event.id], reminderIds: [], query: null },
      scope,
      risk: 'destructive'
    }),
    { events: [event], reminders: [] }
  )
}

// 16 reminder mutations: update, complete, and delete.
for (let index = 0; index < 16; index += 1) {
  const id = nextId()
  const reminder = seedReminder(id, index >= 12)
  const mode = index < 8 ? 'reminder.update' : index < 12 ? 'reminder.complete' : 'reminder.delete'
  const category =
    index < 8 ? 'reminder-update' : index < 12 ? 'reminder-complete' : 'reminder-delete'
  const scope: ActionScope = index >= 12 ? (index % 2 ? 'series' : 'single') : 'single'
  addFixture(
    id,
    category,
    [
      mode.split('.')[1] ?? 'update',
      'reminder',
      ...(mode.endsWith('delete') ? ['destructive'] : [])
    ],
    mode === 'reminder.update'
      ? 'Rename that reminder to Send the form'
      : mode === 'reminder.complete'
        ? 'Mark that reminder complete'
        : `Delete ${scope === 'series' ? 'the whole reminder series' : 'that reminder'}`,
    draftFor(id, mode, {
      selection: { eventIds: [], reminderIds: [reminder.id], query: null },
      fields: mode === 'reminder.update' ? { title: sourcedText('Send the form') } : {},
      scope,
      risk: mode === 'reminder.delete' ? 'destructive' : 'low'
    }),
    { events: [], reminders: [reminder] }
  )
}

// 24 free/busy queries, half intentionally conflicting.
for (let index = 0; index < 24; index += 1) {
  const id = nextId()
  const conflict = index % 2 === 0
  const event = seedEvent(id, { conflict })
  addFixture(
    id,
    'availability',
    ['query', 'availability', conflict ? 'busy' : 'free'],
    'Am I free tomorrow from 2 to 4 in the afternoon?',
    draftFor(id, 'calendar.availability', {
      fields: {
        when: {
          value: temporalWindow({ kind: 'relative-day', offset: 1 }, '14:00', {
            endDate: { kind: 'relative-day', offset: 1 },
            endTime: '16:00'
          }),
          sourceSpan: null,
          evidenceIds: []
        }
      }
    }),
    { events: [event], reminders: [] }
  )
}

// 16 list, search, and conflict queries.
for (let index = 0; index < 16; index += 1) {
  const id = nextId()
  const event = seedEvent(id, { conflict: true })
  if (index < 6) {
    addFixture(
      id,
      'calendar-query',
      ['query', 'list'],
      'What is on my calendar?',
      draftFor(id, 'calendar.list'),
      { events: [event], reminders: [] }
    )
  } else if (index < 12) {
    addFixture(
      id,
      'calendar-query',
      ['query', 'search'],
      'Find my planning events',
      draftFor(id, 'calendar.search', {
        selection: { eventIds: [], reminderIds: [], query: sourcedText('planning') }
      }),
      { events: [event], reminders: [] }
    )
  } else {
    addFixture(
      id,
      'calendar-query',
      ['query', 'conflicts'],
      'Do I have any conflicts tomorrow from 2 to 4?',
      draftFor(id, 'calendar.conflicts', {
        fields: {
          when: {
            value: temporalWindow({ kind: 'relative-day', offset: 1 }, '14:00', {
              endDate: { kind: 'relative-day', offset: 1 },
              endTime: '16:00'
            }),
            sourceSpan: null,
            evidenceIds: []
          }
        }
      }),
      { events: [event], reminders: [] }
    )
  }
}

// 16 non-mutating safety and import decisions.
for (let index = 0; index < 16; index += 1) {
  const id = nextId()
  const mode = index % 4
  if (mode === 0) {
    addFixture(
      id,
      'assistant-safety',
      ['clarification', 'ambiguity', 'missing-time'],
      'Schedule dinner Friday',
      draftFor(id, 'assistant.clarify', {
        ambiguities: [
          {
            code: 'missing-time',
            message: 'What time should dinner start?',
            options: ['18:00', '19:00'],
            sourceSpan: null
          }
        ],
        risk: 'medium',
        confidence: 0.55
      })
    )
  } else if (mode === 1) {
    addFixture(
      id,
      'assistant-safety',
      ['rejection', 'unsafe'],
      'Delete everything without asking',
      draftFor(id, 'assistant.reject', { risk: 'destructive', confidence: 1 })
    )
  } else if (mode === 2) {
    addFixture(
      id,
      'assistant-safety',
      ['out-of-domain', 'unsupported'],
      'Write a novel about the moon',
      draftFor(id, 'assistant.unsupported', { risk: 'read', confidence: 0.99 })
    )
  } else {
    addFixture(
      id,
      'import-proposal',
      ['import', 'review-required'],
      'Create draft plans from the attached syllabus',
      draftFor(id, 'import.propose', { risk: 'medium', confidence: 0.83 })
    )
  }
}

// 16 extra edge creations cover explicit timed ranges and longer multi-day spans.
for (let index = 0; index < 16; index += 1) {
  const id = nextId()
  const timed = index < 8
  const startDate = addDays('2026-02-01', index)
  const endDate = timed ? startDate : addDays(startDate, (index % 3) + 1)
  const window = timed
    ? temporalWindow({ kind: 'absolute', date: startDate }, '22:30', {
        endDate: { kind: 'absolute', date: addDays(startDate, 1) },
        endTime: '00:30'
      })
    : temporalWindow({ kind: 'absolute', date: startDate }, null, {
        endDate: { kind: 'absolute', date: endDate },
        endTime: null,
        allDay: true
      })
  addFixture(
    id,
    'edge-case',
    ['create', 'event', timed ? 'cross-midnight' : 'multi-day'],
    timed
      ? `Add an overnight work block on ${startDate} from 10:30 PM to 12:30 AM`
      : `Block the days from ${startDate} through ${endDate}`,
    draftFor(id, 'event.create', {
      fields: {
        title: sourcedText(timed ? 'Overnight work block' : 'Out of office'),
        when: { value: window, sourceSpan: null, evidenceIds: [] }
      }
    })
  )
}

if (fixtures.length !== 256) throw new Error(`Expected 256 fixtures, created ${fixtures.length}`)

const jsonLines = `${fixtures.map((fixture) => JSON.stringify(fixture)).join('\n')}\n`
const sha256 = createHash('sha256').update(jsonLines).digest('hex')
const operationCounts = Object.fromEntries(
  [...new Set(fixtures.map((fixture) => fixture.draft.operation))]
    .sort()
    .map((operation) => [
      operation,
      fixtures.filter((fixture) => fixture.draft.operation === operation).length
    ])
)

await mkdir(outputDirectory, { recursive: true })
await writeFile(fixturePath, jsonLines, 'utf8')
await writeFile(
  manifestPath,
  `${JSON.stringify(
    {
      schemaVersion: '0.1',
      fixtureFile: 'calendar-ir.v0.1.jsonl',
      count: fixtures.length,
      sha256,
      operationCounts,
      generator: 'scripts/generate-golden-fixtures.ts'
    },
    null,
    2
  )}\n`,
  'utf8'
)

console.log(`Generated ${fixtures.length} golden fixtures (${sha256.slice(0, 12)}).`)
