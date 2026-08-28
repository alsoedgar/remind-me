import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { RemindCorePlanner } from './remindcore'

const modelRoot = fileURLToPath(new URL('../../../models/', import.meta.url))

describe('RemindCore INT8 runtime', () => {
  it('loads the zero-initialized teacher-assisted artifact with honest provenance', async () => {
    const planner = await RemindCorePlanner.load(modelRoot)
    expect(planner.info).toMatchObject({
      available: true,
      mode: 'confidence-gated-hybrid',
      teacherUsed: true,
      assistantPlanAvailable: true,
      nativeCapabilityCount: 42,
      networkRequired: false
    })
    expect(planner.info.parameterCount).toBeGreaterThanOrEqual(3_000_000)
    expect(planner.info.parameterCount).toBeLessThanOrEqual(5_000_000)
    expect(planner.info.modelBytes).toBeLessThan(7 * 1024 * 1024)
  })

  it('recognizes a held-out reminder paraphrase and copies only source text', async () => {
    const planner = await RemindCorePlanner.load(modelRoot)
    const text = 'Give me a nudge to feed Juniper tomorrow at 4 PM'
    const result = planner.predict(text)
    expect(result.operation).toBe('reminder.create')
    expect(result.eligibleForAssistance).toBe(true)
    expect(result.spans.find((span) => span.kind === 'TITLE')).toMatchObject({
      text: 'feed Juniper',
      decoder: 'constrained-copy'
    })
    for (const span of result.spans) expect(span.text).toBe(text.slice(span.start, span.end))
  })

  it('detects unrelated requests and withholds model assistance', async () => {
    const planner = await RemindCorePlanner.load(modelRoot)
    const result = planner.predict('Write me a poem about summer')
    expect(result.operation).toBe('assistant.unsupported')
    expect(result.oodProbability).toBeGreaterThan(0.9)
    expect(result.eligibleForAssistance).toBe(false)
  })

  it('recognizes ordinal class questions as calendar reads', async () => {
    const planner = await RemindCorePlanner.load(modelRoot)
    for (const text of [
      "What's my first class today?",
      'Which class comes second tomorrow?',
      'Show me my next lecture'
    ]) {
      expect(planner.predict(text).operation).toBe('calendar.list')
    }
  })

  it('understands explicit multi-action boundaries without gaining write authority', async () => {
    const planner = await RemindCorePlanner.load(modelRoot)
    const result = planner.classifyAssistant(
      'cancel event Design review and dismiss reminder Study group'
    )
    expect(result).toMatchObject({
      route: 'calendar',
      actionCount: 2,
      capabilities: ['calendar.event.delete', 'calendar.reminder.delete']
    })
    expect(planner.info.mode).toBe('confidence-gated-hybrid')
  })

  it('classifies contextual fields, scope, selection, and topic changes with native heads', async () => {
    const planner = await RemindCorePlanner.load(modelRoot)
    const context = {
      focusedKind: 'mixed' as const,
      focusedCount: 4,
      ordinal: null,
      priorCapabilityId: 'calendar.query.list' as const,
      pendingCapabilityId: null
    }

    expect(planner.classifyAssistant('what times are they', context)).toMatchObject({
      dialogueRelation: 'follow-up',
      requestedAttribute: 'time',
      scope: 'plural',
      selection: 'none',
      turnKind: 'calendar-read'
    })
    expect(planner.classifyAssistant('delete the first and third events', context)).toMatchObject({
      dialogueRelation: 'follow-up',
      scope: 'plural',
      selection: 'subset',
      turnKind: 'calendar-write'
    })
    expect(planner.classifyAssistant('anyway hello how are you doing', context)).toMatchObject({
      dialogueRelation: 'new-topic',
      scope: 'none',
      turnKind: 'conversation'
    })
  })
})
