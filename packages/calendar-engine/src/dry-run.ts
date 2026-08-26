import {
  calendarIRResolvedSchema,
  eventEntitySchema,
  reminderEntitySchema,
  type CalendarIRResolved,
  type EventEntity,
  type ReminderEntity
} from '@remind-me/contracts'
import {
  calendarStateSchema,
  dryRunResultSchema,
  resolverContextSchema,
  type CalendarState,
  type DryRunResult,
  type ResolverContext
} from './types'

function cloneState(state: CalendarState): CalendarState {
  return structuredClone(state)
}

function selectedEventIds(command: CalendarIRResolved): Set<string> {
  return new Set(command.selection?.eventIds ?? [])
}

function selectedReminderIds(command: CalendarIRResolved): Set<string> {
  return new Set(command.selection?.reminderIds ?? [])
}

function overlaps(startA: string, endA: string, startB: string, endB: string): boolean {
  return Date.parse(startA) < Date.parse(endB) && Date.parse(startB) < Date.parse(endA)
}

function requireValue<T>(value: T | null, field: string): T {
  if (value === null) throw new Error(`Resolved command is missing ${field}`)
  return value
}

function updateEvents(
  events: EventEntity[],
  command: CalendarIRResolved
): { events: EventEntity[]; affectedIds: string[] } {
  const selected = selectedEventIds(command)
  const affectedIds: string[] = []
  const updated = events.map((event) => {
    if (!selected.has(event.id)) return event
    affectedIds.push(event.id)
    return eventEntitySchema.parse({
      ...event,
      title: command.fields.title ?? event.title,
      description: command.fields.description ?? event.description,
      location: command.fields.location ?? event.location,
      startUtc: command.fields.startUtc ?? event.startUtc,
      endUtc: command.fields.endUtc ?? event.endUtc,
      timezone: command.fields.timezone ?? event.timezone,
      allDay: command.fields.allDay ?? event.allDay,
      recurrence: command.recurrence ?? event.recurrence,
      status: command.fields.status === 'cancelled' ? 'cancelled' : event.status,
      updatedAt: command.resolvedAt
    })
  })
  return { events: updated, affectedIds }
}

function updateReminders(
  reminders: ReminderEntity[],
  command: CalendarIRResolved
): { reminders: ReminderEntity[]; affectedIds: string[] } {
  const selected = selectedReminderIds(command)
  const affectedIds: string[] = []
  const updated = reminders.map((reminder) => {
    if (!selected.has(reminder.id)) return reminder
    affectedIds.push(reminder.id)
    const completed =
      command.operation === 'reminder.complete' || command.fields.status === 'completed'
    return reminderEntitySchema.parse({
      ...reminder,
      title: command.fields.title ?? reminder.title,
      notes: command.fields.description ?? reminder.notes,
      dueAtUtc: command.fields.dueAtUtc ?? reminder.dueAtUtc,
      timezone: command.fields.timezone ?? reminder.timezone,
      recurrence: command.recurrence ?? reminder.recurrence,
      status: completed
        ? 'completed'
        : command.fields.status === 'cancelled'
          ? 'cancelled'
          : reminder.status,
      completedAt: completed ? command.resolvedAt : reminder.completedAt,
      updatedAt: command.resolvedAt
    })
  })
  return { reminders: updated, affectedIds }
}

export function dryRunCalendarCommand(
  inputCommand: CalendarIRResolved,
  inputState: CalendarState,
  inputContext: ResolverContext
): DryRunResult {
  const command = calendarIRResolvedSchema.parse(inputCommand)
  const context = resolverContextSchema.parse(inputContext)
  const state = cloneState(calendarStateSchema.parse(inputState))
  let mutationCount = 0
  let affectedIds: string[] = []
  let summary = 'No calendar changes proposed.'

  switch (command.operation) {
    case 'event.create': {
      const id = `event:${command.requestId}`
      const event = eventEntitySchema.parse({
        id,
        calendarId: context.defaultCalendarId,
        title: requireValue(command.fields.title, 'title'),
        description: command.fields.description ?? '',
        location: command.fields.location ?? '',
        startUtc: requireValue(command.fields.startUtc, 'startUtc'),
        endUtc: requireValue(command.fields.endUtc, 'endUtc'),
        timezone: requireValue(command.fields.timezone, 'timezone'),
        allDay: command.fields.allDay ?? false,
        recurrence: command.recurrence,
        status: 'active',
        provenance: 'assistant',
        createdAt: command.resolvedAt,
        updatedAt: command.resolvedAt
      })
      state.events.push(event)
      mutationCount = 1
      affectedIds = [id]
      summary = `Create event “${event.title}”.`
      break
    }
    case 'event.duplicate': {
      const sourceId = command.selection?.eventIds[0]
      const source = sourceId ? state.events.find((event) => event.id === sourceId) : null
      if (!source) throw new Error('The event to duplicate is unavailable')
      const id = `event:${command.requestId}`
      const event = eventEntitySchema.parse({
        ...source,
        id,
        startUtc: command.fields.startUtc ?? source.startUtc,
        endUtc: command.fields.endUtc ?? source.endUtc,
        timezone: command.fields.timezone ?? source.timezone,
        allDay: command.fields.allDay ?? source.allDay,
        recurrence: command.recurrence,
        provenance: 'assistant',
        createdAt: command.resolvedAt,
        updatedAt: command.resolvedAt
      })
      state.events.push(event)
      mutationCount = 1
      affectedIds = [id]
      summary = `Duplicate event “${event.title}”.`
      break
    }
    case 'event.update':
    case 'event.move': {
      const result = updateEvents(state.events, command)
      state.events = result.events
      affectedIds = result.affectedIds
      mutationCount = affectedIds.length
      summary = `${command.operation === 'event.move' ? 'Move' : 'Update'} ${mutationCount} event(s).`
      break
    }
    case 'event.delete': {
      const selected = selectedEventIds(command)
      const retained = state.events.filter((event) => !selected.has(event.id))
      mutationCount = state.events.length - retained.length
      affectedIds = state.events.filter((event) => selected.has(event.id)).map((event) => event.id)
      state.events = retained
      summary = `Delete ${mutationCount} event(s) with ${command.scope} scope.`
      break
    }
    case 'reminder.create': {
      const id = `reminder:${command.requestId}`
      const reminder = reminderEntitySchema.parse({
        id,
        calendarId: context.defaultCalendarId,
        title: requireValue(command.fields.title, 'title'),
        notes: command.fields.description ?? '',
        dueAtUtc: requireValue(command.fields.dueAtUtc, 'dueAtUtc'),
        timezone: requireValue(command.fields.timezone, 'timezone'),
        recurrence: command.recurrence,
        status: 'active',
        completedAt: null,
        provenance: 'assistant',
        createdAt: command.resolvedAt,
        updatedAt: command.resolvedAt
      })
      state.reminders.push(reminder)
      mutationCount = 1
      affectedIds = [id]
      summary = `Create reminder “${reminder.title}”.`
      break
    }
    case 'reminder.update':
    case 'reminder.complete': {
      const result = updateReminders(state.reminders, command)
      state.reminders = result.reminders
      affectedIds = result.affectedIds
      mutationCount = affectedIds.length
      summary = `${command.operation === 'reminder.complete' ? 'Complete' : 'Update'} ${mutationCount} reminder(s).`
      break
    }
    case 'reminder.delete': {
      const selected = selectedReminderIds(command)
      const retained = state.reminders.filter((reminder) => !selected.has(reminder.id))
      mutationCount = state.reminders.length - retained.length
      affectedIds = state.reminders
        .filter((reminder) => selected.has(reminder.id))
        .map((reminder) => reminder.id)
      state.reminders = retained
      summary = `Delete ${mutationCount} reminder(s) with ${command.scope} scope.`
      break
    }
    case 'calendar.availability': {
      const rangeStart = requireValue(command.fields.rangeStartUtc, 'rangeStartUtc')
      const rangeEnd = requireValue(command.fields.rangeEndUtc, 'rangeEndUtc')
      const conflicts = state.events.filter(
        (event) =>
          event.status === 'active' && overlaps(event.startUtc, event.endUtc, rangeStart, rangeEnd)
      )
      affectedIds = conflicts.map((event) => event.id)
      summary =
        conflicts.length === 0
          ? 'The requested time is free.'
          : `Busy with ${conflicts.length} event(s).`
      break
    }
    case 'calendar.conflicts': {
      const rangeStart = command.fields.rangeStartUtc
      const rangeEnd = command.fields.rangeEndUtc
      const conflicts =
        rangeStart && rangeEnd
          ? state.events.filter((event) =>
              overlaps(event.startUtc, event.endUtc, rangeStart, rangeEnd)
            )
          : []
      affectedIds = conflicts.map((event) => event.id)
      summary = `Found ${conflicts.length} possible conflict(s).`
      break
    }
    case 'calendar.list':
      affectedIds = state.events.map((event) => event.id)
      summary = `Listed ${state.events.length} event(s).`
      break
    case 'calendar.search': {
      const query = command.selection?.query?.value.toLocaleLowerCase() ?? ''
      const matches = state.events.filter((event) =>
        event.title.toLocaleLowerCase().includes(query)
      )
      affectedIds = matches.map((event) => event.id)
      summary = `Found ${matches.length} matching event(s).`
      break
    }
    case 'assistant.clarify':
      summary = 'Clarification required before continuing.'
      break
    case 'assistant.reject':
      summary = 'Request rejected by the safety policy.'
      break
    case 'assistant.unsupported':
      summary = 'Request is outside the supported calendar domain.'
      break
    case 'import.propose':
      summary = 'Import proposal staged for review.'
      break
  }

  return dryRunResultSchema.parse({
    accepted: true,
    state,
    mutationCount,
    affectedIds,
    summary,
    requiresConfirmation: command.requiresConfirmation
  })
}
