import { randomUUID } from 'node:crypto'
import { Temporal } from '@js-temporal/polyfill'
import {
  createEventDocumentImportIdentity,
  createReminderDocumentImportIdentity,
  expandEventsInRange,
  findOccurrenceConflicts,
  refreshEventDocumentImportIdentity,
  refreshReminderDocumentImportIdentity
} from '@remind-me/calendar-engine'
import {
  availabilityResultSchema,
  availabilityRequestSchema,
  calendarBackupSchema,
  calendarMutationResultSchema,
  calendarSnapshotRequestSchema,
  calendarSnapshotSchema,
  dataDeleteAllResultSchema,
  eventEntitySchema,
  eventFormSchema,
  preferencesEntitySchema,
  recurrenceExceptionEntitySchema,
  reminderEntitySchema,
  reminderFormSchema,
  reviewedDocumentItemSchema,
  type AvailabilityResult,
  type AvailabilityRequest,
  type CalendarBackup,
  type CalendarBatchItem,
  type CalendarMutationResult,
  type CalendarOperation,
  type CalendarSnapshot,
  type CalendarSnapshotRequest,
  type DataDeleteAllResult,
  type EventForm,
  type EventEntity,
  type PreferencesEntity,
  type PreferencesUpdate,
  type RecurrenceRule,
  type RecurrenceExceptionEntity,
  type ReminderEntity,
  type ReminderForm,
  type RiskLevel,
  type ReviewedDocumentItem,
  type Weekday
} from '@remind-me/contracts'
import type { SqliteCalendarRepository } from './sqlite-repository'

const weekdayNumber: Record<Weekday, number> = {
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
  sunday: 7
}

function toInstant(date: string, time: string, timezone: string): string {
  return Temporal.PlainDate.from(date)
    .toZonedDateTime({ timeZone: timezone, plainTime: Temporal.PlainTime.from(time) })
    .toInstant()
    .toString({ fractionalSecondDigits: 3 })
}

function eventInstants(form: EventForm): { startUtc: string; endUtc: string } {
  if (form.allDay) {
    return {
      startUtc: toInstant(form.startDate, '00:00', form.timezone),
      endUtc: toInstant(
        Temporal.PlainDate.from(form.endDate).add({ days: 1 }).toString(),
        '00:00',
        form.timezone
      )
    }
  }
  if (form.startTime === null || form.endTime === null) {
    throw new Error('Timed events require start and end times')
  }
  return {
    startUtc: toInstant(form.startDate, form.startTime, form.timezone),
    endUtc: toInstant(form.endDate, form.endTime, form.timezone)
  }
}

function matchesNextDate(
  date: Temporal.PlainDate,
  base: Temporal.PlainDate,
  rule: RecurrenceRule
): boolean {
  const days = base.until(date, { largestUnit: 'day' }).days
  switch (rule.frequency) {
    case 'daily':
      return days > 0 && days % rule.interval === 0
    case 'weekly': {
      const baseWeekStart = base.subtract({ days: base.dayOfWeek - 1 })
      const candidateWeekStart = date.subtract({ days: date.dayOfWeek - 1 })
      const week = Math.floor(
        baseWeekStart.until(candidateWeekStart, { largestUnit: 'day' }).days / 7
      )
      const allowed =
        rule.byWeekday.length > 0
          ? rule.byWeekday.map((weekday) => weekdayNumber[weekday])
          : [base.dayOfWeek]
      return week >= 0 && week % rule.interval === 0 && allowed.includes(date.dayOfWeek)
    }
    case 'monthly': {
      const months = base
        .with({ day: 1 })
        .until(date.with({ day: 1 }), { largestUnit: 'month' }).months
      const monthDays = rule.byMonthDay.length > 0 ? rule.byMonthDay : [base.day]
      const matchesDay = monthDays.some((day) =>
        day > 0 ? date.day === day : date.day === date.daysInMonth + day + 1
      )
      return months > 0 && months % rule.interval === 0 && matchesDay
    }
    case 'yearly': {
      const years = date.year - base.year
      return (
        years > 0 &&
        years % rule.interval === 0 &&
        date.month === base.month &&
        date.day === base.day
      )
    }
  }
}

function nextRecurringReminder(reminder: ReminderEntity): ReminderEntity | null {
  const rule = reminder.recurrence
  if (!rule || reminder.dueAtUtc === null) return null
  if (rule.end.kind === 'count' && rule.end.count <= 1) return null

  const current = Temporal.Instant.from(reminder.dueAtUtc).toZonedDateTimeISO(reminder.timezone)
  const baseDate = current.toPlainDate()
  let candidate = baseDate.add({ days: 1 })
  for (let index = 0; index < 3_660; index += 1) {
    if (rule.end.kind === 'until' && Temporal.PlainDate.compare(candidate, rule.end.date) > 0) {
      return null
    }
    if (matchesNextDate(candidate, baseDate, rule)) {
      const nextDue = candidate
        .toZonedDateTime({ timeZone: reminder.timezone, plainTime: current.toPlainTime() })
        .toInstant()
        .toString({ fractionalSecondDigits: 3 })
      return reminderEntitySchema.parse({
        ...reminder,
        dueAtUtc: nextDue,
        recurrence:
          rule.end.kind === 'count'
            ? { ...rule, end: { kind: 'count', count: rule.end.count - 1 } }
            : rule,
        status: 'active',
        completedAt: null,
        importIdentity: reminder.importIdentity
          ? refreshReminderDocumentImportIdentity(reminder.importIdentity, {
              id: null,
              calendarId: reminder.calendarId,
              title: reminder.title,
              notes: reminder.notes,
              dueDate: candidate.toString(),
              dueTime: current.toPlainTime().toString({ smallestUnit: 'minute' }),
              timezone: reminder.timezone,
              recurrence:
                rule.end.kind === 'count'
                  ? { ...rule, end: { kind: 'count', count: rule.end.count - 1 } }
                  : rule
            })
          : null,
        updatedAt: new Date().toISOString()
      })
    }
    candidate = candidate.add({ days: 1 })
  }
  throw new Error('Recurring reminder exceeded the supported ten-year horizon')
}

function reminderDueAtUtc(form: ReminderForm): string | null {
  if (form.dueDate === null || form.dueTime === null) return null
  return toInstant(form.dueDate, form.dueTime, form.timezone)
}

export class PersistentCalendarService {
  constructor(private readonly repository: SqliteCalendarRepository) {}

  getSnapshot(inputRange: CalendarSnapshotRequest): CalendarSnapshot {
    const range = calendarSnapshotRequestSchema.parse(inputRange)
    const events = this.repository.listEvents()
    const exceptions = this.repository.listRecurrenceExceptions()
    return calendarSnapshotSchema.parse({
      calendars: this.repository.listCalendars(),
      events,
      occurrences: expandEventsInRange(events, range.rangeStartUtc, range.rangeEndUtc, exceptions),
      reminders: this.repository.listReminders(),
      preferences: this.repository.getPreferences(),
      canUndo: this.repository.canUndo(),
      generatedAt: new Date().toISOString()
    })
  }

  checkAvailability(inputRange: AvailabilityRequest): AvailabilityResult {
    const range = availabilityRequestSchema.parse(inputRange)
    const conflicts = findOccurrenceConflicts(
      this.repository.listEvents(),
      range.rangeStartUtc,
      range.rangeEndUtc,
      this.repository.listRecurrenceExceptions()
    ).filter((occurrence) => occurrence.eventId !== range.excludeEventId)
    return availabilityResultSchema.parse({
      free: conflicts.length === 0,
      conflicts,
      summary:
        conflicts.length === 0
          ? 'That time is free.'
          : `That time overlaps ${conflicts.length} event${conflicts.length === 1 ? '' : 's'}.`
    })
  }

  saveEvent(
    inputForm: EventForm,
    range: CalendarSnapshotRequest,
    options: {
      actor?: 'manual' | 'assistant' | 'import'
      operation?: 'event.create' | 'event.update' | 'event.move' | 'event.duplicate'
      assistantProposalId?: string
    } = {}
  ): CalendarMutationResult {
    const form = eventFormSchema.parse(inputForm)
    const existing = form.id ? this.repository.getEvent(form.id) : null
    if (form.id && !existing) throw new Error('The event no longer exists')
    const now = new Date().toISOString()
    const instants = eventInstants(form)
    const event = eventEntitySchema.parse({
      id: existing?.id ?? `event:${randomUUID()}`,
      calendarId: form.calendarId ?? existing?.calendarId ?? this.repository.listCalendars()[0]?.id,
      title: form.title,
      description: form.description,
      location: form.location,
      ...instants,
      timezone: form.timezone,
      allDay: form.allDay,
      recurrence: form.recurrence,
      status: 'active',
      provenance: existing?.provenance ?? options.actor ?? 'manual',
      importIdentity: existing?.importIdentity
        ? refreshEventDocumentImportIdentity(existing.importIdentity, form)
        : null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    })
    const operation = options.operation ?? (existing ? 'event.update' : 'event.create')
    const verb =
      operation === 'event.move'
        ? 'Moved'
        : operation === 'event.duplicate'
          ? 'Duplicated'
          : existing
            ? 'Updated'
            : 'Created'
    const receipt = this.repository.saveEvent(
      event,
      operation,
      `${verb} “${event.title}”.`,
      options.actor ?? 'manual',
      options.assistantProposalId ?? null
    )
    return calendarMutationResultSchema.parse({ snapshot: this.getSnapshot(range), receipt })
  }

  deleteEvent(
    id: string,
    range: CalendarSnapshotRequest,
    actor: 'manual' | 'assistant' | 'import' = 'manual',
    assistantProposalId: string | null = null
  ): CalendarMutationResult {
    const event = this.repository.getEvent(id)
    if (!event) throw new Error('The event no longer exists')
    const receipt = this.repository.deleteEvent(
      id,
      `Deleted “${event.title}”.`,
      actor,
      assistantProposalId
    )
    return calendarMutationResultSchema.parse({ snapshot: this.getSnapshot(range), receipt })
  }

  saveReminder(
    inputForm: ReminderForm,
    range: CalendarSnapshotRequest,
    options: {
      actor?: 'manual' | 'assistant' | 'import'
      operation?: 'reminder.create' | 'reminder.update'
      assistantProposalId?: string
    } = {}
  ): CalendarMutationResult {
    const form = reminderFormSchema.parse(inputForm)
    const existing = form.id ? this.repository.getReminder(form.id) : null
    if (form.id && !existing) throw new Error('The reminder no longer exists')
    const now = new Date().toISOString()
    const reminder = reminderEntitySchema.parse({
      id: existing?.id ?? `reminder:${randomUUID()}`,
      calendarId: form.calendarId ?? existing?.calendarId ?? this.repository.listCalendars()[0]?.id,
      title: form.title,
      notes: form.notes,
      dueAtUtc: reminderDueAtUtc(form),
      timezone: form.timezone,
      recurrence: form.recurrence,
      status: 'active',
      completedAt: null,
      provenance: existing?.provenance ?? options.actor ?? 'manual',
      importIdentity: existing?.importIdentity
        ? refreshReminderDocumentImportIdentity(existing.importIdentity, form)
        : null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    })
    const operation = options.operation ?? (existing ? 'reminder.update' : 'reminder.create')
    const receipt = this.repository.saveReminder(
      reminder,
      operation,
      `${existing ? 'Updated' : 'Created'} “${reminder.title}”.`,
      options.actor ?? 'manual',
      options.assistantProposalId ?? null
    )
    return calendarMutationResultSchema.parse({ snapshot: this.getSnapshot(range), receipt })
  }

  completeReminder(
    id: string,
    range: CalendarSnapshotRequest,
    actor: 'manual' | 'assistant' | 'import' = 'manual',
    assistantProposalId: string | null = null
  ): CalendarMutationResult {
    const reminder = this.repository.getReminder(id)
    if (!reminder) throw new Error('The reminder no longer exists')
    const next = nextRecurringReminder(reminder)
    const now = new Date().toISOString()
    const completed =
      next ??
      reminderEntitySchema.parse({
        ...reminder,
        status: 'completed',
        completedAt: now,
        updatedAt: now
      })
    const receipt = this.repository.saveReminder(
      completed,
      'reminder.complete',
      next
        ? `Completed “${reminder.title}” and scheduled its next occurrence.`
        : `Completed “${reminder.title}”.`,
      actor,
      assistantProposalId
    )
    return calendarMutationResultSchema.parse({ snapshot: this.getSnapshot(range), receipt })
  }

  deleteReminder(
    id: string,
    range: CalendarSnapshotRequest,
    actor: 'manual' | 'assistant' | 'import' = 'manual',
    assistantProposalId: string | null = null
  ): CalendarMutationResult {
    const reminder = this.repository.getReminder(id)
    if (!reminder) throw new Error('The reminder no longer exists')
    const receipt = this.repository.deleteReminder(
      id,
      `Deleted “${reminder.title}”.`,
      actor,
      assistantProposalId
    )
    return calendarMutationResultSchema.parse({ snapshot: this.getSnapshot(range), receipt })
  }

  deleteEntities(
    inputEventIds: readonly string[],
    inputReminderIds: readonly string[],
    summary: string,
    range: CalendarSnapshotRequest,
    actor: 'manual' | 'assistant' | 'import' = 'manual',
    assistantProposalId: string | null = null
  ): CalendarMutationResult {
    const eventIds = [...new Set(inputEventIds)]
    const reminderIds = [...new Set(inputReminderIds)]
    if (
      eventIds.length !== inputEventIds.length ||
      reminderIds.length !== inputReminderIds.length
    ) {
      throw new Error('A bulk delete cannot contain the same item twice')
    }
    if (eventIds.length === 0 && reminderIds.length === 0) {
      throw new Error('A bulk delete needs at least one calendar item')
    }
    for (const id of eventIds) {
      if (!this.repository.getEvent(id)) throw new Error('An event selected for deletion changed')
    }
    for (const id of reminderIds) {
      if (!this.repository.getReminder(id)) {
        throw new Error('A reminder selected for deletion changed')
      }
    }
    const receipt = this.repository.applyEntityBatch(
      { events: [], eventIdsToDelete: eventIds, reminders: [], reminderIdsToDelete: reminderIds },
      eventIds.length > 0 ? 'event.delete' : 'reminder.delete',
      'destructive',
      summary.trim().slice(0, 2_000),
      actor,
      assistantProposalId
    )
    return calendarMutationResultSchema.parse({ snapshot: this.getSnapshot(range), receipt })
  }

  applyBatch(
    inputItems: readonly CalendarBatchItem[],
    summary: string,
    range: CalendarSnapshotRequest,
    options: {
      actor?: 'manual' | 'assistant' | 'import'
      operation?: CalendarOperation
      risk?: RiskLevel
      assistantProposalId?: string
    } = {}
  ): CalendarMutationResult {
    if (inputItems.length === 0) throw new Error('A batch needs at least one calendar change')
    const items = inputItems.map((item) => structuredClone(item))
    const now = new Date().toISOString()
    const defaultCalendarId = this.repository.listCalendars()[0]?.id
    if (!defaultCalendarId) throw new Error('No local calendar is available')
    const events: EventEntity[] = []
    const eventIdsToDelete: string[] = []
    const reminders: ReminderEntity[] = []
    const reminderIdsToDelete: string[] = []
    const touched = new Set<string>()

    const markTouched = (key: string): void => {
      if (touched.has(key)) throw new Error('A batch cannot change the same item twice')
      touched.add(key)
    }

    for (const item of items) {
      switch (item.kind) {
        case 'event-save': {
          const form = eventFormSchema.parse(item.form)
          const existing = form.id ? this.repository.getEvent(form.id) : null
          if (form.id && !existing) throw new Error('An event in this batch no longer exists')
          if (form.id) markTouched(`event:${form.id}`)
          events.push(
            eventEntitySchema.parse({
              id: existing?.id ?? `event:${randomUUID()}`,
              calendarId: form.calendarId ?? existing?.calendarId ?? defaultCalendarId,
              title: form.title,
              description: form.description,
              location: form.location,
              ...eventInstants(form),
              timezone: form.timezone,
              allDay: form.allDay,
              recurrence: form.recurrence,
              status: 'active',
              provenance: existing?.provenance ?? options.actor ?? 'manual',
              importIdentity: existing?.importIdentity
                ? refreshEventDocumentImportIdentity(existing.importIdentity, form)
                : null,
              createdAt: existing?.createdAt ?? now,
              updatedAt: now
            })
          )
          break
        }
        case 'event-delete': {
          if (!this.repository.getEvent(item.id)) {
            throw new Error('An event in this batch no longer exists')
          }
          markTouched(`event:${item.id}`)
          eventIdsToDelete.push(item.id)
          break
        }
        case 'reminder-save': {
          const form = reminderFormSchema.parse(item.form)
          const existing = form.id ? this.repository.getReminder(form.id) : null
          if (form.id && !existing) throw new Error('A reminder in this batch no longer exists')
          if (form.id) markTouched(`reminder:${form.id}`)
          reminders.push(
            reminderEntitySchema.parse({
              id: existing?.id ?? `reminder:${randomUUID()}`,
              calendarId: form.calendarId ?? existing?.calendarId ?? defaultCalendarId,
              title: form.title,
              notes: form.notes,
              dueAtUtc: reminderDueAtUtc(form),
              timezone: form.timezone,
              recurrence: form.recurrence,
              status: 'active',
              completedAt: null,
              provenance: existing?.provenance ?? options.actor ?? 'manual',
              importIdentity: existing?.importIdentity
                ? refreshReminderDocumentImportIdentity(existing.importIdentity, form)
                : null,
              createdAt: existing?.createdAt ?? now,
              updatedAt: now
            })
          )
          break
        }
        case 'reminder-complete': {
          const existing = this.repository.getReminder(item.id)
          if (!existing) throw new Error('A reminder in this batch no longer exists')
          markTouched(`reminder:${item.id}`)
          const next = nextRecurringReminder(existing)
          reminders.push(
            reminderEntitySchema.parse(
              next ?? {
                ...existing,
                status: 'completed',
                completedAt: now,
                updatedAt: now
              }
            )
          )
          break
        }
        case 'reminder-delete': {
          if (!this.repository.getReminder(item.id)) {
            throw new Error('A reminder in this batch no longer exists')
          }
          markTouched(`reminder:${item.id}`)
          reminderIdsToDelete.push(item.id)
          break
        }
      }
    }

    const receipt = this.repository.applyEntityBatch(
      { events, eventIdsToDelete, reminders, reminderIdsToDelete },
      options.operation ?? 'event.duplicate',
      options.risk ??
        (eventIdsToDelete.length || reminderIdsToDelete.length ? 'destructive' : 'low'),
      summary.trim().slice(0, 2_000),
      options.actor ?? 'manual',
      options.assistantProposalId ?? null
    )
    return calendarMutationResultSchema.parse({ snapshot: this.getSnapshot(range), receipt })
  }

  undoLastAction(range: CalendarSnapshotRequest): CalendarMutationResult {
    const receipt = this.repository.undoLast(new Date().toISOString())
    return calendarMutationResultSchema.parse({ snapshot: this.getSnapshot(range), receipt })
  }

  updatePreferences(update: PreferencesUpdate): PreferencesEntity {
    const current = this.repository.getPreferences()
    const definedUpdate = Object.fromEntries(
      Object.entries(update).filter((entry) => entry[1] !== undefined)
    )
    return this.repository.updatePreferences(
      preferencesEntitySchema.parse({
        ...current,
        ...definedUpdate,
        id: 'local',
        updatedAt: new Date().toISOString()
      })
    )
  }

  createBackup(): CalendarBackup {
    return calendarBackupSchema.parse({
      format: 'remind-me-backup',
      formatVersion: 1,
      contractVersion: '0.1',
      exportedAt: new Date().toISOString(),
      calendars: this.repository.listCalendars(),
      events: this.repository.listEvents(),
      reminders: this.repository.listReminders(),
      recurrenceExceptions: this.repository.listRecurrenceExceptions(),
      preferences: this.repository.getPreferences()
    })
  }

  deleteAllData(range: CalendarSnapshotRequest, recoveryCopiesDeleted = 0): DataDeleteAllResult {
    const requestRange = calendarSnapshotRequestSchema.parse(range)
    const deleted = this.repository.deleteAllData()
    return dataDeleteAllResultSchema.parse({
      ...deleted,
      recoveryCopiesDeleted,
      snapshot: this.getSnapshot(requestRange)
    })
  }

  importBackup(
    backupInput: CalendarBackup,
    range: CalendarSnapshotRequest
  ): CalendarMutationResult {
    const backup = calendarBackupSchema.parse(backupInput)
    const now = new Date().toISOString()
    const defaultCalendar = this.repository.listCalendars()[0]
    if (!defaultCalendar) throw new Error('No local calendar is available')
    const eventIdMap = new Map<string, string>()
    const events = backup.events.map((event) => {
      const id = `event:${randomUUID()}`
      eventIdMap.set(event.id, id)
      return eventEntitySchema.parse({
        ...event,
        id,
        calendarId: defaultCalendar.id,
        provenance: 'import',
        createdAt: now,
        updatedAt: now
      })
    })
    const reminders = backup.reminders.map((reminder) =>
      reminderEntitySchema.parse({
        ...reminder,
        id: `reminder:${randomUUID()}`,
        calendarId: defaultCalendar.id,
        provenance: 'import',
        createdAt: now,
        updatedAt: now
      })
    )
    const recurrenceExceptions = backup.recurrenceExceptions.flatMap(
      (exception): RecurrenceExceptionEntity[] => {
        const parentEventId = eventIdMap.get(exception.parentEventId)
        if (!parentEventId) return []
        const replacementEventId = exception.replacementEventId
          ? (eventIdMap.get(exception.replacementEventId) ?? null)
          : null
        return [
          recurrenceExceptionEntitySchema.parse({
            ...exception,
            id: `exception:${randomUUID()}`,
            parentEventId,
            replacementEventId,
            createdAt: now
          })
        ]
      }
    )
    const importedPreferences = preferencesEntitySchema.parse({
      ...backup.preferences,
      id: 'local',
      updatedAt: now
    })
    const receipt = this.repository.importEntities(
      events,
      reminders,
      `Imported ${events.length} event(s) and ${reminders.length} reminder(s).`,
      recurrenceExceptions,
      importedPreferences
    )
    return calendarMutationResultSchema.parse({ snapshot: this.getSnapshot(range), receipt })
  }

  importEntities(
    inputEvents: CalendarBackup['events'],
    inputReminders: CalendarBackup['reminders'],
    range: CalendarSnapshotRequest
  ): CalendarMutationResult {
    const now = new Date().toISOString()
    const defaultCalendar = this.repository.listCalendars()[0]
    if (!defaultCalendar) throw new Error('No local calendar is available')
    const events = inputEvents.map((event) =>
      eventEntitySchema.parse({
        ...event,
        id: `event:${randomUUID()}`,
        calendarId: defaultCalendar.id,
        provenance: 'import',
        createdAt: now,
        updatedAt: now
      })
    )
    const reminders = inputReminders.map((reminder) =>
      reminderEntitySchema.parse({
        ...reminder,
        id: `reminder:${randomUUID()}`,
        calendarId: defaultCalendar.id,
        provenance: 'import',
        createdAt: now,
        updatedAt: now
      })
    )
    const receipt = this.repository.importEntities(
      events,
      reminders,
      `Imported ${events.length} event(s) and ${reminders.length} reminder(s).`
    )
    return calendarMutationResultSchema.parse({ snapshot: this.getSnapshot(range), receipt })
  }

  importReviewedDocumentItems(
    inputItems: readonly ReviewedDocumentItem[],
    sourceDisplayName: string,
    range: CalendarSnapshotRequest
  ): CalendarMutationResult {
    const items = inputItems.map((item) => reviewedDocumentItemSchema.parse(item))
    if (items.length === 0) throw new Error('Select at least one proposed item to import')
    const now = new Date().toISOString()
    const defaultCalendar = this.repository.listCalendars()[0]
    if (!defaultCalendar) throw new Error('No local calendar is available')
    const sourceRowKey = (sourceSha256: string, sourceRowId: string): string =>
      `${sourceSha256}:${sourceRowId}`
    const reviewedSourceRows = new Set(
      items.map((item) =>
        sourceRowKey(item.sourceIdentity.sourceSha256, item.sourceIdentity.sourceRowId)
      )
    )
    if (reviewedSourceRows.size !== items.length) {
      throw new Error('A reviewed document batch cannot contain the same source row twice')
    }
    const importedSourceRows = new Set(
      [...this.repository.listEvents(), ...this.repository.listReminders()].flatMap((entity) =>
        entity.importIdentity
          ? [sourceRowKey(entity.importIdentity.sourceSha256, entity.importIdentity.sourceRowId)]
          : []
      )
    )
    const events: EventEntity[] = []
    const reminders: ReminderEntity[] = []
    let duplicateCount = 0
    for (const item of items) {
      const sourceKey = sourceRowKey(
        item.sourceIdentity.sourceSha256,
        item.sourceIdentity.sourceRowId
      )
      if (importedSourceRows.has(sourceKey)) {
        duplicateCount += 1
        continue
      }
      importedSourceRows.add(sourceKey)
      if (item.kind === 'event') {
        const form = eventFormSchema.parse(item.form)
        events.push(
          eventEntitySchema.parse({
            id: `event:${randomUUID()}`,
            calendarId: defaultCalendar.id,
            title: form.title,
            description: form.description,
            location: form.location,
            ...eventInstants(form),
            timezone: form.timezone,
            allDay: form.allDay,
            recurrence: form.recurrence,
            status: 'active',
            provenance: 'import',
            importIdentity: createEventDocumentImportIdentity(
              item.sourceIdentity,
              form,
              item.schedule
            ),
            createdAt: now,
            updatedAt: now
          })
        )
      } else {
        const form = reminderFormSchema.parse(item.form)
        reminders.push(
          reminderEntitySchema.parse({
            id: `reminder:${randomUUID()}`,
            calendarId: defaultCalendar.id,
            title: form.title,
            notes: form.notes,
            dueAtUtc: reminderDueAtUtc(form),
            timezone: form.timezone,
            recurrence: form.recurrence,
            status: 'active',
            completedAt: null,
            provenance: 'import',
            importIdentity: createReminderDocumentImportIdentity(item.sourceIdentity, form),
            createdAt: now,
            updatedAt: now
          })
        )
      }
    }
    if (events.length === 0 && reminders.length === 0) {
      throw new Error('Every selected source row was imported already.')
    }
    const safeDisplayName = sourceDisplayName.trim().slice(0, 500) || 'document'
    const receipt = this.repository.importEntities(
      events,
      reminders,
      `Imported ${events.length} event(s) and ${reminders.length} reminder(s) from “${safeDisplayName}”${duplicateCount > 0 ? `; skipped ${duplicateCount} source row(s) imported earlier` : ''}.`
    )
    return calendarMutationResultSchema.parse({ snapshot: this.getSnapshot(range), receipt })
  }
}
