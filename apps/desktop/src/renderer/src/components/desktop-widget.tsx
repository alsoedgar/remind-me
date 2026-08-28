import { useMemo, useState, type ReactNode } from 'react'
import type { AppWindowMode, CalendarSnapshot } from '@remind-me/contracts'
import { formatDueDate, formatEventTime, localParts, todayDate } from '../calendar-utils'
import { dayAgendaItems, type DayAgendaItem } from '../day-agenda'
import type { AppRoute } from '../store/ui-store'
import {
  activeWidgetReminders,
  addLocalDays,
  buildWidgetWeek,
  type WidgetOccurrence
} from '../widget-data'
import { AssistantPanel } from './assistant-panel'
import type { EditorRequest } from './editors'

type WidgetTab = 'agenda' | 'reminders' | 'assistant'

function compactTimeRange(occurrence: WidgetOccurrence, locale: string): string {
  if (occurrence.allDay) return 'All day'
  const formatter = new Intl.DateTimeFormat(locale, {
    timeZone: occurrence.timezone,
    hour: 'numeric',
    minute: '2-digit'
  })
  return `${formatter.format(new Date(occurrence.startUtc))}–${formatter.format(new Date(occurrence.endUtc))}`
}

function compactEventDetails(occurrence: WidgetOccurrence): string[] {
  const details: string[] = []
  if (occurrence.location.trim()) details.push(occurrence.location.trim())
  const description = occurrence.description.trim().replace(/\s+/gu, ' ')
  if (description)
    details.push(description.length > 92 ? `${description.slice(0, 89)}…` : description)
  if (occurrence.recurring && details.length < 2) details.push('Repeating event')
  return details.slice(0, 2)
}

function MiniAgendaItem({
  item,
  locale,
  onOpenEvent,
  onOpenReminder
}: {
  item: DayAgendaItem
  locale: string
  onOpenEvent: (eventId: string) => void
  onOpenReminder: (reminderId: string) => void
}): ReactNode {
  if (item.kind === 'event') {
    const occurrence = item.occurrence
    return (
      <button
        className="widget-list-item"
        type="button"
        onClick={() => onOpenEvent(occurrence.eventId)}
      >
        <span className="widget-item-time">
          {formatEventTime(occurrence.startUtc, occurrence.timezone, locale, occurrence.allDay)}
        </span>
        <span>
          <strong>{occurrence.title}</strong>
          <small className="widget-item-range">{compactTimeRange(occurrence, locale)}</small>
          {compactEventDetails(occurrence).map((detail) => (
            <small className="widget-item-detail" key={detail}>
              {detail}
            </small>
          ))}
        </span>
        <span aria-hidden="true">›</span>
      </button>
    )
  }

  return (
    <button
      className="widget-list-item widget-day-reminder"
      type="button"
      onClick={() => onOpenReminder(item.reminder.id)}
    >
      <span className="widget-item-time">
        {formatDueDate(item.reminder.dueAtUtc, item.reminder.timezone, locale)}
      </span>
      <span>
        <strong>{item.reminder.title}</strong>
        <small className="widget-item-detail">Reminder</small>
        {item.reminder.notes ? (
          <small className="widget-item-detail">{item.reminder.notes}</small>
        ) : null}
      </span>
      <span aria-hidden="true">›</span>
    </button>
  )
}

function GlanceAgendaItem({
  item,
  locale,
  onOpenEvent,
  onOpenReminder
}: {
  item: DayAgendaItem
  locale: string
  onOpenEvent: (eventId: string) => void
  onOpenReminder: (reminderId: string) => void
}): ReactNode {
  if (item.kind === 'event') {
    const occurrence = item.occurrence
    const detail = compactEventDetails(occurrence)[0]
    return (
      <button
        className="glance-agenda-item"
        type="button"
        onClick={() => onOpenEvent(occurrence.eventId)}
      >
        <time>
          {formatEventTime(occurrence.startUtc, occurrence.timezone, locale, occurrence.allDay)}
        </time>
        <span>
          <strong>{occurrence.title}</strong>
          {detail ? <small>{detail}</small> : null}
        </span>
        <span aria-hidden="true">›</span>
      </button>
    )
  }

  return (
    <button
      className="glance-agenda-item glance-reminder-item"
      type="button"
      onClick={() => onOpenReminder(item.reminder.id)}
    >
      <time>{formatDueDate(item.reminder.dueAtUtc, item.reminder.timezone, locale)}</time>
      <span>
        <strong>{item.reminder.title}</strong>
        <small>Reminder</small>
      </span>
      <span aria-hidden="true">›</span>
    </button>
  )
}

function GlanceReminderItem({
  reminder,
  locale,
  onOpenReminder
}: {
  reminder: CalendarSnapshot['reminders'][number]
  locale: string
  onOpenReminder: (reminderId: string) => void
}): ReactNode {
  return (
    <button
      className="glance-agenda-item glance-reminder-item"
      type="button"
      onClick={() => onOpenReminder(reminder.id)}
    >
      <time>
        {formatDueDate(reminder.dueAtUtc, reminder.timezone, locale, { includeDate: true })}
      </time>
      <span>
        <strong>{reminder.title}</strong>
        {reminder.notes ? <small>{reminder.notes}</small> : <small>Reminder</small>}
      </span>
      <span aria-hidden="true">›</span>
    </button>
  )
}

export function DesktopWidget({
  snapshot,
  loading,
  error,
  pinned,
  busy,
  mode,
  onSetPinned,
  onSetCompactMode,
  onExpand,
  onOpenAssistant,
  onOpenDocument,
  onOpenEditor,
  onQuickAdd,
  onOpenEvent,
  onOpenReminder,
  onCompleteReminder
}: {
  snapshot: CalendarSnapshot | null
  loading: boolean
  error: string | null
  pinned: boolean
  busy: boolean
  mode: Extract<AppWindowMode, 'widget' | 'glance'>
  onSetPinned: (pinned: boolean) => void
  onSetCompactMode: (mode: Extract<AppWindowMode, 'widget' | 'glance'>) => void
  onExpand: (route?: AppRoute) => void
  onOpenAssistant: () => void
  onOpenDocument: () => void
  onOpenEditor: (request: EditorRequest) => void
  onQuickAdd: (date: string) => void
  onOpenEvent: (eventId: string) => void
  onOpenReminder: (reminderId: string) => void
  onCompleteReminder: (reminderId: string) => void
}): ReactNode {
  const timezone =
    snapshot?.preferences.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const locale = snapshot?.preferences.locale ?? 'en-US'
  const today = todayDate(timezone)
  const [selectedDate, setSelectedDate] = useState(today)
  const [weekAnchor, setWeekAnchor] = useState(today)
  const [tab, setTab] = useState<WidgetTab>('agenda')
  const week = useMemo(
    () => buildWidgetWeek(weekAnchor, snapshot?.occurrences ?? [], locale),
    [locale, snapshot?.occurrences, weekAnchor]
  )
  const selectedDayItems = useMemo(
    () => dayAgendaItems(snapshot?.occurrences ?? [], snapshot?.reminders ?? [], selectedDate),
    [selectedDate, snapshot?.occurrences, snapshot?.reminders]
  )
  const reminders = activeWidgetReminders(snapshot?.reminders ?? [])
  const selectedDateLabel = new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC'
  }).format(new Date(`${selectedDate}T12:00:00.000Z`))
  const compactSelectedDateLabel = new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC'
  }).format(new Date(`${selectedDate}T12:00:00.000Z`))

  function selectDate(date: string): void {
    setSelectedDate(date)
    setTab('agenda')
  }

  function shiftSelectedDate(offset: number): void {
    const next = addLocalDays(selectedDate, offset)
    setSelectedDate(next)
    if (next < weekAnchor || next > addLocalDays(weekAnchor, 6)) setWeekAnchor(next)
    setTab('agenda')
  }

  function selectToday(): void {
    setSelectedDate(today)
    setWeekAnchor(today)
    setTab('agenda')
  }

  const compactAssistant = (
    <AssistantPanel mode="compact" onOpen={onOpenEditor} onOpenDocument={onOpenDocument} />
  )

  if (mode === 'glance') {
    return (
      <main className="desktop-widget glance-widget" data-testid="glance-widget" data-view={tab}>
        <header className="glance-header">
          <div>
            <span className="widget-brand-mark" aria-hidden="true">
              ◒
            </span>
            <strong>Remind Me</strong>
          </div>
          <div className="glance-actions">
            <button
              type="button"
              data-active={pinned}
              disabled={busy}
              onClick={() => onSetPinned(!pinned)}
              aria-pressed={pinned}
              title={pinned ? 'Let other windows cover this glance' : 'Keep this glance visible'}
            >
              {pinned ? '●' : '○'}
              <span className="visually-hidden">Toggle always on top</span>
            </button>
            <button type="button" disabled={busy} onClick={() => onSetCompactMode('widget')}>
              Mini
            </button>
            <button type="button" disabled={busy} onClick={() => onExpand()}>
              ↗<span className="visually-hidden">Open full app</span>
            </button>
          </div>
        </header>

        <nav className="glance-tabs" aria-label="Tiny view">
          <button type="button" data-active={tab === 'agenda'} onClick={() => setTab('agenda')}>
            Day <span>{selectedDayItems.length}</span>
          </button>
          <button
            type="button"
            data-active={tab === 'reminders'}
            onClick={() => setTab('reminders')}
          >
            Reminders <span>{reminders.length}</span>
          </button>
          <button
            type="button"
            data-active={tab === 'assistant'}
            onClick={() => setTab('assistant')}
          >
            ✦ Ask
          </button>
        </nav>

        {tab === 'assistant' ? (
          <section className="glance-assistant-shell" aria-label="Local assistant">
            <header className="glance-assistant-bar">
              <span>
                <strong>Local assistant</strong>
                <small>Private · on device</small>
              </span>
              <button type="button" onClick={onOpenAssistant}>
                Full chat ↗
              </button>
            </header>
            <div className="glance-assistant">{compactAssistant}</div>
          </section>
        ) : (
          <>
            {tab === 'agenda' ? (
              <div className="glance-day-nav">
                <button
                  type="button"
                  onClick={() => shiftSelectedDate(-1)}
                  aria-label="Previous day"
                >
                  ←
                </button>
                <button type="button" onClick={selectToday} title="Return to today">
                  {compactSelectedDateLabel}
                </button>
                <button type="button" onClick={() => shiftSelectedDate(1)} aria-label="Next day">
                  →
                </button>
              </div>
            ) : (
              <div className="glance-section-heading">
                <strong>Active reminders</strong>
                <small>Scroll to see all</small>
              </div>
            )}
            <section className="glance-agenda" aria-live="polite">
              {!snapshot ? (
                <div className="glance-agenda-empty">
                  <strong>{loading ? 'Opening calendar…' : 'Calendar unavailable'}</strong>
                  <small>{error ?? 'Your plans stay on this device.'}</small>
                </div>
              ) : tab === 'agenda' && selectedDayItems.length ? (
                selectedDayItems.map((item) => (
                  <GlanceAgendaItem
                    item={item}
                    locale={locale}
                    key={`${item.kind}:${item.id}`}
                    onOpenEvent={onOpenEvent}
                    onOpenReminder={onOpenReminder}
                  />
                ))
              ) : tab === 'reminders' && reminders.length ? (
                reminders.map((reminder) => (
                  <GlanceReminderItem
                    key={reminder.id}
                    reminder={reminder}
                    locale={locale}
                    onOpenReminder={onOpenReminder}
                  />
                ))
              ) : tab === 'agenda' ? (
                <button
                  type="button"
                  className="glance-agenda-empty"
                  onClick={() => onQuickAdd(selectedDate)}
                >
                  <strong>A quiet day</strong>
                  <small>Tap to add a plan.</small>
                </button>
              ) : (
                <button
                  type="button"
                  className="glance-agenda-empty"
                  onClick={() =>
                    onOpenEditor({
                      kind: 'reminder',
                      reminder: null,
                      date: selectedDate,
                      title: null
                    })
                  }
                >
                  <strong>No active reminders</strong>
                  <small>Tap to add one.</small>
                </button>
              )}
            </section>
            <footer className="glance-footer">
              <span>
                {tab === 'agenda' && selectedDayItems.length
                  ? `${selectedDayItems.length} ${selectedDayItems.length === 1 ? 'item' : 'items'} · scroll for all`
                  : tab === 'reminders' && reminders.length
                    ? `${reminders.length} active · scroll for all`
                    : 'Private · on device'}
              </span>
              <button
                type="button"
                onClick={() => {
                  if (tab === 'agenda') onQuickAdd(selectedDate)
                  else
                    onOpenEditor({
                      kind: 'reminder',
                      reminder: null,
                      date: selectedDate,
                      title: null
                    })
                }}
              >
                {tab === 'agenda' ? '+ Add' : '+ Reminder'}
              </button>
            </footer>
          </>
        )}
      </main>
    )
  }

  return (
    <main className="desktop-widget" data-testid="desktop-widget" data-view={tab}>
      <header className="widget-header">
        <div className="widget-brand">
          <span className="widget-brand-mark" aria-hidden="true">
            ◒
          </span>
          <div>
            <strong>Remind Me</strong>
            <small>{pinned ? 'staying nearby' : 'mini calendar'}</small>
          </div>
        </div>
        <div className="widget-window-actions">
          <button type="button" disabled={busy} onClick={() => onSetCompactMode('glance')}>
            Tiny
          </button>
          <button
            type="button"
            data-active={pinned}
            disabled={busy}
            onClick={() => onSetPinned(!pinned)}
            aria-pressed={pinned}
            title={pinned ? 'Let other windows cover this widget' : 'Keep this widget visible'}
          >
            {pinned ? 'Pinned' : 'Pin'}
          </button>
          <button type="button" disabled={busy} onClick={() => onExpand()}>
            Open app ↗
          </button>
        </div>
      </header>

      {tab !== 'assistant' ? (
        <section className="widget-date-card" aria-labelledby="widget-date-heading">
          <div className="widget-date-heading">
            <div>
              <p className="eyebrow">Every plan, one day</p>
              <h1 id="widget-date-heading">{selectedDateLabel}</h1>
            </div>
            <div className="widget-date-actions">
              <button type="button" onClick={() => shiftSelectedDate(-1)} aria-label="Previous day">
                ←
              </button>
              <button type="button" onClick={selectToday} title="Return to today">
                Today
              </button>
              <button type="button" onClick={() => shiftSelectedDate(1)} aria-label="Next day">
                →
              </button>
              <button
                type="button"
                className="widget-add-button"
                onClick={() => onQuickAdd(selectedDate)}
              >
                +<span className="visually-hidden">Add a plan on {selectedDateLabel}</span>
              </button>
            </div>
          </div>
          <div className="widget-week" aria-label="Seven-day calendar strip">
            {week.map((day) => (
              <button
                type="button"
                key={day.date}
                data-selected={day.date === selectedDate}
                onClick={() => selectDate(day.date)}
                aria-label={`${day.date}, ${day.eventCount} events`}
              >
                <span>{day.weekday}</span>
                <strong>{day.dayNumber}</strong>
                <i data-visible={day.eventCount > 0} aria-hidden="true" />
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <nav className="widget-tabs" aria-label="Mini view">
        <button type="button" data-active={tab === 'agenda'} onClick={() => setTab('agenda')}>
          Day <span>{selectedDayItems.length}</span>
        </button>
        <button type="button" data-active={tab === 'reminders'} onClick={() => setTab('reminders')}>
          Reminders <span>{reminders.length}</span>
        </button>
        <button type="button" data-active={tab === 'assistant'} onClick={() => setTab('assistant')}>
          ✦ Assistant
        </button>
      </nav>

      {tab === 'assistant' ? (
        <section className="widget-assistant" aria-label="Local assistant">
          {compactAssistant}
        </section>
      ) : (
        <section className="widget-list" aria-live="polite">
          {!snapshot ? (
            <div className="widget-empty">
              <span className="widget-loading-mark" aria-hidden="true" />
              <strong>{loading ? 'Opening your calendar…' : 'Calendar unavailable'}</strong>
              <small>{error ?? 'Everything stays on this device.'}</small>
            </div>
          ) : tab === 'agenda' ? (
            selectedDayItems.length ? (
              selectedDayItems.map((item) => (
                <MiniAgendaItem
                  item={item}
                  locale={locale}
                  key={`${item.kind}:${item.id}`}
                  onOpenEvent={onOpenEvent}
                  onOpenReminder={onOpenReminder}
                />
              ))
            ) : (
              <div className="widget-empty">
                <span aria-hidden="true">☼</span>
                <strong>A quiet page</strong>
                <small>No events or reminders on this day.</small>
              </div>
            )
          ) : reminders.length ? (
            reminders.map((reminder) => {
              const overdue = Date.parse(reminder.dueAtUtc) < Date.now()
              return (
                <div
                  className="widget-list-item widget-reminder-item"
                  data-overdue={overdue}
                  key={reminder.id}
                >
                  <button
                    className="widget-check-button"
                    type="button"
                    disabled={busy}
                    onClick={() => onCompleteReminder(reminder.id)}
                    aria-label={`Complete ${reminder.title}`}
                  >
                    ✓
                  </button>
                  <button type="button" onClick={() => onOpenReminder(reminder.id)}>
                    <span>
                      <strong>{reminder.title}</strong>
                      <small>
                        {overdue ? 'Overdue · ' : ''}
                        {formatDueDate(reminder.dueAtUtc, reminder.timezone, locale, {
                          includeDate:
                            localParts(reminder.dueAtUtc, reminder.timezone).date !== today
                        })}
                      </small>
                    </span>
                    <span aria-hidden="true">›</span>
                  </button>
                </div>
              )
            })
          ) : (
            <div className="widget-empty">
              <span aria-hidden="true">✓</span>
              <strong>Nothing tugging at you</strong>
              <small>Your active reminders will settle here.</small>
            </div>
          )}
        </section>
      )}

      <footer className="widget-footer">
        {tab === 'assistant' ? (
          <>
            <button type="button" className="widget-ask-button" onClick={() => setTab('agenda')}>
              <span aria-hidden="true">←</span>
              Back to day
            </button>
            <button type="button" onClick={onOpenAssistant}>
              Full chat ↗
            </button>
          </>
        ) : (
          <>
            <button type="button" className="widget-ask-button" onClick={() => setTab('assistant')}>
              <span aria-hidden="true">✦</span>
              Ask your local assistant
            </button>
            <button
              type="button"
              onClick={() => onExpand(tab === 'agenda' ? 'calendar' : 'reminders')}
            >
              See all
            </button>
          </>
        )}
      </footer>
    </main>
  )
}
