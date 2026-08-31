import { randomUUID } from 'node:crypto'
import { Temporal } from '@js-temporal/polyfill'
import ICAL from 'ical.js'
import {
  eventEntitySchema,
  recurrenceRuleSchema,
  reminderEntitySchema,
  type EventEntity,
  type RecurrenceRule,
  type ReminderEntity,
  type Weekday
} from '@remind-me/contracts'

const weekdayToIcs: Record<Weekday, string> = {
  monday: 'MO',
  tuesday: 'TU',
  wednesday: 'WE',
  thursday: 'TH',
  friday: 'FR',
  saturday: 'SA',
  sunday: 'SU'
}

const icsToWeekday = Object.fromEntries(
  Object.entries(weekdayToIcs).map(([weekday, code]) => [code, weekday])
) as Record<string, Weekday>

interface IcalTimeLike {
  isDate: boolean
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  zone?: { tzid?: string }
  toJSDate: () => Date
  toString: () => string
}

interface IcalTimeProperty {
  value: IcalTimeLike
  timezoneId: string | null
}

export interface IcsImportResult {
  events: EventEntity[]
  reminders: ReminderEntity[]
  skippedCount: number
}

function escapeText(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('\n', '\\n')
    .replaceAll(',', '\\,')
    .replaceAll(';', '\\;')
}

function foldLine(line: string): string {
  if (line.length <= 73) return line
  const pieces: string[] = []
  let remaining = line
  while (remaining.length > 73) {
    pieces.push(remaining.slice(0, 73))
    remaining = remaining.slice(73)
  }
  pieces.push(remaining)
  return pieces.join('\r\n ')
}

function utcIcs(instant: string): string {
  const wholeSeconds = new Date(instant).toISOString().slice(0, 19)
  return `${wholeSeconds.replaceAll('-', '').replaceAll(':', '')}Z`
}

function localDateAt(instant: string, timezone: string): string {
  return Temporal.Instant.from(instant).toZonedDateTimeISO(timezone).toPlainDate().toString()
}

function compactDate(date: string): string {
  return date.replaceAll('-', '')
}

function recurrenceToIcs(rule: RecurrenceRule): string {
  const parts = [`FREQ=${rule.frequency.toUpperCase()}`, `INTERVAL=${rule.interval}`]
  if (rule.byWeekday.length > 0) {
    parts.push(`BYDAY=${rule.byWeekday.map((weekday) => weekdayToIcs[weekday]).join(',')}`)
  }
  if (rule.byMonthDay.length > 0) parts.push(`BYMONTHDAY=${rule.byMonthDay.join(',')}`)
  if (rule.end.kind === 'count') parts.push(`COUNT=${rule.end.count}`)
  if (rule.end.kind === 'until') parts.push(`UNTIL=${compactDate(rule.end.date)}`)
  return parts.join(';')
}

function recurrenceFromIcs(value: string): RecurrenceRule | null {
  const fields = new Map(
    value.split(';').map((part) => {
      const separator = part.indexOf('=')
      return [part.slice(0, separator).toUpperCase(), part.slice(separator + 1)]
    })
  )
  const frequency = fields.get('FREQ')?.toLowerCase()
  if (!frequency || !['daily', 'weekly', 'monthly', 'yearly'].includes(frequency)) return null
  const byWeekday = (fields.get('BYDAY')?.split(',') ?? [])
    .map((day) => icsToWeekday[day.replace(/^[+-]?\d+/, '')])
    .filter((day): day is Weekday => Boolean(day))
  const byMonthDay = (fields.get('BYMONTHDAY')?.split(',') ?? [])
    .map(Number)
    .filter((day) => Number.isInteger(day) && day !== 0 && day >= -31 && day <= 31)
  const until = fields.get('UNTIL')
  const count = Number(fields.get('COUNT'))
  const end: RecurrenceRule['end'] =
    Number.isInteger(count) && count > 0
      ? { kind: 'count', count }
      : until && /^\d{8}/.test(until)
        ? { kind: 'until', date: `${until.slice(0, 4)}-${until.slice(4, 6)}-${until.slice(6, 8)}` }
        : { kind: 'never' }

  return recurrenceRuleSchema.parse({
    frequency,
    interval: Math.max(1, Number(fields.get('INTERVAL')) || 1),
    byWeekday,
    byMonthDay,
    end
  })
}

function stringProperty(component: InstanceType<typeof ICAL.Component>, name: string): string {
  const value: unknown = component.getFirstPropertyValue(name)
  return typeof value === 'string' ? value : ''
}

function timeProperty(
  component: InstanceType<typeof ICAL.Component>,
  name: string
): IcalTimeProperty | null {
  const property = component.getFirstProperty(name)
  const value: unknown = property?.getFirstValue()
  if (
    typeof value === 'object' &&
    value !== null &&
    'isDate' in value &&
    'toJSDate' in value &&
    typeof value.toJSDate === 'function' &&
    'toString' in value &&
    typeof value.toString === 'function'
  ) {
    const timezone: unknown = property?.getParameter('tzid')
    return {
      value: value as IcalTimeLike,
      timezoneId: typeof timezone === 'string' ? timezone : null
    }
  }
  return null
}

function timeToInstant(property: IcalTimeProperty, fallbackTimezone: string): string {
  const { value } = property
  if (value.isDate) {
    return Temporal.PlainDate.from(value.toString())
      .toZonedDateTime({
        timeZone: fallbackTimezone,
        plainTime: Temporal.PlainTime.from('00:00')
      })
      .toInstant()
      .toString({ fractionalSecondDigits: 3 })
  }
  const zoneId = property.timezoneId ?? value.zone?.tzid
  if (zoneId === 'UTC' || zoneId === 'Z') return value.toJSDate().toISOString()
  return Temporal.PlainDateTime.from({
    year: value.year,
    month: value.month,
    day: value.day,
    hour: value.hour,
    minute: value.minute,
    second: value.second
  })
    .toZonedDateTime(zoneId && zoneId !== 'floating' ? zoneId : fallbackTimezone)
    .toInstant()
    .toString({ fractionalSecondDigits: 3 })
}

function timezoneFor(
  component: InstanceType<typeof ICAL.Component>,
  time: IcalTimeProperty,
  fallbackTimezone: string
): string {
  const explicit = stringProperty(component, 'x-remind-me-timezone')
  if (explicit) return explicit
  const zoneId = time.timezoneId ?? time.value.zone?.tzid
  return zoneId && zoneId !== 'floating' && zoneId !== 'Z' ? zoneId : fallbackTimezone
}

export function exportIcs(
  events: readonly EventEntity[],
  reminders: readonly ReminderEntity[]
): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'CALSCALE:GREGORIAN',
    'PRODID:-//Remind Me//Local Calendar 1.0//EN'
  ]

  for (const event of events) {
    lines.push('BEGIN:VEVENT')
    lines.push(`UID:${escapeText(event.id)}@remind-me.local`)
    lines.push(`DTSTAMP:${utcIcs(event.updatedAt)}`)
    if (event.allDay) {
      lines.push(`DTSTART;VALUE=DATE:${compactDate(localDateAt(event.startUtc, event.timezone))}`)
      lines.push(`DTEND;VALUE=DATE:${compactDate(localDateAt(event.endUtc, event.timezone))}`)
    } else {
      lines.push(`DTSTART:${utcIcs(event.startUtc)}`)
      lines.push(`DTEND:${utcIcs(event.endUtc)}`)
    }
    lines.push(`SUMMARY:${escapeText(event.title)}`)
    if (event.description) lines.push(`DESCRIPTION:${escapeText(event.description)}`)
    if (event.location) lines.push(`LOCATION:${escapeText(event.location)}`)
    lines.push(`X-REMIND-ME-TIMEZONE:${escapeText(event.timezone)}`)
    if (event.recurrence) lines.push(`RRULE:${recurrenceToIcs(event.recurrence)}`)
    if (event.status === 'cancelled') lines.push('STATUS:CANCELLED')
    lines.push('END:VEVENT')
  }

  for (const reminder of reminders) {
    lines.push('BEGIN:VTODO')
    lines.push(`UID:${escapeText(reminder.id)}@remind-me.local`)
    lines.push(`DTSTAMP:${utcIcs(reminder.updatedAt)}`)
    if (reminder.dueAtUtc) lines.push(`DUE:${utcIcs(reminder.dueAtUtc)}`)
    lines.push(`SUMMARY:${escapeText(reminder.title)}`)
    if (reminder.notes) lines.push(`DESCRIPTION:${escapeText(reminder.notes)}`)
    lines.push(`X-REMIND-ME-TIMEZONE:${escapeText(reminder.timezone)}`)
    if (reminder.recurrence) lines.push(`RRULE:${recurrenceToIcs(reminder.recurrence)}`)
    lines.push(`STATUS:${reminder.status === 'completed' ? 'COMPLETED' : 'NEEDS-ACTION'}`)
    if (reminder.completedAt) lines.push(`COMPLETED:${utcIcs(reminder.completedAt)}`)
    lines.push('END:VTODO')
  }

  lines.push('END:VCALENDAR')
  return `${lines.map(foldLine).join('\r\n')}\r\n`
}

export function importIcs(
  input: string,
  options: { defaultCalendarId: string; defaultTimezone: string; now?: string }
): IcsImportResult {
  const root = new ICAL.Component(ICAL.parse(input))
  const now = options.now ?? new Date().toISOString()
  const events: EventEntity[] = []
  const reminders: ReminderEntity[] = []
  let skippedCount = 0

  for (const component of root.getAllSubcomponents('vevent')) {
    try {
      const start = timeProperty(component, 'dtstart')
      const end = timeProperty(component, 'dtend')
      if (!start || !end) throw new Error('VEVENT is missing DTSTART or DTEND')
      const timezone = timezoneFor(component, start, options.defaultTimezone)
      const recurrenceValue = component.getFirstPropertyValue('rrule')
      const recurrence = recurrenceValue ? recurrenceFromIcs(String(recurrenceValue)) : null
      events.push(
        eventEntitySchema.parse({
          id: `event:${randomUUID()}`,
          calendarId: options.defaultCalendarId,
          title: stringProperty(component, 'summary') || 'Imported event',
          description: stringProperty(component, 'description'),
          location: stringProperty(component, 'location'),
          startUtc: timeToInstant(start, timezone),
          endUtc: timeToInstant(end, timezone),
          timezone,
          allDay: start.value.isDate,
          recurrence,
          status:
            stringProperty(component, 'status').toUpperCase() === 'CANCELLED'
              ? 'cancelled'
              : 'active',
          provenance: 'import',
          createdAt: now,
          updatedAt: now
        })
      )
    } catch {
      skippedCount += 1
    }
  }

  for (const component of root.getAllSubcomponents('vtodo')) {
    try {
      const due = timeProperty(component, 'due')
      if (!due) throw new Error('VTODO is missing DUE')
      const timezone = timezoneFor(component, due, options.defaultTimezone)
      const recurrenceValue = component.getFirstPropertyValue('rrule')
      const recurrence = recurrenceValue ? recurrenceFromIcs(String(recurrenceValue)) : null
      const completed = stringProperty(component, 'status').toUpperCase() === 'COMPLETED'
      const completedTime = timeProperty(component, 'completed')
      reminders.push(
        reminderEntitySchema.parse({
          id: `reminder:${randomUUID()}`,
          calendarId: options.defaultCalendarId,
          title: stringProperty(component, 'summary') || 'Imported reminder',
          notes: stringProperty(component, 'description'),
          dueAtUtc: timeToInstant(due, timezone),
          timezone,
          recurrence,
          status: completed ? 'completed' : 'active',
          completedAt: completedTime ? timeToInstant(completedTime, timezone) : null,
          provenance: 'import',
          createdAt: now,
          updatedAt: now
        })
      )
    } catch {
      skippedCount += 1
    }
  }

  return { events, reminders, skippedCount }
}
