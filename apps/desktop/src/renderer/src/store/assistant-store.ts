import { create } from 'zustand'
import type { AssistantConversation, AssistantExchange } from '@remind-me/contracts'
import { useCalendarStore } from './calendar-store'

interface AssistantState {
  conversation: AssistantConversation | null
  composer: string
  loading: boolean
  busy: boolean
  pendingMessage: string | null
  activity: 'thinking' | 'applying' | 'updating' | null
  error: string | null
  feedbackEligibleRequestIds: string[]
  replyRatings: Record<string, 'helpful' | 'unhelpful'>
  initialize: () => Promise<void>
  setComposer: (composer: string) => void
  send: (text?: string) => Promise<boolean>
  confirm: (proposalId: string) => Promise<boolean>
  reject: (proposalId: string, mode?: 'cancel' | 'edit') => Promise<boolean>
  clearConversation: () => Promise<boolean>
  rateReply: (requestId: string, rating: 'helpful' | 'unhelpful') => Promise<boolean>
  clearError: () => void
}

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return 'The local assistant ran into a problem.'
  return error.message.replace(/^Error invoking remote method '[^']+': Error: /u, '')
}

function applyExchange(exchange: AssistantExchange): void {
  useCalendarStore.setState({
    snapshot: exchange.snapshot,
    toast: exchange.response.receipt
      ? {
          message: exchange.response.receipt.summary,
          undoable: exchange.response.receipt.undoable
        }
      : null
  })
}

function feedbackRequestId(exchange: AssistantExchange): string | null {
  if (!exchange.response.feedbackEligible) return null
  return (
    [...exchange.conversation.turns]
      .reverse()
      .find((turn) => turn.role === 'assistant' && turn.requestId !== null)?.requestId ?? null
  )
}

export const useAssistantStore = create<AssistantState>((set, get) => ({
  conversation: null,
  composer: '',
  loading: false,
  busy: false,
  pendingMessage: null,
  activity: null,
  error: null,
  feedbackEligibleRequestIds: [],
  replyRatings: {},

  initialize: async () => {
    if (get().loading || get().conversation) return
    set({ loading: true, error: null })
    try {
      const conversation = await window.remindMe.getAssistantConversation()
      set({ conversation, loading: false })
    } catch (error) {
      set({ error: errorMessage(error), loading: false })
    }
  },

  setComposer: (composer) => set({ composer }),

  send: async (input) => {
    const text = (input ?? get().composer).trim()
    if (!text || get().busy) return false
    set({
      busy: true,
      composer: '',
      pendingMessage: text,
      activity: 'thinking',
      error: null
    })
    try {
      const exchange = await window.remindMe.sendAssistantMessage({
        conversationId: get().conversation?.id ?? null,
        text,
        range: useCalendarStore.getState().range
      })
      applyExchange(exchange)
      const feedbackId = feedbackRequestId(exchange)
      set({
        conversation: exchange.conversation,
        busy: false,
        pendingMessage: null,
        activity: null,
        ...(feedbackId
          ? {
              feedbackEligibleRequestIds: [
                ...new Set([...get().feedbackEligibleRequestIds, feedbackId])
              ].slice(-40)
            }
          : {})
      })
      return true
    } catch (error) {
      set({
        composer: get().composer.trim() ? get().composer : text,
        error: errorMessage(error),
        busy: false,
        pendingMessage: null,
        activity: null
      })
      return false
    }
  },

  confirm: async (proposalId) => {
    if (get().busy) return false
    set({ busy: true, activity: 'applying', error: null })
    try {
      const exchange = await window.remindMe.confirmAssistantProposal({
        proposalId,
        range: useCalendarStore.getState().range
      })
      applyExchange(exchange)
      const feedbackId = feedbackRequestId(exchange)
      set({
        conversation: exchange.conversation,
        busy: false,
        activity: null,
        ...(feedbackId
          ? {
              feedbackEligibleRequestIds: [
                ...new Set([...get().feedbackEligibleRequestIds, feedbackId])
              ].slice(-40)
            }
          : {})
      })
      return true
    } catch (error) {
      set({ error: errorMessage(error), busy: false, activity: null })
      return false
    }
  },

  reject: async (proposalId, mode = 'cancel') => {
    if (get().busy) return false
    set({ busy: true, activity: 'updating', error: null })
    try {
      const exchange = await window.remindMe.rejectAssistantProposal({
        proposalId,
        mode,
        range: useCalendarStore.getState().range
      })
      applyExchange(exchange)
      const feedbackId = feedbackRequestId(exchange)
      set({
        conversation: exchange.conversation,
        busy: false,
        activity: null,
        ...(feedbackId
          ? {
              feedbackEligibleRequestIds: [
                ...new Set([...get().feedbackEligibleRequestIds, feedbackId])
              ].slice(-40)
            }
          : {})
      })
      return true
    } catch (error) {
      set({ error: errorMessage(error), busy: false, activity: null })
      return false
    }
  },

  clearConversation: async () => {
    const conversationId = get().conversation?.id
    if (!conversationId || get().busy) return false
    const composerAtStart = get().composer
    set({ busy: true, composer: '', activity: 'updating', error: null })
    try {
      const conversation = await window.remindMe.clearAssistantConversation(conversationId)
      set({
        conversation,
        busy: false,
        activity: null,
        pendingMessage: null,
        feedbackEligibleRequestIds: [],
        replyRatings: {}
      })
      return true
    } catch (error) {
      set({
        composer: get().composer.trim() ? get().composer : composerAtStart,
        error: errorMessage(error),
        busy: false,
        activity: null
      })
      return false
    }
  },

  rateReply: async (requestId, rating) => {
    const conversationId = get().conversation?.id
    if (!conversationId || !get().feedbackEligibleRequestIds.includes(requestId)) return false
    try {
      const result = await window.remindMe.rateAssistantReply({
        conversationId,
        requestId,
        rating
      })
      if (!result.accepted) {
        set({ error: result.message })
        return false
      }
      set({
        replyRatings: { ...get().replyRatings, [requestId]: rating },
        error: null
      })
      return true
    } catch (error) {
      set({ error: errorMessage(error) })
      return false
    }
  },

  clearError: () => set({ error: null })
}))
