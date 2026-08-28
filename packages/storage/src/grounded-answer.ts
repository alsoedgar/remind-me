import type { AssistantRequestedField } from '@remind-me/contracts'

export const groundedAnswerPageSize = 8

export type GroundedAttributeField = Exclude<AssistantRequestedField, 'name' | 'details'>
export type GroundedAnswerMode = 'names' | 'attributes' | 'details' | 'summary'

export interface GroundedAnswerItem {
  key: string
  kind: 'event' | 'reminder'
  title: string
  dateLabel: string
  timeLabel: string
  detail: string
  attributes: Readonly<Partial<Record<GroundedAttributeField, string>>>
}

export interface GroundedAnswerRequest {
  items: readonly GroundedAnswerItem[]
  locale: string
  mode: GroundedAnswerMode
  fields?: readonly GroundedAttributeField[]
  startIndex?: number
  pageSize?: number
  staleCount?: number
  emptyText?: string
}

export interface GroundedAnswerPage {
  text: string
  presentedKeys: string[]
  nextCursor: number | null
  startIndex: number
  endIndex: number
}

const attributeLabels: Readonly<Record<GroundedAttributeField, string>> = {
  time: 'time',
  start: 'start',
  end: 'end',
  date: 'date',
  location: 'location',
  duration: 'duration',
  notes: 'notes',
  recurrence: 'repeats'
}

function withoutTerminalPunctuation(value: string): string {
  return value.trim().replace(/[.!?]+$/gu, '')
}

function withTerminalPunctuation(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  return /[.!?]$/u.test(trimmed) ? trimmed : `${trimmed}.`
}

function titleKey(title: string): string {
  return title.trim().toLocaleLowerCase()
}

function displayTitles(items: readonly GroundedAnswerItem[]): Map<string, string> {
  const counts = new Map<string, number>()
  for (const item of items) {
    const key = titleKey(item.title)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return new Map(
    items.map((item) => {
      const duplicate = (counts.get(titleKey(item.title)) ?? 0) > 1
      return [
        item.key,
        duplicate ? `${item.title} (${item.dateLabel}, ${item.timeLabel})` : item.title
      ]
    })
  )
}

function groupedSummary(items: readonly GroundedAnswerItem[]): string {
  const groups = new Map<string, GroundedAnswerItem[]>()
  for (const item of items) {
    const group = groups.get(item.dateLabel) ?? []
    group.push(item)
    groups.set(item.dateLabel, group)
  }
  return [...groups.entries()]
    .map(
      ([date, group]) =>
        `${date}: ${group
          .map(
            (item) =>
              `${item.timeLabel} — ${item.kind === 'reminder' ? 'reminder: ' : ''}${item.title}`
          )
          .join('; ')}`
    )
    .join('. ')
}

function paginationNote(
  startIndex: number,
  endIndex: number,
  total: number,
  pageSize: number,
  nextCursor: number | null
): string {
  if (startIndex === 0 && nextCursor === null) return ''
  const shown = `Showing ${startIndex + 1}–${endIndex} of ${total}.`
  if (nextCursor === null) return shown
  const remaining = total - nextCursor
  return `${shown} Say “continue” for the next ${Math.min(pageSize, remaining)}.`
}

/**
 * Renders only caller-supplied, verified calendar facts. It owns presentation
 * and pagination, but never retrieves entities or infers missing values.
 */
export function renderGroundedAnswer(request: GroundedAnswerRequest): GroundedAnswerPage {
  const pageSize = Math.max(1, Math.min(20, request.pageSize ?? groundedAnswerPageSize))
  const requestedStart = Math.max(0, Math.trunc(request.startIndex ?? 0))
  const startIndex = Math.min(requestedStart, request.items.length)
  const page = request.items.slice(startIndex, startIndex + pageSize)
  const endIndex = startIndex + page.length
  const nextCursor = endIndex < request.items.length ? endIndex : null
  const staleCount = Math.max(0, Math.trunc(request.staleCount ?? 0))
  const staleNote = staleCount
    ? ` I skipped ${staleCount} deleted or unavailable item${staleCount === 1 ? '' : 's'}.`
    : ''

  if (page.length === 0) {
    const empty = request.emptyText ?? 'I could not find an available item in that result.'
    return {
      text: `${withTerminalPunctuation(empty)}${staleNote}`.trim(),
      presentedKeys: [],
      nextCursor: null,
      startIndex,
      endIndex
    }
  }

  const titles = displayTitles(request.items)
  let body: string
  if (request.mode === 'summary' || (request.mode === 'names' && request.items.length > pageSize)) {
    body = groupedSummary(page)
  } else if (request.mode === 'details') {
    body = page.map((item) => withoutTerminalPunctuation(item.detail)).join('; ')
  } else if (request.mode === 'attributes') {
    const fields = [...new Set(request.fields ?? [])]
    const facts = page.map((item) => {
      const values = fields.map((field) => {
        const value = withoutTerminalPunctuation(item.attributes[field] ?? 'not saved')
        return fields.length === 1 ? value : `${attributeLabels[field]}: ${value}`
      })
      const title = titles.get(item.key) ?? item.title
      return page.length === 1
        ? `${title} — ${values.join('; ')}`
        : `“${title}” — ${values.join('; ')}`
    })
    body = facts.join('; ')
  } else {
    body = new Intl.ListFormat(request.locale, { style: 'long', type: 'conjunction' }).format(
      page.map((item) => titles.get(item.key) ?? item.title)
    )
  }

  const note = paginationNote(startIndex, endIndex, request.items.length, pageSize, nextCursor)
  return {
    text: `${withTerminalPunctuation(body)}${note ? ` ${note}` : ''}${staleNote}`.trim(),
    presentedKeys: page.map((item) => item.key),
    nextCursor,
    startIndex,
    endIndex
  }
}
