import { useMemo, useState, type ReactNode } from 'react'
import type { AppRoute } from '../store/ui-store'
import type { AppWindowMode, CalendarSnapshot } from '@remind-me/contracts'
import { formatDueDate, formatEventTime, localParts, todayDate } from '../calendar-utils'
import { activeWidgetReminders, buildWidgetWeek, eventsForWidgetDay } from '../widget-data'
import type { WidgetOccurrence } from '../widget-data'

type WidgetTab = 'agenda' | 'reminders'

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
  const [tab, setTab] = useState<WidgetTab>('agenda')
  const week = useMemo(
    () => buildWidgetWeek(today, snapshot?.occurrences ?? [], locale),
    [locale, snapshot?.occurrences, today]
  )
  const selectedEvents = eventsForWidgetDay(snapshot?.occurrences ?? [], selectedDate)
  const reminders = activeWidgetReminders(snapshot?.reminders ?? [])
  const selectedDateLabel = new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC'
  }).format(new Date(`${selectedDate}T12:00:00.000Z`))

  if (mode === 'glance') {
    const now = Date.now()
    const todayEvents = eventsForWidgetDay(snapshot?.occurrences ?? [], today, 8)
    const upcomingEvents = [...(snapshot?.occurrences ?? [])]
      .filter((occurrence) => Date.parse(occurrence.endUtc) > now)
      .sort((left, right) => Date.parse(left.startUtc) - Date.parse(right.startUtc))
    const nextEvent =
      todayEvents.find((occurrence) => Date.parse(occurrence.endUtc) > now) ??
      upcomingEvents[0] ??
      todayEvents[0] ??
      null
    const nextReminder = reminders[0] ?? null
    const remainingCount = nextEvent
      ? Math.max(
          0,
          eventsForWidgetDay(snapshot?.occurrences ?? [], nextEvent.originalDate, 8).length - 1
        )
      : 0
    const nextEventDayLabel = nextEvent
      ? new Intl.DateTimeFormat(locale, {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
          timeZone: 'UTC'
        }).format(new Date(`${nextEvent.originalDate}T12:00:00.000Z`))
      : ''

    return (
      <main className="desktop-widget glance-widget" data-testid="glance-widget">
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
        <section className="glance-date">
          <span>{new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(new Date())}</span>
          <strong>
            {new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(new Date())}
          </strong>
        </section>
        {nextEvent ? (
          <button
            type="button"
            className="glance-primary"
            onClick={() => onOpenEvent(nextEvent.eventId)}
          >
            <span className="eyebrow">
              {nextEvent.originalDate !== today
                ? `Next · ${nextEventDayLabel}`
                : Date.parse(nextEvent.startUtc) > now
                  ? 'Up next'
                  : 'Happening now'}
            </span>
            <strong>{nextEvent.title}</strong>
            <span>{compactTimeRange(nextEvent, locale)}</span>
            {compactEventDetails(nextEvent).map((detail) => (
              <small key={detail}>{detail}</small>
            ))}
          </button>
        ) : nextReminder ? (
          <button
            type="button"
            className="glance-primary"
            onClick={() => onOpenReminder(nextReminder.id)}
          >
            <span className="eyebrow">Next reminder</span>
            <strong>{nextReminder.title}</strong>
            <span>{formatDueDate(nextReminder.dueAtUtc, nextReminder.timezone, locale)}</span>
          </button>
        ) : (
          <button
            type="button"
            className="glance-primary glance-empty"
            onClick={() => onQuickAdd(today)}
          >
            <span className="eyebrow">Today</span>
            <strong>A quiet page</strong>
            <small>Tap to add something.</small>
          </button>
        )}
        <footer className="glance-footer">
          <span>
            {remainingCount
              ? `+${remainingCount} more ${nextEvent?.originalDate === today ? 'today' : 'that day'}`
              : 'Private · on device'}
          </span>
          <button type="button" onClick={onOpenAssistant}>
            ✦ Ask
          </button>
        </footer>
      </main>
    )
  }

  return (
    <main className="desktop-widget" data-testid="desktop-widget">
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

      <section className="widget-date-card" aria-labelledby="widget-date-heading">
        <div className="widget-date-heading">
          <div>
            <p className="eyebrow">Seven gentle days</p>
            <h1 id="widget-date-heading">{selectedDateLabel}</h1>
          </div>
          <button
            type="button"
            className="widget-add-button"
            onClick={() => onQuickAdd(selectedDate)}
          >
            +<span className="visually-hidden">Add a plan on {selectedDateLabel}</span>
          </button>
        </div>
        <div className="widget-week" aria-label="Next seven days">
          {week.map((day) => (
            <button
              type="button"
              key={day.date}
              data-selected={day.date === selectedDate}
              onClick={() => {
                setSelectedDate(day.date)
                setTab('agenda')
              }}
              aria-label={`${day.date}, ${day.eventCount} events`}
            >
              <span>{day.weekday}</span>
              <strong>{day.dayNumber}</strong>
              <i data-visible={day.eventCount > 0} aria-hidden="true" />
            </button>
          ))}
        </div>
      </section>

      <nav className="widget-tabs" aria-label="Mini view">
        <button type="button" data-active={tab === 'agenda'} onClick={() => setTab('agenda')}>
          Day <span>{selectedEvents.length}</span>
        </button>
        <button type="button" data-active={tab === 'reminders'} onClick={() => setTab('reminders')}>
          Reminders <span>{reminders.length}</span>
        </button>
      </nav>

      <section className="widget-list" aria-live="polite">
        {!snapshot ? (
          <div className="widget-empty">
            <span className="widget-loading-mark" aria-hidden="true" />
            <strong>{loading ? 'Opening your calendar…' : 'Calendar unavailable'}</strong>
            <small>{error ?? 'Everything stays on this device.'}</small>
          </div>
        ) : tab === 'agenda' ? (
          selectedEvents.length ? (
            selectedEvents.map((occurrence) => (
              <button
                className="widget-list-item"
                type="button"
                key={occurrence.occurrenceId}
                onClick={() => onOpenEvent(occurrence.eventId)}
              >
                <span className="widget-item-time">
                  {formatEventTime(
                    occurrence.startUtc,
                    occurrence.timezone,
                    locale,
                    occurrence.allDay
                  )}
                </span>
                <span>
                  <strong>{occurrence.title}</strong>
                  <small className="widget-item-range">
                    {compactTimeRange(occurrence, locale)}
                  </small>
                  {compactEventDetails(occurrence).map((detail) => (
                    <small className="widget-item-detail" key={detail}>
                      {detail}
                    </small>
                  ))}
                </span>
                <span aria-hidden="true">›</span>
              </button>
            ))
          ) : (
            <div className="widget-empty">
              <span aria-hidden="true">☼</span>
              <strong>A quiet page</strong>
              <small>No events on this day.</small>
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
                        includeDate: localParts(reminder.dueAtUtc, reminder.timezone).date !== today
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

      <footer className="widget-footer">
        <button type="button" className="widget-ask-button" onClick={onOpenAssistant}>
          <span aria-hidden="true">✦</span>
          Ask your local assistant
        </button>
        <button type="button" onClick={() => onExpand(tab === 'agenda' ? 'calendar' : 'reminders')}>
          See all
        </button>
      </footer>
    </main>
  )
}
