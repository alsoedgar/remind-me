import { create } from 'zustand'
import type { AppWindowMode, AppWindowState } from '@remind-me/contracts'

interface WindowModeState {
  state: AppWindowState | null
  busy: boolean
  error: string | null
  initialize: () => Promise<void>
  setMode: (mode: AppWindowMode) => Promise<boolean>
  setPinned: (pinned: boolean) => Promise<boolean>
}

function message(error: unknown): string {
  if (!(error instanceof Error)) return 'The window could not change modes.'
  return error.message.replace(/^Error invoking remote method '[^']+': Error: /u, '')
}

export const useWindowStore = create<WindowModeState>((set, get) => ({
  state: null,
  busy: false,
  error: null,

  initialize: async () => {
    if (get().state || get().busy) return
    set({ busy: true, error: null })
    try {
      const state = await window.remindMe.getWindowState()
      set({ state, busy: false })
    } catch (error) {
      set({ error: message(error), busy: false })
    }
  },

  setMode: async (mode) => {
    if (get().busy) return false
    set({ busy: true, error: null })
    try {
      const state = await window.remindMe.setWindowMode(mode)
      set({ state, busy: false })
      return true
    } catch (error) {
      set({ error: message(error), busy: false })
      return false
    }
  },

  setPinned: async (pinned) => {
    if (get().busy) return false
    set({ busy: true, error: null })
    try {
      const state = await window.remindMe.setWindowPinned(pinned)
      set({ state, busy: false })
      return true
    } catch (error) {
      set({ error: message(error), busy: false })
      return false
    }
  }
}))
