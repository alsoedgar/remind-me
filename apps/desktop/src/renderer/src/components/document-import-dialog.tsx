import { Temporal } from '@js-temporal/polyfill'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode
} from 'react'
import { planDocumentExtraction } from '@remind-me/importers/document'
import {
  reviewedDocumentItemSchema,
  type DocumentAnalysis,
  type DocumentFieldEvidence,
  type DocumentImportDraft,
  type DocumentProgressEvent,
  type DocumentSource,
  type EventForm,
  type ReminderForm,
  type ReviewedDocumentItem
} from '@remind-me/contracts'
import { DocumentProcessingCancelledError, LocalDocumentProcessor } from '../document-processor'
import { useCalendarStore } from '../store/calendar-store'
import {
  buildDocumentWeekPreview,
  componentLabels,
  documentWeekdays,
  formatDocumentTime
} from './document-week-preview'

type DialogPhase = 'choosing' | 'processing' | 'review' | 'saving' | 'error'
type EvidenceField = keyof DocumentFieldEvidence
type ReviewView = 'week' | 'details' | 'source'

interface EditableDraft {
  draft: DocumentImportDraft
  selected: boolean
}

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return 'The local document reader ran into a problem.'
  return error.message.replace(/^Error invoking remote method '[^']+': Error: /u, '')
}

function confidenceLabel(confidence: number): string {
  if (confidence >= 0.9) return 'high confidence'
  if (confidence >= 0.75) return 'good confidence'
  return 'check closely'
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function EvidenceLink({
  field,
  ids,
  onShow
}: {
  field: EvidenceField
  ids: readonly string[]
  onShow: (field: EvidenceField) => void
}): ReactNode {
  if (ids.length === 0) return null
  return (
    <button className="evidence-link" type="button" onClick={() => onShow(field)}>
      Show evidence
    </button>
  )
}

function EventDraftEditor({
  draft,
  onChange,
  onShowEvidence
}: {
  draft: Extract<DocumentImportDraft, { kind: 'event' }>
  onChange: (form: EventForm) => void
  onShowEvidence: (field: EvidenceField) => void
}): ReactNode {
  const form = draft.form
  const fieldId = (field: string): string => `${draft.id}-${field}`
  return (
    <div className="document-draft-editor">
      <div className="document-field full-field">
        <div className="document-field-heading">
          <label htmlFor={fieldId('title')}>Title</label>
          <EvidenceLink field="title" ids={draft.fieldEvidence.title} onShow={onShowEvidence} />
        </div>
        <input
          id={fieldId('title')}
          required
          maxLength={1000}
          value={form.title}
          onChange={(event) => onChange({ ...form, title: event.target.value })}
        />
      </div>
      {draft.schedule ? (
        <div className="document-course-identity" aria-label="Extracted class identity">
          <span>
            <strong>{draft.schedule.courseCode}</strong>
            {draft.schedule.sectionCode ? ` · section ${draft.schedule.sectionCode}` : ''}
          </span>
          <span>{componentLabels[draft.schedule.component]}</span>
          {draft.schedule.crn ? <span>CRN {draft.schedule.crn}</span> : null}
          {draft.schedule.creditHours !== null ? (
            <span>{draft.schedule.creditHours} credit hours</span>
          ) : null}
          <span>
            {draft.schedule.verification === 'layout-and-planscan'
              ? 'Layout + PlanScan agree'
              : 'Layout checked'}
          </span>
        </div>
      ) : null}
      <div className="document-form-grid">
        <div className="document-field">
          <div className="document-field-heading">
            <label htmlFor={fieldId('start-date')}>Starts</label>
            <EvidenceLink field="when" ids={draft.fieldEvidence.when} onShow={onShowEvidence} />
          </div>
          <input
            id={fieldId('start-date')}
            required
            type="date"
            value={form.startDate}
            onChange={(event) => onChange({ ...form, startDate: event.target.value })}
          />
        </div>
        {!form.allDay ? (
          <label className="document-field" htmlFor={fieldId('start-time')}>
            Start time
            <input
              id={fieldId('start-time')}
              required
              type="time"
              value={form.startTime ?? ''}
              onChange={(event) => onChange({ ...form, startTime: event.target.value })}
            />
          </label>
        ) : null}
        <label className="document-field" htmlFor={fieldId('end-date')}>
          Ends
          <input
            id={fieldId('end-date')}
            required
            type="date"
            min={form.startDate}
            value={form.endDate}
            onChange={(event) => onChange({ ...form, endDate: event.target.value })}
          />
        </label>
        {!form.allDay ? (
          <label className="document-field" htmlFor={fieldId('end-time')}>
            End time
            <input
              id={fieldId('end-time')}
              required
              type="time"
              value={form.endTime ?? ''}
              onChange={(event) => onChange({ ...form, endTime: event.target.value })}
            />
          </label>
        ) : null}
      </div>
      {form.recurrence?.frequency === 'weekly' ? (
        <fieldset className="document-recurrence-review">
          <legend>Repeats every week</legend>
          <p>Each checked day becomes one meeting at the time above.</p>
          <div>
            {documentWeekdays.map((weekday) => {
              const checked = form.recurrence?.byWeekday.includes(weekday) ?? false
              return (
                <label key={weekday} data-active={checked}>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={checked && form.recurrence?.byWeekday.length === 1}
                    onChange={(event) => {
                      if (form.recurrence?.frequency !== 'weekly') return
                      const byWeekday = event.target.checked
                        ? [...new Set([...form.recurrence.byWeekday, weekday])]
                        : form.recurrence.byWeekday.filter((day) => day !== weekday)
                      onChange({
                        ...form,
                        recurrence: { ...form.recurrence, byWeekday }
                      })
                    }}
                  />
                  {weekday.slice(0, 3)}
                </label>
              )
            })}
          </div>
          {form.recurrence.end.kind === 'until' ? (
            <label className="document-field">
              Last meeting date
              <input
                type="date"
                min={form.startDate}
                value={form.recurrence.end.date}
                onChange={(event) =>
                  onChange({
                    ...form,
                    recurrence:
                      form.recurrence?.frequency === 'weekly'
                        ? {
                            ...form.recurrence,
                            end: { kind: 'until', date: event.target.value }
                          }
                        : form.recurrence
                  })
                }
              />
            </label>
          ) : null}
        </fieldset>
      ) : null}
      <label className="document-check-label">
        <input
          type="checkbox"
          checked={form.allDay}
          onChange={(event) =>
            onChange({
              ...form,
              allDay: event.target.checked,
              startTime: event.target.checked ? null : (form.startTime ?? '09:00'),
              endTime: event.target.checked ? null : (form.endTime ?? '10:00')
            })
          }
        />
        All-day event
      </label>
      <div className="document-field full-field">
        <div className="document-field-heading">
          <label htmlFor={fieldId('location')}>Location</label>
          <EvidenceLink
            field="location"
            ids={draft.fieldEvidence.location}
            onShow={onShowEvidence}
          />
        </div>
        <input
          id={fieldId('location')}
          maxLength={1000}
          value={form.location}
          onChange={(event) => onChange({ ...form, location: event.target.value })}
          placeholder="Optional"
        />
      </div>
      <label className="document-field full-field" htmlFor={fieldId('notes')}>
        Notes
        <textarea
          id={fieldId('notes')}
          rows={2}
          maxLength={10000}
          value={form.description}
          onChange={(event) => onChange({ ...form, description: event.target.value })}
          placeholder="Optional"
        />
      </label>
    </div>
  )
}

function ReminderDraftEditor({
  draft,
  onChange,
  onShowEvidence
}: {
  draft: Extract<DocumentImportDraft, { kind: 'reminder' }>
  onChange: (form: ReminderForm) => void
  onShowEvidence: (field: EvidenceField) => void
}): ReactNode {
  const form = draft.form
  const fieldId = (field: string): string => `${draft.id}-${field}`
  return (
    <div className="document-draft-editor">
      <div className="document-field full-field">
        <div className="document-field-heading">
          <label htmlFor={fieldId('title')}>Reminder</label>
          <EvidenceLink field="title" ids={draft.fieldEvidence.title} onShow={onShowEvidence} />
        </div>
        <input
          id={fieldId('title')}
          required
          maxLength={1000}
          value={form.title}
          onChange={(event) => onChange({ ...form, title: event.target.value })}
        />
      </div>
      <div className="document-form-grid">
        <div className="document-field">
          <div className="document-field-heading">
            <label htmlFor={fieldId('due-date')}>Due</label>
            <EvidenceLink field="when" ids={draft.fieldEvidence.when} onShow={onShowEvidence} />
          </div>
          <input
            id={fieldId('due-date')}
            required
            type="date"
            value={form.dueDate}
            onChange={(event) => onChange({ ...form, dueDate: event.target.value })}
          />
        </div>
        <label className="document-field" htmlFor={fieldId('due-time')}>
          Time
          <input
            id={fieldId('due-time')}
            required
            type="time"
            value={form.dueTime}
            onChange={(event) => onChange({ ...form, dueTime: event.target.value })}
          />
        </label>
      </div>
      <label className="document-field full-field" htmlFor={fieldId('notes')}>
        Notes
        <textarea
          id={fieldId('notes')}
          rows={2}
          maxLength={10000}
          value={form.notes}
          onChange={(event) => onChange({ ...form, notes: event.target.value })}
          placeholder="Optional"
        />
      </label>
    </div>
  )
}

export function DocumentImportDialog({ onClose }: { onClose: () => void }): ReactNode {
  const snapshot = useCalendarStore((state) => state.snapshot)
  const range = useCalendarStore((state) => state.range)
  const applyMutationResult = useCalendarStore((state) => state.applyMutationResult)
  const [phase, setPhase] = useState<DialogPhase>('choosing')
  const [source, setSource] = useState<DocumentSource | null>(null)
  const [progressState, setProgressState] = useState<DocumentProgressEvent | null>(null)
  const [analysis, setAnalysis] = useState<DocumentAnalysis | null>(null)
  const [drafts, setDrafts] = useState<EditableDraft[]>([])
  const [activeDraftId, setActiveDraftId] = useState<string | null>(null)
  const [evidenceField, setEvidenceField] = useState<EvidenceField | null>(null)
  const [reviewView, setReviewView] = useState<ReviewView>('details')
  const [error, setError] = useState<string | null>(null)
  const [reviewError, setReviewError] = useState<string | null>(null)
  const processorRef = useRef<LocalDocumentProcessor | null>(null)
  const selectionIdRef = useRef<string | null>(null)
  const committedRef = useRef(false)

  const close = useCallback(() => {
    processorRef.current?.cancel()
    const selectionId = selectionIdRef.current
    if (selectionId && !committedRef.current) {
      void window.remindMe.discardDocumentSelection(selectionId).catch(() => undefined)
    }
    onClose()
  }, [onClose])

  useEffect(() => {
    if (!snapshot) {
      setPhase('error')
      setError('Your local calendar is still opening. Try the document again in a moment.')
      return undefined
    }
    let mounted = true
    const processor = new LocalDocumentProcessor()
    processorRef.current = processor

    const start = async (): Promise<void> => {
      try {
        const chosen = await window.remindMe.selectDocumentForPlanning()
        if (!mounted) return
        if (chosen.cancelled || !chosen.selection) {
          onClose()
          return
        }
        const selection = chosen.selection
        selectionIdRef.current = selection.source.id
        setSource(selection.source)
        setPhase('processing')
        const extraction = await processor.analyze(selection, (nextProgress) => {
          if (mounted) setProgressState(nextProgress)
        })
        if (!mounted) return
        setProgressState({
          stage: 'planning',
          progress: 0.96,
          message: 'Turning extracted dates into editable proposals…',
          currentPage: null,
          totalPages: extraction.pages.length
        })
        await new Promise<void>((resolveFrame) => requestAnimationFrame(() => resolveFrame()))
        const calendar = snapshot.calendars[0]
        if (!calendar) throw new Error('No local calendar is available')
        const nowUtc = new Date().toISOString()
        const localDate = Temporal.Instant.from(nowUtc)
          .toZonedDateTimeISO(snapshot.preferences.timezone)
          .toPlainDate()
          .toString()
        const planned = planDocumentExtraction(extraction, {
          selectionId: selection.source.id,
          nowUtc,
          localDate,
          timezone: snapshot.preferences.timezone,
          locale: snapshot.preferences.locale,
          defaultCalendarId: calendar.id,
          defaultEventDurationMinutes: 60,
          events: snapshot.events,
          reminders: snapshot.reminders
        })
        if (!mounted) return
        const editable = planned.drafts.map((draft) => ({ draft, selected: true }))
        setAnalysis(planned)
        setDrafts(editable)
        setActiveDraftId(editable[0]?.draft.id ?? null)
        setReviewView(planned.drafts.some((draft) => draft.schedule) ? 'week' : 'details')
        setPhase('review')
        setProgressState({
          stage: 'complete',
          progress: 1,
          message: 'Review is ready.',
          currentPage: null,
          totalPages: extraction.pages.length
        })
      } catch (processingError) {
        if (!mounted || processingError instanceof DocumentProcessingCancelledError) return
        setError(errorMessage(processingError))
        setPhase('error')
      }
    }

    void start()
    return () => {
      mounted = false
      processor.dispose()
      processorRef.current = null
    }
  }, [onClose, snapshot])

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && phase !== 'saving') close()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [close, phase])

  const active = drafts.find((item) => item.draft.id === activeDraftId) ?? null
  const allBlocks = useMemo(
    () => analysis?.extraction.pages.flatMap((page) => page.blocks) ?? [],
    [analysis]
  )
  const activeEvidenceIds = useMemo(() => {
    if (!active) return []
    if (evidenceField) return active.draft.fieldEvidence[evidenceField]
    return [
      ...new Set([
        ...active.draft.fieldEvidence.title,
        ...active.draft.fieldEvidence.when,
        ...active.draft.fieldEvidence.location,
        ...active.draft.fieldEvidence.description
      ])
    ]
  }, [active, evidenceField])
  const activeEvidence = useMemo(
    () => allBlocks.filter((block) => activeEvidenceIds.includes(block.id)),
    [activeEvidenceIds, allBlocks]
  )
  const activePageNumber = activeEvidence[0]?.page ?? active?.draft.page ?? 1
  const activePage =
    analysis?.extraction.pages.find((page) => page.page === activePageNumber) ?? null
  const selectedCount = drafts.filter((item) => item.selected).length
  const weekPreview = useMemo(
    () => buildDocumentWeekPreview(drafts.map((item) => item.draft)),
    [drafts]
  )
  const selectedWeekPreview = useMemo(
    () =>
      buildDocumentWeekPreview(drafts.filter((item) => item.selected).map((item) => item.draft)),
    [drafts]
  )

  function updateEventForm(draftId: string, update: (form: EventForm) => EventForm): void {
    setDrafts((current) =>
      current.map((item) =>
        item.draft.id === draftId && item.draft.kind === 'event'
          ? { ...item, draft: { ...item.draft, form: update(item.draft.form) } }
          : item
      )
    )
  }

  function updateReminderForm(draftId: string, update: (form: ReminderForm) => ReminderForm): void {
    setDrafts((current) =>
      current.map((item) =>
        item.draft.id === draftId && item.draft.kind === 'reminder'
          ? { ...item, draft: { ...item.draft, form: update(item.draft.form) } }
          : item
      )
    )
  }

  function toggleDraft(draftId: string): void {
    setDrafts((current) =>
      current.map((item) =>
        item.draft.id === draftId ? { ...item, selected: !item.selected } : item
      )
    )
  }

  function showEvidence(field: EvidenceField): void {
    setEvidenceField(field)
    setReviewView('source')
  }

  async function commit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!analysis || selectedCount === 0 || phase === 'saving') return
    setReviewError(null)
    const items: ReviewedDocumentItem[] = []
    try {
      for (const item of drafts.filter((candidate) => candidate.selected)) {
        items.push(
          reviewedDocumentItemSchema.parse({
            draftId: item.draft.id,
            kind: item.draft.kind,
            form: item.draft.form
          })
        )
      }
    } catch (validationError) {
      setReviewError(
        `One selected item needs a valid title, date, and time before saving. ${errorMessage(validationError)}`
      )
      return
    }
    setPhase('saving')
    try {
      const result = await window.remindMe.commitDocumentImport(analysis.selectionId, items, range)
      committedRef.current = true
      applyMutationResult(result)
      onClose()
    } catch (commitError) {
      setReviewError(errorMessage(commitError))
      setPhase('review')
    }
  }

  const isReview = phase === 'review' || phase === 'saving'
  return (
    <div
      className="dialog-backdrop document-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && phase !== 'saving') close()
      }}
    >
      <section
        className="document-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="document-dialog-title"
      >
        <header className="dialog-header document-dialog-header">
          <div className="document-title-lockup">
            <span className="document-spark" aria-hidden="true">
              ✦
            </span>
            <div>
              <p className="eyebrow">Private document planning</p>
              <h2 id="document-dialog-title">
                {isReview ? 'Review what I found' : 'Read a schedule locally'}
              </h2>
              {source ? (
                <p className="document-source-line">
                  {source.displayName} · {formatBytes(source.byteLength)} · never uploaded
                </p>
              ) : null}
            </div>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="Close document planner"
            disabled={phase === 'saving'}
            onClick={close}
          >
            ×
          </button>
        </header>

        {phase === 'choosing' || phase === 'processing' ? (
          <div className="document-processing" role="status" aria-live="polite">
            <div className="document-processing-glyph" aria-hidden="true">
              <span />
              <i>✦</i>
            </div>
            <div>
              <p className="eyebrow">PDF text first · OCR only when needed</p>
              <h3>
                {phase === 'choosing'
                  ? 'Waiting for your file…'
                  : (progressState?.message ?? 'Starting the local reader…')}
              </h3>
              <p>
                Processing runs in an isolated worker with bundled models. You can cancel without
                changing your calendar.
              </p>
            </div>
            <span className="document-progress-track" aria-hidden="true">
              <span style={{ width: `${Math.round((progressState?.progress ?? 0.02) * 100)}%` }} />
            </span>
            <div className="document-processing-meta">
              <span>
                {progressState?.currentPage && progressState.totalPages
                  ? `Page ${progressState.currentPage} of ${progressState.totalPages}`
                  : 'On this device'}
              </span>
              <button className="secondary-button" type="button" onClick={close}>
                Cancel
              </button>
            </div>
          </div>
        ) : null}

        {phase === 'error' ? (
          <div className="document-error" role="alert">
            <span aria-hidden="true">!</span>
            <h3>I stopped before making any proposals</h3>
            <p>{error}</p>
            <p className="document-error-hint">
              Try a smaller, unlocked PDF or export the image as PNG or JPEG.
            </p>
            <button className="retro-button" type="button" onClick={close}>
              Close safely
            </button>
          </div>
        ) : null}

        {isReview && analysis ? (
          <form className="document-review" onSubmit={(event) => void commit(event)}>
            <div className="document-review-toolbar">
              <div>
                <strong>
                  {weekPreview.scheduleSeriesCount > 0
                    ? `${weekPreview.scheduleSeriesCount} recurring series · ${weekPreview.meetingCount} meetings each week`
                    : `${analysis.drafts.length} proposal${analysis.drafts.length === 1 ? '' : 's'}`}
                </strong>
                <span>
                  {selectedCount} of {analysis.drafts.length} selected ·{' '}
                  {weekPreview.courseCount > 0 ? `${weekPreview.courseCount} courses · ` : ''}
                  {analysis.extraction.pages.reduce(
                    (total, page) => total + page.words.length,
                    0
                  )}{' '}
                  positioned words
                </span>
              </div>
              <div className="document-selection-actions">
                <span
                  className="planscan-review-chip"
                  data-active={Boolean(analysis.extraction.planScan)}
                  title={
                    analysis.extraction.planScan
                      ? `${analysis.extraction.planScan.modelId} linked evidence in ${analysis.extraction.planScan.processingDurationMs} ms`
                      : 'The learned model was unavailable; deterministic rules remain active.'
                  }
                >
                  {analysis.extraction.planScan
                    ? `Dual checked · ${drafts.filter((item) => item.draft.schedule?.verification === 'layout-and-planscan').length}`
                    : 'Rules fallback'}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    setDrafts((current) => current.map((item) => ({ ...item, selected: true })))
                  }
                >
                  Select all
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setDrafts((current) => current.map((item) => ({ ...item, selected: false })))
                  }
                >
                  Select none
                </button>
              </div>
            </div>

            <nav className="document-review-tabs" aria-label="Document confirmation views">
              {(
                [
                  ['week', 'Week preview', `${selectedWeekPreview.meetingCount} selected meetings`],
                  ['details', 'Edit details', `${selectedCount} selected series`],
                  [
                    'source',
                    'Source',
                    `${analysis.extraction.pages.length} page${analysis.extraction.pages.length === 1 ? '' : 's'}`
                  ]
                ] as const
              ).map(([view, label, hint]) => (
                <button
                  key={view}
                  type="button"
                  data-active={reviewView === view}
                  aria-current={reviewView === view ? 'page' : undefined}
                  onClick={() => setReviewView(view)}
                >
                  <strong>{label}</strong>
                  <span>{hint}</span>
                </button>
              ))}
            </nav>

            {analysis.plannerWarnings.length > 0 ? (
              <details className="document-warning">
                <summary>
                  <strong>{analysis.plannerWarnings.length} local reader checks</strong>
                  <span>Open for extraction notes</span>
                </summary>
                <div role="status">
                  {analysis.plannerWarnings.map((warning) => (
                    <p key={warning}>{warning}</p>
                  ))}
                </div>
              </details>
            ) : null}

            <div className="document-review-grid" data-view={reviewView}>
              <section
                className="document-week-preview"
                aria-label="Weekly calendar confirmation"
                hidden={reviewView !== 'week'}
              >
                <div className="document-week-summary">
                  <div>
                    <p className="eyebrow">One series can appear on several days</p>
                    <h3>Check the week at a glance</h3>
                    <p>
                      M/W/F appears three times below but saves as one recurring series. Different
                      sections and CRNs stay separate.
                    </p>
                  </div>
                  <div className="document-week-stats" aria-label="Schedule totals">
                    <span>
                      <strong>{weekPreview.seriesCount}</strong>series
                    </span>
                    <span>
                      <strong>{weekPreview.meetingCount}</strong>meetings / week
                    </span>
                    <span>
                      <strong>{weekPreview.courseCount || '—'}</strong>courses
                    </span>
                  </div>
                </div>
                <div className="document-week-board">
                  {weekPreview.days.map((day) => (
                    <section className="document-week-day" key={day.weekday}>
                      <header>
                        <strong>{day.weekday.slice(0, 3)}</strong>
                        <span>{day.items.length || '—'}</span>
                      </header>
                      <div>
                        {day.items.map((meeting) => {
                          const editable = drafts.find((item) => item.draft.id === meeting.draftId)
                          return (
                            <article
                              className="document-week-meeting"
                              data-color={meeting.colorIndex}
                              data-selected={editable?.selected ?? false}
                              key={`${meeting.draftId}:${day.weekday}`}
                            >
                              <div className="document-week-meeting-heading">
                                <span>{formatDocumentTime(meeting.startTime)}</span>
                                <label>
                                  <input
                                    type="checkbox"
                                    checked={editable?.selected ?? false}
                                    onChange={() => toggleDraft(meeting.draftId)}
                                  />
                                  <span className="visually-hidden">
                                    Select {meeting.title} on {day.weekday}
                                  </span>
                                </label>
                              </div>
                              <button
                                type="button"
                                onClick={() => {
                                  setActiveDraftId(meeting.draftId)
                                  setEvidenceField(null)
                                  setReviewView('details')
                                }}
                              >
                                <strong>{meeting.title}</strong>
                                <span>
                                  {[meeting.courseCode, meeting.sectionCode]
                                    .filter(Boolean)
                                    .join(' · ')}
                                </span>
                                {meeting.component ? (
                                  <em>{componentLabels[meeting.component]}</em>
                                ) : null}
                                <small>
                                  {formatDocumentTime(meeting.startTime)}
                                  {meeting.endTime ? `–${formatDocumentTime(meeting.endTime)}` : ''}
                                  {meeting.location ? ` · ${meeting.location}` : ''}
                                </small>
                              </button>
                            </article>
                          )
                        })}
                        {day.items.length === 0 ? (
                          <span className="document-week-empty">open</span>
                        ) : null}
                      </div>
                    </section>
                  ))}
                </div>
              </section>

              <div
                className="document-draft-list"
                aria-label="Editable proposed calendar items"
                hidden={reviewView !== 'details'}
              >
                {drafts.map((item, index) => {
                  const draft = item.draft
                  const isActive = draft.id === activeDraftId
                  return (
                    <article
                      className="document-draft-card"
                      data-active={isActive}
                      data-selected={item.selected}
                      key={draft.id}
                    >
                      <div className="document-draft-heading">
                        <label className="document-draft-select">
                          <input
                            type="checkbox"
                            checked={item.selected}
                            onChange={() => toggleDraft(draft.id)}
                          />
                          <span className="visually-hidden">Select proposal {index + 1}</span>
                        </label>
                        <button
                          className="document-draft-summary"
                          type="button"
                          aria-expanded={isActive}
                          onClick={() => {
                            setActiveDraftId(draft.id)
                            setEvidenceField(null)
                          }}
                        >
                          <span>
                            <i>
                              {draft.schedule
                                ? componentLabels[draft.schedule.component]
                                : draft.kind}
                            </i>
                            <strong>{draft.form.title}</strong>
                          </span>
                          <small>
                            {draft.schedule
                              ? [
                                  draft.schedule.courseCode,
                                  draft.schedule.sectionCode,
                                  draft.schedule.crn
                                ]
                                  .filter(Boolean)
                                  .join(' · ')
                              : `Page ${draft.page}`}{' '}
                            · {Math.round(draft.confidence * 100)}% ·{' '}
                            {confidenceLabel(draft.confidence)}
                          </small>
                        </button>
                      </div>
                      {isActive ? (
                        <>
                          {draft.kind === 'event' ? (
                            <EventDraftEditor
                              draft={draft}
                              onChange={(form) => updateEventForm(draft.id, () => form)}
                              onShowEvidence={showEvidence}
                            />
                          ) : (
                            <ReminderDraftEditor
                              draft={draft}
                              onChange={(form) => updateReminderForm(draft.id, () => form)}
                              onShowEvidence={showEvidence}
                            />
                          )}
                          {draft.warnings.length > 0 ? (
                            <ul className="document-draft-warnings">
                              {draft.warnings.map((warning) => (
                                <li key={warning}>{warning}</li>
                              ))}
                            </ul>
                          ) : null}
                        </>
                      ) : null}
                    </article>
                  )
                })}
                {drafts.length === 0 ? (
                  <div className="document-empty-drafts">
                    <span aria-hidden="true">⌁</span>
                    <h3>No complete plans yet</h3>
                    <p>
                      The reader needs a title, date, and time together. You can close this review
                      and type the missing details to the assistant.
                    </p>
                  </div>
                ) : null}
              </div>

              <aside
                className="document-evidence-panel"
                aria-label="Visible source evidence"
                hidden={reviewView !== 'source'}
              >
                <div className="document-evidence-heading">
                  <div>
                    <p className="eyebrow">Visible evidence</p>
                    <h3>
                      Page {activePageNumber}
                      {evidenceField ? ` · ${evidenceField}` : ''}
                    </h3>
                  </div>
                  {activePage ? <span>{activePage.extraction.replace('-', ' ')}</span> : null}
                </div>
                {activePage ? (
                  <div className="document-page-frame">
                    <img
                      src={activePage.thumbnailDataUrl}
                      alt={`Source preview, page ${activePage.page}`}
                    />
                    <div className="document-evidence-overlay" aria-hidden="true">
                      {activeEvidence
                        .filter((block) => block.page === activePage.page)
                        .map((block) => (
                          <span
                            key={block.id}
                            style={{
                              left: `${block.boundingBox.x * 100}%`,
                              top: `${block.boundingBox.y * 100}%`,
                              width: `${block.boundingBox.width * 100}%`,
                              height: `${block.boundingBox.height * 100}%`
                            }}
                          />
                        ))}
                    </div>
                  </div>
                ) : (
                  <div className="document-no-evidence">Choose a proposal to see its source.</div>
                )}
                <div className="document-evidence-copy">
                  {activeEvidence.length > 0 ? (
                    activeEvidence.map((block) => (
                      <blockquote key={block.id}>
                        <span>
                          page {block.page} · {block.method.replace('-', ' ')} ·{' '}
                          {Math.round(block.confidence * 100)}%
                        </span>
                        “{block.text}”
                      </blockquote>
                    ))
                  ) : (
                    <p>Select “Show evidence” beside a field to isolate the exact source line.</p>
                  )}
                </div>
                <p className="document-evidence-note">
                  Highlights are normalized bounding boxes from PDF text or local OCR. Edits stay
                  editable and are never written back to the source file.
                </p>
              </aside>
            </div>

            {reviewError ? (
              <div className="document-review-error" role="alert">
                {reviewError}
              </div>
            ) : null}
            <footer className="document-review-footer">
              <div>
                <strong>Nothing is saved until you confirm.</strong>
                <span>The selected batch becomes one undoable local action.</span>
              </div>
              <div>
                <button
                  className="secondary-button"
                  type="button"
                  disabled={phase === 'saving'}
                  onClick={close}
                >
                  Discard
                </button>
                <button
                  className="retro-button"
                  type="submit"
                  disabled={phase === 'saving' || selectedCount === 0}
                >
                  {phase === 'saving'
                    ? 'Saving locally…'
                    : `Add ${selectedCount} selected item${selectedCount === 1 ? '' : 's'}`}
                </button>
              </div>
            </footer>
          </form>
        ) : null}
      </section>
    </div>
  )
}
