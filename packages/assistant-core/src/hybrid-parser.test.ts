import { describe, expect, it } from 'vitest'
import {
  parseCalendarTextHybrid,
  planCalendarTextHybrid,
  type SemanticPlannerPrediction
} from './hybrid-parser'
import type { DeterministicParserContext } from './deterministic-parser'

function context(text: string): DeterministicParserContext {
  return {
    requestId: 'request:hybrid-test',
    text,
    previousUserText: null,
    nowUtc: '2026-08-24T15:00:00.000Z',
    localDate: '2026-08-24',
    timezone: 'America/Chicago',
    locale: 'en-US',
    events: [],
    reminders: []
  }
}

function prediction(
  text: string,
  overrides: Partial<SemanticPlannerPrediction> = {}
): SemanticPlannerPrediction {
  const title = 'feed Juniper'
  const start = text.indexOf(title)
  return {
    operation: 'reminder.create',
    operationConfidence: 0.99,
    ambiguityProbability: 0.01,
    oodProbability: 0.01,
    spans: [{ kind: 'TITLE', start, end: start + title.length }],
    eligibleForAssistance: true,
    ...overrides
  }
}

describe('confidence-gated hybrid parser', () => {
  it('turns a safe held-out paraphrase into a source-grounded CalendarIR draft', () => {
    const text = 'Give me a nudge to feed Juniper tomorrow at 4 PM'
    const result = parseCalendarTextHybrid(context(text), prediction(text))
    expect(result.route).toBe('model-assisted')
    expect(result.draft.operation).toBe('reminder.create')
    expect(result.draft.fields.title).toMatchObject({
      value: 'feed Juniper',
      sourceSpan: { start: 19, end: 31 }
    })
    expect(result.draft.fields.when?.value.start.date).toEqual({ kind: 'relative-day', offset: 1 })
  })

  it('falls back when the calibrated model gate is closed', () => {
    const text = 'Give me a nudge to feed Juniper tomorrow at 4 PM'
    const result = parseCalendarTextHybrid(
      context(text),
      prediction(text, { eligibleForAssistance: false })
    )
    expect(result.route).toBe('rules-fallback')
    expect(result.draft.operation).toBe('event.create')
  })

  it('never lets a model hint replace a recognized destructive command', () => {
    const text = 'Delete team sync'
    const result = parseCalendarTextHybrid(
      {
        ...context(text),
        events: [
          {
            id: 'event:team-sync',
            calendarId: 'calendar:local',
            title: 'Team sync',
            description: '',
            location: '',
            startUtc: '2026-08-25T15:00:00.000Z',
            endUtc: '2026-08-25T16:00:00.000Z',
            timezone: 'America/Chicago',
            allDay: false,
            recurrence: null,
            status: 'active',
            provenance: 'manual',
            createdAt: '2026-08-24T15:00:00.000Z',
            updatedAt: '2026-08-24T15:00:00.000Z'
          }
        ]
      },
      prediction(text, {
        operation: 'event.create',
        spans: [{ kind: 'TITLE', start: 7, end: text.length }]
      })
    )
    expect(result.route).toBe('rules-fallback')
    expect(result.draft.operation).toBe('event.delete')
    expect(result.draft.risk).toBe('destructive')
  })

  it('routes the compatible calendar draft through AssistantPlan v2', () => {
    const text = 'Give me a nudge to feed Juniper tomorrow at 4 PM'
    const result = planCalendarTextHybrid(context(text), prediction(text))
    expect(result.assistantPlan).toMatchObject({
      version: '2',
      plannerSource: 'remindcore',
      actions: [{ capabilityId: 'calendar.reminder.create', review: 'preview' }]
    })
    expect(result.draft).toMatchObject({
      operation: 'reminder.create',
      fields: { title: { value: 'feed Juniper' } }
    })
  })
})
