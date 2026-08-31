import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Temporal } from '@js-temporal/polyfill'
import type {
  CalendarBatchItem,
  CalendarSnapshot,
  EventEntity,
  EventForm,
  RecurrenceRule,
  ReminderEntity,
  ReminderForm,
  Weekday
} from '@remind-me/contracts'
import { eventToForm, reminderToForm, todayDate } from '../calendar-utils'
import { useCalendarStore } from '../store/calendar-store'

export type EditorRequest =
  | {
      kind: 'event'
      event: EventEntity | null
      date: string | null
      title: string | null
      draft?: EventForm
    }
  | {
      kind: 'reminder'
      reminder: ReminderEntity | null
      date: string | null
      title: string | null
      draft?: ReminderForm
    }

const weekdays: readonly Weekday[] = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday'
]

const frequencyUnits: Record<RecurrenceRule['frequency'], string> = {
  daily: 'day',
  weekly: 'week',
  monthly: 'month',
  yearly: 'year'
}

const weekdayLabels: Record<Weekday, string> = {
  sunday: 'Sun',
  monday: 'Mon',
  tuesday: 'Tue',
  wednesday: 'Wed',
  thursday: 'Thu',
  friday: 'Fri',
  saturday: 'Sat'
}

function weekdayFor(date: string): Weekday {
  return weekdays[new Date(`${date}T12:00:00.000Z`).getUTCDay()] ?? 'monday'
}

function defaultRecurrence(frequency: RecurrenceRule['frequency'], date: string): RecurrenceRule {
  return {
    frequency,
    interval: 1,
    byWeekday: frequency === 'weekly' ? [weekdayFor(date)] : [],
    byMonthDay: frequency === 'monthly' ? [Number(date.slice(-2))] : [],
    end: { kind: 'never' }
  }
}

function RecurrenceFields({
  recurrence,
  date,
  onChange
}: {
  recurrence: RecurrenceRule | null
  date: string
  onChange: (recurrence: RecurrenceRule | null) => void
}): ReactNode {
  const endKind = recurrence?.end.kind ?? 'never'
  return (
    <fieldset className="recurrence-fields">
      <legend>Repeat</legend>
      <div className="form-grid recurrence-grid">
        <label>
          Pattern
          <select
            value={recurrence?.frequency ?? 'none'}
            onChange={(event) => {
              const frequency = event.target.value
              onChange(
                frequency === 'none'
                  ? null
                  : defaultRecurrence(frequency as RecurrenceRule['frequency'], date)
              )
            }}
          >
            <option value="none">Does not repeat</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
            <option value="yearly">Yearly</option>
          </select>
        </label>
        {recurrence ? (
          <>
            <label>
              Every
              <span className="inline-field">
                <input
                  type="number"
                  min="1"
                  max="365"
                  value={recurrence.interval}
                  onChange={(event) =>
                    onChange({ ...recurrence, interval: Number(event.target.value) || 1 })
                  }
                />
                <span>{frequencyUnits[recurrence.frequency]}(s)</span>
              </span>
            </label>
            {recurrence.frequency === 'weekly' ? (
              <div className="full-field recurrence-weekday-field">
                <span className="field-label">Repeat on</span>
                <div className="weekday-picker" aria-label="Weekdays for this repeat">
                  {weekdays.map((weekday) => {
                    const selected = recurrence.byWeekday.includes(weekday)
                    return (
                      <button
                        className="weekday-toggle"
                        data-selected={selected}
                        type="button"
                        key={weekday}
                        aria-pressed={selected}
                        onClick={() => {
                          const byWeekday = selected
                            ? recurrence.byWeekday.filter((candidate) => candidate !== weekday)
                            : [...recurrence.byWeekday, weekday].sort(
                                (left, right) => weekdays.indexOf(left) - weekdays.indexOf(right)
                              )
                          if (byWeekday.length > 0) onChange({ ...recurrence, byWeekday })
                        }}
                      >
                        {weekdayLabels[weekday]}
                      </button>
                    )
                  })}
                </div>
                <div className="recurrence-presets">
                  <button
                    type="button"
                    className="text-button"
                    onClick={() =>
                      onChange({
                        ...recurrence,
                        byWeekday: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday']
                      })
                    }
                  >
                    Weekdays
                  </button>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => onChange({ ...recurrence, byWeekday: ['sunday', 'saturday'] })}
                  >
                    Weekends
                  </button>
                </div>
                <small>Only these days repeat; the first matching day is used automatically.</small>
              </div>
            ) : null}
            {recurrence.frequency === 'monthly' ? (
              <label>
                Day of month
                <input
                  type="number"
                  min="1"
                  max="31"
                  value={recurrence.byMonthDay[0] ?? Number(date.slice(-2))}
                  onChange={(event) =>
                    onChange({
                      ...recurrence,
                      byMonthDay: [Math.min(31, Math.max(1, Number(event.target.value) || 1))]
                    })
                  }
                />
              </label>
            ) : null}
            <label>
              Ends
              <select
                value={endKind}
                onChange={(event) => {
                  const kind = event.target.value
                  onChange({
                    ...recurrence,
                    end:
                      kind === 'count'
                        ? { kind: 'count', count: 10 }
                        : kind === 'until'
                          ? { kind: 'until', date }
                          : { kind: 'never' }
                  })
                }}
              >
                <option value="never">Never</option>
                <option value="until">On a date</option>
                <option value="count">After a count</option>
              </select>
            </label>
            {recurrence.end.kind === 'until' ? (
              <label>
                Last date
                <input
                  type="date"
                  min={date}
                  value={recurrence.end.date}
                  onChange={(event) =>
                    onChange({ ...recurrence, end: { kind: 'until', date: event.target.value } })
                  }
                />
              </label>
            ) : null}
            {recurrence.end.kind === 'count' ? (
              <label>
                Occurrences
                <input
                  type="number"
                  min="1"
                  max="10000"
                  value={recurrence.end.count}
                  onChange={(event) =>
                    onChange({
                      ...recurrence,
                      end: { kind: 'count', count: Number(event.target.value) || 1 }
                    })
                  }
                />
              </label>
            ) : null}
          </>
        ) : null}
      </div>
    </fieldset>
  )
}

function DialogFrame({
  title,
  eyebrow,
  onClose,
  children
}: {
  title: string
  eyebrow: string
  onClose: () => void
  children: ReactNode
}): ReactNode {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section
        className="editor-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="editor-title"
      >
        <header className="dialog-header">
          <div>
            <p className="eyebrow">{eyebrow}</p>
            <h2 id="editor-title">{title}</h2>
          </div>
          <button className="icon-button" type="button" aria-label="Close editor" onClick={onClose}>
            ×
          </button>
        </header>
        {children}
      </section>
    </div>
  )
}

export function RepeatDayScheduleDialog({
  date,
  snapshot,
  onClose
}: {
  date: string
  snapshot: CalendarSnapshot
  onClose: () => void
}): ReactNode {
  const applyBatch = useCalendarStore((state) => state.applyBatch)
  const busy = useCalendarStore((state) => state.busy)
  const sourceOccurrences = snapshot.occurrences.filter(
    (occurrence, index, occurrences) =>
      occurrence.originalDate === date &&
      occurrences.findIndex(
        (candidate) => candidate.originalDate === date && candidate.eventId === occurrence.eventId
      ) === index
  )
  const [selectedEventIds, setSelectedEventIds] = useState<string[]>(() =>
    sourceOccurrences.map((occurrence) => occurrence.eventId)
  )
  const [selectedWeekdays, setSelectedWeekdays] = useState<Weekday[]>([weekdayFor(date)])
  const [endDate, setEndDate] = useState(() =>
    Temporal.PlainDate.from(date).add({ weeks: 8 }).toString()
  )
  const beginsAfter = Temporal.PlainDate.from(date).add({ days: 1 })
  const dateLabel = new Intl.DateTimeFormat(snapshot.preferences.locale, {
    timeZone: 'UTC',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric'
  }).format(new Date(`${date}T12:00:00.000Z`))

  async function repeatSchedule(submitEvent: FormEvent): Promise<void> {
    submitEvent.preventDefault()
    const items = sourceOccurrences.flatMap((occurrence): CalendarBatchItem[] => {
      if (!selectedEventIds.includes(occurrence.eventId)) return []
      const source = snapshot.events.find((event) => event.id === occurrence.eventId)
      if (!source) return []
      const sourceForm = eventToForm(source)
      const spanDays = Temporal.PlainDate.from(sourceForm.startDate).until(
        Temporal.PlainDate.from(sourceForm.endDate),
        { largestUnit: 'day' }
      ).days
      return [
        {
          kind: 'event-save',
          form: {
            ...sourceForm,
            id: null,
            startDate: beginsAfter.toString(),
            endDate: beginsAfter.add({ days: spanDays }).toString(),
            recurrence: {
              frequency: 'weekly',
              interval: 1,
              byWeekday: selectedWeekdays,
              byMonthDay: [],
              end: { kind: 'until', date: endDate }
            }
          }
        }
      ]
    })
    if (items.length === 0 || selectedWeekdays.length === 0) return
    const saved = await applyBatch(
      items,
      `Repeated ${items.length} event${items.length === 1 ? '' : 's'} from ${date} on ${selectedWeekdays.map((weekday) => weekdayLabels[weekday]).join(', ')} through ${endDate}.`
    )
    if (saved) onClose()
  }

  return (
    <DialogFrame eyebrow="Repeat a day" title={`Reuse ${dateLabel}'s rhythm`} onClose={onClose}>
      <form
        className="editor-form repeat-day-form"
        onSubmit={(event) => void repeatSchedule(event)}
      >
        <p className="muted-copy repeat-day-intro">
          Choose which events to copy and the weekdays they should recur. Copies begin after the
          source day, so the plans already on {dateLabel} are never duplicated.
        </p>
        <fieldset className="repeat-source-events">
          <legend>Events to repeat</legend>
          {sourceOccurrences.length ? (
            sourceOccurrences.map((occurrence) => {
              const event = snapshot.events.find((candidate) => candidate.id === occurrence.eventId)
              if (!event) return null
              return (
                <label className="repeat-source-row" key={occurrence.eventId}>
                  <input
                    type="checkbox"
                    checked={selectedEventIds.includes(occurrence.eventId)}
                    onChange={(input) =>
                      setSelectedEventIds((current) =>
                        input.target.checked
                          ? [...current, occurrence.eventId]
                          : current.filter((id) => id !== occurrence.eventId)
                      )
                    }
                  />
                  <span>
                    <strong>{occurrence.title}</strong>
                    <small>
                      {occurrence.allDay
                        ? 'All day'
                        : new Intl.DateTimeFormat(snapshot.preferences.locale, {
                            timeZone: occurrence.timezone,
                            hour: 'numeric',
                            minute: '2-digit'
                          }).format(new Date(occurrence.startUtc))}
                      {event.recurrence ? ' · source already repeats' : ''}
                    </small>
                  </span>
                </label>
              )
            })
          ) : (
            <p className="muted-copy">There are no events on this day to repeat.</p>
          )}
        </fieldset>
        <fieldset className="recurrence-fields repeat-target-days">
          <legend>Copy this schedule to</legend>
          <div className="weekday-picker" aria-label="Target weekdays">
            {weekdays.map((weekday) => {
              const selected = selectedWeekdays.includes(weekday)
              return (
                <button
                  className="weekday-toggle"
                  data-selected={selected}
                  type="button"
                  key={weekday}
                  aria-pressed={selected}
                  onClick={() =>
                    setSelectedWeekdays((current) =>
                      selected
                        ? current.filter((candidate) => candidate !== weekday)
                        : [...current, weekday].sort(
                            (left, right) => weekdays.indexOf(left) - weekdays.indexOf(right)
                          )
                    )
                  }
                >
                  {weekdayLabels[weekday]}
                </button>
              )
            })}
          </div>
          <label className="repeat-until-field">
            Repeat through
            <input
              required
              type="date"
              min={beginsAfter.toString()}
              value={endDate}
              onChange={(event) => setEndDate(event.target.value)}
            />
          </label>
        </fieldset>
        <footer className="dialog-actions">
          <span className="selection-summary">
            {selectedEventIds.length} event{selectedEventIds.length === 1 ? '' : 's'} ·{' '}
            {selectedWeekdays.length} day{selectedWeekdays.length === 1 ? '' : 's'} selected
          </span>
          <div>
            <button className="secondary-button" type="button" onClick={onClose}>
              Cancel
            </button>
            <button
              className="retro-button"
              type="submit"
              disabled={
                busy ||
                sourceOccurrences.length === 0 ||
                selectedEventIds.length === 0 ||
                selectedWeekdays.length === 0
              }
            >
              {busy ? 'Repeating…' : 'Create repeating copies'}
            </button>
          </div>
        </footer>
      </form>
    </DialogFrame>
  )
}

function wallInstant(date: string, time: string, timezone: string): string {
  return Temporal.PlainDate.from(date)
    .toZonedDateTime({ timeZone: timezone, plainTime: Temporal.PlainTime.from(time) })
    .toInstant()
    .toString({ fractionalSecondDigits: 3 })
}

function EventEditor({
  event,
  date,
  title,
  draft,
  onClose
}: {
  event: EventEntity | null
  date: string | null
  title: string | null
  draft: EventForm | undefined
  onClose: () => void
}): ReactNode {
  const snapshot = useCalendarStore((state) => state.snapshot)
  const saveEvent = useCalendarStore((state) => state.saveEvent)
  const deleteEvent = useCalendarStore((state) => state.deleteEvent)
  const busy = useCalendarStore((state) => state.busy)
  const fallbackDate = date ?? todayDate(snapshot?.preferences.timezone ?? 'UTC')
  const [form, setForm] = useState<EventForm>(() =>
    draft
      ? structuredClone(draft)
      : event
        ? eventToForm(event)
        : {
            id: null,
            calendarId: snapshot?.calendars[0]?.id ?? null,
            title: title ?? '',
            description: '',
            location: '',
            startDate: fallbackDate,
            startTime: '09:00',
            endDate: fallbackDate,
            endTime: '10:00',
            timezone: snapshot?.preferences.timezone ?? 'UTC',
            allDay: false,
            recurrence: null
          }
  )
  const [duplicating, setDuplicating] = useState(false)
  const [availability, setAvailability] = useState<{
    free: boolean
    summary: string
  } | null>(null)
  const [checking, setChecking] = useState(false)

  async function submit(submitEvent: FormEvent): Promise<void> {
    submitEvent.preventDefault()
    if (await saveEvent(form)) onClose()
  }

  async function checkTime(): Promise<void> {
    setChecking(true)
    try {
      const rangeStartUtc = wallInstant(
        form.startDate,
        form.allDay ? '00:00' : (form.startTime ?? '00:00'),
        form.timezone
      )
      const rangeEndUtc = form.allDay
        ? wallInstant(
            Temporal.PlainDate.from(form.endDate).add({ days: 1 }).toString(),
            '00:00',
            form.timezone
          )
        : wallInstant(form.endDate, form.endTime ?? '00:00', form.timezone)
      const result = await window.remindMe.checkAvailability({
        rangeStartUtc,
        rangeEndUtc,
        excludeEventId: form.id
      })
      setAvailability({ free: result.free, summary: result.summary })
    } catch (error) {
      setAvailability({
        free: false,
        summary: error instanceof Error ? error.message : 'Could not check this time.'
      })
    } finally {
      setChecking(false)
    }
  }

  return (
    <DialogFrame
      eyebrow={duplicating ? 'Duplicate event' : event ? 'Edit event' : 'New event'}
      title={
        duplicating
          ? `Copy of ${event?.title ?? form.title}`
          : event
            ? event.title
            : 'Make room for something'
      }
      onClose={onClose}
    >
      <form className="editor-form" onSubmit={(submitEvent) => void submit(submitEvent)}>
        <label className="full-field">
          Title
          <input
            autoFocus
            required
            maxLength={1000}
            value={form.title}
            onChange={(inputEvent) => setForm({ ...form, title: inputEvent.target.value })}
            placeholder="Coffee with Maya"
          />
        </label>
        <div className="form-grid two-columns">
          <label>
            Starts
            <input
              required
              type="date"
              value={form.startDate}
              onChange={(inputEvent) => setForm({ ...form, startDate: inputEvent.target.value })}
            />
          </label>
          {!form.allDay ? (
            <label>
              Start time
              <input
                required
                type="time"
                value={form.startTime ?? ''}
                onChange={(inputEvent) => setForm({ ...form, startTime: inputEvent.target.value })}
              />
            </label>
          ) : null}
          <label>
            Ends
            <input
              required
              type="date"
              min={form.startDate}
              value={form.endDate}
              onChange={(inputEvent) => setForm({ ...form, endDate: inputEvent.target.value })}
            />
          </label>
          {!form.allDay ? (
            <label>
              End time
              <input
                required
                type="time"
                value={form.endTime ?? ''}
                onChange={(inputEvent) => setForm({ ...form, endTime: inputEvent.target.value })}
              />
            </label>
          ) : null}
        </div>
        <label className="check-label">
          <input
            type="checkbox"
            checked={form.allDay}
            onChange={(inputEvent) =>
              setForm({
                ...form,
                allDay: inputEvent.target.checked,
                startTime: inputEvent.target.checked ? null : '09:00',
                endTime: inputEvent.target.checked ? null : '10:00'
              })
            }
          />
          All-day event
        </label>
        <div className="form-grid two-columns">
          <label>
            Location
            <input
              maxLength={1000}
              value={form.location}
              onChange={(inputEvent) => setForm({ ...form, location: inputEvent.target.value })}
              placeholder="Optional"
            />
          </label>
          <label>
            Timezone
            <input
              required
              value={form.timezone}
              onChange={(inputEvent) => setForm({ ...form, timezone: inputEvent.target.value })}
            />
          </label>
        </div>
        <label className="full-field">
          Notes
          <textarea
            maxLength={10000}
            rows={3}
            value={form.description}
            onChange={(inputEvent) => setForm({ ...form, description: inputEvent.target.value })}
            placeholder="Anything helpful to remember"
          />
        </label>
        <RecurrenceFields
          recurrence={form.recurrence}
          date={form.startDate}
          onChange={(recurrence) => setForm({ ...form, recurrence })}
        />
        {duplicating ? (
          <p className="editor-inline-note" role="status">
            This is a new copy. Adjust its date, time, or repeat pattern before saving.
          </p>
        ) : null}
        <div className="availability-row">
          <button className="secondary-button" type="button" onClick={() => void checkTime()}>
            {checking ? 'Checking…' : 'Check this time'}
          </button>
          {availability ? (
            <span className="availability-result" data-free={availability.free} role="status">
              {availability.summary}
            </span>
          ) : null}
        </div>
        <footer className="dialog-actions">
          {event && !duplicating ? (
            <div className="editor-leading-actions">
              <button
                className="danger-button"
                type="button"
                disabled={busy}
                onClick={() => {
                  if (window.confirm(`Delete “${event.title}”?`)) {
                    void deleteEvent(event.id).then((deleted) => {
                      if (deleted) onClose()
                    })
                  }
                }}
              >
                Delete
              </button>
              <button
                className="secondary-button"
                type="button"
                disabled={busy}
                onClick={() => {
                  setForm({ ...form, id: null })
                  setDuplicating(true)
                }}
              >
                Duplicate
              </button>
            </div>
          ) : (
            <span />
          )}
          <div>
            <button className="secondary-button" type="button" onClick={onClose}>
              Cancel
            </button>
            <button className="retro-button" type="submit" disabled={busy}>
              {busy ? 'Saving…' : duplicating ? 'Add copy' : event ? 'Save changes' : 'Add event'}
            </button>
          </div>
        </footer>
      </form>
    </DialogFrame>
  )
}

function ReminderEditor({
  reminder,
  date,
  title,
  draft,
  onClose
}: {
  reminder: ReminderEntity | null
  date: string | null
  title: string | null
  draft: ReminderForm | undefined
  onClose: () => void
}): ReactNode {
  const snapshot = useCalendarStore((state) => state.snapshot)
  const saveReminder = useCalendarStore((state) => state.saveReminder)
  const deleteReminder = useCalendarStore((state) => state.deleteReminder)
  const busy = useCalendarStore((state) => state.busy)
  const fallbackDate = date ?? todayDate(snapshot?.preferences.timezone ?? 'UTC')
  const [form, setForm] = useState<ReminderForm>(() =>
    draft
      ? structuredClone(draft)
      : reminder
        ? reminderToForm(reminder)
        : {
            id: null,
            calendarId: snapshot?.calendars[0]?.id ?? null,
            title: title ?? '',
            notes: '',
            dueDate: fallbackDate,
            dueTime: '09:00',
            timezone: snapshot?.preferences.timezone ?? 'UTC',
            recurrence: null
          }
  )
  const hasDueDate = form.dueDate !== null && form.dueTime !== null

  async function submit(submitEvent: FormEvent): Promise<void> {
    submitEvent.preventDefault()
    if (await saveReminder(form)) onClose()
  }

  return (
    <DialogFrame
      eyebrow={reminder ? 'Edit reminder' : 'New reminder'}
      title={reminder ? reminder.title : 'Keep a small promise'}
      onClose={onClose}
    >
      <form className="editor-form" onSubmit={(submitEvent) => void submit(submitEvent)}>
        <label className="full-field">
          Title
          <input
            autoFocus
            required
            maxLength={1000}
            value={form.title}
            onChange={(inputEvent) => setForm({ ...form, title: inputEvent.target.value })}
            placeholder="Call Mom"
          />
        </label>
        <label className="reminder-due-toggle">
          <input
            checked={hasDueDate}
            type="checkbox"
            onChange={(inputEvent) => {
              if (inputEvent.target.checked) {
                setForm({ ...form, dueDate: fallbackDate, dueTime: '09:00' })
                return
              }
              setForm({ ...form, dueDate: null, dueTime: null, recurrence: null })
            }}
          />
          <span>
            <strong>Set a due date</strong>
            <small>Undated reminders stay in your reminders list without a notification.</small>
          </span>
        </label>
        <div className="form-grid two-columns" data-disabled={!hasDueDate}>
          <label>
            Due date
            <input
              disabled={!hasDueDate}
              required={hasDueDate}
              type="date"
              value={form.dueDate ?? ''}
              onChange={(inputEvent) => setForm({ ...form, dueDate: inputEvent.target.value })}
            />
          </label>
          <label>
            Due time
            <input
              disabled={!hasDueDate}
              required={hasDueDate}
              type="time"
              value={form.dueTime ?? ''}
              onChange={(inputEvent) => setForm({ ...form, dueTime: inputEvent.target.value })}
            />
          </label>
          <label className="full-field">
            Timezone
            <input
              required
              value={form.timezone}
              onChange={(inputEvent) => setForm({ ...form, timezone: inputEvent.target.value })}
            />
          </label>
        </div>
        <label className="full-field">
          Notes
          <textarea
            maxLength={10000}
            rows={4}
            value={form.notes}
            onChange={(inputEvent) => setForm({ ...form, notes: inputEvent.target.value })}
            placeholder="Optional context for future you"
          />
        </label>
        {hasDueDate && form.dueDate ? (
          <RecurrenceFields
            recurrence={form.recurrence}
            date={form.dueDate}
            onChange={(recurrence) => setForm({ ...form, recurrence })}
          />
        ) : (
          <p className="editor-inline-note">Add a due date to make this reminder repeat.</p>
        )}
        <footer className="dialog-actions">
          {reminder ? (
            <button
              className="danger-button"
              type="button"
              disabled={busy}
              onClick={() => {
                if (window.confirm(`Delete “${reminder.title}”?`)) {
                  void deleteReminder(reminder.id).then((deleted) => {
                    if (deleted) onClose()
                  })
                }
              }}
            >
              Delete
            </button>
          ) : (
            <span />
          )}
          <div>
            <button className="secondary-button" type="button" onClick={onClose}>
              Cancel
            </button>
            <button className="retro-button" type="submit" disabled={busy}>
              {busy ? 'Saving…' : reminder ? 'Save changes' : 'Add reminder'}
            </button>
          </div>
        </footer>
      </form>
    </DialogFrame>
  )
}

export function EditorDialog({
  request,
  onClose
}: {
  request: EditorRequest
  onClose: () => void
}): ReactNode {
  return request.kind === 'event' ? (
    <EventEditor
      event={request.event}
      date={request.date}
      title={request.title}
      draft={request.draft}
      onClose={onClose}
    />
  ) : (
    <ReminderEditor
      reminder={request.reminder}
      date={request.date}
      title={request.title}
      draft={request.draft}
      onClose={onClose}
    />
  )
}
