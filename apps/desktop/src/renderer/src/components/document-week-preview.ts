import { Temporal } from '@js-temporal/polyfill'
import type { DocumentImportDraft, DocumentScheduleMetadata, Weekday } from '@remind-me/contracts'

export const documentWeekdays = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday'
] as const satisfies readonly Weekday[]

export interface DocumentWeekItem {
  draftId: string
  kind: DocumentImportDraft['kind']
  weekday: Weekday
  title: string
  courseCode: string | null
  sectionCode: string | null
  component: DocumentScheduleMetadata['component'] | null
  startTime: string
  endTime: string | null
  location: string
  colorIndex: number
}

export interface DocumentWeekPreview {
  days: ReadonlyArray<{ weekday: Weekday; items: DocumentWeekItem[] }>
  seriesCount: number
  meetingCount: number
  courseCount: number
  scheduleSeriesCount: number
}

export const componentLabels: Readonly<Record<DocumentScheduleMetadata['component'], string>> = {
  lecture: 'Lecture',
  'lecture-discussion': 'Lecture-discussion',
  laboratory: 'Laboratory',
  'laboratory-discussion': 'Laboratory-discussion',
  discussion: 'Discussion',
  seminar: 'Seminar',
  studio: 'Studio',
  clinical: 'Clinical',
  practicum: 'Practicum',
  'primary-section': 'Primary section',
  'linked-section': 'Linked section',
  'class-meeting': 'Class meeting'
}

function weekdayForDate(date: string): Weekday {
  return documentWeekdays[Temporal.PlainDate.from(date).dayOfWeek - 1] ?? 'monday'
}

function colorIndex(value: string): number {
  let hash = 0
  for (const character of value) hash = (hash * 31 + character.codePointAt(0)!) >>> 0
  return hash % 6
}

export function formatDocumentTime(time: string | null): string {
  if (!time) return 'All day'
  const [hoursText, minutes = '00'] = time.split(':')
  const hours = Number(hoursText)
  if (!Number.isFinite(hours)) return time
  const suffix = hours >= 12 ? 'PM' : 'AM'
  const displayHours = hours % 12 || 12
  return `${displayHours}:${minutes} ${suffix}`
}

export function buildDocumentWeekPreview(
  drafts: readonly DocumentImportDraft[]
): DocumentWeekPreview {
  const byDay = new Map(documentWeekdays.map((weekday) => [weekday, [] as DocumentWeekItem[]]))
  const courses = new Set<string>()
  let scheduleSeriesCount = 0

  for (const draft of drafts) {
    if (draft.kind === 'reminder' && (draft.form.dueDate === null || draft.form.dueTime === null)) {
      continue
    }
    const schedule = draft.schedule
    if (schedule) {
      scheduleSeriesCount += 1
      courses.add(schedule.courseCode.toLocaleLowerCase())
    }
    const weekdays =
      draft.form.recurrence?.frequency === 'weekly' && draft.form.recurrence.byWeekday.length > 0
        ? draft.form.recurrence.byWeekday
        : [weekdayForDate(draft.kind === 'event' ? draft.form.startDate : draft.form.dueDate!)]
    for (const weekday of weekdays) {
      const item: DocumentWeekItem = {
        draftId: draft.id,
        kind: draft.kind,
        weekday,
        title: draft.form.title,
        courseCode: schedule?.courseCode ?? null,
        sectionCode: schedule?.sectionCode ?? null,
        component: schedule?.component ?? null,
        startTime: draft.kind === 'event' ? (draft.form.startTime ?? '00:00') : draft.form.dueTime!,
        endTime: draft.kind === 'event' ? draft.form.endTime : null,
        location: draft.kind === 'event' ? draft.form.location : '',
        colorIndex: colorIndex(schedule?.courseCode ?? draft.form.title)
      }
      byDay.get(weekday)?.push(item)
    }
  }

  const days = documentWeekdays.map((weekday) => ({
    weekday,
    items: (byDay.get(weekday) ?? []).sort(
      (left, right) =>
        left.startTime.localeCompare(right.startTime) || left.title.localeCompare(right.title)
    )
  }))
  return {
    days,
    seriesCount: drafts.length,
    meetingCount: days.reduce((total, day) => total + day.items.length, 0),
    courseCount: courses.size,
    scheduleSeriesCount
  }
}
