import { create } from 'zustand'
import { isThemeId, type ThemeId } from '@remind-me/ui'

export type AppRoute = 'today' | 'calendar' | 'reminders' | 'settings'

interface UiState {
  route: AppRoute
  theme: ThemeId
  assistantOpen: boolean
  assistantWide: boolean
  setRoute: (route: AppRoute) => void
  setTheme: (theme: ThemeId) => void
  setAssistantOpen: (open: boolean) => void
  toggleAssistantWide: () => void
}

function storedTheme(): ThemeId {
  const value = localStorage.getItem('remind-me:theme') ?? ''
  return isThemeId(value) ? value : 'morning-lo-fi'
}

export const useUiStore = create<UiState>((set) => ({
  route: 'today',
  theme: storedTheme(),
  assistantOpen: localStorage.getItem('remind-me:assistant-open') === 'true',
  assistantWide: localStorage.getItem('remind-me:assistant-wide') === 'true',
  setRoute: (route) => set({ route }),
  setTheme: (theme) => {
    localStorage.setItem('remind-me:theme', theme)
    set({ theme })
  },
  setAssistantOpen: (assistantOpen) => {
    localStorage.setItem('remind-me:assistant-open', String(assistantOpen))
    set({ assistantOpen })
  },
  toggleAssistantWide: () =>
    set((state) => {
      const assistantWide = !state.assistantWide
      localStorage.setItem('remind-me:assistant-wide', String(assistantWide))
      return { assistantWide }
    })
}))
