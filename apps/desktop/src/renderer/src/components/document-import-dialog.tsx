import { Temporal } from '@js-temporal/polyfill'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from 'react'
import {
  createEventDocumentImportIdentity,
  createReminderDocumentImportIdentity,
  reconcileDocumentEvent,
  reconcileDocumentReminder
} from '@remind-me/calendar-engine'
import {
  applyDocumentFallbackResponse,
  applyDocumentRepairResponse,
  buildDocumentFallbackRequests,
  planDocumentExtraction
} from '@remind-me/importers/document'
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
import {
  buildDocumentChronology,
  buildDocumentMonthPreview,
  summarizeDocumentReview
} from './document-review-preview'
import {
  canMergeDocumentDrafts,
  canReclassifyDocumentDraft,
  canSplitDocumentDraft,
  mergeDocumentDrafts,
  reclassifyDocumentDraft,
  splitDocumentDraft
} from './document-review-operations'

type DialogPhase = 'choosing' | 'processing' | 'review' | 'saving' | 'error'
type EvidenceField = keyof DocumentFieldEvidence
type ReviewView = 'week' | 'timeline' | 'month' | 'details' | 'source'

interface EditableDraft {
  draft: DocumentImportDraft
  selected: boolean
  selectionMode: 'recommended' | 'user'
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

function formatDocumentDate(date: string, locale: string): string {
  const parsed = Temporal.PlainDate.from(date)
  return new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC'
  }).format(new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day)))
}

function recurrenceSummary(draft: DocumentImportDraft): string {
  const recurrence = draft.form.recurrence
  if (!recurrence) return 'One time'
  const interval = recurrence.interval === 1 ? '' : ` every ${recurrence.interval}`
  const days =
    recurrence.frequency === 'weekly' && recurrence.byWeekday.length > 0
      ? ` · ${recurrence.byWeekday.map((day) => day.slice(0, 3)).join(', ')}`
      : ''
  const ending =
    recurrence.end.kind === 'until'
      ? ` · through ${recurrence.end.date}`
      : recurrence.end.kind === 'count'
        ? ` · ${recurrence.end.count} times`
        : ''
  return `${recurrence.frequency}${interval}${days}${ending}`
}

const reconciliationCopy = {
  new: {
    label: 'New item',
    message: 'No matching calendar item was found.'
  },
  'same-source': {
    label: 'Already imported',
    message: 'This exact document row is already on your calendar and cannot be added twice.'
  },
  'likely-duplicate': {
    label: 'Possible duplicate',
    message: 'A very similar item exists. Compare it below, then select this one only if needed.'
  },
  'protected-distinct': {
    label: 'Distinct class',
    message: 'A similar class exists, but its CRN, section, or component is different.'
  }
} as const

const reconciliationRelationshipCopy = {
  'same-source-row': 'same imported source row',
  'same-semantic-item': 'same course/date identity',
  'likely-semantic-overlap': 'matching title, date, and time',
  'protected-distinct-course': 'different CRN, section, or component'
} as const

function EvidenceLink({
  field,
  ids,
  confidence,
  onShow
}: {
  field: EvidenceField
  ids: readonly string[]
  confidence: number | null
  onShow: (field: EvidenceField) => void
}): ReactNode {
  if (ids.length === 0) return null
  return (
    <button className="evidence-link" type="button" onClick={() => onShow(field)}>
      Evidence {confidence === null ? '' : `${Math.round(confidence * 100)}%`}
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
          <EvidenceLink
            field="title"
            ids={draft.fieldEvidence.title}
            confidence={draft.fieldConfidence.title}
            onShow={onShowEvidence}
          />
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
              : draft.schedule.verification === 'fallback-grouping'
                ? 'Qwen grouped · code verified'
                : 'Layout checked'}
          </span>
        </div>
      ) : null}
      <div className="document-form-grid">
        <div className="document-field">
          <div className="document-field-heading">
            <label htmlFor={fieldId('start-date')}>Starts</label>
            <EvidenceLink
              field="when"
              ids={draft.fieldEvidence.when}
              confidence={draft.fieldConfidence.when}
              onShow={onShowEvidence}
            />
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
            confidence={draft.fieldConfidence.location}
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
      <div className="document-field full-field">
        <div className="document-field-heading">
          <label htmlFor={fieldId('notes')}>Notes</label>
          <EvidenceLink
            field="description"
            ids={draft.fieldEvidence.description}
            confidence={draft.fieldConfidence.description}
            onShow={onShowEvidence}
          />
        </div>
        <textarea
          id={fieldId('notes')}
          rows={2}
          maxLength={10000}
          value={form.description}
          onChange={(event) => onChange({ ...form, description: event.target.value })}
          placeholder="Optional"
        />
      </div>
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
          <EvidenceLink
            field="title"
            ids={draft.fieldEvidence.title}
            confidence={draft.fieldConfidence.title}
            onShow={onShowEvidence}
          />
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
            <EvidenceLink
              field="when"
              ids={draft.fieldEvidence.when}
              confidence={draft.fieldConfidence.when}
              onShow={onShowEvidence}
            />
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
      <div className="document-field full-field">
        <div className="document-field-heading">
          <label htmlFor={fieldId('notes')}>Notes</label>
          <EvidenceLink
            field="description"
            ids={draft.fieldEvidence.description}
            confidence={draft.fieldConfidence.description}
            onShow={onShowEvidence}
          />
        </div>
        <textarea
          id={fieldId('notes')}
          rows={2}
          maxLength={10000}
          value={form.notes}
          onChange={(event) => onChange({ ...form, notes: event.target.value })}
          placeholder="Optional"
        />
      </div>
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
  const [activeSkippedId, setActiveSkippedId] = useState<string | null>(null)
  const [evidenceField, setEvidenceField] = useState<EvidenceField | null>(null)
  const [reviewView, setReviewView] = useState<ReviewView>('details')
  const [reviewMonth, setReviewMonth] = useState(new Date().toISOString().slice(0, 7))
  const [sourcePageNumber, setSourcePageNumber] = useState(1)
  const [sourceZoom, setSourceZoom] = useState(1)
  const [error, setError] = useState<string | null>(null)
  const [reviewError, setReviewError] = useState<string | null>(null)
  const [reviewNotice, setReviewNotice] = useState<string | null>(null)
  const processorRef = useRef<LocalDocumentProcessor | null>(null)
  const selectionIdRef = useRef<string | null>(null)
  const committedRef = useRef(false)
  const sourceFrameRef = useRef<HTMLDivElement | null>(null)
  const sourcePanRef = useRef({ active: false, x: 0, y: 0, left: 0, top: 0 })

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
        const planningContext = {
          selectionId: selection.source.id,
          nowUtc,
          localDate,
          timezone: snapshot.preferences.timezone,
          locale: snapshot.preferences.locale,
          defaultCalendarId: calendar.id,
          defaultEventDurationMinutes: 60,
          events: snapshot.events,
          reminders: snapshot.reminders
        }
        const planned = planDocumentExtraction(extraction, planningContext)
        if (!mounted) return
        let reviewedPlan = planned
        if (planned.repairSession) {
          setProgressState({
            stage: 'planning',
            progress: 0.98,
            message: 'Checking parser disagreements against quoted source text…',
            currentPage: null,
            totalPages: extraction.pages.length
          })
          try {
            const repair = await window.remindMe.repairDocumentDisagreement(
              planned.repairSession.request
            )
            if (!mounted) return
            if (repair) reviewedPlan = applyDocumentRepairResponse(planned, repair)
          } catch {
            // The optional model is advisory. Deterministic proposals remain
            // reviewable if the pack is unavailable or cannot ground a choice.
          }
        }
        const fallbackRequests = buildDocumentFallbackRequests(reviewedPlan)
        if (fallbackRequests.length > 0) {
          setProgressState({
            stage: 'planning',
            progress: 0.99,
            message: 'Checking ungrouped source fields with the installed local fallback…',
            currentPage: fallbackRequests[0]?.page ?? null,
            totalPages: extraction.pages.length
          })
          try {
            for (const request of fallbackRequests) {
              const fallback = await window.remindMe.groupDocumentCoverageGap(request)
              if (!mounted) return
              if (!fallback) break
              reviewedPlan = applyDocumentFallbackResponse(
                reviewedPlan,
                request,
                fallback,
                planningContext
              )
            }
          } catch {
            // The optional model can add only grounded review candidates. The
            // deterministic result remains intact if the pack is unavailable.
          }
        }
        const editable = reviewedPlan.drafts.map((draft) => ({
          draft,
          selected: draft.reconciliation.recommendedSelected,
          selectionMode: 'recommended' as const
        }))
        setAnalysis(reviewedPlan)
        setDrafts(editable)
        setActiveDraftId(editable[0]?.draft.id ?? null)
        setActiveSkippedId(
          editable.length === 0 ? (reviewedPlan.skippedItems[0]?.id ?? null) : null
        )
        setSourcePageNumber(editable[0]?.draft.page ?? reviewedPlan.skippedItems[0]?.page ?? 1)
        setReviewMonth(
          (
            reviewedPlan.drafts
              .map((draft) => (draft.kind === 'event' ? draft.form.startDate : draft.form.dueDate))
              .sort()[0] ?? localDate
          ).slice(0, 7)
        )
        setReviewView(
          reviewedPlan.drafts.length === 0
            ? 'details'
            : reviewedPlan.drafts.some((draft) => draft.schedule)
              ? 'week'
              : 'timeline'
        )
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
  const activeSkipped = analysis?.skippedItems.find((item) => item.id === activeSkippedId) ?? null
  const allBlocks = useMemo(
    () => analysis?.extraction.pages.flatMap((page) => page.blocks) ?? [],
    [analysis]
  )
  const activeEvidenceIds = useMemo(() => {
    if (activeSkipped) return activeSkipped.evidenceIds
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
  }, [active, activeSkipped, evidenceField])
  const activeEvidence = useMemo(
    () => allBlocks.filter((block) => activeEvidenceIds.includes(block.id)),
    [activeEvidenceIds, allBlocks]
  )
  const activePageNumber = analysis?.extraction.pages.some((page) => page.page === sourcePageNumber)
    ? sourcePageNumber
    : (activeEvidence[0]?.page ?? active?.draft.page ?? activeSkipped?.page ?? 1)
  const activePage =
    analysis?.extraction.pages.find((page) => page.page === activePageNumber) ?? null
  const selectedDrafts = useMemo(
    () => drafts.filter((item) => item.selected).map((item) => item.draft),
    [drafts]
  )
  const selectedCount = selectedDrafts.length
  const reconciliationCounts = useMemo(
    () => ({
      sameSource: drafts.filter((item) => item.draft.reconciliation.state === 'same-source').length,
      likelyDuplicate: drafts.filter(
        (item) => item.draft.reconciliation.state === 'likely-duplicate'
      ).length,
      protectedDistinct: drafts.filter(
        (item) => item.draft.reconciliation.state === 'protected-distinct'
      ).length
    }),
    [drafts]
  )
  const weekPreview = useMemo(
    () => buildDocumentWeekPreview(drafts.map((item) => item.draft)),
    [drafts]
  )
  const selectedWeekPreview = useMemo(
    () => buildDocumentWeekPreview(selectedDrafts),
    [selectedDrafts]
  )
  const chronology = useMemo(() => buildDocumentChronology(selectedDrafts), [selectedDrafts])
  const monthPreview = useMemo(
    () =>
      buildDocumentMonthPreview(
        selectedDrafts,
        reviewMonth,
        snapshot?.preferences.locale ?? 'en-US'
      ),
    [reviewMonth, selectedDrafts, snapshot?.preferences.locale]
  )
  const reviewTotals = useMemo(
    () =>
      summarizeDocumentReview(
        drafts.map((item) => item.draft),
        analysis?.skippedItems ?? []
      ),
    [analysis?.skippedItems, drafts]
  )
  const draftGroups = useMemo(() => {
    const groups = new Map<
      string,
      { key: string; label: string; detail: string; items: EditableDraft[] }
    >()
    for (const item of drafts) {
      const schedule = item.draft.schedule
      const key = schedule ? `course:${schedule.courseCode.toLocaleLowerCase()}` : 'other-plans'
      const current = groups.get(key) ?? {
        key,
        label: schedule?.courseCode ?? 'Other dated plans',
        detail: schedule ? 'Course components stay separate' : 'Events and reminders',
        items: []
      }
      current.items.push(item)
      groups.set(key, current)
    }
    return [...groups.values()].map((group) => ({
      ...group,
      detail: group.key.startsWith('course:')
        ? `${[
            ...new Set(
              group.items
                .map((item) => item.draft.schedule?.component)
                .filter((component): component is NonNullable<typeof component> =>
                  Boolean(component)
                )
                .map((component) => componentLabels[component])
            )
          ].join(' · ')} · ${group.items.length} series`
        : `${group.items.length} item${group.items.length === 1 ? '' : 's'}`
    }))
  }, [drafts])

  function updateEventForm(draftId: string, update: (form: EventForm) => EventForm): void {
    setDrafts((current) =>
      current.map((item) => {
        if (item.draft.id !== draftId || item.draft.kind !== 'event') return item
        const form = update(item.draft.form)
        let importIdentity: typeof item.draft.importIdentity
        let reconciliation: typeof item.draft.reconciliation
        try {
          importIdentity = createEventDocumentImportIdentity(
            {
              sourceSha256: item.draft.importIdentity.sourceSha256,
              sourceRowId: item.draft.importIdentity.sourceRowId
            },
            form,
            item.draft.schedule
          )
          reconciliation = reconcileDocumentEvent(
            importIdentity,
            form,
            snapshot?.events ?? [],
            snapshot?.reminders ?? []
          )
        } catch {
          return { ...item, draft: { ...item.draft, form } }
        }
        return {
          ...item,
          selected:
            reconciliation.state === 'same-source'
              ? false
              : item.selectionMode === 'recommended'
                ? reconciliation.recommendedSelected
                : item.selected,
          draft: { ...item.draft, form, importIdentity, reconciliation }
        }
      })
    )
  }

  function updateReminderForm(draftId: string, update: (form: ReminderForm) => ReminderForm): void {
    setDrafts((current) =>
      current.map((item) => {
        if (item.draft.id !== draftId || item.draft.kind !== 'reminder') return item
        const form = update(item.draft.form)
        let importIdentity: typeof item.draft.importIdentity
        let reconciliation: typeof item.draft.reconciliation
        try {
          importIdentity = createReminderDocumentImportIdentity(
            {
              sourceSha256: item.draft.importIdentity.sourceSha256,
              sourceRowId: item.draft.importIdentity.sourceRowId
            },
            form
          )
          reconciliation = reconcileDocumentReminder(
            importIdentity,
            form,
            snapshot?.reminders ?? [],
            snapshot?.events ?? []
          )
        } catch {
          return { ...item, draft: { ...item.draft, form } }
        }
        return {
          ...item,
          selected:
            reconciliation.state === 'same-source'
              ? false
              : item.selectionMode === 'recommended'
                ? reconciliation.recommendedSelected
                : item.selected,
          draft: { ...item.draft, form, importIdentity, reconciliation }
        }
      })
    )
  }

  function toggleDraft(draftId: string): void {
    setDrafts((current) =>
      current.map((item) =>
        item.draft.id === draftId && item.draft.reconciliation.state !== 'same-source'
          ? { ...item, selected: !item.selected, selectionMode: 'user' }
          : item
      )
    )
  }

  function activateDraft(draftId: string, nextView?: ReviewView): void {
    const draft = drafts.find((item) => item.draft.id === draftId)?.draft
    setActiveDraftId(draftId)
    setActiveSkippedId(null)
    setEvidenceField(null)
    if (draft) setSourcePageNumber(draft.page)
    if (nextView) setReviewView(nextView)
  }

  function showEvidence(field: EvidenceField): void {
    const ids = active?.draft.fieldEvidence[field] ?? []
    const page = allBlocks.find((block) => ids.includes(block.id))?.page
    setEvidenceField(field)
    setActiveSkippedId(null)
    if (page) setSourcePageNumber(page)
    setReviewView('source')
  }

  function showSkippedEvidence(skippedId: string): void {
    const skipped = analysis?.skippedItems.find((item) => item.id === skippedId)
    if (!skipped) return
    setActiveDraftId(null)
    setActiveSkippedId(skipped.id)
    setEvidenceField(null)
    setSourcePageNumber(skipped.page)
    setReviewView('source')
  }

  function splitDraft(draftId: string): void {
    const editable = drafts.find((item) => item.draft.id === draftId)
    if (!editable || !canSplitDocumentDraft(editable.draft)) return
    const split = splitDocumentDraft(
      editable.draft,
      snapshot?.events ?? [],
      snapshot?.reminders ?? []
    )
    setDrafts((current) =>
      current.flatMap((item) =>
        item.draft.id === draftId
          ? split.map((draft) => ({
              draft,
              selected: editable.selected && draft.reconciliation.state !== 'same-source',
              selectionMode: 'user' as const
            }))
          : [item]
      )
    )
    setActiveDraftId(split[0]?.id ?? null)
    setReviewNotice(
      `Split “${editable.draft.form.title}” into ${split.length} independently editable weekday series.`
    )
    setReviewError(null)
  }

  function mergeMatchingDrafts(draftId: string): void {
    const editable = drafts.find((item) => item.draft.id === draftId)
    if (!editable) return
    const matches = drafts
      .filter(
        (item) =>
          item.selected &&
          item.draft.id !== draftId &&
          canMergeDocumentDrafts(editable.draft, item.draft)
      )
      .map((item) => item.draft)
    if (matches.length === 0) {
      setReviewError(
        'No other selected weekly series is safe to merge. Titles, times, locations, term bounds, CRNs, sections, and components must agree.'
      )
      return
    }
    const merged = mergeDocumentDrafts(
      editable.draft,
      matches,
      snapshot?.events ?? [],
      snapshot?.reminders ?? []
    )
    const removedIds = new Set([editable.draft.id, ...matches.map((draft) => draft.id)])
    setDrafts((current) =>
      current.flatMap((item) => {
        if (item.draft.id === editable.draft.id) {
          return [
            {
              draft: merged,
              selected: merged.reconciliation.state !== 'same-source',
              selectionMode: 'user' as const
            }
          ]
        }
        return removedIds.has(item.draft.id) ? [] : [item]
      })
    )
    setActiveDraftId(merged.id)
    setReviewNotice(`Merged ${matches.length + 1} matching weekly series into one review item.`)
    setReviewError(null)
  }

  function reclassifyDraft(draftId: string): void {
    const editable = drafts.find((item) => item.draft.id === draftId)
    if (!editable || !canReclassifyDocumentDraft(editable.draft)) return
    const draft = reclassifyDocumentDraft(
      editable.draft,
      snapshot?.events ?? [],
      snapshot?.reminders ?? []
    )
    setDrafts((current) =>
      current.map((item) =>
        item.draft.id === draftId
          ? {
              draft,
              selected: draft.reconciliation.state !== 'same-source' && item.selected,
              selectionMode: 'user'
            }
          : item
      )
    )
    setReviewNotice(
      `Reclassified “${draft.form.title}” as ${draft.kind === 'event' ? 'an event' : 'a reminder'}.`
    )
    setReviewError(null)
  }

  function moveReviewMonth(months: number): void {
    setReviewMonth((current) => Temporal.PlainYearMonth.from(current).add({ months }).toString())
  }

  function beginSourcePan(event: ReactPointerEvent<HTMLDivElement>): void {
    const frame = sourceFrameRef.current
    if (!frame || sourceZoom <= 1) return
    sourcePanRef.current = {
      active: true,
      x: event.clientX,
      y: event.clientY,
      left: frame.scrollLeft,
      top: frame.scrollTop
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function moveSourcePan(event: ReactPointerEvent<HTMLDivElement>): void {
    const frame = sourceFrameRef.current
    const pan = sourcePanRef.current
    if (!frame || !pan.active) return
    frame.scrollLeft = pan.left - (event.clientX - pan.x)
    frame.scrollTop = pan.top - (event.clientY - pan.y)
  }

  function endSourcePan(event: ReactPointerEvent<HTMLDivElement>): void {
    sourcePanRef.current.active = false
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  async function commit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!analysis || selectedCount === 0 || phase === 'saving') return
    setReviewError(null)
    const items: ReviewedDocumentItem[] = []
    try {
      for (const item of drafts.filter((candidate) => candidate.selected)) {
        const sourceIdentity = {
          sourceSha256: item.draft.importIdentity.sourceSha256,
          sourceRowId: item.draft.importIdentity.sourceRowId
        }
        items.push(
          item.draft.kind === 'event'
            ? reviewedDocumentItemSchema.parse({
                draftId: item.draft.id,
                kind: 'event',
                sourceIdentity,
                schedule: item.draft.schedule,
                form: item.draft.form
              })
            : reviewedDocumentItemSchema.parse({
                draftId: item.draft.id,
                kind: 'reminder',
                sourceIdentity,
                schedule: null,
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
        data-testid="document-dialog"
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
            data-testid="document-close"
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
          <form
            className="document-review"
            data-testid="document-review"
            onSubmit={(event) => void commit(event)}
          >
            <div className="document-review-toolbar">
              <div>
                <strong>
                  {reviewTotals.weeklyMeetingCount > 0
                    ? `${reviewTotals.seriesCount} series · ${reviewTotals.weeklyMeetingCount} recurring meetings / week`
                    : `${reviewTotals.seriesCount} proposal${reviewTotals.seriesCount === 1 ? '' : 's'}`}
                  {reviewTotals.skippedRowCount > 0
                    ? ` · ${reviewTotals.skippedRowCount} skipped row${reviewTotals.skippedRowCount === 1 ? '' : 's'}`
                    : ''}
                </strong>
                <span>
                  {selectedCount} of {drafts.length} selected ·{' '}
                  {reviewTotals.courseCount > 0 ? `${reviewTotals.courseCount} courses · ` : ''}
                  {reviewTotals.noFixedTimeCount > 0
                    ? `${reviewTotals.noFixedTimeCount} without fixed times · `
                    : ''}
                  {analysis.extraction.pages.reduce((total, page) => total + page.words.length, 0)}{' '}
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
                {reconciliationCounts.sameSource > 0 ? (
                  <span className="document-duplicate-chip" data-kind="same-source">
                    {reconciliationCounts.sameSource} already imported
                  </span>
                ) : null}
                {reconciliationCounts.likelyDuplicate > 0 ? (
                  <span className="document-duplicate-chip" data-kind="likely-duplicate">
                    {reconciliationCounts.likelyDuplicate} to compare
                  </span>
                ) : null}
                {reconciliationCounts.protectedDistinct > 0 ? (
                  <span className="document-duplicate-chip" data-kind="protected-distinct">
                    {reconciliationCounts.protectedDistinct} distinct
                  </span>
                ) : null}
                {analysis.skippedItems.length > 0 ? (
                  <span className="document-duplicate-chip" data-kind="skipped">
                    {analysis.skippedItems.length} skipped safely
                  </span>
                ) : null}
                <button
                  type="button"
                  onClick={() =>
                    setDrafts((current) =>
                      current.map((item) => ({
                        ...item,
                        selected: item.draft.reconciliation.recommendedSelected,
                        selectionMode: 'recommended'
                      }))
                    )
                  }
                >
                  Select recommended
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setDrafts((current) =>
                      current.map((item) => ({
                        ...item,
                        selected: false,
                        selectionMode: 'user'
                      }))
                    )
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
                  ['timeline', 'Chronological', `${chronology.length} dated series`],
                  ['month', 'Month', `${monthPreview.occurrenceCount} visible meetings`],
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
                  data-review-view={view}
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

            {reviewNotice ? (
              <div className="document-review-notice" role="status">
                <span>{reviewNotice}</span>
                <button type="button" onClick={() => setReviewNotice(null)}>
                  Dismiss
                </button>
              </div>
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
                      <strong>{reviewTotals.weeklyMeetingCount}</strong>recurring / week
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
                              data-reconciliation={editable?.draft.reconciliation.state ?? 'new'}
                              key={`${meeting.draftId}:${day.weekday}`}
                            >
                              <div className="document-week-meeting-heading">
                                <span>{formatDocumentTime(meeting.startTime)}</span>
                                <label>
                                  <input
                                    type="checkbox"
                                    checked={editable?.selected ?? false}
                                    disabled={
                                      editable?.draft.reconciliation.state === 'same-source'
                                    }
                                    onChange={() => toggleDraft(meeting.draftId)}
                                  />
                                  <span className="visually-hidden">
                                    Select {meeting.title} on {day.weekday}
                                  </span>
                                </label>
                              </div>
                              <button
                                type="button"
                                onClick={() => activateDraft(meeting.draftId, 'details')}
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

              <section
                className="document-chronology-preview"
                aria-label="Chronological document confirmation"
                hidden={reviewView !== 'timeline'}
              >
                <div className="document-preview-heading">
                  <div>
                    <p className="eyebrow">Actual dates, not weekday buckets</p>
                    <h3>Read every proposal in date order</h3>
                    <p>
                      One-off plans from different weeks stay on their printed dates. Recurring
                      series show their full range without expanding into a wall of duplicates.
                    </p>
                  </div>
                  <span>{chronology.length} selected series</span>
                </div>
                <div className="document-chronology-list">
                  {chronology.map((item) => {
                    const editable = drafts.find((draft) => draft.draft.id === item.draftId)
                    return (
                      <button
                        type="button"
                        className="document-chronology-item"
                        data-reconciliation={editable?.draft.reconciliation.state ?? 'new'}
                        key={item.draftId}
                        onClick={() => activateDraft(item.draftId, 'details')}
                      >
                        <time dateTime={item.date}>
                          <strong>
                            {formatDocumentDate(item.date, snapshot?.preferences.locale ?? 'en-US')}
                          </strong>
                          <span>{formatDocumentTime(item.startTime)}</span>
                        </time>
                        <span>
                          <strong>{item.title}</strong>
                          <small>
                            {item.schedule
                              ? `${item.schedule.courseCode} · ${componentLabels[item.schedule.component]}`
                              : item.kind}
                          </small>
                          <small>{editable ? recurrenceSummary(editable.draft) : 'One time'}</small>
                        </span>
                        <span>
                          {item.endTime
                            ? `${formatDocumentTime(item.startTime)}–${formatDocumentTime(item.endTime)}`
                            : formatDocumentTime(item.startTime)}
                          {item.location ? <small>{item.location}</small> : null}
                        </span>
                      </button>
                    )
                  })}
                  {chronology.length === 0 ? (
                    <div className="document-empty-drafts">
                      <h3>No selected dates to preview</h3>
                      <p>Select at least one proposal, then return to this view.</p>
                    </div>
                  ) : null}
                </div>
              </section>

              <section
                className="document-month-preview"
                aria-label="Monthly calendar confirmation"
                hidden={reviewView !== 'month'}
              >
                <div className="document-month-heading">
                  <div>
                    <p className="eyebrow">Occurrence-level preview</p>
                    <h3>{monthPreview.label}</h3>
                    <p>
                      {monthPreview.occurrenceCount} selected meetings and reminders this month.
                    </p>
                  </div>
                  <div className="document-month-actions">
                    <button
                      type="button"
                      aria-label="Previous month"
                      onClick={() => moveReviewMonth(-1)}
                    >
                      ←
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setReviewMonth(
                          (
                            chronology.map((item) => item.date).sort()[0] ??
                            new Date().toISOString().slice(0, 10)
                          ).slice(0, 7)
                        )
                      }
                    >
                      First date
                    </button>
                    <button
                      type="button"
                      aria-label="Next month"
                      onClick={() => moveReviewMonth(1)}
                    >
                      →
                    </button>
                  </div>
                </div>
                <div className="document-month-weekdays" aria-hidden="true">
                  {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((weekday) => (
                    <span key={weekday}>{weekday}</span>
                  ))}
                </div>
                <div className="document-month-grid">
                  {monthPreview.cells.map((cell) => (
                    <section data-in-month={cell.inMonth} key={cell.date}>
                      <time dateTime={cell.date}>{cell.day}</time>
                      <div>
                        {cell.items.slice(0, 4).map((item) => (
                          <button
                            type="button"
                            key={`${cell.date}:${item.draftId}`}
                            onClick={() => activateDraft(item.draftId, 'details')}
                            title={`${formatDocumentTime(item.startTime)} · ${item.title}${item.location ? ` · ${item.location}` : ''}`}
                          >
                            <span>{formatDocumentTime(item.startTime)}</span>
                            <strong>{item.title}</strong>
                          </button>
                        ))}
                        {cell.items.length > 4 ? (
                          <small>+{cell.items.length - 4} more</small>
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
                {draftGroups.map((group) => (
                  <section className="document-draft-group" key={group.key}>
                    <header>
                      <div>
                        <strong>{group.label}</strong>
                        <span>{group.detail}</span>
                      </div>
                      <span>{group.items.filter((item) => item.selected).length} selected</span>
                    </header>
                    {group.items.map((item) => {
                      const draft = item.draft
                      const isActive = draft.id === activeDraftId
                      const index = drafts.findIndex((candidate) => candidate.draft.id === draft.id)
                      return (
                        <article
                          className="document-draft-card"
                          data-testid="document-draft-card"
                          data-active={isActive}
                          data-selected={item.selected}
                          data-reconciliation={draft.reconciliation.state}
                          data-draft-kind={draft.kind}
                          data-draft-title={draft.form.title}
                          data-draft-recurrence={
                            draft.form.recurrence ? JSON.stringify(draft.form.recurrence) : ''
                          }
                          data-draft-schedule={draft.schedule ? JSON.stringify(draft.schedule) : ''}
                          key={draft.id}
                        >
                          <div className="document-draft-heading">
                            <label className="document-draft-select">
                              <input
                                type="checkbox"
                                checked={item.selected}
                                disabled={draft.reconciliation.state === 'same-source'}
                                onChange={() => toggleDraft(draft.id)}
                              />
                              <span className="visually-hidden">Select proposal {index + 1}</span>
                            </label>
                            <button
                              className="document-draft-summary"
                              type="button"
                              aria-expanded={isActive}
                              onClick={() => activateDraft(draft.id)}
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
                          {draft.reconciliation.state !== 'new' ? (
                            <div
                              className="document-reconciliation"
                              data-kind={draft.reconciliation.state}
                              role={
                                draft.reconciliation.state === 'likely-duplicate' ? 'alert' : 'note'
                              }
                            >
                              <div>
                                <strong>
                                  {reconciliationCopy[draft.reconciliation.state].label}
                                </strong>
                                <span>
                                  {reconciliationCopy[draft.reconciliation.state].message}
                                </span>
                              </div>
                              {draft.reconciliation.matches.length > 0 ? (
                                <ul>
                                  {draft.reconciliation.matches.map((match) => (
                                    <li
                                      key={`${match.entityKind}:${match.entityId}:${match.relationship}`}
                                    >
                                      <strong>{match.title}</strong>
                                      <span>{match.detail}</span>
                                      <small>
                                        {reconciliationRelationshipCopy[match.relationship]}
                                      </small>
                                    </li>
                                  ))}
                                </ul>
                              ) : null}
                            </div>
                          ) : null}
                          {isActive ? (
                            <>
                              <div
                                className="document-structure-actions"
                                aria-label="Proposal structure tools"
                              >
                                <div>
                                  <strong>Structure tools</strong>
                                  <span>
                                    Explicit review edits; source evidence stays attached.
                                  </span>
                                </div>
                                <div>
                                  <button
                                    type="button"
                                    disabled={!canSplitDocumentDraft(draft)}
                                    onClick={() => splitDraft(draft.id)}
                                  >
                                    Split weekdays
                                  </button>
                                  <button
                                    type="button"
                                    disabled={
                                      !drafts.some(
                                        (candidate) =>
                                          candidate.selected &&
                                          canMergeDocumentDrafts(draft, candidate.draft)
                                      )
                                    }
                                    onClick={() => mergeMatchingDrafts(draft.id)}
                                  >
                                    Merge matching selected
                                  </button>
                                  <button
                                    type="button"
                                    disabled={!canReclassifyDocumentDraft(draft)}
                                    onClick={() => reclassifyDraft(draft.id)}
                                  >
                                    Make {draft.kind === 'event' ? 'reminder' : 'event'}
                                  </button>
                                </div>
                              </div>
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
                  </section>
                ))}
                {analysis.skippedItems.length > 0 ? (
                  <section
                    className="document-skipped-group"
                    aria-label="Safely skipped source rows"
                  >
                    <header>
                      <div>
                        <strong>Not added on purpose</strong>
                        <span>
                          These rows stay visible because guessing a missing time would create a
                          false event.
                        </span>
                      </div>
                      <span>{analysis.skippedItems.length} skipped</span>
                    </header>
                    <div>
                      {analysis.skippedItems.map((item) => (
                        <article key={item.id} data-kind={item.category}>
                          <span aria-hidden="true">
                            {item.category === 'no-fixed-time' ? '∅' : '?'}
                          </span>
                          <div>
                            <strong>{item.title}</strong>
                            <small>
                              Page {item.page} · {Math.round(item.confidence * 100)}% source clarity
                            </small>
                            <p>{item.reason}</p>
                          </div>
                          <button type="button" onClick={() => showSkippedEvidence(item.id)}>
                            Review source
                          </button>
                        </article>
                      ))}
                    </div>
                  </section>
                ) : null}
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
                data-testid="document-evidence-panel"
                data-extraction={activePage?.extraction ?? ''}
                aria-label="Visible source evidence"
                hidden={reviewView !== 'source'}
              >
                <div className="document-evidence-heading">
                  <div>
                    <p className="eyebrow">
                      {activeSkipped ? 'Skipped row evidence' : 'Visible field evidence'}
                    </p>
                    <h3>
                      Page {activePageNumber}
                      {evidenceField ? ` · ${evidenceField}` : ''}
                    </h3>
                    <p>
                      {activeSkipped?.title ?? active?.draft.form.title ?? 'Choose a review item'}
                    </p>
                  </div>
                  <div className="document-source-controls">
                    {activePage ? (
                      <span>
                        {activePage.extraction.replace('-', ' ')} ·{' '}
                        {activePage.reviewImageDataUrl ? 'high-resolution local view' : 'thumbnail'}
                      </span>
                    ) : null}
                    <div>
                      <button
                        type="button"
                        aria-label="Previous source page"
                        disabled={activePageNumber <= 1}
                        onClick={() => {
                          setSourcePageNumber((page) => Math.max(1, page - 1))
                          setSourceZoom(1)
                        }}
                      >
                        ← Page
                      </button>
                      <button
                        type="button"
                        aria-label="Zoom out"
                        disabled={sourceZoom <= 1}
                        onClick={() => setSourceZoom((zoom) => Math.max(1, zoom - 0.5))}
                      >
                        −
                      </button>
                      <button type="button" onClick={() => setSourceZoom(1)}>
                        {Math.round(sourceZoom * 100)}%
                      </button>
                      <button
                        type="button"
                        aria-label="Zoom in"
                        disabled={sourceZoom >= 4}
                        onClick={() => setSourceZoom((zoom) => Math.min(4, zoom + 0.5))}
                      >
                        +
                      </button>
                      <button
                        type="button"
                        aria-label="Next source page"
                        disabled={activePageNumber >= analysis.extraction.pages.length}
                        onClick={() => {
                          setSourcePageNumber((page) =>
                            Math.min(analysis.extraction.pages.length, page + 1)
                          )
                          setSourceZoom(1)
                        }}
                      >
                        Page →
                      </button>
                    </div>
                  </div>
                </div>
                <div className="document-page-strip" aria-label="Source pages">
                  {analysis.extraction.pages.map((page) => (
                    <button
                      type="button"
                      data-active={page.page === activePageNumber}
                      aria-label={`Show source page ${page.page}`}
                      key={page.page}
                      onClick={() => {
                        setSourcePageNumber(page.page)
                        setSourceZoom(1)
                      }}
                    >
                      <img src={page.thumbnailDataUrl} alt="" />
                      <span>Page {page.page}</span>
                    </button>
                  ))}
                </div>
                {activePage ? (
                  <div
                    className="document-page-frame"
                    data-testid="document-page-frame"
                    data-pannable={sourceZoom > 1}
                    ref={sourceFrameRef}
                    onPointerDown={beginSourcePan}
                    onPointerMove={moveSourcePan}
                    onPointerUp={endSourcePan}
                    onPointerCancel={endSourcePan}
                  >
                    <div className="document-page-canvas" style={{ width: `${sourceZoom * 100}%` }}>
                      <img
                        data-testid="document-source-image"
                        src={activePage.reviewImageDataUrl ?? activePage.thumbnailDataUrl}
                        alt={`Source preview, page ${activePage.page}`}
                        draggable={false}
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
                  Drag to pan after zooming. Highlights are normalized boxes from PDF text or local
                  OCR. The high-resolution review image stays in memory and is discarded with this
                  dialog.
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
                  data-testid="document-confirm"
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
