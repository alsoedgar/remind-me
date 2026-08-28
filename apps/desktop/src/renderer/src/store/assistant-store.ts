import { create } from 'zustand'
import type { AssistantConversation, AssistantExchange } from '@remind-me/contracts'
import { useCalendarStore } from './calendar-store'

interface AssistantState {
  conversation: AssistantConversation | null
  composer: string
  loading: boolean
  busy: boolean
  pendingMessage: string | null
  activity: 'thinking' | 'responding' | 'applying' | 'updating' | null
  activityMessage: string | null
  queuePosition: number
  cancelRequested: boolean
  streamId: string | null
  streamingReply: string | null
  error: string | null
  feedbackEligibleRequestIds: string[]
  replyRatings: Record<string, 'helpful' | 'unhelpful'>
  initialize: () => Promise<void>
  setComposer: (composer: string) => void
  send: (text?: string) => Promise<boolean>
  cancel: () => Promise<boolean>
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

let localStreamSequence = 0

function assistantStreamId(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  if (uuid) return `assistant-stream:${uuid}`
  localStreamSequence += 1
  return `assistant-stream:${Date.now()}:${localStreamSequence}`
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

function modelActivityMessage(
  phase: 'queued' | 'loading' | 'generating' | 'validating' | 'cancelled',
  queuePosition: number
): string {
  if (phase === 'queued') {
    return queuePosition > 1
      ? `Waiting behind ${queuePosition - 1} local ${queuePosition === 2 ? 'task' : 'tasks'}…`
      : 'Waiting for the local model…'
  }
  if (phase === 'loading') return 'Loading the private language model…'
  if (phase === 'generating') return 'Writing a local response…'
  if (phase === 'validating') return 'Checking the response against your calendar…'
  return 'Stopping the local response…'
}

export const useAssistantStore = create<AssistantState>((set, get) => ({
  conversation: null,
  composer: '',
  loading: false,
  busy: false,
  pendingMessage: null,
  activity: null,
  activityMessage: null,
  queuePosition: 0,
  cancelRequested: false,
  streamId: null,
  streamingReply: null,
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
    const streamId = assistantStreamId()
    set({
      busy: true,
      composer: '',
      pendingMessage: text,
      activity: 'thinking',
      activityMessage: 'Thinking with your calendar…',
      queuePosition: 0,
      cancelRequested: false,
      streamId,
      streamingReply: null,
      error: null
    })
    let stopStreaming = (): void => undefined
    try {
      const subscribe = window.remindMe.onAssistantStream
      if (typeof subscribe === 'function') {
        stopStreaming = subscribe((event) => {
          const current = get()
          if (!current.busy || current.streamId !== event.streamId) return
          if (event.type === 'status') {
            set({
              activityMessage: modelActivityMessage(event.status.phase, event.status.queuePosition),
              queuePosition: event.status.queuePosition,
              cancelRequested: current.cancelRequested || event.status.phase === 'cancelled'
            })
            return
          }
          if (!event.text.trim()) return
          set({
            activity: 'responding',
            activityMessage: 'Responding locally…',
            streamingReply: event.text
          })
        })
      }
    } catch {
      // Streaming is progressive enhancement; the final validated exchange still arrives.
    }
    try {
      const exchange = await window.remindMe.sendAssistantMessage({
        conversationId: get().conversation?.id ?? null,
        text,
        range: useCalendarStore.getState().range,
        streamId
      })
      applyExchange(exchange)
      const feedbackId = feedbackRequestId(exchange)
      set({
        conversation: exchange.conversation,
        busy: false,
        pendingMessage: null,
        activity: null,
        activityMessage: null,
        queuePosition: 0,
        cancelRequested: false,
        streamId: null,
        streamingReply: null,
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
        activity: null,
        activityMessage: null,
        queuePosition: 0,
        cancelRequested: false,
        streamId: null,
        streamingReply: null
      })
      return false
    } finally {
      stopStreaming()
    }
  },

  cancel: async () => {
    const streamId = get().streamId
    if (!streamId || !get().busy || get().cancelRequested) return false
    set({
      cancelRequested: true,
      activity: 'thinking',
      activityMessage: 'Stopping the local response…',
      streamingReply: null
    })
    try {
      const response = await window.remindMe.cancelAssistantMessage(streamId)
      if (!response.cancelled) {
        set({ activityMessage: 'Finishing the current local step…' })
      }
      return response.cancelled
    } catch (error) {
      set({
        cancelRequested: false,
        activityMessage: 'Finishing the current local step…',
        error: errorMessage(error)
      })
      return false
    }
  },

  confirm: async (proposalId) => {
    if (get().busy) return false
    set({
      busy: true,
      activity: 'applying',
      activityMessage: 'Checking and saving that locally…',
      streamId: null,
      streamingReply: null,
      error: null
    })
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
        activityMessage: null,
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
      set({ error: errorMessage(error), busy: false, activity: null, activityMessage: null })
      return false
    }
  },

  reject: async (proposalId, mode = 'cancel') => {
    if (get().busy) return false
    set({
      busy: true,
      activity: 'updating',
      activityMessage: 'Updating the conversation…',
      streamId: null,
      streamingReply: null,
      error: null
    })
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
        activityMessage: null,
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
      set({ error: errorMessage(error), busy: false, activity: null, activityMessage: null })
      return false
    }
  },

  clearConversation: async () => {
    const conversationId = get().conversation?.id
    if (!conversationId || get().busy) return false
    const composerAtStart = get().composer
    set({
      busy: true,
      composer: '',
      activity: 'updating',
      activityMessage: 'Updating the conversation…',
      streamId: null,
      streamingReply: null,
      error: null
    })
    try {
      const conversation = await window.remindMe.clearAssistantConversation(conversationId)
      set({
        conversation,
        busy: false,
        activity: null,
        activityMessage: null,
        pendingMessage: null,
        streamId: null,
        streamingReply: null,
        feedbackEligibleRequestIds: [],
        replyRatings: {}
      })
      return true
    } catch (error) {
      set({
        composer: get().composer.trim() ? get().composer : composerAtStart,
        error: errorMessage(error),
        busy: false,
        activity: null,
        activityMessage: null
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
