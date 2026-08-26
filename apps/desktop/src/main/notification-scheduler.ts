import { Notification } from 'electron'
import type { SqliteCalendarRepository } from '@remind-me/storage'

const maximumTimerDelay = 2_147_000_000

export class ReminderNotificationScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false

  constructor(
    private readonly repository: SqliteCalendarRepository,
    private readonly onNotificationClick: () => void,
    private readonly allowNotifications = true
  ) {}

  reschedule(): void {
    this.clearTimer()
    if (this.stopped || !this.allowNotifications) return
    if (!this.repository.getPreferences().notificationsEnabled || !Notification.isSupported()) {
      return
    }

    const next = this.repository.listPendingReminderNotifications()[0]
    if (!next) return
    const delay = Date.parse(next.dueAtUtc) - Date.now()
    if (delay <= 0) {
      queueMicrotask(() => this.deliverDue())
      return
    }
    this.timer = setTimeout(() => this.deliverDue(), Math.min(delay, maximumTimerDelay))
  }

  stop(): void {
    this.stopped = true
    this.clearTimer()
  }

  private deliverDue(): void {
    this.clearTimer()
    if (this.stopped || !this.repository.getPreferences().notificationsEnabled) return

    const now = new Date()
    const nowIso = now.toISOString()
    for (const reminder of this.repository.listPendingReminderNotifications()) {
      if (Date.parse(reminder.dueAtUtc) > now.getTime()) break
      const notification = new Notification({
        title: reminder.title,
        body: reminder.notes || 'This reminder is due now.',
        silent: false
      })
      notification.on('click', this.onNotificationClick)
      notification.show()
      this.repository.recordReminderNotification(reminder.id, reminder.dueAtUtc, nowIso)
    }
    this.reschedule()
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}
