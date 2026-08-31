import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type {
  CalendarSnapshot,
  CanvasAssignment,
  CanvasAssignmentImportKind,
  CanvasAssignmentsResponse,
  CanvasConnectionStatus
} from '@remind-me/contracts'
import { useCalendarStore } from '../store/calendar-store'

function messageFor(error: unknown): string {
  if (!(error instanceof Error)) return 'Canvas could not finish that request.'
  return error.message.replace(/^Error invoking remote method '[^']+': Error: /u, '')
}

function formattedDue(assignment: CanvasAssignment, snapshot: CalendarSnapshot): string {
  return new Intl.DateTimeFormat(snapshot.preferences.locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: snapshot.preferences.timezone
  }).format(new Date(assignment.dueAtUtc))
}

function importKindLabel(kind: CanvasAssignmentImportKind): string {
  return kind === 'reminder' ? 'Added as reminder' : 'Added to calendar'
}

export function CanvasAssignments({ snapshot }: { snapshot: CalendarSnapshot }): ReactNode {
  const range = useCalendarStore((state) => state.range)
  const applyMutationResult = useCalendarStore((state) => state.applyMutationResult)
  const [status, setStatus] = useState<CanvasConnectionStatus | null>(null)
  const [assignments, setAssignments] = useState<CanvasAssignment[]>([])
  const [withoutDueDateCount, setWithoutDueDateCount] = useState(0)
  const [instanceUrl, setInstanceUrl] = useState('')
  const [accessToken, setAccessToken] = useState('')
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())
  const [importKind, setImportKind] = useState<CanvasAssignmentImportKind>('reminder')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void window.remindMe
      .getCanvasStatus()
      .then((next) => {
        if (!active) return
        setStatus(next)
        setInstanceUrl(next.instanceUrl ?? '')
      })
      .catch((reason: unknown) => {
        if (active) setError(messageFor(reason))
      })
    return () => {
      active = false
    }
  }, [snapshot.generatedAt])

  const selectableAssignments = useMemo(
    () => assignments.filter((assignment) => assignment.importKind === null),
    [assignments]
  )

  const loadAssignments = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      const response: CanvasAssignmentsResponse = await window.remindMe.listCanvasAssignments()
      setAssignments(response.assignments)
      setWithoutDueDateCount(response.withoutDueDateCount)
      setStatus((current) =>
        current ? { ...current, lastSyncedAt: response.fetchedAt, lastError: null } : current
      )
      setSelectedKeys(
        new Set(
          response.assignments
            .filter((assignment) => assignment.importKind === null)
            .slice(0, 50)
            .map((assignment) => assignment.sourceKey)
        )
      )
      setMessage(
        response.assignments.length
          ? 'Choose the due dates you want to keep locally.'
          : 'Canvas has no upcoming assignments with due dates right now.'
      )
    } catch (reason) {
      setError(messageFor(reason))
    } finally {
      setBusy(false)
    }
  }

  const connect = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      const next = await window.remindMe.connectCanvas({ instanceUrl, accessToken })
      setStatus(next)
      setInstanceUrl(next.instanceUrl ?? instanceUrl)
      setAccessToken('')
      setMessage('Canvas is connected. Reading upcoming assignment due dates…')
      const response = await window.remindMe.listCanvasAssignments()
      setAssignments(response.assignments)
      setWithoutDueDateCount(response.withoutDueDateCount)
      setStatus((current) =>
        current ? { ...current, lastSyncedAt: response.fetchedAt, lastError: null } : current
      )
      setSelectedKeys(
        new Set(
          response.assignments
            .filter((assignment) => assignment.importKind === null)
            .slice(0, 50)
            .map((assignment) => assignment.sourceKey)
        )
      )
      setMessage(
        response.assignments.length
          ? 'Canvas is connected. Review the due dates before adding them locally.'
          : 'Canvas is connected, but there are no upcoming assignments with due dates right now.'
      )
    } catch (reason) {
      setError(messageFor(reason))
    } finally {
      setBusy(false)
    }
  }

  const disconnect = async (): Promise<void> => {
    if (
      !window.confirm('Disconnect Canvas from this device? Your local calendar items will stay.')
    ) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      const next = await window.remindMe.disconnectCanvas()
      setStatus(next)
      setAssignments([])
      setSelectedKeys(new Set())
      setWithoutDueDateCount(0)
      setAccessToken('')
      setMessage('Canvas was disconnected. Your local calendar items were left untouched.')
    } catch (reason) {
      setError(messageFor(reason))
    } finally {
      setBusy(false)
    }
  }

  const importSelected = async (): Promise<void> => {
    const sourceKeys = [...selectedKeys]
    if (sourceKeys.length === 0) return
    setBusy(true)
    setError(null)
    try {
      const response = await window.remindMe.importCanvasAssignments({
        sourceKeys,
        kind: importKind,
        range
      })
      applyMutationResult(response.result)
      setAssignments((current) =>
        current.map((assignment) =>
          selectedKeys.has(assignment.sourceKey) && assignment.importKind === null
            ? { ...assignment, importKind }
            : assignment
        )
      )
      setSelectedKeys(new Set())
      setMessage(
        response.updatedCount
          ? `${response.createdCount} added and ${response.updatedCount} refreshed locally.`
          : `${response.createdCount} assignment${response.createdCount === 1 ? '' : 's'} added locally.`
      )
    } catch (reason) {
      setError(messageFor(reason))
    } finally {
      setBusy(false)
    }
  }

  const toggleAssignment = (sourceKey: string): void => {
    setSelectedKeys((current) => {
      const next = new Set(current)
      if (next.has(sourceKey)) next.delete(sourceKey)
      else if (next.size < 50) next.add(sourceKey)
      return next
    })
  }

  if (status === null) {
    return (
      <section className="paper-card settings-section canvas-settings" aria-busy="true">
        <p className="eyebrow">Optional Canvas connection</p>
        <h2>Checking Canvas…</h2>
      </section>
    )
  }

  return (
    <section className="paper-card settings-section canvas-settings">
      <div className="settings-heading-with-count">
        <span>
          <p className="eyebrow">Optional Canvas connection</p>
          <h2>Bring assignment due dates in</h2>
        </span>
        <span className="count-chip">Read-only</span>
      </div>
      <p className="muted-copy">
        Canvas stays the source. Choose which upcoming due dates become private local reminders or
        all-day calendar items; repeated imports update the same item instead of duplicating it.
      </p>

      {!status.credentialStorageAvailable ? (
        <div className="canvas-credential-warning">
          <p className="settings-warning">
            This device’s protected credential storage is unavailable, so Remind Me will not save a
            Canvas token here yet.
          </p>
          {status.configured ? (
            <button
              className="text-button"
              type="button"
              disabled={busy}
              onClick={() => void disconnect()}
            >
              Remove saved Canvas connection
            </button>
          ) : null}
        </div>
      ) : !status.configured ? (
        <form className="canvas-connect-form" onSubmit={(event) => void connect(event)}>
          <label>
            Your Canvas site
            <input
              autoComplete="url"
              inputMode="url"
              placeholder="https://school.instructure.com"
              value={instanceUrl}
              onChange={(event) => setInstanceUrl(event.target.value)}
              disabled={busy}
            />
          </label>
          <label>
            Personal access token
            <input
              autoComplete="off"
              type="password"
              spellCheck={false}
              placeholder="Paste a Canvas token"
              value={accessToken}
              onChange={(event) => setAccessToken(event.target.value)}
              disabled={busy}
            />
          </label>
          <p className="settings-note">
            In most Canvas accounts: Account → Settings → New Access Token. The token is encrypted
            by this device’s credential storage and is never added to a backup.
          </p>
          <button
            className="primary-button"
            type="submit"
            disabled={busy || !instanceUrl.trim() || !accessToken.trim()}
          >
            {busy ? 'Connecting…' : 'Connect Canvas'}
          </button>
        </form>
      ) : (
        <div className="canvas-connected-controls">
          <div>
            <strong>Connected to Canvas</strong>
            <small>{status.instanceUrl}</small>
          </div>
          <div>
            <button
              className="secondary-button"
              type="button"
              disabled={busy}
              onClick={() => void loadAssignments()}
            >
              {busy ? 'Refreshing…' : 'Refresh due dates'}
            </button>
            <button
              className="text-button"
              type="button"
              disabled={busy}
              onClick={() => void disconnect()}
            >
              Disconnect
            </button>
          </div>
        </div>
      )}

      {status.lastSyncedAt ? (
        <p className="settings-note">
          Last refreshed{' '}
          {new Intl.DateTimeFormat(snapshot.preferences.locale, {
            dateStyle: 'medium',
            timeStyle: 'short',
            timeZone: snapshot.preferences.timezone
          }).format(new Date(status.lastSyncedAt))}
          .
        </p>
      ) : null}
      {status.lastError ? <p className="settings-warning">{status.lastError}</p> : null}
      {message ? <p className="settings-note canvas-message">{message}</p> : null}
      {error ? <p className="settings-warning">{error}</p> : null}

      {assignments.length ? (
        <div className="canvas-assignment-review">
          <div className="canvas-review-toolbar">
            <div>
              <strong>{selectedKeys.size} selected</strong>
              <small>Choose up to 50 at a time.</small>
            </div>
            <button
              className="text-button"
              type="button"
              disabled={busy || selectableAssignments.length === 0}
              onClick={() =>
                setSelectedKeys(
                  new Set(
                    selectableAssignments.slice(0, 50).map((assignment) => assignment.sourceKey)
                  )
                )
              }
            >
              Select available
            </button>
          </div>
          <div className="canvas-import-controls">
            <label>
              Add selected as
              <select
                value={importKind}
                disabled={busy || selectedKeys.size === 0}
                onChange={(event) =>
                  setImportKind(event.target.value as CanvasAssignmentImportKind)
                }
              >
                <option value="reminder">Reminders at the due time</option>
                <option value="all-day-event">All-day calendar items</option>
              </select>
            </label>
            <button
              className="primary-button"
              type="button"
              disabled={busy || selectedKeys.size === 0}
              onClick={() => void importSelected()}
            >
              Add / refresh selected locally
            </button>
          </div>
          <ul className="canvas-assignment-list" aria-label="Upcoming Canvas assignments">
            {assignments.map((assignment) => {
              const alreadyAdded = assignment.importKind !== null
              const selected = selectedKeys.has(assignment.sourceKey)
              return (
                <li key={assignment.sourceKey} data-added={alreadyAdded}>
                  <label>
                    <input
                      type="checkbox"
                      checked={selected}
                      disabled={busy || (!selected && selectedKeys.size >= 50)}
                      onChange={() => toggleAssignment(assignment.sourceKey)}
                    />
                    <span className="canvas-assignment-main">
                      <strong>{assignment.title}</strong>
                      <small>{assignment.courseName}</small>
                    </span>
                    <span className="canvas-assignment-meta">
                      <strong>{formattedDue(assignment, snapshot)}</strong>
                      <small>
                        {assignment.importKind !== null
                          ? importKindLabel(assignment.importKind)
                          : assignment.pointsPossible === null
                            ? 'Canvas assignment'
                            : `${assignment.pointsPossible} point${assignment.pointsPossible === 1 ? '' : 's'}`}
                      </small>
                    </span>
                  </label>
                </li>
              )
            })}
          </ul>
          {withoutDueDateCount ? (
            <p className="settings-note">
              {withoutDueDateCount} Canvas assignment{withoutDueDateCount === 1 ? '' : 's'} without
              a due date {withoutDueDateCount === 1 ? 'is' : 'are'} not shown.
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
