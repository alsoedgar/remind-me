import { localParts } from './calendar-utils'

export interface DayAgendaOccurrence {
  occurrenceId: string
  eventId: string
  title: string
  description: string
  location: string
  startUtc: string
  endUtc: string
  timezone: string
  allDay: boolean
  originalDate: string
  recurring: boolean
}

export interface DayAgendaReminder {
  id: string
  title: string
  notes?: string
  dueAtUtc: string | null
  timezone: string
  status: 'active' | 'completed' | 'cancelled'
}

export type DayAgendaItem =
  | {
      kind: 'event'
      id: string
      sortAt: number
      occurrence: DayAgendaOccurrence
    }
  | {
      kind: 'reminder'
      id: string
      sortAt: number
      reminder: DayAgendaReminder
    }

/**
 * Builds the complete, chronological agenda for a local calendar date.
 * This projection deliberately has no display limit; each view decides how
 * much room it can show by scrolling rather than silently dropping plans.
 */
export function dayAgendaItems(
  occurrences: readonly DayAgendaOccurrence[],
  reminders: readonly DayAgendaReminder[],
  date: string
): DayAgendaItem[] {
  return [
    ...occurrences
      .filter((occurrence) => occurrence.originalDate === date)
      .map((occurrence): DayAgendaItem => ({
        kind: 'event',
        id: occurrence.occurrenceId,
        sortAt: Date.parse(occurrence.startUtc),
        occurrence
      })),
    ...reminders
      .filter(
        (reminder) =>
          reminder.status === 'active' &&
          reminder.dueAtUtc !== null &&
          localParts(reminder.dueAtUtc, reminder.timezone).date === date
      )
      .map((reminder): DayAgendaItem => ({
        kind: 'reminder',
        id: reminder.id,
        sortAt: Date.parse(reminder.dueAtUtc!),
        reminder
      }))
  ].sort(
    (left, right) =>
      left.sortAt - right.sortAt ||
      left.kind.localeCompare(right.kind) ||
      left.id.localeCompare(right.id)
  )
}
