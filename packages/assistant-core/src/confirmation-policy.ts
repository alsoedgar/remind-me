import type { CalendarIRDraft } from '@remind-me/contracts'

export type ActionDisposition = 'answer' | 'preview' | 'confirm' | 'clarify' | 'reject'

const readOperations = new Set<CalendarIRDraft['operation']>([
  'calendar.list',
  'calendar.search',
  'calendar.availability',
  'calendar.conflicts'
])

const destructiveOperations = new Set<CalendarIRDraft['operation']>([
  'event.delete',
  'reminder.delete'
])

export function getActionDisposition(draft: CalendarIRDraft): ActionDisposition {
  if (draft.operation === 'assistant.reject' || draft.operation === 'assistant.unsupported') {
    return 'reject'
  }
  if (draft.operation === 'assistant.clarify' || draft.ambiguities.length > 0) {
    return 'clarify'
  }
  if (readOperations.has(draft.operation)) return 'answer'
  if (
    destructiveOperations.has(draft.operation) ||
    draft.scope === 'future' ||
    draft.scope === 'series' ||
    draft.risk === 'high' ||
    draft.risk === 'destructive'
  ) {
    return 'confirm'
  }
  return 'preview'
}

export function requiresExplicitConfirmation(draft: CalendarIRDraft): boolean {
  return getActionDisposition(draft) === 'confirm'
}
