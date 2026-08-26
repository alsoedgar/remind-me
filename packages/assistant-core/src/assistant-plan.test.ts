import { describe, expect, it } from 'vitest'
import { assistantPlanSchema, type EventEntity } from '@remind-me/contracts'
import {
  assistantPlanFromCalendarDrafts,
  calendarDraftFromAssistantPlanAction
} from './assistant-plan'
import { parseCalendarText, type DeterministicParserContext } from './deterministic-parser'

const now = '2026-08-24T15:00:00.000Z'

function event(title: string): EventEntity {
  return {
    id: `event:${title.toLocaleLowerCase().replace(/\s+/gu, '-')}`,
    calendarId: 'calendar:local',
    title,
    description: '',
    location: '',
    startUtc: '2026-08-25T15:00:00.000Z',
    endUtc: '2026-08-25T16:00:00.000Z',
    timezone: 'America/Chicago',
    allDay: false,
    recurrence: null,
    status: 'active',
    provenance: 'manual',
    createdAt: now,
    updatedAt: now
  }
}

function context(
  requestId: string,
  text: string,
  events: EventEntity[] = []
): DeterministicParserContext {
  return {
    requestId,
    text,
    previousUserText: null,
    nowUtc: now,
    localDate: '2026-08-24',
    timezone: 'America/Chicago',
    locale: 'en-US',
    events,
    reminders: []
  }
}

describe('AssistantPlan v2 calendar compatibility', () => {
  it('round-trips a grounded event creation through the capability boundary', () => {
    const text = 'Schedule design review tomorrow at 2 PM'
    const draft = parseCalendarText(context('request:create', text)).draft
    const plan = assistantPlanFromCalendarDrafts([draft], text)

    expect(plan).toMatchObject({
      version: '2',
      status: 'ready',
      plannerSource: 'deterministic',
      responseGoal: { mode: 'preview' },
      actions: [
        {
          requestId: 'request:create',
          capabilityId: 'calendar.event.create',
          review: 'preview',
          target: { kind: 'calendar' },
          arguments: { kind: 'calendar' }
        }
      ]
    })
    expect(plan.evidence[0]).toMatchObject({
      text,
      sourceSpan: { start: 0, end: text.length }
    })

    const action = plan.actions[0]
    if (!action) throw new Error('Expected one action')
    const roundTripped = calendarDraftFromAssistantPlanAction(plan, action.id)
    expect(roundTripped).toMatchObject({
      operation: 'event.create',
      fields: {
        title: { value: 'design review' },
        when: { value: { start: { date: { kind: 'relative-day', offset: 1 }, time: '14:00' } } }
      }
    })
  })

  it('keeps destructive selection and explicit confirmation intact', () => {
    const text = 'Delete Team sync'
    const draft = parseCalendarText(context('request:delete', text, [event('Team sync')])).draft
    const plan = assistantPlanFromCalendarDrafts([draft], text, { plannerSource: 'remindcore' })
    expect(plan.actions[0]).toMatchObject({
      capabilityId: 'calendar.event.delete',
      risk: 'destructive',
      review: 'explicit-confirmation',
      target: { kind: 'calendar', selection: { eventIds: ['event:team-sync'] } }
    })
    const action = plan.actions[0]
    if (!action) throw new Error('Expected one action')
    expect(calendarDraftFromAssistantPlanAction(plan, action.id)).toMatchObject({
      operation: 'event.delete',
      selection: { eventIds: ['event:team-sync'] },
      risk: 'destructive'
    })
  })

  it('represents multiple ordered actions and only backward dependencies', () => {
    const firstText = 'Schedule tutoring tomorrow at 4 PM'
    const secondText = 'Schedule dinner tomorrow at 7 PM'
    const source = `${firstText}; ${secondText}`
    const first = parseCalendarText(context('request:batch:1', firstText)).draft
    const second = parseCalendarText(context('request:batch:2', secondText)).draft
    const plan = assistantPlanFromCalendarDrafts([first, second], source, {
      requestId: 'request:batch',
      dependencyIndexes: [[], [0]]
    })
    expect(plan.actions).toHaveLength(2)
    expect(plan.actions[1]?.dependsOn).toEqual([plan.actions[0]?.id])
    expect(plan.evidence.map((item) => item.text)).toEqual([firstText, secondText])

    const invalid = structuredClone(plan)
    invalid.actions[0]!.dependsOn = [invalid.actions[1]!.id]
    expect(assistantPlanSchema.safeParse(invalid).success).toBe(false)
  })

  it('rejects evidence spans that are not exact source projections', () => {
    const text = 'What do I have tomorrow?'
    const draft = parseCalendarText(context('request:list', text)).draft
    const plan = structuredClone(assistantPlanFromCalendarDrafts([draft], text))
    plan.evidence[0]!.text = 'invented text'
    expect(assistantPlanSchema.safeParse(plan).success).toBe(false)
  })
})
