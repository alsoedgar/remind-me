import type { AssistantPlan, CalendarIRDraft } from '@remind-me/contracts'
import {
  assistantPlanFromCalendarDrafts,
  calendarDraftFromAssistantPlanAction
} from './assistant-plan'
import {
  parseCalendarText,
  type DeterministicParseResult,
  type DeterministicParserContext,
  type SemanticParserHint
} from './deterministic-parser'

export interface SemanticPlannerSpan {
  kind: 'TITLE' | 'TARGET' | 'DESCRIPTION' | 'LOCATION' | 'DATE' | 'TIME' | 'RECURRENCE'
  start: number
  end: number
}

export interface SemanticPlannerPrediction {
  operation: string
  operationConfidence: number
  ambiguityProbability: number
  oodProbability: number
  spans: readonly SemanticPlannerSpan[]
  eligibleForAssistance: boolean
}

export interface HybridParseResult extends DeterministicParseResult {
  route: 'rules-only' | 'rules-model-agreement' | 'model-assisted' | 'rules-fallback'
  modelPrediction: SemanticPlannerPrediction | null
}

export interface AssistantPlanningResult extends HybridParseResult {
  assistantPlan: AssistantPlan
}

const assistedOperations = new Set<SemanticParserHint['operation']>([
  'event.create',
  'event.duplicate',
  'event.update',
  'event.move',
  'event.delete',
  'reminder.create',
  'reminder.update',
  'reminder.complete',
  'reminder.delete',
  'calendar.list',
  'calendar.search',
  'calendar.availability',
  'calendar.conflicts'
])

function safeHint(prediction: SemanticPlannerPrediction): SemanticParserHint | null {
  if (!prediction.eligibleForAssistance) return null
  if (!assistedOperations.has(prediction.operation as SemanticParserHint['operation'])) return null
  const title = prediction.spans.find((span) => span.kind === 'TITLE') ?? null
  const target = prediction.spans.find((span) => span.kind === 'TARGET') ?? null
  const description = prediction.spans.find((span) => span.kind === 'DESCRIPTION') ?? null
  const location = prediction.spans.find((span) => span.kind === 'LOCATION') ?? null
  return {
    operation: prediction.operation as SemanticParserHint['operation'],
    confidence: prediction.operationConfidence,
    titleSpan: title ? { start: title.start, end: title.end } : null,
    targetSpan: target ? { start: target.start, end: target.end } : null,
    descriptionSpan: description ? { start: description.start, end: description.end } : null,
    locationSpan: location ? { start: location.start, end: location.end } : null
  }
}

function withRoute(
  result: DeterministicParseResult,
  route: HybridParseResult['route'],
  modelPrediction: SemanticPlannerPrediction | null
): HybridParseResult {
  return { ...result, route, modelPrediction }
}

export function parseCalendarTextHybrid(
  context: DeterministicParserContext,
  prediction: SemanticPlannerPrediction | null
): HybridParseResult {
  const rules = parseCalendarText(context)
  if (!prediction) return withRoute(rules, 'rules-only', null)
  const mayReplaceGenericDatedEvent =
    rules.draft.operation === 'event.create' && rules.matchedPattern === 'event-create-inferred'
  if (rules.draft.operation !== 'assistant.unsupported' && !mayReplaceGenericDatedEvent) {
    return withRoute(
      rules,
      rules.draft.operation === prediction.operation ? 'rules-model-agreement' : 'rules-fallback',
      prediction
    )
  }

  const hint = safeHint(prediction)
  if (!hint) return withRoute(rules, 'rules-fallback', prediction)
  const assisted = parseCalendarText({ ...context, semanticHint: hint })
  const validAssistedOperation =
    assisted.draft.operation === hint.operation || assisted.draft.operation === 'assistant.clarify'
  if (!validAssistedOperation) return withRoute(rules, 'rules-fallback', prediction)
  return withRoute(assisted, 'model-assisted', prediction)
}

export function isModelAssistedDraft(result: HybridParseResult): result is HybridParseResult & {
  draft: CalendarIRDraft
} {
  return result.route === 'model-assisted'
}

export function planCalendarTextHybrid(
  context: DeterministicParserContext,
  prediction: SemanticPlannerPrediction | null
): AssistantPlanningResult {
  const parsed = parseCalendarTextHybrid(context, prediction)
  const plannerSource =
    parsed.route === 'rules-only'
      ? 'deterministic'
      : parsed.route === 'model-assisted'
        ? 'remindcore'
        : 'hybrid'
  const assistantPlan = assistantPlanFromCalendarDrafts([parsed.draft], context.text, {
    plannerSource
  })
  const action = assistantPlan.actions[0]
  if (!action) throw new Error('The assistant plan did not contain its calendar action')
  return {
    ...parsed,
    draft: calendarDraftFromAssistantPlanAction(assistantPlan, action.id),
    assistantPlan
  }
}
