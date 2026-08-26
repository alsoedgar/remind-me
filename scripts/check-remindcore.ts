import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { parseCalendarTextHybrid } from '@remind-me/assistant-core'
import { calendarIRDraftSchema } from '@remind-me/contracts'
import { RemindCorePlanner } from '@remind-me/model-runtime'

interface HeldoutExample {
  id: string
  text: string
  ambiguous: boolean
  ood: boolean
  program: { operation: string; risk: string }
}

interface Thresholds {
  operationConfidence: number
  ambiguityProbability: number
  oodProbability: number
  safeAssistedOperations: string[]
  destructiveAlwaysConfirmationOnly: true
  seriesAlwaysConfirmationOnly: true
}

function percentile(values: readonly number[], percentileValue: number): number {
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * percentileValue))
  return sorted[index] ?? 0
}

function rate(numerator: number, denominator: number): number {
  return numerator / Math.max(1, denominator)
}

const workspace = process.cwd()
const modelRoot = resolve(workspace, 'models')
const fixturePath = resolve(workspace, 'fixtures/remindcore/heldout.v0.1.jsonl')
const manifestPath = resolve(workspace, 'ml/remindcore/data/manifest.json')
const thresholdsPath = resolve(modelRoot, 'remindcore/thresholds.json')
const reportPath = resolve(workspace, 'ml/remindcore/reports/runtime-metrics.json')

const [fixtureContents, manifestContents, thresholdContents, releaseManifestContents] =
  await Promise.all([
    readFile(fixturePath, 'utf8'),
    readFile(manifestPath, 'utf8'),
    readFile(thresholdsPath, 'utf8'),
    readFile(resolve(modelRoot, 'manifest.json'), 'utf8')
  ])
const manifest = JSON.parse(manifestContents) as {
  runtimeFixture: { examples: number; bytes: number; sha256: string }
}
const fixtureHash = createHash('sha256').update(fixtureContents).digest('hex')
if (
  Buffer.byteLength(fixtureContents) !== manifest.runtimeFixture.bytes ||
  fixtureHash !== manifest.runtimeFixture.sha256
) {
  throw new Error('The RemindCore held-out fixture does not match its dataset manifest.')
}

const examples = fixtureContents
  .split(/\r?\n/u)
  .filter(Boolean)
  .map((line) => JSON.parse(line) as HeldoutExample)
if (examples.length !== manifest.runtimeFixture.examples) {
  throw new Error('The RemindCore held-out fixture count is incorrect.')
}
const thresholds = JSON.parse(thresholdContents) as Thresholds
const releaseManifest = JSON.parse(releaseManifestContents) as {
  artifacts: Array<{
    role: string
    path: string
    byteLength: number
    sha256: string
    provenance: string
  }>
}
const plannerArtifacts = releaseManifest.artifacts.filter((artifact) => artifact.role === 'planner')
if (plannerArtifacts.length !== 4) throw new Error('Expected four RemindCore release artifacts.')
for (const artifact of plannerArtifacts) {
  if (artifact.provenance !== 'project-trained') {
    throw new Error(`RemindCore artifact has incorrect provenance: ${artifact.path}`)
  }
  const contents = await readFile(resolve(modelRoot, artifact.path))
  if (
    contents.byteLength !== artifact.byteLength ||
    createHash('sha256').update(contents).digest('hex') !== artifact.sha256
  ) {
    throw new Error(`RemindCore release artifact failed verification: ${artifact.path}`)
  }
}
if (!thresholds.destructiveAlwaysConfirmationOnly || !thresholds.seriesAlwaysConfirmationOnly) {
  throw new Error('RemindCore safety thresholds cannot relax destructive or series confirmation.')
}

const planner = await RemindCorePlanner.load(modelRoot)
const latencies: number[] = []
let operationCorrect = 0
let oodPositive = 0
let oodDetected = 0
let ambiguityPositive = 0
let ambiguityDetected = 0
let eligible = 0
let eligibleCorrect = 0
let schemaValid = 0
let hybridCorrect = 0
let hybridEvaluated = 0
const rulesBaseline = { correct: 0, evaluated: 0 }

// One discarded warm-up keeps startup/JSON parsing separate from warm inference latency.
planner.predict('What do I have tomorrow?')
for (const example of examples) {
  const started = performance.now()
  const prediction = planner.predict(example.text)
  latencies.push(performance.now() - started)
  operationCorrect += Number(prediction.operation === example.program.operation)
  if (example.ood) {
    oodPositive += 1
    oodDetected += Number(prediction.oodProbability >= thresholds.oodProbability)
  }
  if (example.ambiguous) {
    ambiguityPositive += 1
    ambiguityDetected += Number(prediction.ambiguityProbability >= thresholds.ambiguityProbability)
  }
  if (prediction.eligibleForAssistance) {
    eligible += 1
    eligibleCorrect += Number(prediction.operation === example.program.operation)
  }

  const parserContext = {
    requestId: `request:${example.id.replace(/[^a-zA-Z0-9._:-]/gu, '-')}`,
    text: example.text,
    previousUserText: null,
    nowUtc: '2026-08-24T15:00:00.000Z',
    localDate: '2026-08-24',
    timezone: 'America/Chicago',
    locale: 'en-US',
    events: [],
    reminders: []
  }
  const rules = parseCalendarTextHybrid(parserContext, null)
  calendarIRDraftSchema.parse(rules.draft)
  schemaValid += 1
  if (
    !example.ood &&
    !example.ambiguous &&
    thresholds.safeAssistedOperations.includes(example.program.operation)
  ) {
    rulesBaseline.evaluated += 1
    rulesBaseline.correct += Number(rules.draft.operation === example.program.operation)
    const hybrid = parseCalendarTextHybrid(parserContext, prediction)
    calendarIRDraftSchema.parse(hybrid.draft)
    hybridEvaluated += 1
    hybridCorrect += Number(hybrid.draft.operation === example.program.operation)
  }
}

const metrics = {
  fixtureExamples: examples.length,
  operationAccuracy: rate(operationCorrect, examples.length),
  oodRecall: rate(oodDetected, oodPositive),
  ambiguityRecall: rate(ambiguityDetected, ambiguityPositive),
  eligibleAssistedPrecision: rate(eligibleCorrect, eligible),
  eligibleAssistedCoverage: rate(eligible, examples.length),
  schemaValidity: rate(schemaValid, examples.length),
  rulesSafeOperationAccuracy: rate(rulesBaseline.correct, rulesBaseline.evaluated),
  hybridSafeOperationAccuracy: rate(hybridCorrect, hybridEvaluated),
  warmLatencyMs: {
    median: percentile(latencies, 0.5),
    p95: percentile(latencies, 0.95)
  }
}

if (metrics.schemaValidity !== 1)
  throw new Error('RemindCore produced an invalid CalendarIR draft.')
if (eligible < 10) throw new Error('RemindCore eligibility coverage is too small to assess.')
if (metrics.eligibleAssistedPrecision < 0.99) {
  throw new Error(
    `RemindCore eligible precision ${metrics.eligibleAssistedPrecision.toFixed(4)} is below 0.99.`
  )
}
if (metrics.oodRecall < 0.95) {
  throw new Error(`RemindCore OOD recall ${metrics.oodRecall.toFixed(4)} is below 0.95.`)
}
if (metrics.warmLatencyMs.p95 > 300) {
  throw new Error(`RemindCore warm p95 ${metrics.warmLatencyMs.p95.toFixed(1)}ms is too slow.`)
}
if (metrics.hybridSafeOperationAccuracy < metrics.rulesSafeOperationAccuracy) {
  throw new Error('The confidence-gated hybrid regressed the held-out rules baseline.')
}

await writeFile(
  reportPath,
  `${JSON.stringify(
    {
      schemaVersion: 1,
      model: planner.info,
      metrics,
      assertions: {
        modelNeverWritesDatabase: true,
        destructiveAndSeriesRemainConfirmationOnly: true,
        teacherUsed: planner.info.teacherUsed,
        networkRequired: false
      }
    },
    null,
    2
  )}\n`,
  'utf8'
)

console.log(
  `RemindCore: ${(metrics.eligibleAssistedPrecision * 100).toFixed(2)}% eligible precision at ${(metrics.eligibleAssistedCoverage * 100).toFixed(1)}% fixture coverage; OOD recall ${(metrics.oodRecall * 100).toFixed(1)}%; warm p95 ${metrics.warmLatencyMs.p95.toFixed(1)}ms.`
)
console.log(
  `Safe-operation execution: rules ${(metrics.rulesSafeOperationAccuracy * 100).toFixed(1)}% -> hybrid ${(metrics.hybridSafeOperationAccuracy * 100).toFixed(1)}%.`
)
