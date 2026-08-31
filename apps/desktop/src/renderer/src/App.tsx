import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { isThemeId } from '@remind-me/ui'
import type {
  AppInfo,
  AppWindowMode,
  CalendarSnapshot,
  FlexModelAccelerationPreference,
  FlexModelStatus,
  FlexModelWarmthPolicy,
  ResponseStyle,
  Weekday
} from '@remind-me/contracts'
import {
  dateKey,
  formatDueDate,
  formatEventTime,
  localParts,
  recurrenceLabel,
  todayDate
} from './calendar-utils'
import { EditorDialog, RepeatDayScheduleDialog, type EditorRequest } from './components/editors'
import { AssistantPanel } from './components/assistant-panel'
import { DesktopWidget } from './components/desktop-widget'
import { DocumentImportDialog } from './components/document-import-dialog'
import { CanvasAssignments } from './components/canvas-assignments'
import { ThemeCustomizer } from './components/theme-customizer'
import { dayAgendaItems } from './day-agenda'
import { appearanceFromPreferences, applyAppearanceToDocument } from './theme-runtime'
import { useCalendarStore } from './store/calendar-store'
import { useAssistantStore } from './store/assistant-store'
import { useUiStore, type AppRoute } from './store/ui-store'
import { useVoiceStore } from './store/voice-store'
import { useWindowStore } from './store/window-store'

interface NavigationItem {
  id: AppRoute
  label: string
  hint: string
  glyph: ReactNode
}

const navigationItems: readonly NavigationItem[] = [
  {
    id: 'today',
    label: 'Today',
    hint: 'Your daily home',
    glyph: <path d="M5 4.5h14v15H5zM8 2v5M16 2v5M5 9h14" />
  },
  {
    id: 'calendar',
    label: 'Calendar',
    hint: 'See time clearly',
    glyph: <path d="M4 6h16v14H4zM8 3v6M16 3v6M4 10h16M8 14h2M14 14h2M8 17h2" />
  },
  {
    id: 'reminders',
    label: 'Reminders',
    hint: 'Keep promises nearby',
    glyph: <path d="M7 4h10l2 3v12H5V7zM9 11l2 2 4-5M9 16h6" />
  },
  {
    id: 'settings',
    label: 'Settings',
    hint: 'Make it yours',
    glyph: (
      <path d="M12 8.5A3.5 3.5 0 1 0 12 15.5 3.5 3.5 0 0 0 12 8.5ZM4 12h2M18 12h2M12 4v2M12 18v2M6.3 6.3l1.4 1.4M16.3 16.3l1.4 1.4M17.7 6.3l-1.4 1.4M7.7 16.3l-1.4 1.4" />
    )
  }
]

const weekdayIndexes: Record<Weekday, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6
}

const responseStylePresets: ReadonlyArray<{
  id: string
  name: string
  description: string
  style: ResponseStyle
}> = [
  {
    id: 'cozy',
    name: 'Cozy',
    description: 'Warm, relaxed, and gently helpful.',
    style: {
      warmth: 0.86,
      brevity: 0.58,
      formality: 0.12,
      humor: 0.16,
      emoji: 0,
      contractions: true,
      proactivity: 0.56
    }
  },
  {
    id: 'concise',
    name: 'Concise',
    description: 'Short answers with very little flourish.',
    style: {
      warmth: 0.46,
      brevity: 0.94,
      formality: 0.32,
      humor: 0,
      emoji: 0,
      contractions: true,
      proactivity: 0.18
    }
  },
  {
    id: 'polished',
    name: 'Polished',
    description: 'Measured, clear, and a little more formal.',
    style: {
      warmth: 0.62,
      brevity: 0.62,
      formality: 0.78,
      humor: 0.02,
      emoji: 0,
      contractions: false,
      proactivity: 0.38
    }
  }
]

const responseStyleDials: ReadonlyArray<{
  key: 'warmth' | 'brevity' | 'formality' | 'humor' | 'proactivity'
  label: string
  low: string
  high: string
}> = [
  { key: 'warmth', label: 'Warmth', low: 'Neutral', high: 'Cozy' },
  { key: 'brevity', label: 'Brevity', low: 'Roomy', high: 'Brief' },
  { key: 'formality', label: 'Formality', low: 'Relaxed', high: 'Polished' },
  { key: 'humor', label: 'Playfulness', low: 'Straight', high: 'Light' },
  { key: 'proactivity', label: 'Helpfulness', low: 'Quiet', high: 'Guiding' }
]

function Icon({ children }: { children: ReactNode }): ReactNode {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="nav-icon">
      {children}
    </svg>
  )
}

function Navigation({
  snapshot,
  onEnterWidget
}: {
  snapshot: CalendarSnapshot | null
  onEnterWidget: () => void
}): ReactNode {
  const route = useUiStore((state) => state.route)
  const setRoute = useUiStore((state) => state.setRoute)
  const overdueCount =
    snapshot?.reminders.filter(
      (reminder) =>
        reminder.status === 'active' &&
        reminder.dueAtUtc !== null &&
        Date.parse(reminder.dueAtUtc) < Date.now()
    ).length ?? 0

  return (
    <aside className="sidebar" aria-label="Primary navigation">
      <div className="brand-lockup">
        <div className="brand-mark" aria-hidden="true">
          <span className="brand-mark-sun" />
          <span className="brand-mark-line" />
        </div>
        <div>
          <div className="brand-name">Remind Me</div>
          <div className="brand-tagline">a little room for time</div>
        </div>
      </div>
      <nav className="nav-list">
        {navigationItems.map((item) => (
          <button
            className="nav-button"
            data-active={route === item.id}
            key={item.id}
            onClick={() => setRoute(item.id)}
            type="button"
            aria-current={route === item.id ? 'page' : undefined}
          >
            <Icon>{item.glyph}</Icon>
            <span>
              <strong>
                {item.label}
                {item.id === 'reminders' && overdueCount > 0 ? (
                  <span className="nav-badge" aria-label={`${overdueCount} overdue`}>
                    {overdueCount}
                  </span>
                ) : null}
              </strong>
              <small>{item.hint}</small>
            </span>
          </button>
        ))}
      </nav>
      <div className="sidebar-footer">
        <button className="widget-nav-launcher" type="button" onClick={onEnterWidget}>
          <Icon>
            <path d="M5 4.5h14v15H5zM8 2v5M16 2v5M5 9h14M8 13h3M8 16h7" />
          </Icon>
          <span>
            <strong>Mini view</strong>
            <small>Keep plans nearby</small>
          </span>
        </button>
        <div className="local-card">
          <span className="status-dot" aria-hidden="true" />
          <div>
            <strong>Private & local</strong>
            <span>
              {snapshot
                ? `${snapshot.events.length + snapshot.reminders.length} items on device`
                : 'Opening your calendar…'}
            </span>
          </div>
        </div>
      </div>
    </aside>
  )
}

function EmptyAgenda({ onAdd }: { onAdd: () => void }): ReactNode {
  return (
    <div className="empty-agenda">
      <div className="empty-illustration" aria-hidden="true">
        <span className="empty-sun" />
        <span className="empty-hill hill-one" />
        <span className="empty-hill hill-two" />
      </div>
      <p className="empty-title">Nothing is asking for your time yet.</p>
      <p className="muted-copy">Add something, or enjoy the breathing room.</p>
      <button className="text-button" type="button" onClick={onAdd}>
        Add your first plan <span aria-hidden="true">→</span>
      </button>
    </div>
  )
}

function TodayView({
  snapshot,
  onOpen
}: {
  snapshot: CalendarSnapshot
  onOpen: (request: EditorRequest) => void
}): ReactNode {
  const setRoute = useUiStore((state) => state.setRoute)
  const completeReminder = useCalendarStore((state) => state.completeReminder)
  const { preferences } = snapshot
  const today = todayDate(preferences.timezone)
  const events = snapshot.occurrences.filter((occurrence) => occurrence.originalDate === today)
  const reminders = snapshot.reminders
    .filter(
      (reminder) =>
        reminder.status === 'active' &&
        reminder.dueAtUtc !== null &&
        localParts(reminder.dueAtUtc, reminder.timezone).date <= today
    )
    .sort((left, right) => Date.parse(left.dueAtUtc!) - Date.parse(right.dueAtUtc!))
  const planCount = events.length + reminders.length
  const inNextWeek = snapshot.occurrences.filter((occurrence) => {
    const difference =
      (Date.parse(`${occurrence.originalDate}T00:00:00.000Z`) -
        Date.parse(`${today}T00:00:00.000Z`)) /
      86_400_000
    return difference >= 0 && difference < 7
  }).length

  return (
    <div className="view-stack">
      <div className="today-grid">
        <section className="paper-card agenda-card" aria-labelledby="agenda-heading">
          <div className="card-heading-row">
            <div>
              <p className="eyebrow">Your day</p>
              <h2 id="agenda-heading">{planCount ? 'A day with shape' : 'A quiet page'}</h2>
            </div>
            <span className="count-chip">
              {planCount} {planCount === 1 ? 'plan' : 'plans'}
            </span>
          </div>
          {planCount === 0 ? (
            <EmptyAgenda
              onAdd={() => onOpen({ kind: 'event', event: null, date: today, title: null })}
            />
          ) : (
            <div className="agenda-list">
              {events.map((occurrence) => {
                const event = snapshot.events.find(
                  (candidate) => candidate.id === occurrence.eventId
                )
                return (
                  <button
                    className="agenda-item"
                    key={occurrence.occurrenceId}
                    type="button"
                    onClick={() => {
                      if (event) onOpen({ kind: 'event', event, date: null, title: null })
                    }}
                  >
                    <span className="agenda-time">
                      {formatEventTime(
                        occurrence.startUtc,
                        occurrence.timezone,
                        preferences.locale,
                        occurrence.allDay
                      )}
                    </span>
                    <span>
                      <strong>{occurrence.title}</strong>
                      <small>{occurrence.location || 'Event'}</small>
                    </span>
                    <span className="item-kind">event</span>
                  </button>
                )
              })}
              {reminders.map((reminder) => (
                <div className="agenda-item reminder-agenda-item" key={reminder.id}>
                  <button
                    className="complete-button"
                    type="button"
                    aria-label={`Complete ${reminder.title}`}
                    onClick={() => void completeReminder(reminder.id)}
                  >
                    ✓
                  </button>
                  <button
                    className="agenda-item-main"
                    type="button"
                    onClick={() => onOpen({ kind: 'reminder', reminder, date: null, title: null })}
                  >
                    <span>
                      <strong>{reminder.title}</strong>
                      <small>
                        {formatDueDate(reminder.dueAtUtc, reminder.timezone, preferences.locale, {
                          includeDate:
                            reminder.dueAtUtc !== null &&
                            localParts(reminder.dueAtUtc, reminder.timezone).date < today
                        })}
                      </small>
                    </span>
                    <span className="item-kind">reminder</span>
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
        <section className="paper-card gentle-card" aria-labelledby="gentle-heading">
          <p className="eyebrow">Gentle heads-up</p>
          <h2 id="gentle-heading">The week at a glance</h2>
          <div className="week-summary-number">{inNextWeek}</div>
          <p className="muted-copy">
            {inNextWeek === 0
              ? 'No events are crowding the next seven days.'
              : `${inNextWeek} event${inNextWeek === 1 ? '' : 's'} across the next seven days.`}
          </p>
          <button className="text-button" type="button" onClick={() => setRoute('calendar')}>
            Open calendar <span aria-hidden="true">→</span>
          </button>
        </section>
      </div>
    </div>
  )
}

interface MonthCell {
  key: string
  date: string
  day: number
  inMonth: boolean
  today: boolean
}

function monthCells(anchor: Date, weekStartsOn: Weekday, timezone: string): MonthCell[] {
  const year = anchor.getFullYear()
  const month = anchor.getMonth()
  const firstWeekday = new Date(Date.UTC(year, month, 1)).getUTCDay()
  const offset = (firstWeekday - weekdayIndexes[weekStartsOn] + 7) % 7
  const today = todayDate(timezone)
  return Array.from({ length: 42 }, (_, index) => {
    const cellDate = new Date(Date.UTC(year, month, index - offset + 1))
    const date = dateKey(cellDate.getUTCFullYear(), cellDate.getUTCMonth(), cellDate.getUTCDate())
    return {
      key: date,
      date,
      day: cellDate.getUTCDate(),
      inMonth: cellDate.getUTCMonth() === month,
      today: date === today
    }
  })
}

function CalendarView({
  snapshot,
  onOpen,
  onRepeatDay
}: {
  snapshot: CalendarSnapshot
  onOpen: (request: EditorRequest) => void
  onRepeatDay: (date: string) => void
}): ReactNode {
  const [anchor, setAnchor] = useState(
    () => new Date(new Date().getFullYear(), new Date().getMonth(), 1)
  )
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const dayAgendaRef = useRef<HTMLElement | null>(null)
  const loadFor = useCalendarStore((state) => state.loadFor)
  const preferences = snapshot.preferences
  const cells = useMemo(
    () => monthCells(anchor, preferences.weekStartsOn, preferences.timezone),
    [anchor, preferences.timezone, preferences.weekStartsOn]
  )
  const weekdayLabels = useMemo(() => {
    const base = new Date(Date.UTC(2026, 7, 23 + weekdayIndexes[preferences.weekStartsOn]))
    return Array.from({ length: 7 }, (_, index) =>
      new Intl.DateTimeFormat(preferences.locale, { weekday: 'short', timeZone: 'UTC' }).format(
        new Date(base.getTime() + index * 86_400_000)
      )
    )
  }, [preferences.locale, preferences.weekStartsOn])
  const monthName = new Intl.DateTimeFormat(preferences.locale, {
    month: 'long',
    year: 'numeric'
  }).format(anchor)
  const query = search.trim().toLocaleLowerCase(preferences.locale)
  const selectedAgenda = useMemo(
    () =>
      selectedDate ? dayAgendaItems(snapshot.occurrences, snapshot.reminders, selectedDate) : [],
    [selectedDate, snapshot.occurrences, snapshot.reminders]
  )
  const selectedDateLabel = selectedDate
    ? new Intl.DateTimeFormat(preferences.locale, {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric',
        timeZone: 'UTC'
      }).format(new Date(`${selectedDate}T12:00:00.000Z`))
    : ''
  const selectedEventCount = selectedAgenda.filter((item) => item.kind === 'event').length
  const selectedReminderCount = selectedAgenda.length - selectedEventCount

  useEffect(() => {
    const agenda = dayAgendaRef.current
    if (!selectedDate || !agenda || window.matchMedia('(min-width: 1280px)').matches) return
    const frame = window.requestAnimationFrame(() => {
      agenda.scrollIntoView({
        behavior: preferences.reduceMotion ? 'auto' : 'smooth',
        block: 'start'
      })
      agenda.focus({ preventScroll: true })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [preferences.reduceMotion, selectedDate])

  function moveMonth(change: number): void {
    const next = new Date(anchor.getFullYear(), anchor.getMonth() + change, 1)
    setAnchor(next)
    setSelectedDate(null)
    void loadFor(next)
  }

  return (
    <section className="paper-card calendar-card" aria-labelledby="calendar-heading">
      <div className="calendar-toolbar">
        <div>
          <p className="eyebrow">Calendar</p>
          <h2 id="calendar-heading">{monthName}</h2>
          <p className="calendar-toolbar-hint">Choose any day to see every plan in it.</p>
        </div>
        <label className="search-field">
          <span className="visually-hidden">Search calendar</span>
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search this calendar"
          />
        </label>
        <div className="month-controls" aria-label="Month navigation">
          <button
            className="icon-button"
            type="button"
            onClick={() => moveMonth(-1)}
            aria-label="Previous month"
          >
            ←
          </button>
          <button
            className="secondary-button"
            type="button"
            onClick={() => {
              const now = new Date()
              setAnchor(new Date(now.getFullYear(), now.getMonth(), 1))
              setSelectedDate(todayDate(preferences.timezone))
              void loadFor(now)
            }}
          >
            Today
          </button>
          <button
            className="icon-button"
            type="button"
            onClick={() => moveMonth(1)}
            aria-label="Next month"
          >
            →
          </button>
        </div>
      </div>
      <div className="calendar-browser" data-agenda-open={Boolean(selectedDate)}>
        <div className="calendar-month-pane">
          <div className="calendar-weekdays" aria-hidden="true">
            {weekdayLabels.map((day, index) => (
              <span key={`${day}-${index}`}>{day}</span>
            ))}
          </div>
          <div className="calendar-grid">
            {cells.map((cell) => {
              const occurrences = snapshot.occurrences.filter(
                (occurrence) =>
                  occurrence.originalDate === cell.date &&
                  (!query ||
                    `${occurrence.title} ${occurrence.location}`
                      .toLocaleLowerCase(preferences.locale)
                      .includes(query))
              )
              const reminders = snapshot.reminders.filter(
                (reminder) =>
                  reminder.status === 'active' &&
                  reminder.dueAtUtc !== null &&
                  localParts(reminder.dueAtUtc, reminder.timezone).date === cell.date &&
                  (!query ||
                    `${reminder.title} ${reminder.notes}`
                      .toLocaleLowerCase(preferences.locale)
                      .includes(query))
              )
              const items = occurrences.length + reminders.length
              return (
                <div
                  className="calendar-day"
                  data-outside={!cell.inMonth}
                  data-today={cell.today}
                  data-selected={selectedDate === cell.date}
                  key={cell.key}
                >
                  <button
                    className="calendar-day-open"
                    type="button"
                    aria-label={`View all ${items} ${items === 1 ? 'item' : 'items'} on ${cell.date}`}
                    aria-pressed={selectedDate === cell.date}
                    onClick={() => setSelectedDate(cell.date)}
                  />
                  <div className="calendar-day-actions">
                    <button
                      className="calendar-day-number"
                      type="button"
                      aria-label={`View ${cell.date}`}
                      aria-current={cell.today ? 'date' : undefined}
                      onClick={() => setSelectedDate(cell.date)}
                    >
                      {cell.day}
                    </button>
                    <div className="calendar-day-action-buttons">
                      <button
                        className="calendar-add-button"
                        type="button"
                        aria-label={`Add event on ${cell.date}`}
                        title="Add an event"
                        onClick={() =>
                          onOpen({ kind: 'event', event: null, date: cell.date, title: null })
                        }
                      >
                        +
                      </button>
                      {occurrences.length > 0 ? (
                        <button
                          className="repeat-day-button"
                          type="button"
                          aria-label={`Repeat the schedule from ${cell.date}`}
                          title="Repeat this day's schedule"
                          onClick={() => onRepeatDay(cell.date)}
                        >
                          ↻
                        </button>
                      ) : null}
                    </div>
                  </div>
                  <div className="calendar-items">
                    {occurrences.slice(0, 3).map((occurrence) => {
                      const event = snapshot.events.find(
                        (candidate) => candidate.id === occurrence.eventId
                      )
                      return (
                        <button
                          className="calendar-pill event-pill"
                          type="button"
                          key={occurrence.occurrenceId}
                          title={`${occurrence.title}${occurrence.location ? ` · ${occurrence.location}` : ''}`}
                          onClick={() => {
                            if (event) onOpen({ kind: 'event', event, date: null, title: null })
                          }}
                        >
                          <span>
                            {formatEventTime(
                              occurrence.startUtc,
                              occurrence.timezone,
                              preferences.locale,
                              occurrence.allDay
                            )}
                          </span>{' '}
                          {occurrence.title}
                        </button>
                      )
                    })}
                    {reminders.slice(0, Math.max(0, 3 - occurrences.length)).map((reminder) => (
                      <button
                        className="calendar-pill reminder-pill"
                        type="button"
                        key={reminder.id}
                        title={reminder.title}
                        onClick={() =>
                          onOpen({ kind: 'reminder', reminder, date: null, title: null })
                        }
                      >
                        ◦ {reminder.title}
                      </button>
                    ))}
                    {items > 3 ? (
                      <button
                        className="more-items"
                        type="button"
                        onClick={() => setSelectedDate(cell.date)}
                      >
                        +{items - 3} more · view day
                      </button>
                    ) : null}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
        {selectedDate ? (
          <aside
            className="calendar-day-agenda"
            aria-labelledby="selected-day-heading"
            key={selectedDate}
            ref={dayAgendaRef}
            tabIndex={-1}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setSelectedDate(null)
            }}
          >
            <header className="calendar-agenda-heading">
              <div>
                <p className="eyebrow">Complete day</p>
                <h3 id="selected-day-heading">{selectedDateLabel}</h3>
                <p>
                  {selectedEventCount} {selectedEventCount === 1 ? 'event' : 'events'}
                  {selectedReminderCount
                    ? ` · ${selectedReminderCount} ${selectedReminderCount === 1 ? 'reminder' : 'reminders'}`
                    : ''}
                </p>
              </div>
              <button
                className="calendar-agenda-close"
                type="button"
                aria-label="Close day agenda"
                onClick={() => setSelectedDate(null)}
              >
                ×
              </button>
            </header>
            <div className="calendar-agenda-actions">
              <button
                className="retro-button"
                type="button"
                onClick={() =>
                  onOpen({ kind: 'event', event: null, date: selectedDate, title: null })
                }
              >
                + Add event
              </button>
              {selectedEventCount > 0 ? (
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => onRepeatDay(selectedDate)}
                >
                  ↻ Repeat day
                </button>
              ) : null}
            </div>
            <div className="calendar-agenda-list" aria-live="polite">
              {selectedAgenda.length ? (
                selectedAgenda.map((item) => {
                  if (item.kind === 'event') {
                    const occurrence = item.occurrence
                    const event = snapshot.events.find(
                      (candidate) => candidate.id === occurrence.eventId
                    )
                    const repeat = recurrenceLabel(event?.recurrence ?? null)
                    return (
                      <button
                        className="calendar-agenda-item"
                        type="button"
                        key={item.id}
                        onClick={() => {
                          if (event) onOpen({ kind: 'event', event, date: null, title: null })
                        }}
                      >
                        <time>
                          {formatEventTime(
                            occurrence.startUtc,
                            occurrence.timezone,
                            preferences.locale,
                            occurrence.allDay
                          )}
                          {!occurrence.allDay
                            ? `–${formatEventTime(
                                occurrence.endUtc,
                                occurrence.timezone,
                                preferences.locale,
                                false
                              )}`
                            : ''}
                        </time>
                        <span>
                          <strong>{occurrence.title}</strong>
                          {occurrence.location || occurrence.description || repeat ? (
                            <small>
                              {[occurrence.location, occurrence.description, repeat]
                                .filter(Boolean)
                                .join(' · ')}
                            </small>
                          ) : null}
                        </span>
                        <i>event</i>
                      </button>
                    )
                  }
                  const reminder = snapshot.reminders.find(
                    (candidate) => candidate.id === item.reminder.id
                  )
                  if (!reminder) return null
                  return (
                    <button
                      className="calendar-agenda-item calendar-agenda-reminder"
                      type="button"
                      key={item.id}
                      onClick={() =>
                        onOpen({ kind: 'reminder', reminder, date: null, title: null })
                      }
                    >
                      <time>
                        {formatDueDate(reminder.dueAtUtc, reminder.timezone, preferences.locale)}
                      </time>
                      <span>
                        <strong>{reminder.title}</strong>
                        {reminder.notes ? <small>{reminder.notes}</small> : null}
                      </span>
                      <i>reminder</i>
                    </button>
                  )
                })
              ) : (
                <div className="calendar-agenda-empty">
                  <span aria-hidden="true">☼</span>
                  <strong>This day is open.</strong>
                  <p>Add a plan here, or choose any other day to inspect it.</p>
                </div>
              )}
            </div>
          </aside>
        ) : null}
      </div>
    </section>
  )
}

type ReminderFilter = 'upcoming' | 'overdue' | 'completed' | 'recurring' | 'unscheduled'

function RemindersView({
  snapshot,
  onOpen
}: {
  snapshot: CalendarSnapshot
  onOpen: (request: EditorRequest) => void
}): ReactNode {
  const [filter, setFilter] = useState<ReminderFilter>('upcoming')
  const [search, setSearch] = useState('')
  const completeReminder = useCalendarStore((state) => state.completeReminder)
  const now = Date.now()
  const query = search.trim().toLocaleLowerCase(snapshot.preferences.locale)
  const reminders = snapshot.reminders.filter((reminder) => {
    if (
      query &&
      !`${reminder.title} ${reminder.notes}`
        .toLocaleLowerCase(snapshot.preferences.locale)
        .includes(query)
    )
      return false
    if (filter === 'completed') return reminder.status === 'completed'
    if (filter === 'recurring') return reminder.status === 'active' && Boolean(reminder.recurrence)
    if (filter === 'unscheduled') return reminder.status === 'active' && reminder.dueAtUtc === null
    if (filter === 'overdue')
      return (
        reminder.status === 'active' &&
        reminder.dueAtUtc !== null &&
        Date.parse(reminder.dueAtUtc) < now
      )
    return (
      reminder.status === 'active' &&
      reminder.dueAtUtc !== null &&
      Date.parse(reminder.dueAtUtc) >= now
    )
  })

  return (
    <section className="paper-card reminders-card" aria-labelledby="reminders-heading">
      <div className="card-heading-row">
        <div>
          <p className="eyebrow">Reminders</p>
          <h2 id="reminders-heading">Small promises, kept close</h2>
        </div>
        <button
          className="retro-button"
          type="button"
          onClick={() => onOpen({ kind: 'reminder', reminder: null, date: null, title: null })}
        >
          + New reminder
        </button>
      </div>
      <div className="reminder-tools">
        <div className="filter-row" aria-label="Reminder filters">
          {(['upcoming', 'overdue', 'unscheduled', 'completed', 'recurring'] as const).map(
            (option) => (
              <button
                type="button"
                data-active={filter === option}
                key={option}
                onClick={() => setFilter(option)}
              >
                {option === 'unscheduled'
                  ? 'No date'
                  : `${option[0]?.toUpperCase()}${option.slice(1)}`}
              </button>
            )
          )}
        </div>
        <label className="search-field">
          <span className="visually-hidden">Search reminders</span>
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search reminders"
          />
        </label>
      </div>
      {reminders.length === 0 ? (
        <div className="empty-list">
          <span className="check-circle" aria-hidden="true">
            ✓
          </span>
          <h3>No reminders here.</h3>
          <p>Try another filter, or add a small promise for later.</p>
        </div>
      ) : (
        <div className="reminder-list">
          {reminders.map((reminder) => {
            const recurrence = recurrenceLabel(reminder.recurrence)
            const overdue =
              reminder.status === 'active' &&
              reminder.dueAtUtc !== null &&
              Date.parse(reminder.dueAtUtc) < now
            return (
              <article className="reminder-row" data-overdue={overdue} key={reminder.id}>
                <button
                  className="complete-button"
                  type="button"
                  disabled={reminder.status === 'completed'}
                  aria-label={`Complete ${reminder.title}`}
                  onClick={() => void completeReminder(reminder.id)}
                >
                  {reminder.status === 'completed' ? '✓' : ''}
                </button>
                <button
                  className="reminder-main"
                  type="button"
                  onClick={() => onOpen({ kind: 'reminder', reminder, date: null, title: null })}
                >
                  <strong>{reminder.title}</strong>
                  <span>
                    {formatDueDate(
                      reminder.dueAtUtc,
                      reminder.timezone,
                      snapshot.preferences.locale,
                      { includeDate: true }
                    )}
                    {recurrence ? ` · ${recurrence}` : ''}
                  </span>
                  {reminder.notes ? <small>{reminder.notes}</small> : null}
                </button>
                {overdue ? <span className="overdue-chip">overdue</span> : null}
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}

function SettingsDisclosure({
  eyebrow,
  title,
  defaultOpen = false,
  children
}: {
  eyebrow: string
  title: ReactNode
  defaultOpen?: boolean
  children: ReactNode
}): ReactNode {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <details
      className="paper-card settings-section settings-disclosure"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span>
          <small className="eyebrow">{eyebrow}</small>
          <strong>{title}</strong>
        </span>
        <span className="settings-disclosure-label" aria-hidden="true">
          Details
        </span>
      </summary>
      <div className="settings-disclosure-body">{children}</div>
    </details>
  )
}

function SettingsView({
  snapshot,
  appInfo
}: {
  snapshot: CalendarSnapshot
  appInfo: AppInfo | null
}): ReactNode {
  const updatePreferences = useCalendarStore((state) => state.updatePreferences)
  const exportData = useCalendarStore((state) => state.exportData)
  const importData = useCalendarStore((state) => state.importData)
  const deleteAllData = useCalendarStore((state) => state.deleteAllData)
  const busy = useCalendarStore((state) => state.busy)
  const windowBusy = useWindowStore((state) => state.busy)
  const setWindowMode = useWindowStore((state) => state.setMode)
  const voiceRuntime = useVoiceStore((state) => state.runtime)
  const voiceWarming = useVoiceStore((state) => state.warming)
  const initializeVoice = useVoiceStore((state) => state.initialize)
  const warmVoice = useVoiceStore((state) => state.warm)
  const [timezone, setTimezone] = useState(snapshot.preferences.timezone)
  const [preferredName, setPreferredName] = useState(
    snapshot.preferences.assistantProfile.preferredName
  )
  const [customInstructions, setCustomInstructions] = useState(
    snapshot.preferences.assistantProfile.customInstructions
  )
  const [deleteArmed, setDeleteArmed] = useState(false)
  const [deleteConfirmation, setDeleteConfirmation] = useState('')
  const [flexModel, setFlexModel] = useState<FlexModelStatus | null>(null)
  const [flexModelBusy, setFlexModelBusy] = useState(false)
  const [flexModelMessage, setFlexModelMessage] = useState<string | null>(null)
  useEffect(() => setTimezone(snapshot.preferences.timezone), [snapshot.preferences.timezone])
  useEffect(
    () => setPreferredName(snapshot.preferences.assistantProfile.preferredName),
    [snapshot.preferences.assistantProfile.preferredName]
  )
  useEffect(
    () => setCustomInstructions(snapshot.preferences.assistantProfile.customInstructions),
    [snapshot.preferences.assistantProfile.customInstructions]
  )
  useEffect(() => {
    void initializeVoice()
  }, [initializeVoice])
  useEffect(() => {
    let active = true
    void window.remindMe
      .getFlexModelStatus()
      .then((status) => {
        if (active) {
          setFlexModel(status)
          setFlexModelMessage(status.error)
        }
      })
      .catch((error: unknown) => {
        if (active)
          setFlexModelMessage(
            error instanceof Error ? error.message : 'Could not read the optional model status.'
          )
      })
    const unsubscribe = window.remindMe.onFlexModelProgress((progress) => {
      if (!active) return
      setFlexModel(progress.status)
      setFlexModelMessage(progress.message)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [])
  const responseStyle = snapshot.preferences.responseStyle
  const responseAdaptation = snapshot.preferences.responseAdaptation
  const assistantProfile = snapshot.preferences.assistantProfile
  const flexModelInstalled = Boolean(
    flexModel && flexModel.installedBytes === flexModel.downloadBytes
  )
  const normalizedPreferredName = preferredName.trim()
  const normalizedCustomInstructions = customInstructions.trim()
  const assistantProfileDirty =
    normalizedPreferredName !== assistantProfile.preferredName ||
    normalizedCustomInstructions !== assistantProfile.customInstructions
  const activeResponsePreset = responseStylePresets.find(
    (preset) => JSON.stringify(preset.style) === JSON.stringify(responseStyle)
  )?.id
  const updateResponseStyle = (patch: Partial<ResponseStyle>): void => {
    void updatePreferences({ responseStyle: { ...responseStyle, ...patch } })
  }
  const saveAssistantProfile = async (): Promise<void> => {
    await updatePreferences({
      assistantProfile: {
        ...assistantProfile,
        preferredName: normalizedPreferredName,
        customInstructions: normalizedCustomInstructions
      }
    })
  }
  const removeAssistantMemory = async (memoryIndex: number): Promise<void> => {
    await updatePreferences({
      assistantProfile: {
        ...assistantProfile,
        memories: assistantProfile.memories.filter((_, index) => index !== memoryIndex)
      }
    })
  }
  const confirmDeleteAll = async (): Promise<void> => {
    if (deleteConfirmation !== 'DELETE') return
    if (await deleteAllData()) {
      useAssistantStore.setState({
        conversation: null,
        composer: '',
        loading: false,
        busy: false,
        error: null
      })
      setDeleteArmed(false)
      setDeleteConfirmation('')
    }
  }
  const runFlexModelAction = async (
    action: () => Promise<FlexModelStatus>,
    completedMessage: string
  ): Promise<void> => {
    setFlexModelBusy(true)
    setFlexModelMessage(null)
    try {
      const status = await action()
      setFlexModel(status)
      setFlexModelMessage(status.error ?? completedMessage)
    } catch (error) {
      setFlexModelMessage(
        error instanceof Error ? error.message : 'The optional model action did not finish.'
      )
    } finally {
      setFlexModelBusy(false)
    }
  }
  const flexBackendLabel = (backend: FlexModelStatus['profile']['backend']): string =>
    backend === 'metal'
      ? 'Apple silicon Metal'
      : backend === 'cuda'
        ? 'NVIDIA CUDA'
        : backend === 'vulkan'
          ? 'Vulkan GPU'
          : `${flexModel?.profile.threads ?? 1}-thread portable CPU`

  return (
    <div className="settings-grid">
      <div className="settings-side-stack settings-primary-stack">
        <section className="paper-card settings-section">
          <ThemeCustomizer
            preferences={snapshot.preferences}
            nativeBackdrop={appInfo?.appearance.nativeBackdrop ?? false}
            transparentWindow={appInfo?.appearance.transparentWindow ?? false}
            nativeBackdropLabel={appInfo?.appearance.label ?? 'Checking glass support…'}
            busy={busy}
            onSave={updatePreferences}
          />
        </section>
        <section className="paper-card settings-section">
          <p className="eyebrow">Calendar display</p>
          <h2>Fit the planner to your day</h2>
          <div className="settings-form-grid">
            <label>
              Density
              <select
                value={snapshot.preferences.density}
                onChange={(event) =>
                  void updatePreferences({
                    density: event.target.value as 'comfortable' | 'compact'
                  })
                }
              >
                <option value="comfortable">Comfortable</option>
                <option value="compact">Compact</option>
              </select>
            </label>
            <label>
              Week starts on
              <select
                value={snapshot.preferences.weekStartsOn}
                onChange={(event) =>
                  void updatePreferences({ weekStartsOn: event.target.value as Weekday })
                }
              >
                <option value="monday">Monday</option>
                <option value="sunday">Sunday</option>
                <option value="saturday">Saturday</option>
              </select>
            </label>
            <label className="full-field">
              Timezone
              <span className="inline-save-field">
                <input value={timezone} onChange={(event) => setTimezone(event.target.value)} />
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => void updatePreferences({ timezone })}
                >
                  Save
                </button>
              </span>
            </label>
            <label className="check-label full-field">
              <input
                type="checkbox"
                checked={snapshot.preferences.notificationsEnabled}
                onChange={(event) =>
                  void updatePreferences({ notificationsEnabled: event.target.checked })
                }
              />
              Show native reminder notifications
            </label>
            <label className="check-label full-field">
              <input
                type="checkbox"
                checked={snapshot.preferences.reduceMotion}
                onChange={(event) => void updatePreferences({ reduceMotion: event.target.checked })}
              />
              Reduce interface motion
            </label>
          </div>
        </section>
        <section className="paper-card settings-section personal-assistant-settings">
          <div className="settings-heading-with-count">
            <span>
              <p className="eyebrow">Personal assistant</p>
              <h2>A little context, kept local</h2>
            </span>
            <span className="count-chip">{assistantProfile.memories.length}/20 memories</span>
          </div>
          <p className="muted-copy">
            Choose what Remind Me may use to personalize replies. This profile stays on this device
            and is not erased when you clear a conversation.
          </p>
          <form
            className="assistant-profile-form"
            onSubmit={(event) => {
              event.preventDefault()
              void saveAssistantProfile()
            }}
          >
            <div className="assistant-profile-fields">
              <label>
                What should I call you?
                <input
                  autoComplete="name"
                  maxLength={80}
                  placeholder="Your preferred name"
                  value={preferredName}
                  onChange={(event) => setPreferredName(event.target.value)}
                />
              </label>
              <label>
                Custom assistant guidance
                <textarea
                  maxLength={2000}
                  placeholder="For example: keep answers direct and call study blocks focus time."
                  rows={3}
                  value={customInstructions}
                  onChange={(event) => setCustomInstructions(event.target.value)}
                />
              </label>
            </div>
            <div className="assistant-profile-actions">
              <label className="check-label assistant-memory-toggle">
                <input
                  type="checkbox"
                  checked={assistantProfile.memoryEnabled}
                  disabled={busy}
                  onChange={(event) =>
                    void updatePreferences({
                      assistantProfile: {
                        ...assistantProfile,
                        memoryEnabled: event.target.checked
                      }
                    })
                  }
                />
                <span>
                  <strong>Use approved memory</strong>
                  <small>Off keeps saved notes, but stops using or adding them.</small>
                </span>
              </label>
              <button
                className="primary-button"
                type="submit"
                disabled={busy || !assistantProfileDirty}
              >
                Save profile
              </button>
            </div>
          </form>
          <div className="approved-memory-panel">
            <div className="approved-memory-heading">
              <strong>Approved memories</strong>
              <small>Say “remember…” in chat to add one.</small>
            </div>
            {assistantProfile.memories.length ? (
              <ul className="approved-memory-list">
                {assistantProfile.memories.map((memory, index) => (
                  <li key={`${memory}-${index}`}>
                    <span>{memory}</span>
                    <button
                      className="approved-memory-remove"
                      type="button"
                      disabled={busy}
                      aria-label={`Forget: ${memory}`}
                      title="Forget this memory"
                      onClick={() => void removeAssistantMemory(index)}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="approved-memory-empty">Nothing has been saved here yet.</p>
            )}
          </div>
        </section>
        <section className="paper-card settings-section assistant-style-settings">
          <p className="eyebrow">Assistant voice</p>
          <h2>Make the replies sound like you</h2>
          <p className="muted-copy">
            The original scratch-trained RemindSpeak model chooses and combines local phrasing
            around protected calendar facts. Together with RemindCore, it is the always-installed
            default assistant; these controls shape its voice without changing calendar facts.
          </p>
          <div className="response-style-presets" role="radiogroup" aria-label="Reply style preset">
            {responseStylePresets.map((preset) => (
              <button
                type="button"
                role="radio"
                aria-checked={activeResponsePreset === preset.id}
                data-active={activeResponsePreset === preset.id}
                key={preset.id}
                onClick={() => void updatePreferences({ responseStyle: preset.style })}
              >
                <strong>{preset.name}</strong>
                <small>{preset.description}</small>
              </button>
            ))}
          </div>
          <div className="response-style-controls">
            {responseStyleDials.map((dial) => (
              <label key={dial.key}>
                <span>
                  <strong>{dial.label}</strong>
                  <output>{Math.round(responseStyle[dial.key] * 100)}%</output>
                </span>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={responseStyle[dial.key]}
                  aria-label={dial.label}
                  onChange={(event) =>
                    updateResponseStyle({ [dial.key]: event.currentTarget.valueAsNumber })
                  }
                />
                <span className="range-labels" aria-hidden="true">
                  <small>{dial.low}</small>
                  <small>{dial.high}</small>
                </span>
              </label>
            ))}
            <label className="check-label response-contractions">
              <input
                type="checkbox"
                checked={responseStyle.contractions}
                onChange={(event) => updateResponseStyle({ contractions: event.target.checked })}
              />
              Use conversational contractions
            </label>
          </div>
          <div className="response-learning-settings">
            <label className="check-label">
              <input
                type="checkbox"
                checked={responseAdaptation.enabled}
                onChange={(event) =>
                  void updatePreferences({
                    responseAdaptation: {
                      ...responseAdaptation,
                      enabled: event.target.checked
                    }
                  })
                }
              />
              <span>
                <strong>Learn my phrasing preferences</strong>
                <small>
                  Helpful and “not quite” ratings adjust only local phrase ranking—never facts or
                  calendar actions.
                </small>
              </span>
            </label>
            <div>
              <span>
                {responseAdaptation.feedbackCount} private rating
                {responseAdaptation.feedbackCount === 1 ? '' : 's'} ·{' '}
                {responseAdaptation.entries.length} learned phrase
                {responseAdaptation.entries.length === 1 ? '' : 's'}
              </span>
              <button
                className="secondary-button"
                type="button"
                disabled={
                  busy ||
                  (responseAdaptation.feedbackCount === 0 &&
                    responseAdaptation.entries.length === 0)
                }
                onClick={() =>
                  void updatePreferences({
                    responseAdaptation: {
                      ...responseAdaptation,
                      feedbackCount: 0,
                      entries: []
                    }
                  })
                }
              >
                Reset learning
              </button>
            </div>
          </div>
          {appInfo ? (
            <details className="settings-inline-details">
              <summary>Response model details</summary>
              <ul className="engine-facts response-model-facts">
                <li>
                  <span>Original model</span>
                  <strong>
                    {(appInfo.speaker.parameterCount / 1_000_000).toFixed(1)}M parameters
                  </strong>
                </li>
                <li>
                  <span>Installed size</span>
                  <strong>{(appInfo.speaker.modelBytes / 1024).toFixed(0)} KiB compressed</strong>
                </li>
                <li>
                  <span>Working memory</span>
                  <strong>{(appInfo.speaker.workingSetBytes / 1024 / 1024).toFixed(1)} MiB</strong>
                </li>
                <li>
                  <span>Candidate replies</span>
                  <strong>{appInfo.speaker.candidateCount || 'Fallback only'}</strong>
                </li>
                <li>
                  <span>Training origin</span>
                  <strong>
                    {appInfo.speaker.teacherUsed ? 'Teacher-assisted' : 'From scratch'}
                  </strong>
                </li>
                <li>
                  <span>Network</span>
                  <strong>Never required</strong>
                </li>
              </ul>
            </details>
          ) : null}
          {appInfo?.speaker.error ? (
            <p className="settings-warning">{appInfo.speaker.error}</p>
          ) : null}
        </section>
      </div>
      <div className="settings-side-stack">
        <section className="paper-card settings-section companion-settings">
          <p className="eyebrow">Desktop companion</p>
          <h2>Keep the day within reach</h2>
          <p className="muted-copy">
            Start quietly in a compact local view, or open either companion whenever you need it.
          </p>
          <label className="check-label">
            <input
              type="checkbox"
              checked={snapshot.preferences.launchAtLogin}
              disabled={
                busy || (appInfo !== null && !['win32', 'darwin'].includes(appInfo.platform))
              }
              onChange={(event) => void updatePreferences({ launchAtLogin: event.target.checked })}
            />
            Open Remind Me when I sign in
          </label>
          <label className="companion-startup-mode">
            Startup view
            <select
              value={snapshot.preferences.startupWindowMode}
              disabled={busy}
              onChange={(event) =>
                void updatePreferences({
                  startupWindowMode: event.target.value as AppWindowMode
                })
              }
            >
              <option value="glance">Tiny glance</option>
              <option value="widget">Mini calendar</option>
              <option value="full">Full app</option>
            </select>
          </label>
          <div className="companion-actions">
            <button
              className="primary-button"
              type="button"
              disabled={windowBusy}
              onClick={() => void setWindowMode('glance')}
            >
              Open tiny glance
            </button>
            <button
              className="secondary-button"
              type="button"
              disabled={windowBusy}
              onClick={() => void setWindowMode('widget')}
            >
              Open mini view
            </button>
          </div>
          {appInfo !== null && !['win32', 'darwin'].includes(appInfo.platform) ? (
            <small className="settings-note">
              The floating views work here; automatic sign-in launch currently uses Windows or macOS
              integration.
            </small>
          ) : null}
        </section>
        <CanvasAssignments snapshot={snapshot} />
        <section className="paper-card settings-section privacy-settings">
          <p className="eyebrow">Privacy</p>
          <h2>Local means local</h2>
          <ul>
            <li>
              <span>Calendar database</span>
              <strong>On device</strong>
            </li>
            <li>
              <span>Required account</span>
              <strong>None</strong>
            </li>
            <li>
              <span>Telemetry</span>
              <strong>Off</strong>
            </li>
            <li>
              <span>Network dependency</span>
              <strong>Optional installs / Canvas</strong>
            </li>
            <li>
              <span>Canvas connection</span>
              <strong>Only when you choose</strong>
            </li>
          </ul>
        </section>
        <SettingsDisclosure
          eyebrow="Release health"
          title={
            appInfo === null
              ? 'Verifying this installation…'
              : appInfo.release.status === 'verified'
                ? 'Offline package verified'
                : 'Safe fallbacks are active'
          }
          defaultOpen={Boolean(appInfo?.release.error || appInfo?.database.error)}
        >
          <p className="muted-copy">
            Required model hashes and known predictions are checked before local AI is trusted.
            Calendar rules and CPU execution remain available if a model is damaged.
          </p>
          {appInfo ? (
            <ul className="engine-facts">
              <li>
                <span>Artifacts</span>
                <strong>
                  {appInfo.release.verifiedArtifactCount} verified ·{' '}
                  {appInfo.release.requiredArtifactCount} required
                </strong>
              </li>
              <li>
                <span>Golden probes</span>
                <strong>
                  {Object.values(appInfo.release.goldenProbes).filter(Boolean).length}/3 passed
                </strong>
              </li>
              <li>
                <span>Original models</span>
                <strong>
                  {(appInfo.release.customModelBytes / 1024 / 1024).toFixed(1)} MiB installed
                </strong>
              </li>
              <li>
                <span>Bounded working set</span>
                <strong>
                  {(appInfo.release.customWorkingSetBytes / 1024 / 1024).toFixed(1)} MiB
                </strong>
              </li>
              <li>
                <span>Execution</span>
                <strong>Portable INT8 CPU</strong>
              </li>
              <li>
                <span>Provider choice</span>
                <strong>
                  {appInfo.release.providers.cacheHit ? 'Cached locally' : 'Benchmarked'}
                </strong>
              </li>
              <li>
                <span>Database</span>
                <strong>
                  {appInfo.database.status === 'recovered'
                    ? 'Recovered safely'
                    : `Healthy · schema ${appInfo.database.schemaVersion}`}
                </strong>
              </li>
            </ul>
          ) : null}
          {appInfo?.release.error ? (
            <p className="settings-warning">{appInfo.release.error}</p>
          ) : null}
          {appInfo?.database.error ? (
            <p className="settings-warning">{appInfo.database.error}</p>
          ) : null}
        </SettingsDisclosure>
        <section className="paper-card settings-section data-settings">
          <p className="eyebrow">Your data</p>
          <h2>Portable, when you choose</h2>
          <p className="muted-copy">
            Back up everything as JSON or exchange calendar items as ICS.
          </p>
          <div className="data-actions">
            <button className="secondary-button" type="button" onClick={() => void importData()}>
              Import JSON / ICS
            </button>
            <button
              className="secondary-button"
              type="button"
              onClick={() => void exportData('json')}
            >
              Export backup
            </button>
            <button
              className="secondary-button"
              type="button"
              onClick={() => void exportData('ics')}
            >
              Export ICS
            </button>
            <button
              className="danger-button data-delete-trigger"
              type="button"
              disabled={busy}
              onClick={() => {
                setDeleteArmed((current) => !current)
                setDeleteConfirmation('')
              }}
            >
              Delete all local data
            </button>
          </div>
          {deleteArmed ? (
            <div className="delete-data-confirmation" role="group" aria-label="Delete all data">
              <strong>This cannot be undone.</strong>
              <p>
                Events, reminders, conversations, preferences, undo history, and any saved Canvas
                connection will be securely erased. Export a backup first if you may need it later.
              </p>
              <label>
                Type DELETE to continue
                <input
                  autoComplete="off"
                  spellCheck={false}
                  value={deleteConfirmation}
                  onChange={(event) => setDeleteConfirmation(event.target.value)}
                />
              </label>
              <div>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => {
                    setDeleteArmed(false)
                    setDeleteConfirmation('')
                  }}
                >
                  Keep my data
                </button>
                <button
                  className="danger-button"
                  type="button"
                  disabled={busy || deleteConfirmation !== 'DELETE'}
                  onClick={() => void confirmDeleteAll()}
                >
                  Erase this device
                </button>
              </div>
            </div>
          ) : null}
        </section>
        <SettingsDisclosure
          eyebrow="Local language planner"
          title={
            appInfo === null
              ? 'Checking RemindCore…'
              : appInfo.planner.available
                ? 'Scratch-trained, safely grounded'
                : 'Using the rules fallback'
          }
          defaultOpen={Boolean(appInfo?.planner.error)}
        >
          <p className="muted-copy">
            RemindCore recognizes paraphrases and copies requested details into a constrained draft.
            Calendar math, review, confirmation, and database writes stay deterministic.
          </p>
          {appInfo ? (
            <ul className="engine-facts">
              <li>
                <span>Original model</span>
                <strong>
                  {(appInfo.planner.parameterCount / 1_000_000).toFixed(1)}M parameters
                </strong>
              </li>
              <li>
                <span>Storage</span>
                <strong>{(appInfo.planner.modelBytes / 1024 / 1024).toFixed(1)} MiB INT8</strong>
              </li>
              <li>
                <span>Training origin</span>
                <strong>{appInfo.planner.teacherUsed ? 'Teacher-assisted' : 'From scratch'}</strong>
              </li>
              <li>
                <span>Safety mode</span>
                <strong>Confidence-gated hybrid</strong>
              </li>
              <li>
                <span>Network</span>
                <strong>Never required</strong>
              </li>
            </ul>
          ) : null}
          {appInfo?.planner.error ? (
            <p className="settings-warning">{appInfo.planner.error}</p>
          ) : null}
        </SettingsDisclosure>
        <section className="paper-card settings-section engine-settings flex-model-settings">
          <p className="eyebrow">Optional flexible fallback</p>
          <h2>
            {flexModel === null
              ? 'Checking the language pack…'
              : flexModel.state === 'downloading'
                ? 'Downloading on this device…'
                : flexModel.state === 'loading'
                  ? 'Loading only when needed…'
                  : flexModel.state === 'ready'
                    ? 'Ready for broader conversation'
                    : flexModel.state === 'installed'
                      ? flexModel.enabled
                        ? 'Installed and enabled'
                        : 'Installed, currently off'
                      : flexModel.state === 'error'
                        ? flexModelInstalled
                          ? 'Installed pack can retry safely'
                          : 'Native models remain active'
                        : 'Add broader local conversation'}
          </h2>
          <p className="muted-copy">
            RemindCore and RemindSpeak remain the original scratch-trained default stack. The
            removable Qwen3 1.7B Q4 pack is an optional hardware-aware tier for broader local
            conversation and unfamiliar phrasing. Calendar actions still pass through the same
            grounded review, deterministic calendar math, and undo checks.
          </p>
          <div className="local-model-lineup" aria-label="Local assistant model roles">
            <span>
              <small>Original default</small>
              <strong>RemindCore + RemindSpeak</strong>
            </span>
            <span>
              <small>Optional broad tier</small>
              <strong>Qwen3 1.7B Q4</strong>
            </span>
          </div>
          {flexModel ? (
            <>
              <details className="settings-inline-details">
                <summary>Language pack details</summary>
                <ul className="engine-facts">
                  <li>
                    <span>Download</span>
                    <strong>{(flexModel.downloadBytes / 1_000_000).toFixed(0)} MB once</strong>
                  </li>
                  <li>
                    <span>Model</span>
                    <strong>{flexModel.displayName}</strong>
                  </li>
                  <li>
                    <span>License</span>
                    <strong>{flexModel.license}</strong>
                  </li>
                  <li>
                    <span>After install</span>
                    <strong>Fully offline</strong>
                  </li>
                  <li>
                    <span>Automatic profile</span>
                    <strong>{flexModel.profile.label.replace('Automatic ', '')}</strong>
                  </li>
                  <li>
                    <span>Runtime</span>
                    <strong>
                      {flexBackendLabel(flexModel.profile.backend)}
                      {' · '}
                      {(flexModel.profile.contextSize / 1_024).toFixed(0)}K tokens per task
                    </strong>
                  </li>
                  <li>
                    <span>Prompt cache</span>
                    <strong>
                      {flexModel.profile.sequences === 2
                        ? 'Separate planner + chat prefixes'
                        : 'Shared low-memory prefix'}
                    </strong>
                  </li>
                  <li>
                    <span>Memory policy</span>
                    <strong>
                      Loads on demand · unloads after{' '}
                      {flexModel.profile.idleUnloadSeconds >= 120
                        ? `${Math.round(flexModel.profile.idleUnloadSeconds / 60)} min`
                        : `${flexModel.profile.idleUnloadSeconds} sec`}
                    </strong>
                  </li>
                  <li>
                    <span>Packaged backends</span>
                    <strong>
                      {flexModel.availableBackends
                        .map((backend) => backend.toUpperCase())
                        .join(' · ')}
                    </strong>
                  </li>
                  <li>
                    <span>Local queue</span>
                    <strong>
                      {flexModel.queue.activeWorkload
                        ? `${flexModel.queue.activeWorkload} active · ${flexModel.queue.queuedJobs} waiting`
                        : flexModel.queue.queuedJobs
                          ? `${flexModel.queue.queuedJobs} waiting`
                          : 'Idle'}
                    </strong>
                  </li>
                  {flexModel.lastRequest ? (
                    <li>
                      <span>Last local run</span>
                      <strong>
                        {flexModel.lastRequest.workload === 'plan'
                          ? 'Planner'
                          : flexModel.lastRequest.workload === 'document-repair'
                            ? 'Document repair'
                            : flexModel.lastRequest.workload === 'document-fallback'
                              ? 'Document fallback'
                              : 'Conversation'}{' '}
                        · {(flexModel.lastRequest.elapsedMs / 1_000).toFixed(1)} sec ·{' '}
                        {flexModel.lastRequest.outputTokens} output tokens ·{' '}
                        {flexModel.lastRequest.timeToFirstTokenMs === null
                          ? 'structured output'
                          : `${(flexModel.lastRequest.timeToFirstTokenMs / 1_000).toFixed(1)} sec first token`}
                        {' · '}
                        {flexModel.lastRequest.prefixCacheReused ? 'prefix reused' : 'fresh prefix'}
                        {' · '}
                        {flexModel.lastRequest.processRssMiB.toLocaleString()} MiB worker memory
                      </strong>
                    </li>
                  ) : null}
                </ul>
                <div className="settings-form-grid flex-runtime-controls">
                  <label>
                    Memory behavior
                    <select
                      value={flexModel.warmthPolicy}
                      disabled={flexModelBusy}
                      onChange={(event) =>
                        void runFlexModelAction(
                          () =>
                            window.remindMe.configureFlexModel({
                              warmthPolicy: event.target.value as FlexModelWarmthPolicy
                            }),
                          'Local model memory behavior updated.'
                        )
                      }
                    >
                      <option value="memory-saver">Memory saver</option>
                      <option value="automatic">Automatic</option>
                      <option value="keep-warm">Keep warm when hardware allows</option>
                    </select>
                  </label>
                  <label>
                    Acceleration
                    <select
                      value={flexModel.accelerationPreference}
                      disabled={flexModelBusy}
                      onChange={(event) =>
                        void runFlexModelAction(
                          () =>
                            window.remindMe.configureFlexModel({
                              accelerationPreference: event.target
                                .value as FlexModelAccelerationPreference
                            }),
                          'Local model acceleration preference updated.'
                        )
                      }
                    >
                      <option value="auto">Best packaged backend</option>
                      <option value="cpu">Portable CPU</option>
                    </select>
                  </label>
                </div>
              </details>
              {flexModel.state === 'downloading' ? (
                <div className="flex-model-progress" aria-live="polite">
                  <div className="voice-progress-track" aria-hidden="true">
                    <span style={{ width: `${Math.round(flexModel.progress * 100)}%` }} />
                  </div>
                  <small>{Math.round(flexModel.progress * 100)}% downloaded and verified</small>
                </div>
              ) : null}
              <div className="flex-model-actions">
                {flexModel.state === 'not-installed' ||
                (flexModel.state === 'error' && !flexModelInstalled) ? (
                  <button
                    className="primary-button"
                    type="button"
                    disabled={flexModelBusy}
                    onClick={() =>
                      void runFlexModelAction(
                        () => window.remindMe.installFlexModel(),
                        'Language pack installed and ready offline.'
                      )
                    }
                  >
                    Install language pack
                  </button>
                ) : flexModel.state === 'downloading' ? (
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() =>
                      void runFlexModelAction(
                        () => window.remindMe.cancelFlexModelInstall(),
                        'Download cancelled.'
                      )
                    }
                  >
                    Cancel download
                  </button>
                ) : (
                  <>
                    <label className="check-label flex-model-enable">
                      <input
                        type="checkbox"
                        checked={flexModel.enabled}
                        disabled={flexModelBusy || flexModel.state === 'loading'}
                        onChange={(event) =>
                          void runFlexModelAction(
                            () => window.remindMe.setFlexModelEnabled(event.target.checked),
                            event.target.checked
                              ? 'Flexible fallback enabled.'
                              : 'Flexible fallback disabled; rules remain available.'
                          )
                        }
                      />
                      Use for broad conversation and requests the compact planner cannot understand
                    </label>
                    {flexModel.state === 'error' ? (
                      <button
                        className="secondary-button"
                        type="button"
                        disabled={flexModelBusy}
                        onClick={() =>
                          void runFlexModelAction(
                            () => window.remindMe.setFlexModelEnabled(true),
                            'Language pack reset. Your next broad request will retry locally.'
                          )
                        }
                      >
                        Reset and retry
                      </button>
                    ) : null}
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={flexModelBusy || flexModel.state === 'loading'}
                      onClick={() =>
                        void runFlexModelAction(
                          () => window.remindMe.removeFlexModel(),
                          'Language pack removed; no calendar data was touched.'
                        )
                      }
                    >
                      Remove language pack
                    </button>
                  </>
                )}
              </div>
            </>
          ) : null}
          {flexModelMessage ? (
            <p className={flexModel?.error ? 'settings-warning' : 'settings-note'}>
              {flexModelMessage}
            </p>
          ) : null}
        </section>
        <SettingsDisclosure
          eyebrow="Offline voice"
          title={
            voiceRuntime === null
              ? 'Checking the local model…'
              : voiceRuntime.available
                ? 'Live transcription ready'
                : 'Model needs attention'
          }
          defaultOpen={Boolean(voiceRuntime?.error)}
        >
          <p className="muted-copy">
            A compact English speech model runs in its own process. Interim words appear as you
            speak, then a cleaned full-context pass produces editable text before the assistant
            acts. Recordings stay in memory and disappear after transcription.
          </p>
          {voiceRuntime ? (
            <ul className="engine-facts">
              <li>
                <span>Model</span>
                <strong>{(voiceRuntime.modelBytes / 1024 / 1024).toFixed(1)} MiB INT8</strong>
              </li>
              <li>
                <span>Language</span>
                <strong>{voiceRuntime.locale}</strong>
              </li>
              <li>
                <span>Network</span>
                <strong>Never required</strong>
              </li>
              <li>
                <span>Memory</span>
                <strong>
                  {voiceRuntime.loaded
                    ? `Warm · unloads after ${voiceRuntime.idleUnloadSeconds}s idle`
                    : 'Loads on first use'}
                </strong>
              </li>
            </ul>
          ) : null}
          {voiceRuntime?.error ? <p className="settings-warning">{voiceRuntime.error}</p> : null}
          {voiceRuntime?.available ? (
            <button
              className="secondary-button warm-model-button"
              type="button"
              disabled={voiceWarming || voiceRuntime.loaded}
              onClick={() => void warmVoice()}
            >
              {voiceRuntime.loaded
                ? 'Model is warm'
                : voiceWarming
                  ? 'Warming locally…'
                  : 'Warm model now'}
            </button>
          ) : null}
        </SettingsDisclosure>
        <SettingsDisclosure
          eyebrow="Local document intelligence"
          title={
            appInfo === null
              ? 'Checking PlanScan…'
              : appInfo.planScan.available
                ? 'Layout-aware and evidence grounded'
                : 'Using the rules fallback'
          }
          defaultOpen={Boolean(appInfo?.planScan.error)}
        >
          <p className="muted-copy">
            PDF text is read first. Scans use bundled OCR, then the original PlanScan model links
            titles, dates, times, and places from their page positions. Every value still points to
            its source and stays editable until you confirm it.
          </p>
          <ul className="engine-facts">
            {appInfo ? (
              <>
                <li>
                  <span>Original model</span>
                  <strong>{(appInfo.planScan.parameterCount / 1_000_000).toFixed(2)}M INT8</strong>
                </li>
                <li>
                  <span>Installed size</span>
                  <strong>{(appInfo.planScan.modelBytes / 1024).toFixed(0)} KiB</strong>
                </li>
                <li>
                  <span>Working memory</span>
                  <strong>{(appInfo.planScan.workingSetBytes / 1024 / 1024).toFixed(1)} MiB</strong>
                </li>
                <li>
                  <span>Training origin</span>
                  <strong>
                    {appInfo.planScan.teacherUsed ? 'Teacher-assisted' : 'From scratch'}
                  </strong>
                </li>
              </>
            ) : null}
            <li>
              <span>Formats</span>
              <strong>PDF · PNG · JPEG · WebP</strong>
            </li>
            <li>
              <span>Runtime</span>
              <strong>≈19 MiB bundled</strong>
            </li>
            <li>
              <span>Network</span>
              <strong>Never required</strong>
            </li>
            <li>
              <span>Source retention</span>
              <strong>Temporary memory</strong>
            </li>
          </ul>
          {appInfo?.planScan.error ? (
            <p className="settings-warning">{appInfo.planScan.error}</p>
          ) : null}
        </SettingsDisclosure>
      </div>
    </div>
  )
}

function CurrentView({
  route,
  snapshot,
  appInfo,
  onOpen,
  onRepeatDay
}: {
  route: AppRoute
  snapshot: CalendarSnapshot
  appInfo: AppInfo | null
  onOpen: (request: EditorRequest) => void
  onRepeatDay: (date: string) => void
}): ReactNode {
  switch (route) {
    case 'today':
      return <TodayView snapshot={snapshot} onOpen={onOpen} />
    case 'calendar':
      return <CalendarView snapshot={snapshot} onOpen={onOpen} onRepeatDay={onRepeatDay} />
    case 'reminders':
      return <RemindersView snapshot={snapshot} onOpen={onOpen} />
    case 'settings':
      return <SettingsView snapshot={snapshot} appInfo={appInfo} />
  }
}

export function App(): ReactNode {
  const route = useUiStore((state) => state.route)
  const theme = useUiStore((state) => state.theme)
  const setTheme = useUiStore((state) => state.setTheme)
  const setRoute = useUiStore((state) => state.setRoute)
  const assistantOpen = useUiStore((state) => state.assistantOpen)
  const assistantWide = useUiStore((state) => state.assistantWide)
  const setAssistantOpen = useUiStore((state) => state.setAssistantOpen)
  const toggleAssistantWide = useUiStore((state) => state.toggleAssistantWide)
  const snapshot = useCalendarStore((state) => state.snapshot)
  const loading = useCalendarStore((state) => state.loading)
  const error = useCalendarStore((state) => state.error)
  const toast = useCalendarStore((state) => state.toast)
  const initialize = useCalendarStore((state) => state.initialize)
  const clearError = useCalendarStore((state) => state.clearError)
  const dismissToast = useCalendarStore((state) => state.dismissToast)
  const undo = useCalendarStore((state) => state.undo)
  const completeReminder = useCalendarStore((state) => state.completeReminder)
  const calendarBusy = useCalendarStore((state) => state.busy)
  const windowState = useWindowStore((state) => state.state)
  const windowBusy = useWindowStore((state) => state.busy)
  const initializeWindow = useWindowStore((state) => state.initialize)
  const setWindowMode = useWindowStore((state) => state.setMode)
  const setWindowPinned = useWindowStore((state) => state.setPinned)
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const [bridgeError, setBridgeError] = useState(false)
  const [editor, setEditor] = useState<EditorRequest | null>(null)
  const [repeatDayDate, setRepeatDayDate] = useState<string | null>(null)
  const [documentPlannerOpen, setDocumentPlannerOpen] = useState(false)
  const [assistantMounted, setAssistantMounted] = useState(assistantOpen)

  useEffect(() => {
    void initialize()
    void initializeWindow()
    window.remindMe
      .getAppInfo()
      .then(setAppInfo)
      .catch(() => setBridgeError(true))
  }, [initialize, initializeWindow])
  useEffect(() => {
    document.documentElement.dataset.windowMode = windowState?.mode ?? 'full'
  }, [windowState?.mode])
  useEffect(() => {
    const preferences = snapshot?.preferences
    if (preferences && isThemeId(preferences.themeId) && preferences.themeId !== theme)
      setTheme(preferences.themeId)
    document.documentElement.dataset.density = preferences?.density ?? 'comfortable'
    document.documentElement.dataset.reduceMotion = String(preferences?.reduceMotion ?? false)
    document.documentElement.dataset.windowControlsOverlay = String(
      appInfo?.appearance.windowControlsOverlay ?? false
    )
    if (preferences)
      applyAppearanceToDocument(
        appearanceFromPreferences(preferences),
        appInfo?.appearance.transparentWindow ?? false
      )
    else document.documentElement.dataset.theme = theme
  }, [appInfo?.appearance, setTheme, snapshot?.preferences, theme])
  useEffect(() => {
    if (assistantOpen) {
      setAssistantMounted(true)
      return
    }
    if (!assistantMounted) return
    const reduceMotion =
      snapshot?.preferences.reduceMotion === true ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const timeout = window.setTimeout(() => setAssistantMounted(false), reduceMotion ? 0 : 220)
    return () => window.clearTimeout(timeout)
  }, [assistantMounted, assistantOpen, snapshot?.preferences.reduceMotion])

  const timezone =
    snapshot?.preferences.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const dateLabel = new Intl.DateTimeFormat(snapshot?.preferences.locale, {
    timeZone: timezone,
    weekday: 'long',
    month: 'long',
    day: 'numeric'
  }).format(new Date())
  const routeName = navigationItems.find((item) => item.id === route)?.label ?? 'Today'
  const toastNode = toast ? (
    <div className="toast" role="status">
      <span>{toast.message}</span>
      {toast.undoable && snapshot?.canUndo ? (
        <button type="button" onClick={() => void undo()}>
          Undo
        </button>
      ) : null}
      <button className="toast-close" type="button" onClick={dismissToast} aria-label="Dismiss">
        ×
      </button>
    </div>
  ) : null
  const windowDragNode = appInfo?.appearance.windowControlsOverlay ? (
    <div className="window-drag-region" aria-hidden="true" />
  ) : null

  async function openFull(routeToOpen?: AppRoute): Promise<void> {
    if (routeToOpen) setRoute(routeToOpen)
    await setWindowMode('full')
  }

  async function enterWidget(): Promise<void> {
    setAssistantOpen(false)
    await setWindowMode('widget')
  }

  function openAssistant(): void {
    setAssistantMounted(true)
    setAssistantOpen(true)
  }

  function closeAssistant(): void {
    setAssistantOpen(false)
  }

  async function openWidgetEditor(request: EditorRequest): Promise<void> {
    if (await setWindowMode('full')) setEditor(request)
  }

  async function openWidgetDocument(): Promise<void> {
    if (await setWindowMode('full')) setDocumentPlannerOpen(true)
  }

  if (windowState?.mode === 'widget' || windowState?.mode === 'glance') {
    return (
      <div className="widget-root">
        {windowDragNode}
        <DesktopWidget
          snapshot={snapshot}
          loading={loading}
          error={error}
          pinned={windowState.pinned}
          busy={windowBusy || calendarBusy}
          mode={windowState.mode}
          onSetPinned={(pinned) => void setWindowPinned(pinned)}
          onSetCompactMode={(mode) => void setWindowMode(mode)}
          onExpand={(routeToOpen) => void openFull(routeToOpen)}
          onOpenAssistant={() => {
            void setWindowMode('full').then((opened) => {
              if (opened) openAssistant()
            })
          }}
          onOpenDocument={() => void openWidgetDocument()}
          onOpenEditor={(request) => void openWidgetEditor(request)}
          onQuickAdd={(date) =>
            void openWidgetEditor({ kind: 'event', event: null, date, title: null })
          }
          onOpenEvent={(eventId) => {
            const event = snapshot?.events.find((candidate) => candidate.id === eventId)
            if (event) void openWidgetEditor({ kind: 'event', event, date: null, title: null })
          }}
          onOpenReminder={(reminderId) => {
            const reminder = snapshot?.reminders.find((candidate) => candidate.id === reminderId)
            if (reminder)
              void openWidgetEditor({ kind: 'reminder', reminder, date: null, title: null })
          }}
          onCompleteReminder={(reminderId) => void completeReminder(reminderId)}
        />
        {toastNode}
      </div>
    )
  }

  return (
    <div className="app-shell" data-testid="app-shell">
      {windowDragNode}
      <Navigation snapshot={snapshot} onEnterWidget={() => void enterWidget()} />
      <main className="main-content">
        <header className="topbar">
          <div>
            <p className="date-line">{dateLabel}</p>
            <h1>{route === 'today' ? 'Good to see you.' : routeName}</h1>
          </div>
          <div className="topbar-actions">
            <div
              className="bridge-status"
              data-ready={Boolean(appInfo)}
              data-testid="bridge-status"
            >
              <span className="status-dot" aria-hidden="true" />
              {bridgeError
                ? 'Bridge unavailable'
                : appInfo
                  ? `Local · v${appInfo.version}`
                  : 'Starting locally…'}
            </div>
            <button
              className="document-import-button"
              data-testid="document-import-button"
              type="button"
              disabled={!snapshot}
              onClick={() => setDocumentPlannerOpen(true)}
              title="Create reviewed plans from an image or PDF"
            >
              <span aria-hidden="true">▧</span>
              Import plan
            </button>
            <button
              className="assistant-toggle-button"
              data-active={assistantOpen}
              data-testid="assistant-toggle"
              type="button"
              onClick={() => (assistantOpen ? closeAssistant() : openAssistant())}
            >
              <span aria-hidden="true">✦</span>
              {assistantOpen ? 'Hide assistant' : 'Ask Remind Me'}
            </button>
            <button
              className="widget-mode-button"
              data-testid="widget-mode-button"
              type="button"
              disabled={windowBusy}
              onClick={() => void enterWidget()}
            >
              Mini view
            </button>
            <button
              className="quick-add"
              type="button"
              onClick={() => setEditor({ kind: 'event', event: null, date: null, title: null })}
            >
              + Quick add
            </button>
          </div>
        </header>
        {error ? (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button type="button" onClick={clearError} aria-label="Dismiss error">
              ×
            </button>
          </div>
        ) : null}
        <div className="view-container">
          {snapshot ? (
            <div className="view-transition-layer" key={route}>
              <CurrentView
                route={route}
                snapshot={snapshot}
                appInfo={appInfo}
                onOpen={setEditor}
                onRepeatDay={setRepeatDayDate}
              />
            </div>
          ) : (
            <section className="paper-card loading-card" aria-live="polite">
              <span className="loading-sun" aria-hidden="true" />
              <h2>{loading ? 'Opening your local calendar…' : 'Your calendar could not open.'}</h2>
              <p>No account or network is needed.</p>
            </section>
          )}
        </div>
      </main>
      {assistantMounted ? (
        <aside
          className="assistant-sidebar"
          data-state={assistantOpen ? 'open' : 'closing'}
          data-wide={assistantWide}
          aria-label="Local assistant"
        >
          <AssistantPanel
            mode="sidebar"
            wide={assistantWide}
            onOpen={setEditor}
            onClose={closeAssistant}
            onToggleWide={toggleAssistantWide}
            onOpenDocument={() => setDocumentPlannerOpen(true)}
          />
        </aside>
      ) : !assistantOpen ? (
        <button
          className="assistant-rail-button"
          type="button"
          onClick={openAssistant}
          aria-label="Open local assistant"
        >
          <span aria-hidden="true">✦</span>
          Ask
        </button>
      ) : null}
      {editor ? <EditorDialog request={editor} onClose={() => setEditor(null)} /> : null}
      {repeatDayDate && snapshot ? (
        <RepeatDayScheduleDialog
          date={repeatDayDate}
          snapshot={snapshot}
          onClose={() => setRepeatDayDate(null)}
        />
      ) : null}
      {documentPlannerOpen ? (
        <DocumentImportDialog onClose={() => setDocumentPlannerOpen(false)} />
      ) : null}
      {toastNode}
    </div>
  )
}
