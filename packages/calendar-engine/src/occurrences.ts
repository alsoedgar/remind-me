import { Temporal } from '@js-temporal/polyfill'
import {
  eventOccurrenceSchema,
  type EventEntity,
  type EventOccurrence,
  type RecurrenceExceptionEntity,
  type RecurrenceRule,
  type Weekday
} from '@remind-me/contracts'

const weekdayNumber: Record<Weekday, number> = {
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
  sunday: 7
}

const maxGeneratedDates = 20_000

function overlaps(
  startA: Temporal.Instant,
  endA: Temporal.Instant,
  startB: Temporal.Instant,
  endB: Temporal.Instant
): boolean {
  return Temporal.Instant.compare(startA, endB) < 0 && Temporal.Instant.compare(startB, endA) < 0
}

function matchesMonthDay(
  date: Temporal.PlainDate,
  values: readonly number[],
  fallbackDay: number
): boolean {
  const candidates = values.length > 0 ? values : [fallbackDay]
  return candidates.some((value) => {
    if (value > 0) return date.day === value
    return date.day === date.daysInMonth + value + 1
  })
}

function matchesRecurrenceDate(
  date: Temporal.PlainDate,
  baseDate: Temporal.PlainDate,
  rule: RecurrenceRule
): boolean {
  if (Temporal.PlainDate.compare(date, baseDate) === 0 && rule.frequency !== 'weekly') return true

  switch (rule.frequency) {
    case 'daily': {
      const days = baseDate.until(date, { largestUnit: 'day' }).days
      return days >= 0 && days % rule.interval === 0
    }
    case 'weekly': {
      const baseWeekStart = baseDate.subtract({ days: baseDate.dayOfWeek - 1 })
      const candidateWeekStart = date.subtract({ days: date.dayOfWeek - 1 })
      const weeks = Math.floor(
        baseWeekStart.until(candidateWeekStart, { largestUnit: 'day' }).days / 7
      )
      const allowedWeekdays =
        rule.byWeekday.length > 0
          ? rule.byWeekday.map((weekday) => weekdayNumber[weekday])
          : [baseDate.dayOfWeek]
      return weeks >= 0 && weeks % rule.interval === 0 && allowedWeekdays.includes(date.dayOfWeek)
    }
    case 'monthly': {
      const baseMonth = baseDate.with({ day: 1 })
      const candidateMonth = date.with({ day: 1 })
      const months = baseMonth.until(candidateMonth, { largestUnit: 'month' }).months
      return (
        months >= 0 &&
        months % rule.interval === 0 &&
        matchesMonthDay(date, rule.byMonthDay, baseDate.day)
      )
    }
    case 'yearly': {
      const years = date.year - baseDate.year
      return (
        years >= 0 &&
        years % rule.interval === 0 &&
        date.month === baseDate.month &&
        matchesMonthDay(date, rule.byMonthDay, baseDate.day)
      )
    }
  }
}

function occurrenceForDate(event: EventEntity, date: Temporal.PlainDate): EventOccurrence {
  const baseStart = Temporal.Instant.from(event.startUtc).toZonedDateTimeISO(event.timezone)
  const baseEnd = Temporal.Instant.from(event.endUtc).toZonedDateTimeISO(event.timezone)
  const start = date.toZonedDateTime({
    timeZone: event.timezone,
    plainTime: event.allDay ? Temporal.PlainTime.from('00:00') : baseStart.toPlainTime()
  })

  const endInstant = event.allDay
    ? date
        .add({
          days: baseStart.toPlainDate().until(baseEnd.toPlainDate(), { largestUnit: 'day' }).days
        })
        .toZonedDateTime({ timeZone: event.timezone, plainTime: Temporal.PlainTime.from('00:00') })
        .toInstant()
    : start.toInstant().add({
        milliseconds: Number(
          Temporal.Instant.from(event.endUtc).epochMilliseconds -
            Temporal.Instant.from(event.startUtc).epochMilliseconds
        )
      })

  return eventOccurrenceSchema.parse({
    occurrenceId: `occ:${event.id}:${date.toString()}`,
    eventId: event.id,
    calendarId: event.calendarId,
    title: event.title,
    description: event.description,
    location: event.location,
    startUtc: start.toInstant().toString({ fractionalSecondDigits: 3 }),
    endUtc: endInstant.toString({ fractionalSecondDigits: 3 }),
    timezone: event.timezone,
    allDay: event.allDay,
    originalDate: date.toString(),
    recurring: event.recurrence !== null
  })
}

export function expandEventOccurrences(
  event: EventEntity,
  rangeStartUtc: string,
  rangeEndUtc: string,
  exceptions: readonly RecurrenceExceptionEntity[] = []
): EventOccurrence[] {
  if (event.status !== 'active') return []

  const rangeStart = Temporal.Instant.from(rangeStartUtc)
  const rangeEnd = Temporal.Instant.from(rangeEndUtc)
  const baseStart = Temporal.Instant.from(event.startUtc).toZonedDateTimeISO(event.timezone)
  const baseDate = baseStart.toPlainDate()
  const cancelledDates = new Set(
    exceptions
      .filter((exception) => exception.parentEventId === event.id)
      .map((exception) => exception.originalDate)
  )

  if (event.recurrence === null) {
    const occurrence = occurrenceForDate(event, baseDate)
    return overlaps(
      Temporal.Instant.from(occurrence.startUtc),
      Temporal.Instant.from(occurrence.endUtc),
      rangeStart,
      rangeEnd
    )
      ? [occurrence]
      : []
  }

  const rule = event.recurrence
  const rangeEndDate = rangeEnd.toZonedDateTimeISO(event.timezone).toPlainDate().add({ days: 1 })
  const occurrences: EventOccurrence[] = []
  let date = baseDate
  let generatedDates = 0
  let recurrenceIndex = 0

  while (
    Temporal.PlainDate.compare(date, rangeEndDate) <= 0 &&
    generatedDates < maxGeneratedDates
  ) {
    generatedDates += 1
    const matches = matchesRecurrenceDate(date, baseDate, rule)
    if (matches) {
      recurrenceIndex += 1
      if (rule.end.kind === 'count' && recurrenceIndex > rule.end.count) break
      if (
        rule.end.kind === 'until' &&
        Temporal.PlainDate.compare(date, Temporal.PlainDate.from(rule.end.date)) > 0
      )
        break

      if (!cancelledDates.has(date.toString())) {
        const occurrence = occurrenceForDate(event, date)
        if (
          overlaps(
            Temporal.Instant.from(occurrence.startUtc),
            Temporal.Instant.from(occurrence.endUtc),
            rangeStart,
            rangeEnd
          )
        ) {
          occurrences.push(occurrence)
        }
      }
    }
    date = date.add({ days: 1 })
  }

  return occurrences
}

export function expandEventsInRange(
  events: readonly EventEntity[],
  rangeStartUtc: string,
  rangeEndUtc: string,
  exceptions: readonly RecurrenceExceptionEntity[] = []
): EventOccurrence[] {
  return events
    .flatMap((event) => expandEventOccurrences(event, rangeStartUtc, rangeEndUtc, exceptions))
    .sort(
      (left, right) =>
        left.startUtc.localeCompare(right.startUtc) || left.title.localeCompare(right.title)
    )
}

export function findOccurrenceConflicts(
  events: readonly EventEntity[],
  rangeStartUtc: string,
  rangeEndUtc: string,
  exceptions: readonly RecurrenceExceptionEntity[] = []
): EventOccurrence[] {
  return expandEventsInRange(events, rangeStartUtc, rangeEndUtc, exceptions).filter((occurrence) =>
    overlaps(
      Temporal.Instant.from(occurrence.startUtc),
      Temporal.Instant.from(occurrence.endUtc),
      Temporal.Instant.from(rangeStartUtc),
      Temporal.Instant.from(rangeEndUtc)
    )
  )
}
