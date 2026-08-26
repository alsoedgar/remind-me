import {
  assistantPlanSchema,
  calendarIRDraftSchema,
  type AssistantCapabilityId,
  type AssistantPlan,
  type AssistantPlanArguments,
  type AssistantPlanTarget,
  type AssistantPlannerSource,
  type AssistantResponseGoal,
  type CalendarIRDraft,
  type CalendarOperation
} from '@remind-me/contracts'
import { assertAssistantPlanExecutable } from './capability-registry'
import { getActionDisposition } from './confirmation-policy'

const operationCapability: Record<CalendarOperation, AssistantCapabilityId> = {
  'event.create': 'calendar.event.create',
  'event.duplicate': 'calendar.event.duplicate',
  'event.update': 'calendar.event.update',
  'event.move': 'calendar.event.move',
  'event.delete': 'calendar.event.delete',
  'reminder.create': 'calendar.reminder.create',
  'reminder.update': 'calendar.reminder.update',
  'reminder.complete': 'calendar.reminder.complete',
  'reminder.delete': 'calendar.reminder.delete',
  'calendar.list': 'calendar.query.list',
  'calendar.search': 'calendar.query.search',
  'calendar.availability': 'calendar.query.availability',
  'calendar.conflicts': 'calendar.query.conflicts',
  'assistant.clarify': 'assistant.clarify',
  'assistant.reject': 'assistant.reject',
  'assistant.unsupported': 'assistant.unsupported',
  'import.propose': 'calendar.import.propose'
}

const capabilityOperation = new Map<AssistantCapabilityId, CalendarOperation>(
  Object.entries(operationCapability).map(([operation, capability]) => [
    capability,
    operation as CalendarOperation
  ])
)

type Evidence = CalendarIRDraft['evidence'][number]

function hash(value: string): string {
  let result = 2_166_136_261
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index)
    result = Math.imul(result, 16_777_619)
  }
  return (result >>> 0).toString(16).padStart(8, '0')
}

function evidenceId(requestId: string, actionIndex: number, itemIndex: number): string {
  return `evidence:plan:${hash(requestId)}:${actionIndex + 1}:${itemIndex + 1}`
}

function actionId(requestId: string, index: number): string {
  return `action:plan:${hash(requestId)}:${index + 1}`
}

function liftedEvidence(
  draft: CalendarIRDraft,
  sourceText: string,
  actionIndex: number
): { evidence: Evidence[]; ids: string[] } {
  const input =
    draft.evidence.length > 0
      ? draft.evidence
      : [
          {
            id: `evidence:fallback:${hash(draft.requestId)}`,
            sourceKind: 'text' as const,
            sourceId: null,
            page: null,
            boundingBox: null,
            text: sourceText.slice(0, 2_000),
            sourceSpan: sourceText ? { start: 0, end: Math.min(sourceText.length, 2_000) } : null
          }
        ]
  const evidence = input.map((item, itemIndex): Evidence => {
    const id = evidenceId(draft.requestId, actionIndex, itemIndex)
    if ((item.sourceKind === 'text' || item.sourceKind === 'voice') && item.sourceId === null) {
      const start = sourceText.indexOf(item.text)
      if (start >= 0) {
        return {
          ...item,
          id,
          sourceSpan: { start, end: start + item.text.length }
        }
      }
      const text = sourceText.slice(0, 2_000)
      return {
        ...item,
        id,
        text,
        sourceSpan: text ? { start: 0, end: text.length } : null
      }
    }
    return { ...item, id }
  })
  return { evidence, ids: evidence.map((item) => item.id) }
}

function remapEvidenceIds<T extends { evidenceIds: string[] } | null>(
  value: T,
  evidenceIds: string[]
): T {
  if (!value) return value
  return { ...value, evidenceIds: evidenceIds.slice(0, 32) }
}

function remappedFields(draft: CalendarIRDraft, evidenceIds: string[]): CalendarIRDraft['fields'] {
  return {
    title: remapEvidenceIds(draft.fields.title, evidenceIds),
    description: remapEvidenceIds(draft.fields.description, evidenceIds),
    location: remapEvidenceIds(draft.fields.location, evidenceIds),
    when: remapEvidenceIds(draft.fields.when, evidenceIds),
    reminderOffsetMinutes: remapEvidenceIds(draft.fields.reminderOffsetMinutes, evidenceIds),
    status: draft.fields.status
  }
}

function remappedSelection(
  draft: CalendarIRDraft,
  evidenceIds: string[]
): CalendarIRDraft['selection'] {
  if (!draft.selection) return null
  return {
    ...draft.selection,
    query: remapEvidenceIds(draft.selection.query, evidenceIds)
  }
}

function reviewFor(draft: CalendarIRDraft): AssistantPlan['actions'][number]['review'] {
  if (draft.operation === 'import.propose') return 'explicit-confirmation'
  const disposition = getActionDisposition(draft)
  if (disposition === 'answer' || disposition === 'clarify' || disposition === 'reject') {
    return 'none'
  }
  return disposition === 'confirm' ? 'explicit-confirmation' : 'preview'
}

function responseGoalFor(drafts: readonly CalendarIRDraft[]): AssistantResponseGoal {
  const operations = new Set(drafts.map((draft) => draft.operation))
  if (operations.has('assistant.clarify')) {
    return { mode: 'clarification', detail: 'brief', include: [], maxItems: 5, maxWords: 120 }
  }
  if (operations.has('assistant.unsupported') || operations.has('assistant.reject')) {
    return { mode: 'unsupported', detail: 'brief', include: [], maxItems: 1, maxWords: 120 }
  }
  if (
    [...operations].every((operation) =>
      ['calendar.list', 'calendar.search', 'calendar.availability', 'calendar.conflicts'].includes(
        operation
      )
    )
  ) {
    return {
      mode: 'answer',
      detail: 'brief',
      include: ['title', 'date', 'time'],
      maxItems: 20,
      maxWords: 180
    }
  }
  return {
    mode: 'preview',
    detail: drafts.length > 1 ? 'standard' : 'brief',
    include: ['title', 'date', 'time', 'location', 'recurrence'],
    maxItems: Math.min(50, drafts.length),
    maxWords: Math.min(600, 80 + drafts.length * 40)
  }
}

export interface AssistantPlanFromCalendarOptions {
  requestId?: string
  plannerSource?: AssistantPlannerSource
  responseGoal?: AssistantResponseGoal
  dependencyIndexes?: readonly (readonly number[])[]
}

export interface AssistantPlanForCapabilityInput {
  requestId: string
  sourceText: string
  capabilityId: AssistantCapabilityId
  target: AssistantPlanTarget
  arguments: AssistantPlanArguments
  scope: AssistantPlan['actions'][number]['scope']
  risk: AssistantPlan['actions'][number]['risk']
  review: AssistantPlan['actions'][number]['review']
  responseGoal: AssistantResponseGoal
  plannerSource?: AssistantPlannerSource
  confidence?: number
}

export function assistantPlanForCapability(input: AssistantPlanForCapabilityInput): AssistantPlan {
  const id = evidenceId(input.requestId, 0, 0)
  const plan = assistantPlanSchema.parse({
    version: '2',
    requestId: input.requestId,
    sourceText: input.sourceText,
    plannerSource: input.plannerSource ?? 'deterministic',
    status: 'ready',
    actions: [
      {
        id: actionId(input.requestId, 0),
        requestId: input.requestId,
        capabilityId: input.capabilityId,
        target: input.target,
        arguments: input.arguments,
        scope: input.scope,
        dependsOn: [],
        evidenceIds: [id],
        confidence: input.confidence ?? 1,
        risk: input.risk,
        review: input.review
      }
    ],
    responseGoal: input.responseGoal,
    evidence: [
      {
        id,
        sourceKind: 'text',
        sourceId: null,
        page: null,
        boundingBox: null,
        text: input.sourceText.slice(0, 2_000),
        sourceSpan: {
          start: 0,
          end: Math.min(input.sourceText.length, 2_000)
        }
      }
    ],
    confidence: input.confidence ?? 1
  })
  assertAssistantPlanExecutable(plan)
  return plan
}

export function assistantPlanFromCalendarDrafts(
  inputDrafts: readonly CalendarIRDraft[],
  sourceText: string,
  options: AssistantPlanFromCalendarOptions = {}
): AssistantPlan {
  if (inputDrafts.length === 0) throw new Error('At least one calendar draft is required')
  const drafts = inputDrafts.map((draft) => calendarIRDraftSchema.parse(draft))
  const requestId = options.requestId ?? drafts[0]?.requestId
  if (!requestId) throw new Error('The assistant plan requires a request ID')
  const allEvidence: Evidence[] = []
  const actionIds = drafts.map((draft, index) => actionId(draft.requestId, index))
  const actions = drafts.map((draft, index) => {
    const lifted = liftedEvidence(draft, sourceText, index)
    allEvidence.push(...lifted.evidence)
    const dependencyIndexes = options.dependencyIndexes?.[index] ?? []
    const dependsOn = dependencyIndexes.map((dependencyIndex) => {
      const dependencyId = actionIds[dependencyIndex]
      if (!dependencyId || dependencyIndex >= index) {
        throw new Error('Assistant plan dependencies must reference an earlier draft')
      }
      return dependencyId
    })
    return {
      id: actionIds[index] ?? actionId(draft.requestId, index),
      requestId: draft.requestId,
      capabilityId: operationCapability[draft.operation],
      target: {
        kind: 'calendar' as const,
        selection: remappedSelection(draft, lifted.ids),
        references: draft.references
      },
      arguments: {
        kind: 'calendar' as const,
        fields: remappedFields(draft, lifted.ids),
        recurrence: draft.recurrence,
        ambiguities: draft.ambiguities
      },
      scope: draft.scope,
      dependsOn,
      evidenceIds: lifted.ids,
      confidence: draft.confidence,
      risk: draft.risk,
      review: reviewFor(draft)
    }
  })
  const status = actions.some((action) => action.capabilityId === 'assistant.unsupported')
    ? 'unsupported'
    : actions.some((action) => action.capabilityId === 'assistant.clarify')
      ? 'clarification'
      : 'ready'
  const plan = assistantPlanSchema.parse({
    version: '2',
    requestId,
    sourceText,
    plannerSource: options.plannerSource ?? 'deterministic',
    status,
    actions,
    responseGoal: options.responseGoal ?? responseGoalFor(drafts),
    evidence: allEvidence,
    confidence: Math.min(...actions.map((action) => action.confidence))
  })
  assertAssistantPlanExecutable(plan)
  return plan
}

export function calendarDraftFromAssistantPlanAction(
  inputPlan: AssistantPlan,
  inputActionId: string
): CalendarIRDraft {
  const plan = assistantPlanSchema.parse(inputPlan)
  assertAssistantPlanExecutable(plan)
  const action = plan.actions.find((candidate) => candidate.id === inputActionId)
  if (!action) throw new Error(`Unknown assistant plan action: ${inputActionId}`)
  const operation = capabilityOperation.get(action.capabilityId)
  if (!operation || action.arguments.kind !== 'calendar' || action.target.kind !== 'calendar') {
    throw new Error(`${action.capabilityId} cannot be adapted to CalendarIR`)
  }
  const selectedEvidence = new Set(action.evidenceIds)
  return calendarIRDraftSchema.parse({
    version: '0.1',
    requestId: action.requestId,
    operation,
    selection: action.target.selection,
    fields: action.arguments.fields,
    recurrence: action.arguments.recurrence,
    scope: action.scope,
    references: action.target.references,
    ambiguities: action.arguments.ambiguities,
    risk: action.risk,
    confidence: action.confidence,
    evidence: plan.evidence.filter((item) => selectedEvidence.has(item.id))
  })
}
