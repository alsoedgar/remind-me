import type {
  CalendarSnapshotRequest,
  EventEntity,
  EventForm,
  ReminderEntity,
  ReminderForm
} from '@remind-me/contracts'

interface LocalParts {
  date: string
  time: string
}

function partsMap(instant: string, timezone: string): Record<string, string> {
  return Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    })
      .formatToParts(new Date(instant))
      .map((part) => [part.type, part.value])
  )
}

export function localParts(instant: string, timezone: string): LocalParts {
  const parts = partsMap(instant, timezone)
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`
  }
}

export function todayDate(timezone: string): string {
  return localParts(new Date().toISOString(), timezone).date
}

export function eventToForm(event: EventEntity): EventForm {
  const start = localParts(event.startUtc, event.timezone)
  const inclusiveEndInstant = event.allDay
    ? new Date(Date.parse(event.endUtc) - 1).toISOString()
    : event.endUtc
  const end = localParts(inclusiveEndInstant, event.timezone)
  return {
    id: event.id,
    calendarId: event.calendarId,
    title: event.title,
    description: event.description,
    location: event.location,
    startDate: start.date,
    startTime: event.allDay ? null : start.time,
    endDate: end.date,
    endTime: event.allDay ? null : end.time,
    timezone: event.timezone,
    allDay: event.allDay,
    recurrence: event.recurrence
  }
}

export function reminderToForm(reminder: ReminderEntity): ReminderForm {
  const due = reminder.dueAtUtc ? localParts(reminder.dueAtUtc, reminder.timezone) : null
  return {
    id: reminder.id,
    calendarId: reminder.calendarId,
    title: reminder.title,
    notes: reminder.notes,
    dueDate: due?.date ?? null,
    dueTime: due?.time ?? null,
    timezone: reminder.timezone,
    recurrence: reminder.recurrence
  }
}

export function snapshotRange(anchor = new Date()): CalendarSnapshotRequest {
  const start = new Date(anchor.getFullYear() - 1, 0, 1)
  const end = new Date(anchor.getFullYear() + 2, 0, 1)
  return {
    rangeStartUtc: start.toISOString(),
    rangeEndUtc: end.toISOString()
  }
}

export function dateKey(year: number, monthIndex: number, day: number): string {
  return `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export function formatEventTime(
  instant: string,
  timezone: string,
  locale: string,
  allDay = false
): string {
  if (allDay) return 'All day'
  return new Intl.DateTimeFormat(locale, {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(instant))
}

export function formatDueDate(
  instant: string | null,
  timezone: string,
  locale: string,
  options: { includeDate?: boolean } = {}
): string {
  if (instant === null) return 'No due date'
  return new Intl.DateTimeFormat(locale, {
    timeZone: timezone,
    ...(options.includeDate ? { weekday: 'short', month: 'short', day: 'numeric' } : {}),
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(instant))
}

export function recurrenceLabel(
  recurrence: EventEntity['recurrence'] | ReminderEntity['recurrence']
): string | null {
  if (!recurrence) return null
  const frequency = {
    daily: 'day',
    weekly: 'week',
    monthly: 'month',
    yearly: 'year'
  }[recurrence.frequency]
  return recurrence.interval === 1
    ? `Every ${frequency}`
    : `Every ${recurrence.interval} ${frequency}s`
}
