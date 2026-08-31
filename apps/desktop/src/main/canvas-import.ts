import { randomUUID } from 'node:crypto'
import { Temporal } from '@js-temporal/polyfill'
import type {
  CalendarBatchItem,
  CanvasAssignment,
  CanvasAssignmentImportKind
} from '@remind-me/contracts'
import type { CanvasImportLink } from '@remind-me/storage'

export interface CanvasImportPlan {
  items: CalendarBatchItem[]
  links: CanvasImportLink[]
  createdCount: number
  updatedCount: number
}

interface CanvasImportPlanInput {
  assignments: readonly CanvasAssignment[]
  targetKind: CanvasAssignmentImportKind
  timezone: string
  existingLinks: readonly CanvasImportLink[]
  localEntityExists: (link: CanvasImportLink) => boolean
  createId?: (kind: 'event' | 'reminder') => string
}

function dueLocalParts(dueAtUtc: string, timezone: string): { date: string; time: string } {
  const due = Temporal.Instant.from(dueAtUtc).toZonedDateTimeISO(timezone)
  return {
    date: due.toPlainDate().toString(),
    time: `${String(due.hour).padStart(2, '0')}:${String(due.minute).padStart(2, '0')}`
  }
}

function canvasDetail(assignment: CanvasAssignment, due: { date: string; time: string }): string {
  const pieces = [
    `Canvas assignment · ${assignment.courseName}`,
    `Due ${due.date} at ${due.time}`,
    assignment.pointsPossible === null
      ? null
      : `${assignment.pointsPossible} point${assignment.pointsPossible === 1 ? '' : 's'}`,
    assignment.description || null
  ].filter((piece): piece is string => piece !== null && piece.length > 0)
  return pieces.join('\n\n').slice(0, 10_000)
}

function generatedId(kind: 'event' | 'reminder'): string {
  return `${kind}:${randomUUID()}`
}

/**
 * Builds a local calendar batch from canonical Canvas assignments. Repeated
 * imports update the linked local item rather than creating a duplicate.
 */
export function buildCanvasImportPlan(input: CanvasImportPlanInput): CanvasImportPlan {
  const existingBySource = new Map(input.existingLinks.map((link) => [link.sourceKey, link]))
  const seenSourceKeys = new Set<string>()
  const seenLocalItems = new Set<string>()
  const items: CalendarBatchItem[] = []
  const links: CanvasImportLink[] = []
  let createdCount = 0
  let updatedCount = 0
  const createId = input.createId ?? generatedId

  for (const assignment of input.assignments) {
    if (seenSourceKeys.has(assignment.sourceKey)) continue
    seenSourceKeys.add(assignment.sourceKey)
    const priorLink = existingBySource.get(assignment.sourceKey)
    const existing = priorLink && input.localEntityExists(priorLink) ? priorLink : null
    const entityKind =
      existing?.entityKind ?? (input.targetKind === 'reminder' ? 'reminder' : 'event')
    const entityId = existing?.entityId ?? createId(entityKind)
    const localKey = `${entityKind}:${entityId}`
    if (seenLocalItems.has(localKey)) continue
    seenLocalItems.add(localKey)

    const due = dueLocalParts(assignment.dueAtUtc, input.timezone)
    const detail = canvasDetail(assignment, due)
    if (entityKind === 'reminder') {
      items.push({
        kind: 'reminder-save',
        form: {
          id: entityId,
          calendarId: null,
          title: assignment.title,
          notes: detail,
          dueDate: due.date,
          dueTime: due.time,
          timezone: input.timezone,
          recurrence: null
        }
      })
    } else {
      items.push({
        kind: 'event-save',
        form: {
          id: entityId,
          calendarId: null,
          title: assignment.title,
          description: detail,
          location: '',
          startDate: due.date,
          startTime: null,
          endDate: due.date,
          endTime: null,
          timezone: input.timezone,
          allDay: true,
          recurrence: null
        }
      })
    }
    links.push({ sourceKey: assignment.sourceKey, entityKind, entityId })
    if (existing) updatedCount += 1
    else createdCount += 1
  }

  return { items, links, createdCount, updatedCount }
}
