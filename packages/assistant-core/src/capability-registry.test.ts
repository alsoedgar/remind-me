import { describe, expect, it } from 'vitest'
import {
  assistantCapabilityIdSchema,
  assistantPlanSchema,
  type AssistantPlan
} from '@remind-me/contracts'
import {
  assertAssistantPlanExecutable,
  assistantCapabilityRegistry,
  getAssistantCapability,
  listAssistantCapabilities,
  validateAssistantPlanCapabilities
} from './capability-registry'

function navigationPlan(): AssistantPlan {
  return assistantPlanSchema.parse({
    version: '2',
    requestId: 'request:navigation',
    sourceText: 'open settings',
    plannerSource: 'deterministic',
    status: 'ready',
    actions: [
      {
        id: 'action:navigation',
        requestId: 'request:navigation',
        capabilityId: 'app.navigation.open',
        target: { kind: 'view', view: 'settings' },
        arguments: { kind: 'navigation', view: 'settings' },
        scope: 'single',
        dependsOn: [],
        evidenceIds: ['evidence:navigation'],
        confidence: 1,
        risk: 'read',
        review: 'none'
      }
    ],
    responseGoal: {
      mode: 'receipt',
      detail: 'brief',
      include: [],
      maxItems: 1,
      maxWords: 20
    },
    evidence: [
      {
        id: 'evidence:navigation',
        sourceKind: 'text',
        sourceId: null,
        page: null,
        boundingBox: null,
        text: 'open settings',
        sourceSpan: { start: 0, end: 13 }
      }
    ],
    confidence: 1
  })
}

describe('assistant capability registry', () => {
  it('defines every contract capability exactly once', () => {
    expect(assistantCapabilityRegistry.map((capability) => capability.id)).toEqual(
      assistantCapabilityIdSchema.options
    )
    expect(new Set(assistantCapabilityRegistry.map((capability) => capability.id)).size).toBe(
      assistantCapabilityRegistry.length
    )
  })

  it('distinguishes executable assistant handlers from existing app-only surfaces', () => {
    expect(getAssistantCapability('calendar.event.create')).toMatchObject({
      status: 'assistant-ready',
      handler: 'calendar-ir',
      confirmation: 'preview'
    })
    expect(getAssistantCapability('app.navigation.open')).toMatchObject({
      status: 'app-ready',
      handler: 'renderer'
    })
    expect(getAssistantCapability('assistant.chat.respond')).toMatchObject({
      status: 'conditional',
      requiresOptionalModel: true
    })
    expect(listAssistantCapabilities({ status: 'assistant-ready' }).length).toBeGreaterThan(20)
  })

  it('does not pretend an app-ready capability has an assistant execution binding', () => {
    const plan = navigationPlan()
    expect(validateAssistantPlanCapabilities(plan)).toEqual([])
    expect(validateAssistantPlanCapabilities(plan, { requireAssistantReady: true })).toMatchObject([
      { capabilityId: 'app.navigation.open', code: 'not-assistant-ready' }
    ])
    expect(() => assertAssistantPlanExecutable(plan)).toThrow(/not assistant-ready/iu)
  })

  it('reports argument and target mismatches before handler dispatch', () => {
    const plan = navigationPlan()
    const invalid = structuredClone(plan)
    invalid.actions[0]!.arguments = { kind: 'none' }
    invalid.actions[0]!.target = { kind: 'none' }
    expect(validateAssistantPlanCapabilities(invalid).map((issue) => issue.code)).toEqual([
      'argument-kind',
      'target-kind'
    ])
  })

  it('refuses to weaken a capability review policy', () => {
    const source = navigationPlan()
    const plan = structuredClone(source)
    plan.actions[0]!.capabilityId = 'app.model.remove'
    plan.actions[0]!.arguments = { kind: 'model', modelId: 'qwen3-1.7b-q4' }
    plan.actions[0]!.target = { kind: 'model', modelId: 'qwen3-1.7b-q4' }
    plan.actions[0]!.review = 'none'
    expect(validateAssistantPlanCapabilities(plan).map((issue) => issue.code)).toContain(
      'review-policy'
    )
  })
})
