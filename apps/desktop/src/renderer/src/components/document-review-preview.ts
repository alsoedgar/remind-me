import { Temporal } from '@js-temporal/polyfill'
import type {
  DocumentImportDraft,
  DocumentScheduleMetadata,
  DocumentSkippedItem,
  RecurrenceRule,
  Weekday
} from '@remind-me/contracts'

const weekdays = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday'
] as const satisfies readonly Weekday[]

export interface DocumentChronologyItem {
  draftId: string
  kind: DocumentImportDraft['kind']
  title: string
  date: string
  endDate: string
  startTime: string | null
  endTime: string | null
  location: string
  schedule: DocumentScheduleMetadata | null
  recurrence: RecurrenceRule | null
}

export interface DocumentMonthOccurrence {
  draftId: string
  kind: DocumentImportDraft['kind']
  title: string
  date: string
  startTime: string | null
  endTime: string | null
  location: string
  schedule: DocumentScheduleMetadata | null
}

export interface DocumentMonthCell {
  date: string
  day: number
  inMonth: boolean
  items: DocumentMonthOccurrence[]
}

export interface DocumentMonthPreview {
  month: string
  label: string
  cells: DocumentMonthCell[]
  occurrenceCount: number
}

export interface DocumentReviewTotals {
  seriesCount: number
  weeklyMeetingCount: number
  courseCount: number
  skippedRowCount: number
  noFixedTimeCount: number
}

function draftDate(draft: DocumentImportDraft): string {
  return draft.kind === 'event' ? draft.form.startDate : draft.form.dueDate
}

function draftEndDate(draft: DocumentImportDraft): string {
  if (draft.kind === 'reminder') return draft.form.dueDate
  if (draft.form.recurrence?.end.kind === 'until') return draft.form.recurrence.end.date
  return draft.form.endDate
}

function draftStartTime(draft: DocumentImportDraft): string | null {
  return draft.kind === 'event' ? draft.form.startTime : draft.form.dueTime
}

function draftEndTime(draft: DocumentImportDraft): string | null {
  return draft.kind === 'event' ? draft.form.endTime : null
}

function matchesMonthDay(
  date: Temporal.PlainDate,
  values: readonly number[],
  fallbackDay: number
): boolean {
  const candidates = values.length > 0 ? values : [fallbackDay]
  return candidates.some((value) =>
    value > 0 ? date.day === value : date.day === date.daysInMonth + value + 1
  )
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
      const baseWeek = baseDate.subtract({ days: baseDate.dayOfWeek - 1 })
      const candidateWeek = date.subtract({ days: date.dayOfWeek - 1 })
      const weeks = Math.floor(baseWeek.until(candidateWeek, { largestUnit: 'day' }).days / 7)
      const allowed =
        rule.byWeekday.length > 0
          ? rule.byWeekday.map((weekday) => weekdays.indexOf(weekday) + 1)
          : [baseDate.dayOfWeek]
      return weeks >= 0 && weeks % rule.interval === 0 && allowed.includes(date.dayOfWeek)
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

function occurrenceDates(
  draft: DocumentImportDraft,
  rangeStart: Temporal.PlainDate,
  rangeEnd: Temporal.PlainDate
): string[] {
  const baseDate = Temporal.PlainDate.from(draftDate(draft))
  if (!draft.form.recurrence) {
    return Temporal.PlainDate.compare(baseDate, rangeStart) >= 0 &&
      Temporal.PlainDate.compare(baseDate, rangeEnd) <= 0
      ? [baseDate.toString()]
      : []
  }

  const rule = draft.form.recurrence
  const until = rule.end.kind === 'until' ? Temporal.PlainDate.from(rule.end.date) : rangeEnd
  const finalDate = Temporal.PlainDate.compare(until, rangeEnd) < 0 ? until : rangeEnd
  if (
    Temporal.PlainDate.compare(finalDate, baseDate) < 0 ||
    Temporal.PlainDate.compare(finalDate, rangeStart) < 0
  )
    return []

  const results: string[] = []
  let matchedCount = 0
  let scanned = 0
  for (
    let date = baseDate;
    Temporal.PlainDate.compare(date, finalDate) <= 0 && scanned < 20_000;
    date = date.add({ days: 1 })
  ) {
    scanned += 1
    if (!matchesRecurrenceDate(date, baseDate, rule)) continue
    matchedCount += 1
    if (rule.end.kind === 'count' && matchedCount > rule.end.count) break
    if (Temporal.PlainDate.compare(date, rangeStart) >= 0) results.push(date.toString())
  }
  return results
}

export function buildDocumentChronology(
  drafts: readonly DocumentImportDraft[]
): DocumentChronologyItem[] {
  return drafts
    .map((draft) => ({
      draftId: draft.id,
      kind: draft.kind,
      title: draft.form.title,
      date: draftDate(draft),
      endDate: draftEndDate(draft),
      startTime: draftStartTime(draft),
      endTime: draftEndTime(draft),
      location: draft.kind === 'event' ? draft.form.location : '',
      schedule: draft.schedule,
      recurrence: draft.form.recurrence
    }))
    .sort(
      (left, right) =>
        left.date.localeCompare(right.date) ||
        (left.startTime ?? '').localeCompare(right.startTime ?? '') ||
        left.title.localeCompare(right.title)
    )
}

export function buildDocumentMonthPreview(
  drafts: readonly DocumentImportDraft[],
  month: string,
  locale = 'en-US'
): DocumentMonthPreview {
  const yearMonth = Temporal.PlainYearMonth.from(month)
  const first = yearMonth.toPlainDate({ day: 1 })
  const last = yearMonth.toPlainDate({ day: yearMonth.daysInMonth })
  const gridStart = first.subtract({ days: first.dayOfWeek - 1 })
  const gridEnd = last.add({ days: 7 - last.dayOfWeek })
  const byDate = new Map<string, DocumentMonthOccurrence[]>()

  for (const draft of drafts) {
    for (const date of occurrenceDates(draft, gridStart, gridEnd)) {
      const item: DocumentMonthOccurrence = {
        draftId: draft.id,
        kind: draft.kind,
        title: draft.form.title,
        date,
        startTime: draftStartTime(draft),
        endTime: draftEndTime(draft),
        location: draft.kind === 'event' ? draft.form.location : '',
        schedule: draft.schedule
      }
      const items = byDate.get(date) ?? []
      items.push(item)
      byDate.set(date, items)
    }
  }

  const cells: DocumentMonthCell[] = []
  for (
    let date = gridStart;
    Temporal.PlainDate.compare(date, gridEnd) <= 0;
    date = date.add({ days: 1 })
  ) {
    const value = date.toString()
    cells.push({
      date: value,
      day: date.day,
      inMonth: date.month === yearMonth.month && date.year === yearMonth.year,
      items: (byDate.get(value) ?? []).sort(
        (left, right) =>
          (left.startTime ?? '').localeCompare(right.startTime ?? '') ||
          left.title.localeCompare(right.title)
      )
    })
  }

  return {
    month: yearMonth.toString(),
    label: new Intl.DateTimeFormat(locale, {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC'
    }).format(new Date(Date.UTC(yearMonth.year, yearMonth.month - 1, 1))),
    cells,
    occurrenceCount: cells
      .filter((cell) => cell.inMonth)
      .reduce((total, cell) => total + cell.items.length, 0)
  }
}

export function summarizeDocumentReview(
  drafts: readonly DocumentImportDraft[],
  skippedItems: readonly DocumentSkippedItem[]
): DocumentReviewTotals {
  const courses = new Set(
    drafts
      .map((draft) => draft.schedule?.courseCode.trim().toLocaleLowerCase() ?? '')
      .filter(Boolean)
  )
  return {
    seriesCount: drafts.length,
    weeklyMeetingCount: drafts.reduce(
      (total, draft) =>
        total +
        (draft.form.recurrence?.frequency === 'weekly'
          ? Math.max(1, draft.form.recurrence.byWeekday.length)
          : 0),
      0
    ),
    courseCount: courses.size,
    skippedRowCount: skippedItems.length,
    noFixedTimeCount: skippedItems.filter((item) => item.category === 'no-fixed-time').length
  }
}
