import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AssistantExchange,
  AssistantSendRequest,
  AssistantStreamEvent,
  RemindMeBridge
} from '@remind-me/contracts'
import { useAssistantStore } from './assistant-store'

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: Error) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function answerExchange(): AssistantExchange {
  return {
    conversation: {
      id: 'conversation:test',
      title: 'Availability',
      turns: [],
      activeProposal: null,
      createdAt: '2026-08-24T12:00:00.000Z',
      updatedAt: '2026-08-24T12:00:01.000Z'
    },
    response: {
      kind: 'answer',
      text: 'Your afternoon is open.',
      relatedEventIds: [],
      relatedReminderIds: [],
      receipt: null
    },
    snapshot: null
  } as unknown as AssistantExchange
}

describe('assistant optimistic conversation state', () => {
  beforeEach(() => {
    useAssistantStore.setState({
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
      replyRatings: {}
    })
  })

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'window')
  })

  it('shows the user message and a thinking activity before local inference finishes', async () => {
    const response = deferred<AssistantExchange>()
    const bridge = {
      sendAssistantMessage: () => response.promise
    } as unknown as RemindMeBridge
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { remindMe: bridge }
    })

    useAssistantStore.getState().setComposer('Am I free Friday afternoon?')
    const request = useAssistantStore.getState().send()

    expect(useAssistantStore.getState()).toMatchObject({
      composer: '',
      busy: true,
      pendingMessage: 'Am I free Friday afternoon?',
      activity: 'thinking'
    })

    response.resolve(answerExchange())
    await expect(request).resolves.toBe(true)
    expect(useAssistantStore.getState()).toMatchObject({
      busy: false,
      pendingMessage: null,
      activity: null
    })
  })

  it('keeps thinking until the first local token and then forms the reply live', async () => {
    const response = deferred<AssistantExchange>()
    let listener: (event: AssistantStreamEvent) => void = () => undefined
    let sentStreamId = ''
    const unsubscribe = vi.fn()
    const bridge = {
      onAssistantStream: (next: (event: AssistantStreamEvent) => void) => {
        listener = next
        return unsubscribe
      },
      sendAssistantMessage: (request: AssistantSendRequest) => {
        sentStreamId = request.streamId ?? ''
        return response.promise
      }
    } as unknown as RemindMeBridge
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { remindMe: bridge }
    })

    const request = useAssistantStore.getState().send('Tell me something encouraging')
    expect(sentStreamId).toMatch(/^assistant-stream:/u)
    expect(useAssistantStore.getState()).toMatchObject({
      activity: 'thinking',
      streamingReply: null
    })

    listener({ type: 'chunk', streamId: 'assistant-stream:other', text: 'Wrong request' })
    expect(useAssistantStore.getState().activity).toBe('thinking')

    listener({ type: 'chunk', streamId: sentStreamId, text: 'You have' })
    expect(useAssistantStore.getState()).toMatchObject({
      activity: 'responding',
      streamingReply: 'You have'
    })

    listener({
      type: 'chunk',
      streamId: sentStreamId,
      text: 'You have room to take this one step at a time.'
    })
    expect(useAssistantStore.getState().streamingReply).toBe(
      'You have room to take this one step at a time.'
    )

    response.resolve(answerExchange())
    await expect(request).resolves.toBe(true)
    expect(useAssistantStore.getState()).toMatchObject({
      activity: null,
      streamId: null,
      streamingReply: null
    })
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('shows queue progress and cooperatively stops the active local response', async () => {
    const response = deferred<AssistantExchange>()
    let listener: (event: AssistantStreamEvent) => void = () => undefined
    let sentStreamId = ''
    const cancelAssistantMessage = vi.fn(async () => ({ cancelled: true }))
    const bridge = {
      onAssistantStream: (next: (event: AssistantStreamEvent) => void) => {
        listener = next
        return () => undefined
      },
      sendAssistantMessage: (request: AssistantSendRequest) => {
        sentStreamId = request.streamId ?? ''
        return response.promise
      },
      cancelAssistantMessage
    } as unknown as RemindMeBridge
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { remindMe: bridge }
    })

    const sending = useAssistantStore.getState().send('Write a short plan for me')
    listener({
      type: 'status',
      streamId: sentStreamId,
      status: {
        workload: 'chat',
        phase: 'queued',
        queuePosition: 3,
        queuedJobs: 3,
        canCancel: true
      }
    })
    expect(useAssistantStore.getState()).toMatchObject({
      activity: 'thinking',
      activityMessage: 'Waiting behind 2 local tasks…',
      queuePosition: 3
    })

    await expect(useAssistantStore.getState().cancel()).resolves.toBe(true)
    expect(cancelAssistantMessage).toHaveBeenCalledWith(sentStreamId)
    expect(useAssistantStore.getState()).toMatchObject({
      cancelRequested: true,
      activityMessage: 'Stopping the local response…'
    })

    response.resolve(answerExchange())
    await expect(sending).resolves.toBe(true)
    expect(useAssistantStore.getState()).toMatchObject({
      busy: false,
      cancelRequested: false,
      activityMessage: null
    })
  })

  it('puts the message back in the composer when inference fails', async () => {
    const response = deferred<AssistantExchange>()
    const bridge = {
      sendAssistantMessage: () => response.promise
    } as unknown as RemindMeBridge
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { remindMe: bridge }
    })

    const request = useAssistantStore.getState().send('Please plan tomorrow')
    response.reject(new Error('Local inference unavailable'))

    await expect(request).resolves.toBe(false)
    expect(useAssistantStore.getState()).toMatchObject({
      composer: 'Please plan tomorrow',
      busy: false,
      pendingMessage: null,
      activity: null,
      error: 'Local inference unavailable'
    })
  })

  it('sends trimmed multi-line typed text without rewriting it', async () => {
    const response = deferred<AssistantExchange>()
    let sentText = ''
    const bridge = {
      sendAssistantMessage: (request: { text: string }) => {
        sentText = request.text
        return response.promise
      }
    } as unknown as RemindMeBridge
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { remindMe: bridge }
    })

    useAssistantStore
      .getState()
      .setComposer('  Move the project review to Thursday\nand keep the same duration.  ')
    const request = useAssistantStore.getState().send()

    expect(sentText).toBe('Move the project review to Thursday\nand keep the same duration.')
    expect(useAssistantStore.getState().pendingMessage).toBe(sentText)
    response.resolve(answerExchange())
    await expect(request).resolves.toBe(true)
  })

  it('keeps a new draft typed while the previous request is thinking', async () => {
    const response = deferred<AssistantExchange>()
    const bridge = {
      sendAssistantMessage: () => response.promise
    } as unknown as RemindMeBridge
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { remindMe: bridge }
    })

    useAssistantStore.getState().setComposer('What is on Tuesday?')
    const request = useAssistantStore.getState().send()
    useAssistantStore.getState().setComposer('Also check Wednesday afternoon')

    response.resolve(answerExchange())
    await expect(request).resolves.toBe(true)
    expect(useAssistantStore.getState().composer).toBe('Also check Wednesday afternoon')
  })

  it('does not overwrite a newer draft when the in-flight request fails', async () => {
    const response = deferred<AssistantExchange>()
    const bridge = {
      sendAssistantMessage: () => response.promise
    } as unknown as RemindMeBridge
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { remindMe: bridge }
    })

    useAssistantStore.getState().setComposer('First request')
    const request = useAssistantStore.getState().send()
    useAssistantStore.getState().setComposer('Keep this newer draft')
    response.reject(new Error('Local inference unavailable'))

    await expect(request).resolves.toBe(false)
    expect(useAssistantStore.getState().composer).toBe('Keep this newer draft')
  })

  it('keeps a new draft typed while the conversation is clearing', async () => {
    const response = deferred<AssistantExchange['conversation']>()
    const bridge = {
      clearAssistantConversation: () => response.promise
    } as unknown as RemindMeBridge
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { remindMe: bridge }
    })
    const original = answerExchange().conversation
    useAssistantStore.setState({ conversation: original, composer: 'old draft' })

    const request = useAssistantStore.getState().clearConversation()
    expect(useAssistantStore.getState()).toMatchObject({ composer: '', busy: true })
    useAssistantStore.getState().setComposer('new draft after clearing')
    response.resolve({ ...original, turns: [], activeProposal: null })

    await expect(request).resolves.toBe(true)
    expect(useAssistantStore.getState()).toMatchObject({
      composer: 'new draft after clearing',
      busy: false,
      activity: null
    })
  })

  it('records an eligible response rating only after the private bridge accepts it', async () => {
    const conversation = answerExchange().conversation
    const bridge = {
      rateAssistantReply: async () => ({
        accepted: true,
        learnedPreferences: 1,
        message: 'Saved privately on this device.'
      })
    } as unknown as RemindMeBridge
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { remindMe: bridge }
    })
    useAssistantStore.setState({
      conversation,
      feedbackEligibleRequestIds: ['request:reply'],
      replyRatings: {}
    })

    await expect(useAssistantStore.getState().rateReply('request:reply', 'helpful')).resolves.toBe(
      true
    )
    expect(useAssistantStore.getState().replyRatings).toEqual({
      'request:reply': 'helpful'
    })
  })
})
