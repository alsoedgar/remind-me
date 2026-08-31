import { Temporal } from '@js-temporal/polyfill'
import {
  canonicalDocumentLocation,
  canonicalDocumentText,
  createEventDocumentImportIdentity,
  createReminderDocumentImportIdentity,
  documentSourceRowId,
  reconcileDocumentEvent,
  reconcileDocumentReminder
} from '@remind-me/calendar-engine'
import type {
  DocumentFieldConfidence,
  DocumentFieldEvidence,
  DocumentImportDraft,
  DocumentScheduleMetadata,
  EventEntity,
  EventForm,
  ReminderEntity,
  ReminderForm,
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

function sortWeekdays(values: readonly Weekday[]): Weekday[] {
  return [...new Set(values)].sort(
    (left, right) => weekdays.indexOf(left) - weekdays.indexOf(right)
  )
}

function sourceFor(draft: DocumentImportDraft, operation: string) {
  return {
    sourceSha256: draft.importIdentity.sourceSha256,
    sourceRowId: documentSourceRowId(
      `${draft.importIdentity.sourceSha256}:${draft.importIdentity.sourceRowId}:review:${operation}`
    )
  }
}

function firstWeekdayOnOrAfter(date: string, weekday: Weekday): string {
  const start = Temporal.PlainDate.from(date)
  const target = weekdays.indexOf(weekday) + 1
  const offset = (target - start.dayOfWeek + 7) % 7
  return start.add({ days: offset }).toString()
}

function eventDurationDays(form: EventForm): number {
  return Temporal.PlainDate.from(form.startDate).until(Temporal.PlainDate.from(form.endDate), {
    largestUnit: 'day'
  }).days
}

function recalculate(
  form: EventForm | ReminderForm,
  schedule: DocumentScheduleMetadata | null,
  source: { sourceSha256: string; sourceRowId: string },
  events: readonly EventEntity[],
  reminders: readonly ReminderEntity[]
): Pick<DocumentImportDraft, 'importIdentity' | 'reconciliation'> {
  if ('startDate' in form) {
    const importIdentity = createEventDocumentImportIdentity(source, form, schedule)
    return {
      importIdentity,
      reconciliation: reconcileDocumentEvent(importIdentity, form, events, reminders)
    }
  }
  const importIdentity = createReminderDocumentImportIdentity(source, form)
  return {
    importIdentity,
    reconciliation: reconcileDocumentReminder(importIdentity, form, reminders, events)
  }
}

export function canSplitDocumentDraft(draft: DocumentImportDraft): boolean {
  return (
    draft.reconciliation.state !== 'same-source' &&
    draft.form.recurrence?.frequency === 'weekly' &&
    draft.form.recurrence.byWeekday.length > 1
  )
}

export function splitDocumentDraft(
  draft: DocumentImportDraft,
  events: readonly EventEntity[],
  reminders: readonly ReminderEntity[]
): DocumentImportDraft[] {
  if (!canSplitDocumentDraft(draft) || draft.form.recurrence?.frequency !== 'weekly') return [draft]
  const recurrence = draft.form.recurrence
  return sortWeekdays(recurrence.byWeekday).map((weekday) => {
    const schedule = draft.schedule ? { ...draft.schedule, weekdays: [weekday] } : null
    const recurrenceForDay = { ...recurrence, byWeekday: [weekday] }
    const source = sourceFor(draft, `split:${weekday}`)
    if (draft.kind === 'event') {
      const startDate = firstWeekdayOnOrAfter(
        draft.schedule?.termStartDate ?? draft.form.startDate,
        weekday
      )
      const form: EventForm = {
        ...draft.form,
        startDate,
        endDate: Temporal.PlainDate.from(startDate)
          .add({ days: eventDurationDays(draft.form) })
          .toString(),
        recurrence: recurrenceForDay
      }
      const identity = recalculate(form, schedule, source, events, reminders)
      return {
        ...draft,
        id: `${draft.id}:split:${weekday.slice(0, 3)}`,
        form,
        schedule,
        semanticRecord: {
          ...draft.semanticRecord,
          startDate: form.startDate,
          endDate: form.endDate,
          recurrence: recurrenceForDay,
          schedule
        },
        ...identity,
        warnings: [...draft.warnings, `Split during review into the ${weekday} series.`]
      } as DocumentImportDraft
    }
    if (draft.form.dueDate === null) return draft
    const dueDate = firstWeekdayOnOrAfter(draft.form.dueDate, weekday)
    const form: ReminderForm = { ...draft.form, dueDate, recurrence: recurrenceForDay }
    const identity = recalculate(form, null, source, events, reminders)
    return {
      ...draft,
      id: `${draft.id}:split:${weekday.slice(0, 3)}`,
      form,
      semanticRecord: {
        ...draft.semanticRecord,
        startDate: dueDate,
        recurrence: recurrenceForDay
      },
      ...identity,
      warnings: [...draft.warnings, `Split during review into the ${weekday} reminder.`]
    } as DocumentImportDraft
  })
}

function recurrenceMergeKey(draft: DocumentImportDraft): string | null {
  const recurrence = draft.form.recurrence
  if (recurrence?.frequency !== 'weekly') return null
  return JSON.stringify({
    interval: recurrence.interval,
    byMonthDay: recurrence.byMonthDay,
    end: recurrence.end
  })
}

function scheduleMergeKey(schedule: DocumentScheduleMetadata | null): string {
  if (!schedule) return 'general'
  return JSON.stringify({
    courseCode: canonicalDocumentText(schedule.courseCode),
    sectionCode: canonicalDocumentText(schedule.sectionCode ?? ''),
    crn: canonicalDocumentText(schedule.crn ?? ''),
    component: schedule.component,
    termStartDate: schedule.termStartDate,
    termEndDate: schedule.termEndDate
  })
}

function nearbyStartDates(left: DocumentImportDraft, right: DocumentImportDraft): boolean {
  const leftDateValue = left.kind === 'event' ? left.form.startDate : left.form.dueDate
  const rightDateValue = right.kind === 'event' ? right.form.startDate : right.form.dueDate
  if (leftDateValue === null || rightDateValue === null) return false
  const leftDate = Temporal.PlainDate.from(leftDateValue)
  const rightDate = Temporal.PlainDate.from(rightDateValue)
  return Math.abs(leftDate.until(rightDate, { largestUnit: 'day' }).days) <= 7
}

export function canMergeDocumentDrafts(
  anchor: DocumentImportDraft,
  candidate: DocumentImportDraft
): boolean {
  if (
    anchor.id === candidate.id ||
    anchor.kind !== candidate.kind ||
    anchor.reconciliation.state === 'same-source' ||
    candidate.reconciliation.state === 'same-source' ||
    recurrenceMergeKey(anchor) === null ||
    recurrenceMergeKey(anchor) !== recurrenceMergeKey(candidate) ||
    scheduleMergeKey(anchor.schedule) !== scheduleMergeKey(candidate.schedule) ||
    !nearbyStartDates(anchor, candidate) ||
    canonicalDocumentText(anchor.form.title) !== canonicalDocumentText(candidate.form.title)
  )
    return false

  if (anchor.kind === 'event' && candidate.kind === 'event') {
    return (
      anchor.form.calendarId === candidate.form.calendarId &&
      anchor.form.timezone === candidate.form.timezone &&
      anchor.form.allDay === candidate.form.allDay &&
      anchor.form.startTime === candidate.form.startTime &&
      anchor.form.endTime === candidate.form.endTime &&
      eventDurationDays(anchor.form) === eventDurationDays(candidate.form) &&
      canonicalDocumentLocation(anchor.form.location) ===
        canonicalDocumentLocation(candidate.form.location) &&
      canonicalDocumentText(anchor.form.description) ===
        canonicalDocumentText(candidate.form.description)
    )
  }
  if (anchor.kind === 'reminder' && candidate.kind === 'reminder') {
    return (
      anchor.form.calendarId === candidate.form.calendarId &&
      anchor.form.timezone === candidate.form.timezone &&
      anchor.form.dueTime === candidate.form.dueTime &&
      canonicalDocumentText(anchor.form.notes) === canonicalDocumentText(candidate.form.notes)
    )
  }
  return false
}

function mergeEvidence(
  drafts: readonly DocumentImportDraft[],
  field: keyof DocumentFieldEvidence
): string[] {
  return [...new Set(drafts.flatMap((draft) => draft.fieldEvidence[field]))].slice(0, 16)
}

function mergeConfidence(
  drafts: readonly DocumentImportDraft[],
  field: keyof DocumentFieldConfidence
): number | null {
  const values = drafts
    .map((draft) => draft.fieldConfidence[field])
    .filter((value): value is number => value !== null)
  return values.length > 0 ? Math.min(...values) : null
}

export function mergeDocumentDrafts(
  anchor: DocumentImportDraft,
  candidates: readonly DocumentImportDraft[],
  events: readonly EventEntity[],
  reminders: readonly ReminderEntity[]
): DocumentImportDraft {
  const drafts = [
    anchor,
    ...candidates.filter((draft) => canMergeDocumentDrafts(anchor, draft))
  ].filter((draft, index, items) => items.findIndex((item) => item.id === draft.id) === index)
  if (drafts.length < 2 || anchor.form.recurrence?.frequency !== 'weekly') return anchor
  const byWeekday = sortWeekdays(
    drafts.flatMap((draft) =>
      draft.form.recurrence?.frequency === 'weekly' ? draft.form.recurrence.byWeekday : []
    )
  )
  const earliestDate = drafts
    .map((draft) => (draft.kind === 'event' ? draft.form.startDate : draft.form.dueDate))
    .filter((date): date is string => date !== null)
    .sort()[0]!
  if (!earliestDate) return anchor
  const recurrence = { ...anchor.form.recurrence, byWeekday }
  const schedule = anchor.schedule ? { ...anchor.schedule, weekdays: byWeekday } : null
  const sourceRows = drafts
    .map((draft) => draft.importIdentity.sourceRowId)
    .sort()
    .join(',')
  const source = sourceFor(anchor, `merge:${sourceRows}`)
  const common = {
    id: `${anchor.id}:merge:${source.sourceRowId.slice(-8)}`,
    page: Math.min(...drafts.map((draft) => draft.page)),
    confidence: Math.min(...drafts.map((draft) => draft.confidence)),
    attention: 'check-evidence' as const,
    sourceText: [...new Set(drafts.map((draft) => draft.sourceText))].join('\n'),
    schedule,
    fieldEvidence: {
      title: mergeEvidence(drafts, 'title'),
      when: mergeEvidence(drafts, 'when'),
      location: mergeEvidence(drafts, 'location'),
      description: mergeEvidence(drafts, 'description')
    },
    fieldConfidence: {
      title: mergeConfidence(drafts, 'title') ?? anchor.fieldConfidence.title,
      when: mergeConfidence(drafts, 'when') ?? anchor.fieldConfidence.when,
      location: mergeConfidence(drafts, 'location'),
      description: mergeConfidence(drafts, 'description')
    },
    warnings: [
      ...new Set(drafts.flatMap((draft) => draft.warnings)),
      `Merged ${drafts.length} compatible weekly series during review.`
    ]
  }

  if (anchor.kind === 'event') {
    const form: EventForm = {
      ...anchor.form,
      startDate: earliestDate,
      endDate: Temporal.PlainDate.from(earliestDate)
        .add({ days: eventDurationDays(anchor.form) })
        .toString(),
      recurrence
    }
    const identity = recalculate(form, schedule, source, events, reminders)
    return {
      ...anchor,
      ...common,
      form,
      semanticRecord: {
        ...anchor.semanticRecord,
        startDate: form.startDate,
        endDate: form.endDate,
        recurrence,
        schedule
      },
      ...identity
    } as DocumentImportDraft
  }

  const form: ReminderForm = { ...anchor.form, dueDate: earliestDate, recurrence }
  const identity = recalculate(form, null, source, events, reminders)
  return {
    ...anchor,
    ...common,
    schedule: null,
    form,
    semanticRecord: {
      ...anchor.semanticRecord,
      startDate: form.dueDate,
      recurrence,
      schedule: null
    },
    ...identity
  } as DocumentImportDraft
}

export function canReclassifyDocumentDraft(draft: DocumentImportDraft): boolean {
  return draft.schedule === null && draft.reconciliation.state !== 'same-source'
}

export function reclassifyDocumentDraft(
  draft: DocumentImportDraft,
  events: readonly EventEntity[],
  reminders: readonly ReminderEntity[]
): DocumentImportDraft {
  if (
    !canReclassifyDocumentDraft(draft) ||
    (draft.kind === 'reminder' && (draft.form.dueDate === null || draft.form.dueTime === null))
  )
    return draft
  const source = {
    sourceSha256: draft.importIdentity.sourceSha256,
    sourceRowId: draft.importIdentity.sourceRowId
  }
  if (draft.kind === 'event') {
    const locationNote = draft.form.location ? `Location: ${draft.form.location}` : ''
    const form: ReminderForm = {
      id: null,
      calendarId: draft.form.calendarId,
      title: draft.form.title,
      notes: [draft.form.description, locationNote].filter(Boolean).join('\n'),
      dueDate: draft.form.startDate,
      dueTime: draft.form.startTime ?? '09:00',
      timezone: draft.form.timezone,
      recurrence: draft.form.recurrence
    }
    const identity = recalculate(form, null, source, events, reminders)
    return {
      ...draft,
      kind: 'reminder',
      form,
      schedule: null,
      semanticRecord: {
        ...draft.semanticRecord,
        kind: 'reminder',
        description: form.notes,
        allDay: false,
        startDate: form.dueDate!,
        endDate: null,
        startTime: form.dueTime!,
        endTime: null,
        timeBasis: 'source-instant',
        location: '',
        schedule: null
      },
      ...identity,
      warnings: [...draft.warnings, 'Reclassified from event to reminder during review.']
    } as DocumentImportDraft
  }

  const start = Temporal.PlainDateTime.from(`${draft.form.dueDate}T${draft.form.dueTime}`)
  const end = start.add({ hours: 1 })
  const form: EventForm = {
    id: null,
    calendarId: draft.form.calendarId,
    title: draft.form.title,
    description: draft.form.notes,
    location: '',
    startDate: start.toPlainDate().toString(),
    startTime: start.toPlainTime().toString({ smallestUnit: 'minute' }),
    endDate: end.toPlainDate().toString(),
    endTime: end.toPlainTime().toString({ smallestUnit: 'minute' }),
    timezone: draft.form.timezone,
    allDay: false,
    recurrence: draft.form.recurrence
  }
  const identity = recalculate(form, null, source, events, reminders)
  return {
    ...draft,
    kind: 'event',
    form,
    schedule: null,
    semanticRecord: {
      ...draft.semanticRecord,
      kind: 'event',
      description: form.description,
      allDay: false,
      startDate: form.startDate,
      endDate: form.endDate,
      startTime: form.startTime,
      endTime: form.endTime,
      timeBasis: 'default-duration',
      location: '',
      schedule: null
    },
    ...identity,
    warnings: [...draft.warnings, 'Reclassified from reminder to event during review.']
  } as DocumentImportDraft
}
