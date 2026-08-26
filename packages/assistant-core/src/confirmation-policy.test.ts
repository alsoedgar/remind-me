import { describe, expect, it } from 'vitest'
import { calendarIRDraftSchema, type CalendarIRDraft } from '@remind-me/contracts'
import { getActionDisposition } from './confirmation-policy'

function baseDraft(overrides: Partial<CalendarIRDraft> = {}): CalendarIRDraft {
  return calendarIRDraftSchema.parse({
    version: '0.1',
    requestId: 'policy-case',
    operation: 'calendar.list',
    selection: null,
    fields: {
      title: null,
      description: null,
      location: null,
      when: null,
      reminderOffsetMinutes: null,
      status: null
    },
    recurrence: null,
    scope: 'single',
    references: [],
    ambiguities: [],
    risk: 'read',
    confidence: 0.99,
    evidence: [],
    ...overrides
  })
}

describe('confirmation policy', () => {
  it('answers read-only calendar questions immediately', () => {
    expect(getActionDisposition(baseDraft())).toBe('answer')
  })

  it('requires confirmation for destructive changes', () => {
    const draft = baseDraft({
      operation: 'event.delete',
      selection: { eventIds: ['event-1'], reminderIds: [], query: null },
      risk: 'destructive'
    })
    expect(getActionDisposition(draft)).toBe('confirm')
  })

  it('clarifies before acting when ambiguity is present', () => {
    const draft = baseDraft({
      operation: 'assistant.clarify',
      risk: 'medium',
      ambiguities: [
        {
          code: 'missing-time',
          message: 'What time should I use?',
          options: [],
          sourceSpan: null
        }
      ]
    })
    expect(getActionDisposition(draft)).toBe('clarify')
  })
})
