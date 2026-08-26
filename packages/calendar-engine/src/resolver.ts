import { requiresExplicitConfirmation } from '@remind-me/assistant-core'
import { Temporal } from '@js-temporal/polyfill'
import {
  calendarIRDraftSchema,
  calendarIRResolvedSchema,
  type CalendarIRDraft,
  type CalendarIRResolved,
  type TemporalAnchor,
  type TemporalWindow,
  type Weekday
} from '@remind-me/contracts'
import { resolverContextSchema, type ResolverContext } from './types'

const weekdayIndex: Record<Weekday, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6
}

export class CalendarResolutionError extends Error {
  readonly code: 'unsupported-expression' | 'invalid-window'

  constructor(code: CalendarResolutionError['code'], message: string) {
    super(message)
    this.name = 'CalendarResolutionError'
    this.code = code
  }
}

function addDays(date: string, days: number): string {
  try {
    return Temporal.PlainDate.from(date).add({ days }).toString()
  } catch {
    throw new CalendarResolutionError('invalid-window', `Invalid local date: ${date}`)
  }
}

function dayOfWeek(date: string): number {
  try {
    return Temporal.PlainDate.from(date).dayOfWeek % 7
  } catch {
    throw new CalendarResolutionError('invalid-window', `Invalid local date: ${date}`)
  }
}

export function resolveTemporalAnchor(anchor: TemporalAnchor, context: ResolverContext): string {
  switch (anchor.kind) {
    case 'absolute':
      return anchor.date
    case 'relative-day':
      return addDays(context.localDate, anchor.offset)
    case 'weekday': {
      const delta = (weekdayIndex[anchor.weekday] - dayOfWeek(context.localDate) + 7) % 7
      const daysAhead = anchor.relation === 'next' && delta === 0 ? 7 : delta
      return addDays(context.localDate, daysAhead)
    }
    case 'verbatim':
      throw new CalendarResolutionError(
        'unsupported-expression',
        `Cannot deterministically resolve “${anchor.text}”`
      )
  }
}

function localInstant(date: string, time: string, timezone: string): string {
  try {
    const plainDate = Temporal.PlainDate.from(date)
    const plainTime = Temporal.PlainTime.from(time)
    return plainDate
      .toZonedDateTime({ timeZone: timezone, plainTime })
      .toInstant()
      .toString({ fractionalSecondDigits: 3 })
  } catch {
    throw new CalendarResolutionError('invalid-window', `Invalid local date/time: ${date} ${time}`)
  }
}

function addMinutes(instant: string, minutes: number): string {
  return Temporal.Instant.from(instant).add({ minutes }).toString({ fractionalSecondDigits: 3 })
}

export interface ResolvedWindow {
  startUtc: string
  endUtc: string
  timezone: string
  allDay: boolean
}

export function resolveTemporalWindow(
  window: TemporalWindow,
  context: ResolverContext
): ResolvedWindow {
  const startDate = resolveTemporalAnchor(window.start.date, context)
  const timezone = window.timezone ?? context.timezone

  if (window.allDay) {
    const startUtc = localInstant(startDate, '00:00', timezone)
    const inclusiveEndDate = window.end
      ? resolveTemporalAnchor(window.end.date, context)
      : startDate
    const endUtc = localInstant(addDays(inclusiveEndDate, 1), '00:00', timezone)
    return { startUtc, endUtc, timezone, allDay: true }
  }

  if (window.start.time === null) {
    throw new CalendarResolutionError('invalid-window', 'Timed window is missing a start time')
  }

  const startUtc = localInstant(startDate, window.start.time, timezone)
  if (window.end === null) {
    return {
      startUtc,
      endUtc: addMinutes(startUtc, context.defaultEventDurationMinutes),
      timezone,
      allDay: false
    }
  }

  const endDate = resolveTemporalAnchor(window.end.date, context)
  const endUtc = localInstant(endDate, window.end.time ?? window.start.time, timezone)
  if (Date.parse(endUtc) <= Date.parse(startUtc)) {
    throw new CalendarResolutionError('invalid-window', 'Resolved end must be after start')
  }
  return { startUtc, endUtc, timezone, allDay: false }
}

export function resolveCalendarIR(
  input: CalendarIRDraft,
  inputContext: ResolverContext
): CalendarIRResolved {
  const draft = calendarIRDraftSchema.parse(input)
  const context = resolverContextSchema.parse(inputContext)
  const resolvedWindow = draft.fields.when
    ? resolveTemporalWindow(draft.fields.when.value, context)
    : null

  const resolved = {
    version: draft.version,
    requestId: draft.requestId,
    operation: draft.operation,
    selection: draft.selection,
    fields: {
      title: draft.fields.title?.value ?? null,
      description: draft.fields.description?.value ?? null,
      location: draft.fields.location?.value ?? null,
      startUtc:
        draft.operation.startsWith('event.') && resolvedWindow ? resolvedWindow.startUtc : null,
      endUtc: draft.operation.startsWith('event.') && resolvedWindow ? resolvedWindow.endUtc : null,
      dueAtUtc:
        draft.operation.startsWith('reminder.') && resolvedWindow ? resolvedWindow.startUtc : null,
      rangeStartUtc:
        draft.operation.startsWith('calendar.') && resolvedWindow ? resolvedWindow.startUtc : null,
      rangeEndUtc:
        draft.operation.startsWith('calendar.') && resolvedWindow ? resolvedWindow.endUtc : null,
      timezone: resolvedWindow?.timezone ?? null,
      allDay: resolvedWindow?.allDay ?? null,
      reminderOffsetMinutes: draft.fields.reminderOffsetMinutes?.value ?? null,
      status: draft.fields.status
    },
    recurrence: draft.recurrence,
    scope: draft.scope,
    risk: draft.risk,
    confidence: draft.confidence,
    requiresConfirmation: requiresExplicitConfirmation(draft),
    evidence: draft.evidence,
    resolvedAt: context.nowUtc
  }

  return calendarIRResolvedSchema.parse(resolved)
}
