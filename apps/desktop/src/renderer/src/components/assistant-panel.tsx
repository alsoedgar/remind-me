import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode
} from 'react'
import type { AssistantProposalPayload, CalendarSnapshot } from '@remind-me/contracts'
import { useAssistantStore } from '../store/assistant-store'
import { useCalendarStore } from '../store/calendar-store'
import { useVoiceStore } from '../store/voice-store'
import type { EditorRequest } from './editors'
import { shouldSubmitComposerKey } from './composer-keyboard'
import { focusComposerAtEnd } from './composer-focus'
import { assistantSuggestions } from './assistant-prompts'

type EditableProposalPayload = Extract<
  AssistantProposalPayload,
  { kind: 'event-save' | 'reminder-save' }
>

function canEdit(payload: AssistantProposalPayload): payload is EditableProposalPayload {
  return payload.kind === 'event-save' || payload.kind === 'reminder-save'
}

function bulkDeletePreview(
  payload: Extract<AssistantProposalPayload, { kind: 'bulk-delete' }>,
  snapshot: CalendarSnapshot | null
): string[] {
  if (!snapshot) return []
  const eventIds = new Set(payload.eventIds)
  const reminderIds = new Set(payload.reminderIds)
  const preview = [
    ...snapshot.events
      .filter((event) => eventIds.has(event.id))
      .slice(0, 6)
      .map((event) => `Event · ${event.title}`),
    ...snapshot.reminders
      .filter((reminder) => reminderIds.has(reminder.id))
      .slice(0, 6)
      .map((reminder) => `Reminder · ${reminder.title}`)
  ].slice(0, 8)
  const remainder = payload.eventIds.length + payload.reminderIds.length - preview.length
  if (remainder > 0) preview.push(`…and ${remainder} more`)
  return preview
}

function compactClarificationLabel(option: string): string {
  if (option.toLocaleLowerCase() === 'create calendar events') return 'Create event'
  return option
}

export function AssistantPanel({
  onOpen,
  mode = 'workspace',
  compactVariant = 'mini',
  wide = false,
  onClose,
  onToggleWide,
  onOpenDocument
}: {
  onOpen: (request: EditorRequest) => void
  mode?: 'workspace' | 'sidebar' | 'compact'
  compactVariant?: 'mini' | 'tiny'
  wide?: boolean
  onClose?: () => void
  onToggleWide?: () => void
  onOpenDocument: () => void
}): ReactNode {
  const conversation = useAssistantStore((state) => state.conversation)
  const composer = useAssistantStore((state) => state.composer)
  const loading = useAssistantStore((state) => state.loading)
  const busy = useAssistantStore((state) => state.busy)
  const pendingMessage = useAssistantStore((state) => state.pendingMessage)
  const activity = useAssistantStore((state) => state.activity)
  const activityMessage = useAssistantStore((state) => state.activityMessage)
  const streamId = useAssistantStore((state) => state.streamId)
  const cancelRequested = useAssistantStore((state) => state.cancelRequested)
  const streamingReply = useAssistantStore((state) => state.streamingReply)
  const error = useAssistantStore((state) => state.error)
  const initialize = useAssistantStore((state) => state.initialize)
  const setComposer = useAssistantStore((state) => state.setComposer)
  const send = useAssistantStore((state) => state.send)
  const cancel = useAssistantStore((state) => state.cancel)
  const confirm = useAssistantStore((state) => state.confirm)
  const reject = useAssistantStore((state) => state.reject)
  const clearConversation = useAssistantStore((state) => state.clearConversation)
  const feedbackEligibleRequestIds = useAssistantStore((state) => state.feedbackEligibleRequestIds)
  const replyRatings = useAssistantStore((state) => state.replyRatings)
  const rateReply = useAssistantStore((state) => state.rateReply)
  const clearError = useAssistantStore((state) => state.clearError)
  const snapshot = useCalendarStore((state) => state.snapshot)
  const timelineRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const focusRequestRef = useRef(0)
  const [clearArmed, setClearArmed] = useState(false)
  const voiceState = useVoiceStore((state) => state.state)
  const voiceRuntime = useVoiceStore((state) => state.runtime)
  const voiceProgress = useVoiceStore((state) => state.progress)
  const voiceLevel = useVoiceStore((state) => state.level)
  const voiceDurationMs = useVoiceStore((state) => state.durationMs)
  const liveTranscript = useVoiceStore((state) => state.liveTranscript)
  const voiceResult = useVoiceStore((state) => state.result)
  const voiceError = useVoiceStore((state) => state.error)
  const initializeVoice = useVoiceStore((state) => state.initialize)
  const startVoice = useVoiceStore((state) => state.start)
  const stopVoice = useVoiceStore((state) => state.stop)
  const cancelVoice = useVoiceStore((state) => state.cancel)
  const clearVoiceReady = useVoiceStore((state) => state.clearReady)

  const requestComposerFocus = useCallback((): void => {
    const request = ++focusRequestRef.current
    const focus = (): void => {
      if (request !== focusRequestRef.current) return
      focusComposerAtEnd(inputRef.current)
    }
    queueMicrotask(focus)
    requestAnimationFrame(() => {
      focus()
      requestAnimationFrame(focus)
    })
  }, [])

  useEffect(() => {
    void initialize()
    void initializeVoice()
  }, [initialize, initializeVoice])

  useLayoutEffect(() => {
    requestComposerFocus()
  }, [requestComposerFocus])

  useLayoutEffect(() => {
    if (!busy) requestComposerFocus()
  }, [busy, requestComposerFocus])

  useLayoutEffect(() => {
    if (voiceState === 'ready') requestComposerFocus()
  }, [requestComposerFocus, voiceState])

  useEffect(() => {
    if (!clearArmed) return
    const timeout = window.setTimeout(() => setClearArmed(false), 6_000)
    return () => window.clearTimeout(timeout)
  }, [clearArmed])

  useEffect(
    () => () => {
      focusRequestRef.current += 1
      const currentVoiceState = useVoiceStore.getState().state
      if (['requesting', 'recording', 'transcribing'].includes(currentVoiceState)) {
        void useVoiceStore.getState().cancel()
      }
    },
    []
  )

  useEffect(() => {
    timelineRef.current?.scrollTo({
      top: timelineRef.current.scrollHeight,
      behavior: streamingReply ? 'auto' : 'smooth'
    })
  }, [
    activity,
    conversation?.turns.length,
    conversation?.activeProposal?.id,
    pendingMessage,
    streamingReply
  ])

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    void send().then((sent) => {
      if (sent) clearVoiceReady()
    })
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (
      !shouldSubmitComposerKey({
        key: event.key,
        shiftKey: event.shiftKey,
        isComposing: event.nativeEvent.isComposing
      })
    ) {
      return
    }
    if (busy) return
    event.preventDefault()
    event.currentTarget.form?.requestSubmit()
  }

  function toggleVoice(): void {
    if (voiceState === 'recording') void stopVoice()
    else void startVoice()
  }

  async function handleClearConversation(): Promise<void> {
    if (!clearArmed) {
      setClearArmed(true)
      requestComposerFocus()
      return
    }
    setClearArmed(false)
    try {
      const currentVoiceState = useVoiceStore.getState().state
      if (['requesting', 'recording', 'transcribing'].includes(currentVoiceState)) {
        await cancelVoice()
      } else {
        clearVoiceReady()
      }
      await clearConversation()
    } finally {
      requestComposerFocus()
    }
  }

  async function editProposal(): Promise<void> {
    const proposal = conversation?.activeProposal
    if (!proposal || !canEdit(proposal.payload)) return
    const payload: EditableProposalPayload = proposal.payload
    if (!(await reject(proposal.id, 'edit'))) return
    if (payload.kind === 'event-save') {
      onOpen({
        kind: 'event',
        event: payload.form.id
          ? (snapshot?.events.find((event) => event.id === payload.form.id) ?? null)
          : null,
        date: null,
        title: null,
        draft: payload.form
      })
    } else {
      onOpen({
        kind: 'reminder',
        reminder: payload.form.id
          ? (snapshot?.reminders.find((reminder) => reminder.id === payload.form.id) ?? null)
          : null,
        date: null,
        title: null,
        draft: payload.form
      })
    }
  }

  const proposal = conversation?.activeProposal
  const bulkClearPayload = proposal?.payload.kind === 'bulk-delete' ? proposal.payload : null
  const bulkClearCount = bulkClearPayload
    ? bulkClearPayload.eventIds.length + bulkClearPayload.reminderIds.length
    : 0
  const bulkClearPreview = bulkClearPayload ? bulkDeletePreview(bulkClearPayload, snapshot) : []
  const compact = mode === 'compact'
  const tiny = compact && compactVariant === 'tiny'
  const pendingClarification = conversation?.dialogueState.pendingClarification ?? null
  const visibleTurns =
    conversation?.turns.slice(tiny ? -1 : compact ? -8 : mode === 'sidebar' ? -16 : -24) ?? []
  const headingId = `assistant-heading-${mode}`
  const inputId = `assistant-input-${mode}`
  const activityLabel =
    activityMessage ??
    (activity === 'applying'
      ? 'Checking and saving that locally…'
      : activity === 'updating'
        ? 'Updating the conversation…'
        : 'Thinking with your calendar…')
  return (
    <>
      <section
        className={`assistant-card assistant-workspace assistant-${mode}-panel`}
        aria-labelledby={headingId}
        aria-busy={busy}
        data-testid={compact ? 'compact-assistant' : undefined}
        data-compact-variant={compact ? compactVariant : undefined}
      >
        <header className="assistant-intro">
          <span className="assistant-spark" aria-hidden="true">
            ✦
          </span>
          <div>
            <p className="eyebrow">{compact ? 'Private assistant' : 'Local assistant'}</p>
            <h2 id={headingId}>
              {compact
                ? 'Ask from right here'
                : mode === 'sidebar'
                  ? 'Your calendar, listening'
                  : 'Talk through your time'}
            </h2>
            <p>
              {compact
                ? tiny
                  ? 'Ask, add, move, or remove plans.'
                  : 'Ask a question or make a reviewed calendar change without opening the full app.'
                : mode === 'sidebar'
                  ? 'Ask naturally about any day. Answers use your private on-device calendar, and changes always wait for review.'
                  : 'Ask naturally. Every answer comes from your on-device calendar, and every change waits for your review.'}
            </p>
          </div>
          <div className="assistant-header-actions">
            <span className="local-pill">{compact ? 'local' : 'offline · private'}</span>
            {mode === 'sidebar' ? (
              <>
                <button
                  className="assistant-window-button"
                  type="button"
                  aria-label={wide ? 'Use standard assistant width' : 'Expand assistant width'}
                  title={wide ? 'Standard width' : 'Expand assistant'}
                  onClick={onToggleWide}
                >
                  {wide ? '↦' : '↔'}
                </button>
                <button
                  className="assistant-window-button"
                  type="button"
                  aria-label="Close assistant sidebar"
                  title="Close assistant"
                  onClick={onClose}
                >
                  ×
                </button>
              </>
            ) : null}
          </div>
        </header>

        <div className="prompt-suggestions" aria-label="Things to try">
          {assistantSuggestions
            .slice(0, mode === 'workspace' ? assistantSuggestions.length : 2)
            .map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                onClick={() => {
                  setClearArmed(false)
                  setComposer(suggestion)
                  requestComposerFocus()
                }}
              >
                {suggestion}
              </button>
            ))}
        </div>

        {!compact ? (
          <div className="assistant-context-strip" aria-label="Assistant privacy and safety">
            <span>
              <i aria-hidden="true" /> Ready on device
            </span>
            <span>Calendar-aware answers</span>
            <span>Review before changes</span>
          </div>
        ) : null}

        <div className="conversation-timeline" ref={timelineRef} aria-live="polite">
          {loading && visibleTurns.length === 0 ? (
            <article
              className="conversation-turn assistant-turn thinking-turn"
              role="status"
              data-testid="assistant-thinking"
            >
              <span className="turn-author">Remind Me</span>
              <div className="thinking-line">
                <span className="thinking-dots" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                <span>Opening your private conversation…</span>
              </div>
            </article>
          ) : null}
          {!loading && visibleTurns.length === 0 && !pendingMessage && !busy ? (
            <article className="conversation-turn assistant-turn assistant-welcome-turn">
              <span className="turn-author">Remind Me</span>
              <p>
                {compact
                  ? 'Ask what is next, check a day, or describe a change in your own words.'
                  : 'Hi. Say hello, ask what I can do, find a free pocket of time, or describe the calendar change you want in your own words.'}
              </p>
            </article>
          ) : null}
          {visibleTurns.map((turn) => (
            <article
              className={`conversation-turn ${turn.role === 'user' ? 'user-turn' : 'assistant-turn'}`}
              key={turn.id}
            >
              <span className="turn-author">{turn.role === 'user' ? 'You' : 'Remind Me'}</span>
              <p>{turn.text}</p>
              {!compact &&
              turn.role === 'assistant' &&
              turn.requestId &&
              feedbackEligibleRequestIds.includes(turn.requestId) ? (
                <div className="reply-feedback" aria-label="Rate this reply">
                  <span>
                    {replyRatings[turn.requestId] ? 'Saved locally' : 'Help me tune my voice'}
                  </span>
                  <button
                    type="button"
                    aria-label="This reply was helpful"
                    aria-pressed={replyRatings[turn.requestId] === 'helpful'}
                    title="Helpful"
                    onClick={() => void rateReply(turn.requestId!, 'helpful')}
                  >
                    Helpful
                  </button>
                  <button
                    type="button"
                    aria-label="This reply was not helpful"
                    aria-pressed={replyRatings[turn.requestId] === 'unhelpful'}
                    title="Not quite"
                    onClick={() => void rateReply(turn.requestId!, 'unhelpful')}
                  >
                    Not quite
                  </button>
                </div>
              ) : null}
            </article>
          ))}

          {pendingMessage ? (
            <article className="conversation-turn user-turn pending-turn">
              <span className="turn-author">You</span>
              <p>{pendingMessage}</p>
            </article>
          ) : null}

          {busy && activity === 'responding' && streamingReply ? (
            <article
              className="conversation-turn assistant-turn streaming-turn"
              role="status"
              data-testid="assistant-streaming"
            >
              <span className="turn-author">Remind Me</span>
              <p>
                {streamingReply}
                <span className="streaming-caret" aria-hidden="true" />
              </p>
              {streamId ? (
                <button
                  className="assistant-stop-button"
                  type="button"
                  disabled={cancelRequested}
                  onClick={() => void cancel()}
                >
                  {cancelRequested ? 'Stopping…' : 'Stop'}
                </button>
              ) : null}
            </article>
          ) : busy && activity ? (
            <article
              className="conversation-turn assistant-turn thinking-turn"
              role="status"
              data-testid="assistant-thinking"
            >
              <span className="turn-author">Remind Me</span>
              <div className="thinking-line">
                <span className="thinking-dots" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                <span>{activityLabel}</span>
              </div>
              {streamId ? (
                <button
                  className="assistant-stop-button"
                  type="button"
                  disabled={cancelRequested}
                  onClick={() => void cancel()}
                >
                  {cancelRequested ? 'Stopping…' : 'Stop'}
                </button>
              ) : null}
            </article>
          ) : null}

          {!busy && !proposal && pendingClarification?.options.length ? (
            <div className="clarification-actions" role="group" aria-label="Quick replies">
              {pendingClarification.options.map((option) => (
                <button type="button" key={option} onClick={() => void send(option)}>
                  {tiny ? compactClarificationLabel(option) : option}
                </button>
              ))}
              {pendingClarification.options.length === 1 ? (
                <button
                  className="clarification-decline"
                  type="button"
                  onClick={() => void send('no thanks')}
                >
                  Not now
                </button>
              ) : null}
            </div>
          ) : null}

          {proposal ? (
            <article className="proposal-card" aria-label="Calendar change awaiting review">
              <div className="proposal-heading">
                <span className="proposal-icon" aria-hidden="true">
                  ✓
                </span>
                <div>
                  <span className="turn-author">Review before saving</span>
                  <h3>{proposal.summary}</h3>
                </div>
                <span className="risk-chip" data-risk={proposal.risk}>
                  {bulkClearPayload
                    ? 'bulk delete'
                    : proposal.risk === 'destructive'
                      ? 'destructive'
                      : 'local preview'}
                </span>
              </div>
              <p className="proposal-note">
                {bulkClearPayload
                  ? `Nothing has changed yet. The exact ${bulkClearCount} ${bulkClearCount === 1 ? 'item' : 'items'} will be checked again and deleted as one undoable action.`
                  : proposal.payload.kind === 'batch'
                    ? 'Nothing has changed yet. Ask about a numbered item, check for conflicts, or revise it in chat.'
                    : 'Nothing has changed yet. Ask for details, check for conflicts, or revise it in chat.'}
              </p>
              {proposal.payload.kind === 'batch' ? (
                <ol className="proposal-batch-list">
                  {proposal.payload.itemSummaries.map((summary, index) => (
                    <li key={`${index}-${summary}`}>{summary}</li>
                  ))}
                </ol>
              ) : null}
              {bulkClearPreview.length > 0 ? (
                <ol className="proposal-batch-list" aria-label="Items included in this clear">
                  {bulkClearPreview.map((summary, index) => (
                    <li key={`${index}-${summary}`}>{summary}</li>
                  ))}
                </ol>
              ) : null}
              <div className="proposal-actions">
                <button
                  className="secondary-button"
                  type="button"
                  disabled={busy}
                  onClick={() => void reject(proposal.id)}
                >
                  Cancel
                </button>
                {canEdit(proposal.payload) ? (
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={busy}
                    onClick={() => void editProposal()}
                  >
                    {tiny ? 'Edit' : 'Edit details'}
                  </button>
                ) : null}
                <button
                  className={proposal.risk === 'destructive' ? 'danger-button' : 'retro-button'}
                  type="button"
                  disabled={busy}
                  onClick={() => void confirm(proposal.id)}
                >
                  {busy
                    ? 'Applying…'
                    : bulkClearPayload
                      ? tiny
                        ? `Delete ${bulkClearCount}`
                        : `Delete ${bulkClearCount} ${bulkClearCount === 1 ? 'item' : 'items'}`
                      : proposal.risk === 'destructive'
                        ? tiny
                          ? 'Confirm'
                          : 'Confirm change'
                        : tiny
                          ? 'Save'
                          : 'Save locally'}
                </button>
              </div>
            </article>
          ) : null}
        </div>

        {error ? (
          <div className="assistant-error" role="alert">
            <span>{error}</span>
            <button type="button" onClick={clearError} aria-label="Dismiss assistant error">
              ×
            </button>
          </div>
        ) : null}

        {voiceState !== 'idle' ? (
          <div className="voice-status" data-state={voiceState} role="status" aria-live="polite">
            {voiceState === 'requesting' ? (
              <>
                <span className="voice-pulse" aria-hidden="true" />
                <div>
                  <strong>Opening your microphone…</strong>
                  <small>Audio stays in memory and never leaves this device.</small>
                </div>
                <button type="button" className="voice-cancel" onClick={() => void cancelVoice()}>
                  Cancel
                </button>
              </>
            ) : null}
            {voiceState === 'recording' ? (
              <>
                <span className="recording-dot" aria-hidden="true" />
                <div>
                  <strong>Listening · {Math.floor(voiceDurationMs / 1000)}s</strong>
                  <small className="voice-live-transcript" aria-live="polite">
                    {liveTranscript || 'Your words will appear here as you speak…'}
                  </small>
                </div>
                <span className="voice-meter" aria-label="Microphone level">
                  {[0.12, 0.28, 0.46, 0.66, 0.84].map((threshold) => (
                    <span key={threshold} data-active={voiceLevel >= threshold} />
                  ))}
                </span>
                <button type="button" className="voice-cancel" onClick={() => void cancelVoice()}>
                  Cancel
                </button>
              </>
            ) : null}
            {voiceState === 'transcribing' ? (
              <>
                <span className="voice-pulse" aria-hidden="true" />
                <div className="voice-progress-copy">
                  <strong>{voiceProgress?.message ?? 'Starting private transcription…'}</strong>
                  <span className="voice-progress-track" aria-hidden="true">
                    <span
                      style={{ width: `${Math.round((voiceProgress?.progress ?? 0.02) * 100)}%` }}
                    />
                  </span>
                </div>
                <button type="button" className="voice-cancel" onClick={() => void cancelVoice()}>
                  Cancel
                </button>
              </>
            ) : null}
            {voiceState === 'ready' && voiceResult ? (
              <>
                <span className="transcript-check" aria-hidden="true">
                  ✓
                </span>
                <div>
                  <strong>Transcript ready—edit anything, then send</strong>
                  <small>
                    {Math.round(voiceResult.audioDurationMs / 100) / 10}s of audio ·{' '}
                    {voiceResult.processingDurationMs}ms locally
                    {voiceResult.confidence !== null && voiceResult.confidence < 0.72
                      ? ' · worth a quick check'
                      : ''}
                  </small>
                </div>
                <button type="button" className="voice-cancel" onClick={clearVoiceReady}>
                  Dismiss
                </button>
              </>
            ) : null}
            {voiceState === 'error' && voiceError ? (
              <>
                <span className="voice-error-mark" aria-hidden="true">
                  !
                </span>
                <div>
                  <strong>Voice input needs attention</strong>
                  <small>{voiceError}</small>
                </div>
                <button type="button" className="voice-cancel" onClick={clearVoiceReady}>
                  Dismiss
                </button>
              </>
            ) : null}
          </div>
        ) : null}

        <form
          className="composer assistant-composer"
          onSubmit={submit}
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) requestComposerFocus()
          }}
        >
          <button
            className="composer-icon-button"
            type="button"
            disabled={busy || ['requesting', 'recording', 'transcribing'].includes(voiceState)}
            aria-label="Create plans from an image or PDF"
            title="Create plans from an image or PDF"
            onClick={onOpenDocument}
          >
            +
          </button>
          <label className="visually-hidden" htmlFor={inputId}>
            Message your local calendar assistant
          </label>
          <textarea
            ref={inputRef}
            id={inputId}
            data-testid="assistant-composer-input"
            rows={1}
            value={composer}
            onChange={(event) => {
              setClearArmed(false)
              setComposer(event.target.value)
            }}
            onKeyDown={handleComposerKeyDown}
            placeholder={
              busy
                ? 'You can type your next message while I work…'
                : tiny
                  ? 'Ask or change a plan…'
                  : compact
                    ? 'Ask about your calendar…'
                    : 'Try “Am I free Friday afternoon?”'
            }
            autoComplete="off"
            enterKeyHint="send"
            spellCheck
            title="Enter to send · Shift+Enter for a new line"
          />
          <button
            className="composer-icon-button microphone"
            type="button"
            data-state={voiceState}
            disabled={
              busy ||
              voiceState === 'requesting' ||
              voiceState === 'transcribing' ||
              voiceRuntime?.available === false
            }
            aria-label={voiceState === 'recording' ? 'Stop and transcribe' : 'Start voice input'}
            aria-pressed={voiceState === 'recording'}
            title={
              voiceRuntime?.available === false
                ? (voiceRuntime.error ?? 'Offline voice is unavailable')
                : voiceState === 'recording'
                  ? 'Stop and transcribe'
                  : 'Tap to talk'
            }
            onClick={toggleVoice}
          >
            <span className="mic-glyph" aria-hidden="true">
              <svg viewBox="0 0 24 24" focusable="false">
                <rect x="9" y="3" width="6" height="11" rx="3" />
                <path d="M6 11a6 6 0 0 0 12 0M12 17v4M9 21h6" />
              </svg>
            </span>
          </button>
          <button
            className="send-button"
            type="submit"
            disabled={busy || !composer.trim()}
            aria-label={compact ? 'Send message' : undefined}
          >
            {busy
              ? compact
                ? '…'
                : activity === 'responding'
                  ? 'Responding…'
                  : 'Thinking…'
              : compact
                ? '↑'
                : 'Send'}
          </button>
        </form>
        {!compact ? (
          <div className="assistant-footnote">
            <span>
              RemindCore understanding · RemindSpeak replies · validated IR · local SQLite
            </span>
            <button
              type="button"
              data-armed={clearArmed}
              disabled={busy}
              aria-label={
                clearArmed ? 'Confirm clearing this conversation' : 'Clear this local conversation'
              }
              onClick={() => void handleClearConversation()}
            >
              {clearArmed ? 'Click again to clear' : 'Clear conversation'}
            </button>
          </div>
        ) : null}
      </section>
    </>
  )
}
