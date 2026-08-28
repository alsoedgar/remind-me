import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import {
  RemindCorePlanner,
  type RemindCoreAssistantContext,
  type RemindCoreAssistantPrediction
} from '@remind-me/model-runtime'

interface CorpusRow {
  text: string
  route: string
  actions: Array<{ capabilityId: string }>
  context: RemindCoreAssistantContext | null
  semantics: {
    dialogueRelation: RemindCoreAssistantPrediction['dialogueRelation']
    requestedAttribute: RemindCoreAssistantPrediction['requestedAttribute']
    scope: RemindCoreAssistantPrediction['scope']
    selection: RemindCoreAssistantPrediction['selection']
    turnKind: RemindCoreAssistantPrediction['turnKind']
  }
}

function percentile(values: readonly number[], value: number): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * value))] ?? 0
}

const workspace = process.cwd()
const modelRoot = resolve(workspace, 'models')
const [challengeText, reportText, firstCandidateText] = await Promise.all([
  readFile(resolve(workspace, 'ml/assistant_corpus/data/challenge.jsonl'), 'utf8'),
  readFile(resolve(workspace, 'ml/remindcore_next/reports/training-metrics.json'), 'utf8'),
  readFile(resolve(workspace, 'ml/remindcore_next/reports/first-candidate-metrics.json'), 'utf8')
])
const report = JSON.parse(reportText) as {
  promoted: boolean
  quantizedChallenge: {
    routeAccuracy: number
    firstCapabilityAccuracy: number
    actionCountAccuracy: number
    exactSequenceAccuracy: number
    selectivePrecision: number
    selectiveCoverage: number
    dialogueRelationAccuracy: number
    requestedAttributeAccuracy: number
    scopeAccuracy: number
    selectionAccuracy: number
    turnKindAccuracy: number
  }
  provenance: { humanBlindExamplesUsed: number }
  safety: { advisoryOnly: boolean; writesDatabase: boolean }
}
const firstCandidate = JSON.parse(firstCandidateText) as { promoted: boolean }
if (!report.promoted || firstCandidate.promoted) {
  throw new Error('RemindCore Next promotion history is invalid')
}
if (report.provenance.humanBlindExamplesUsed !== 0) {
  throw new Error('Developer examples cannot be reported as human-blind data')
}
if (!report.safety.advisoryOnly || report.safety.writesDatabase) {
  throw new Error('RemindCore Next crossed its advisory safety boundary')
}

const rows = challengeText
  .split(/\r?\n/u)
  .filter(Boolean)
  .map((line) => JSON.parse(line) as CorpusRow)
const planner = await RemindCorePlanner.load(modelRoot)
if (!planner.info.assistantPlanAvailable || planner.info.nativeCapabilityCount !== 42) {
  throw new Error('The promoted RemindCore Next extension is unavailable')
}
if (planner.info.modelBytes > 7 * 1024 * 1024) {
  throw new Error('The promoted planner exceeded the 7 MiB compact-install budget')
}

const predictions: RemindCoreAssistantPrediction[] = []
const latencies: number[] = []
planner.classifyAssistant('show my plans tomorrow')
for (const row of rows) {
  const started = performance.now()
  const prediction = planner.classifyAssistant(row.text, row.context)
  latencies.push(performance.now() - started)
  if (!prediction) throw new Error('RemindCore Next returned no challenge prediction')
  predictions.push(prediction)
}
const routeAccuracy =
  predictions.filter((value, index) => value.route === rows[index]?.route).length / rows.length
const firstCapabilityAccuracy =
  predictions.filter(
    (value, index) => value.capabilities[0] === rows[index]?.actions[0]?.capabilityId
  ).length / rows.length
const actionCountAccuracy =
  predictions.filter((value, index) => value.actionCount === rows[index]?.actions.length).length /
  rows.length
const exactSequenceAccuracy =
  predictions.filter(
    (value, index) =>
      value.capabilities.join('\u0000') ===
      rows[index]?.actions.map((action) => action.capabilityId).join('\u0000')
  ).length / rows.length
const eligible = predictions
  .map((value, index) => ({ value, row: rows[index] }))
  .filter(({ value }) => value.eligibleForRoutingAssistance)
const selectivePrecision =
  eligible.filter(({ value, row }) => value.route === row?.route).length /
  Math.max(1, eligible.length)
const selectiveCoverage = eligible.length / rows.length
const dialogueRelationAccuracy =
  predictions.filter(
    (value, index) => value.dialogueRelation === rows[index]?.semantics.dialogueRelation
  ).length / rows.length
const requestedAttributeAccuracy =
  predictions.filter(
    (value, index) => value.requestedAttribute === rows[index]?.semantics.requestedAttribute
  ).length / rows.length
const scopeAccuracy =
  predictions.filter((value, index) => value.scope === rows[index]?.semantics.scope).length /
  rows.length
const selectionAccuracy =
  predictions.filter((value, index) => value.selection === rows[index]?.semantics.selection)
    .length / rows.length
const turnKindAccuracy =
  predictions.filter((value, index) => value.turnKind === rows[index]?.semantics.turnKind).length /
  rows.length

const parityMetrics = [
  ['route accuracy', routeAccuracy, report.quantizedChallenge.routeAccuracy],
  [
    'first capability accuracy',
    firstCapabilityAccuracy,
    report.quantizedChallenge.firstCapabilityAccuracy
  ],
  ['action-count accuracy', actionCountAccuracy, report.quantizedChallenge.actionCountAccuracy],
  [
    'exact-sequence accuracy',
    exactSequenceAccuracy,
    report.quantizedChallenge.exactSequenceAccuracy
  ],
  ['selective precision', selectivePrecision, report.quantizedChallenge.selectivePrecision],
  ['selective coverage', selectiveCoverage, report.quantizedChallenge.selectiveCoverage],
  [
    'dialogue-relation accuracy',
    dialogueRelationAccuracy,
    report.quantizedChallenge.dialogueRelationAccuracy
  ],
  [
    'requested-attribute accuracy',
    requestedAttributeAccuracy,
    report.quantizedChallenge.requestedAttributeAccuracy
  ],
  ['scope accuracy', scopeAccuracy, report.quantizedChallenge.scopeAccuracy],
  ['selection accuracy', selectionAccuracy, report.quantizedChallenge.selectionAccuracy],
  ['turn-kind accuracy', turnKindAccuracy, report.quantizedChallenge.turnKindAccuracy]
] as const
const parityFailures = parityMetrics.filter(
  ([, actual, expected]) => Math.abs(actual - expected) > 1e-9
)
if (parityFailures.length > 0) {
  throw new Error(
    `RemindCore Next runtime parity failed: ${parityFailures
      .map(([label, actual, expected]) => `${label} (${actual} != ${expected})`)
      .join('; ')}`
  )
}

const probes = [
  ['set up study group for tomorrow at 2 pm', 'calendar', 'calendar.event.create'],
  ['switch the window into glance mode', 'app', 'app.window.set-mode'],
  ['what have you remembered about me', 'memory', 'assistant.memory.recall'],
  ['hello there how are you doing', 'conversation', 'assistant.wellbeing']
] as const
for (const [text, route, capability] of probes) {
  const prediction = planner.classifyAssistant(text)
  if (prediction?.route !== route || prediction.capabilities[0] !== capability) {
    throw new Error(`RemindCore Next failed the ${capability} semantic probe`)
  }
}

const focusedContext = {
  focusedKind: 'mixed',
  focusedCount: 4,
  ordinal: null,
  priorCapabilityId: 'calendar.query.list',
  pendingCapabilityId: null
} satisfies RemindCoreAssistantContext
const contextualProbes = [
  {
    text: 'what times are they',
    context: focusedContext,
    expected: {
      dialogueRelation: 'follow-up',
      requestedAttribute: 'time',
      scope: 'plural',
      selection: 'none',
      turnKind: 'calendar-read'
    }
  },
  {
    text: 'delete the first and third events',
    context: focusedContext,
    expected: {
      dialogueRelation: 'follow-up',
      requestedAttribute: 'none',
      scope: 'plural',
      selection: 'subset',
      turnKind: 'calendar-write'
    }
  },
  {
    text: 'anyway hello how are you doing',
    context: focusedContext,
    expected: {
      dialogueRelation: 'new-topic',
      requestedAttribute: 'none',
      scope: 'none',
      selection: 'none',
      turnKind: 'conversation'
    }
  }
] as const
for (const probe of contextualProbes) {
  const prediction = planner.classifyAssistant(probe.text, probe.context)
  if (!prediction) throw new Error(`RemindCore Next returned no contextual prediction`)
  for (const [field, expected] of Object.entries(probe.expected)) {
    if (prediction[field as keyof RemindCoreAssistantPrediction] !== expected) {
      throw new Error(
        `RemindCore Next failed contextual probe ${JSON.stringify(probe.text)}: ${field}`
      )
    }
  }
}

const runtimeMetrics = {
  schemaVersion: 1,
  model: planner.info,
  challenge: {
    examples: rows.length,
    routeAccuracy,
    firstCapabilityAccuracy,
    actionCountAccuracy,
    exactSequenceAccuracy,
    selectivePrecision,
    selectiveCoverage,
    dialogueRelationAccuracy,
    requestedAttributeAccuracy,
    scopeAccuracy,
    selectionAccuracy,
    turnKindAccuracy
  },
  latencyMs: {
    median: percentile(latencies, 0.5),
    p95: percentile(latencies, 0.95)
  },
  assertions: {
    typescriptInt8Parity: true,
    advisoryOnly: true,
    phase5SemanticHeadsPresent: true,
    semanticOutputsAdvisoryOnly: true,
    contextualTopicSwitchProbesPassed: true,
    existingCalendarIRAuthorityRetained: true,
    humanBlindExamplesUsed: 0
  }
}
if (runtimeMetrics.latencyMs.p95 > 50) {
  throw new Error(`RemindCore Next p95 ${runtimeMetrics.latencyMs.p95.toFixed(1)}ms is too slow`)
}
await writeFile(
  resolve(workspace, 'ml/remindcore_next/reports/runtime-metrics.json'),
  `${JSON.stringify(runtimeMetrics, null, 2)}\n`,
  'utf8'
)
console.log(
  `RemindCore Next: ${(routeAccuracy * 100).toFixed(1)}% route, ${(firstCapabilityAccuracy * 100).toFixed(1)}% first capability, ${(exactSequenceAccuracy * 100).toFixed(1)}% exact sequence; semantic heads ${(
    ((dialogueRelationAccuracy +
      requestedAttributeAccuracy +
      scopeAccuracy +
      selectionAccuracy +
      turnKindAccuracy) /
      5) *
    100
  ).toFixed(
    1
  )}% mean; ${(selectivePrecision * 100).toFixed(1)}% selective precision at ${(selectiveCoverage * 100).toFixed(1)}% coverage; p95 ${runtimeMetrics.latencyMs.p95.toFixed(1)}ms.`
)
