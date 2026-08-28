import type { EventOccurrence, ReminderEntity } from '@remind-me/contracts'

export type WidgetOccurrence = Pick<
  EventOccurrence,
  | 'occurrenceId'
  | 'eventId'
  | 'title'
  | 'description'
  | 'location'
  | 'startUtc'
  | 'endUtc'
  | 'timezone'
  | 'allDay'
  | 'originalDate'
  | 'recurring'
>

export type WidgetReminder = Pick<
  ReminderEntity,
  'id' | 'title' | 'dueAtUtc' | 'timezone' | 'status'
>

export interface WidgetDay {
  date: string
  weekday: string
  dayNumber: number
  eventCount: number
}

export function addLocalDays(date: string, offset: number): string {
  const value = new Date(`${date}T12:00:00.000Z`)
  value.setUTCDate(value.getUTCDate() + offset)
  return value.toISOString().slice(0, 10)
}

export function buildWidgetWeek(
  today: string,
  occurrences: readonly WidgetOccurrence[],
  locale: string
): WidgetDay[] {
  return Array.from({ length: 7 }, (_, offset) => {
    const date = addLocalDays(today, offset)
    const value = new Date(`${date}T12:00:00.000Z`)
    return {
      date,
      weekday: new Intl.DateTimeFormat(locale, { weekday: 'narrow', timeZone: 'UTC' }).format(
        value
      ),
      dayNumber: value.getUTCDate(),
      eventCount: occurrences.filter((occurrence) => occurrence.originalDate === date).length
    }
  })
}

export function eventsForWidgetDay(
  occurrences: readonly WidgetOccurrence[],
  date: string,
  limit = Number.POSITIVE_INFINITY
): WidgetOccurrence[] {
  return occurrences
    .filter((occurrence) => occurrence.originalDate === date)
    .sort((left, right) => Date.parse(left.startUtc) - Date.parse(right.startUtc))
    .slice(0, limit)
}

export function activeWidgetReminders<T extends WidgetReminder>(
  reminders: readonly T[],
  limit = Number.POSITIVE_INFINITY
): T[] {
  return reminders
    .filter((reminder) => reminder.status === 'active')
    .sort((left, right) => Date.parse(left.dueAtUtc) - Date.parse(right.dueAtUtc))
    .slice(0, limit)
}
