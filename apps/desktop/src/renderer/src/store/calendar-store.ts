import { create } from 'zustand'
import type {
  CalendarSnapshot,
  CalendarSnapshotRequest,
  CalendarMutationResult,
  CalendarBatchItem,
  EventForm,
  PreferencesUpdate,
  ReminderForm
} from '@remind-me/contracts'
import { snapshotRange } from '../calendar-utils'

interface ToastState {
  message: string
  undoable: boolean
}

interface CalendarState {
  snapshot: CalendarSnapshot | null
  range: CalendarSnapshotRequest
  loading: boolean
  busy: boolean
  error: string | null
  toast: ToastState | null
  initialize: () => Promise<void>
  loadFor: (anchor?: Date) => Promise<void>
  saveEvent: (form: EventForm) => Promise<boolean>
  applyBatch: (items: CalendarBatchItem[], summary: string) => Promise<boolean>
  deleteEvent: (id: string) => Promise<boolean>
  saveReminder: (form: ReminderForm) => Promise<boolean>
  completeReminder: (id: string) => Promise<boolean>
  deleteReminder: (id: string) => Promise<boolean>
  undo: () => Promise<void>
  updatePreferences: (update: PreferencesUpdate) => Promise<boolean>
  exportData: (format: 'json' | 'ics') => Promise<void>
  importData: () => Promise<void>
  deleteAllData: () => Promise<boolean>
  applyMutationResult: (result: CalendarMutationResult) => void
  clearError: () => void
  dismissToast: () => void
}

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return 'Something went wrong.'
  return error.message.replace(/^Error invoking remote method '[^']+': Error: /, '')
}

export const useCalendarStore = create<CalendarState>((set, get) => ({
  snapshot: null,
  range: snapshotRange(),
  loading: false,
  busy: false,
  error: null,
  toast: null,

  initialize: async () => {
    if (get().loading || get().snapshot) return
    await get().loadFor()
  },

  loadFor: async (anchor = new Date()) => {
    const range = snapshotRange(anchor)
    set({ loading: true, error: null, range })
    try {
      const snapshot = await window.remindMe.getCalendarSnapshot(range)
      set({ snapshot, loading: false })
    } catch (error) {
      set({ error: errorMessage(error), loading: false })
    }
  },

  saveEvent: async (form) => {
    set({ busy: true, error: null })
    try {
      const result = await window.remindMe.saveEvent(form, get().range)
      set({
        snapshot: result.snapshot,
        toast: { message: result.receipt.summary, undoable: result.receipt.undoable },
        busy: false
      })
      return true
    } catch (error) {
      set({ error: errorMessage(error), busy: false })
      return false
    }
  },

  applyBatch: async (items, summary) => {
    set({ busy: true, error: null })
    try {
      const result = await window.remindMe.applyCalendarBatch(items, summary, get().range)
      set({
        snapshot: result.snapshot,
        toast: { message: result.receipt.summary, undoable: result.receipt.undoable },
        busy: false
      })
      return true
    } catch (error) {
      set({ error: errorMessage(error), busy: false })
      return false
    }
  },

  deleteEvent: async (id) => {
    set({ busy: true, error: null })
    try {
      const result = await window.remindMe.deleteEvent(id, get().range)
      set({
        snapshot: result.snapshot,
        toast: { message: result.receipt.summary, undoable: result.receipt.undoable },
        busy: false
      })
      return true
    } catch (error) {
      set({ error: errorMessage(error), busy: false })
      return false
    }
  },

  saveReminder: async (form) => {
    set({ busy: true, error: null })
    try {
      const result = await window.remindMe.saveReminder(form, get().range)
      set({
        snapshot: result.snapshot,
        toast: { message: result.receipt.summary, undoable: result.receipt.undoable },
        busy: false
      })
      return true
    } catch (error) {
      set({ error: errorMessage(error), busy: false })
      return false
    }
  },

  completeReminder: async (id) => {
    set({ busy: true, error: null })
    try {
      const result = await window.remindMe.completeReminder(id, get().range)
      set({
        snapshot: result.snapshot,
        toast: { message: result.receipt.summary, undoable: result.receipt.undoable },
        busy: false
      })
      return true
    } catch (error) {
      set({ error: errorMessage(error), busy: false })
      return false
    }
  },

  deleteReminder: async (id) => {
    set({ busy: true, error: null })
    try {
      const result = await window.remindMe.deleteReminder(id, get().range)
      set({
        snapshot: result.snapshot,
        toast: { message: result.receipt.summary, undoable: result.receipt.undoable },
        busy: false
      })
      return true
    } catch (error) {
      set({ error: errorMessage(error), busy: false })
      return false
    }
  },

  undo: async () => {
    if (!get().snapshot?.canUndo) return
    set({ busy: true, error: null })
    try {
      const result = await window.remindMe.undoLastAction(get().range)
      set({
        snapshot: result.snapshot,
        toast: { message: result.receipt.summary, undoable: false },
        busy: false
      })
    } catch (error) {
      set({ error: errorMessage(error), busy: false })
    }
  },

  updatePreferences: async (update) => {
    set({ busy: true, error: null })
    try {
      const preferences = await window.remindMe.updatePreferences(update)
      const snapshot = get().snapshot
      set({
        snapshot: snapshot ? { ...snapshot, preferences } : snapshot,
        toast: { message: 'Settings saved on this device.', undoable: false },
        busy: false
      })
      return true
    } catch (error) {
      set({ error: errorMessage(error), busy: false })
      return false
    }
  },

  exportData: async (format) => {
    set({ busy: true, error: null })
    try {
      const result = await window.remindMe.exportData(format)
      set({
        toast: result.cancelled
          ? null
          : {
              message: `Exported ${result.eventCount} event(s) and ${result.reminderCount} reminder(s).`,
              undoable: false
            },
        busy: false
      })
    } catch (error) {
      set({ error: errorMessage(error), busy: false })
    }
  },

  importData: async () => {
    set({ busy: true, error: null })
    try {
      const result = await window.remindMe.importData(get().range)
      set({
        snapshot: result.snapshot ?? get().snapshot,
        toast: result.cancelled
          ? null
          : {
              message: `Imported ${result.eventCount} event(s) and ${result.reminderCount} reminder(s)${result.skippedCount ? `; skipped ${result.skippedCount}` : ''}.`,
              undoable: !result.cancelled
            },
        busy: false
      })
    } catch (error) {
      set({ error: errorMessage(error), busy: false })
    }
  },

  deleteAllData: async () => {
    set({ busy: true, error: null })
    try {
      const result = await window.remindMe.deleteAllData('DELETE', get().range)
      set({
        snapshot: result.snapshot,
        toast: {
          message: `Deleted ${result.eventCount} event(s), ${result.reminderCount} reminder(s), and local assistant history.`,
          undoable: false
        },
        busy: false
      })
      return true
    } catch (error) {
      set({ error: errorMessage(error), busy: false })
      return false
    }
  },

  applyMutationResult: (result) =>
    set({
      snapshot: result.snapshot,
      toast: { message: result.receipt.summary, undoable: result.receipt.undoable },
      busy: false,
      error: null
    }),

  clearError: () => set({ error: null }),
  dismissToast: () => set({ toast: null })
}))
