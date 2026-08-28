import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { resolve } from 'node:path'
import { createGroundedReply } from '@remind-me/assistant-core'
import {
  RemindSpeakPlanner,
  loadModelManifest,
  remindSpeakTemplateFingerprint,
  verifyModelManifest,
  type RemindSpeakFact,
  type RemindSpeakRequest
} from '@remind-me/model-runtime'

interface FixtureRow {
  id: string
  speechAct: RemindSpeakRequest['speechAct']
  factKeys: string[]
  factKinds: RemindSpeakFact['kind'][]
  factLengths: number[]
  style: RemindSpeakRequest['style']
  variant: number
  recentCount: number
  targets: Record<'lead' | 'body' | 'close', string>
  reference: string
}

const workspace = process.cwd()
const modelRoot = resolve(workspace, 'models')
const fixturePath = resolve(workspace, 'fixtures/remindspeak/heldout.v0.1.jsonl')
const dataManifestPath = resolve(workspace, 'ml/remindspeak/data/manifest.json')
const prototypeReportPath = resolve(workspace, 'ml/remindspeak/reports/prototype-metrics.json')
const runtimeReportPath = resolve(workspace, 'ml/remindspeak/reports/runtime-metrics.json')
const humanStudyReportPath = resolve(
  workspace,
  'ml/remindspeak/reports/human-preference-study.json'
)
const artifactPath = resolve(modelRoot, 'remindspeak/remindspeak-v0.1-int8.json')

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function percentile(values: readonly number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))
  return sorted[index] ?? 0
}

function valuesFor(row: FixtureRow, index: number): RemindSpeakFact[] {
  return row.factKeys.map((key, factIndex) => {
    const value =
      key === 'SUMMARY'
        ? `${(index % 4) + 1} verified local item${index % 4 === 0 ? '' : 's'}`
        : key === 'RECEIPT'
          ? `Saved “Sample plan ${index}” locally.`
          : key === 'SLOT'
            ? `Friday at ${(index % 8) + 1}:00 PM`
            : `the checked calendar evidence is available for sample ${index}`
    return {
      key,
      kind: row.factKinds[factIndex] ?? 'text',
      placeholder: `<${key}>`,
      value
    }
  })
}

function render(template: string, facts: readonly RemindSpeakFact[]): string {
  let output = template
  for (const fact of facts) output = output.replaceAll(fact.placeholder, fact.value)
  return output.replace(/\s+/gu, ' ').trim()
}

function staticText(template: string): string {
  return template.replace(/<[A-Z][A-Z0-9_]*>/gu, ' ')
}

const [fixtureText, dataManifestText, prototypeReportText, humanStudyReportText, artifactText] =
  await Promise.all([
    readFile(fixturePath, 'utf8'),
    readFile(dataManifestPath, 'utf8'),
    readFile(prototypeReportPath, 'utf8'),
    readFile(humanStudyReportPath, 'utf8'),
    readFile(artifactPath, 'utf8')
  ])
const rows = fixtureText
  .split(/\r?\n/u)
  .filter(Boolean)
  .map((line) => JSON.parse(line) as FixtureRow)
const dataManifest = JSON.parse(dataManifestText) as {
  heldoutFixture: { examples: number; sha256: string }
  provenance: Record<string, number>
}
const prototypeReport = JSON.parse(prototypeReportText) as {
  metrics: {
    meanInt8HeadAccuracy: number
    quantizationAccuracyReduction: number
    schemaValidCandidateRate: number
    protectedFactRetention: number
    unsupportedFactIntroductionRate: number
    teacherUsed: boolean
    pretrainedWeightsUsed: boolean
    candidateCombinationsByActAndSignature: Record<string, number>
  }
}
const humanStudyReport = JSON.parse(humanStudyReportText) as {
  status: string
  participantCount: number
  judgments: number
  gatePassed: boolean
  claimBoundary: string
}
const artifact = JSON.parse(artifactText) as {
  safety: { localPreferenceBiasBounded?: boolean }
  training: { projectAuthoredSurfaceAtoms: number }
}

assert(rows.length === dataManifest.heldoutFixture.examples, 'RemindSpeak fixture count mismatch')
assert(
  createHash('sha256').update(fixtureText).digest('hex') === dataManifest.heldoutFixture.sha256,
  'RemindSpeak fixture hash mismatch'
)
assert(
  (dataManifest.provenance.teacherGeneratedExamples ?? 0) > 0,
  'Teacher preference data is missing'
)
assert(
  dataManifest.provenance.teacherAuthoredSurfaceAtoms === 0,
  'Qwen-authored surface atoms must not enter RemindSpeak'
)
assert(
  dataManifest.provenance.personalCalendarExamples === 0,
  'Personal calendar data must remain absent'
)
assert(prototypeReport.metrics.meanInt8HeadAccuracy >= 0.7, 'INT8 head accuracy is below 70%')
assert(
  prototypeReport.metrics.quantizationAccuracyReduction <= 0.01,
  'INT8 head accuracy reduction exceeds one percentage point'
)
assert(
  prototypeReport.metrics.schemaValidCandidateRate === 1,
  'Candidate schema validity regressed'
)
assert(prototypeReport.metrics.protectedFactRetention === 1, 'Protected fact retention regressed')
assert(
  prototypeReport.metrics.unsupportedFactIntroductionRate === 0,
  'Unsupported factual literals were introduced'
)
assert(prototypeReport.metrics.teacherUsed === true, 'Teacher preference use is not reported')
assert(
  prototypeReport.metrics.pretrainedWeightsUsed === false,
  'Pretrained weight use must remain false'
)
const coveredSpeechActs = new Set(
  Object.keys(prototypeReport.metrics.candidateCombinationsByActAndSignature).map(
    (key) => key.split(':')[0]
  )
)
assert(coveredSpeechActs.size === 22, 'Phase 5 must cover all 22 protected speech acts')
assert(
  artifact.training.projectAuthoredSurfaceAtoms === 528,
  'Phase 5 project-authored phrase inventory must contain 528 atoms'
)
assert(
  artifact.safety.localPreferenceBiasBounded === true,
  'The artifact does not declare bounded local preference bias'
)
assert(
  [
    'awaiting-participants',
    'insufficient-sample',
    'complete-passed',
    'complete-not-passed'
  ].includes(humanStudyReport.status),
  'The human preference study report has an invalid status'
)
if (humanStudyReport.participantCount === 0) {
  assert(humanStudyReport.judgments === 0, 'An empty study cannot report human judgments')
  assert(humanStudyReport.gatePassed === false, 'An empty human study cannot pass')
  assert(
    humanStudyReport.claimBoundary.includes('no human preference result is claimed'),
    'The empty study must state its claim boundary'
  )
}

const manifest = await loadModelManifest(modelRoot)
const verification = await verifyModelManifest(modelRoot, manifest)
const speakerArtifacts = verification.artifacts.filter(
  (result) => result.artifact.role === 'speaker'
)
assert(
  speakerArtifacts.length === 3,
  'Expected configuration, compact weights, and ONNX parity artifacts for RemindSpeak'
)
assert(
  speakerArtifacts.some((result) => result.artifact.format === 'onnx'),
  'RemindSpeak ONNX parity export is missing'
)
assert(
  speakerArtifacts.every((result) => result.valid),
  'A RemindSpeak artifact failed verification'
)
assert(
  speakerArtifacts.every((result) => result.artifact.provenance === 'project-trained'),
  'RemindSpeak provenance must be project-trained'
)

const speaker = await RemindSpeakPlanner.load(modelRoot)
assert(speaker.info.parameterCount >= 25_000_000, 'RemindSpeak is below the Phase 6 parameter band')
assert(speaker.info.parameterCount <= 35_000_000, 'RemindSpeak exceeds the Phase 6 parameter band')
assert(speaker.info.modelBytes < 512 * 1024, 'Compressed RemindSpeak install exceeds 512 KiB')
assert(speaker.info.workingSetBytes < 32 * 1024 * 1024, 'RemindSpeak working set exceeds 32 MiB')
assert(speaker.info.teacherUsed === true, 'Runtime omits teacher preference use')
assert(speaker.info.networkRequired === false, 'Runtime reports a network requirement')

const preferenceProbe: RemindSpeakRequest = {
  requestId: 'request:phase6-preference-probe',
  speechAct: 'conversation-answer',
  facts: [
    {
      key: 'DETAIL',
      kind: 'text',
      placeholder: '<DETAIL>',
      value: 'I can help with your local calendar'
    }
  ],
  style: {
    warmth: 0.86,
    brevity: 0.58,
    formality: 0.12,
    humor: 0.16,
    emoji: 0,
    contractions: true,
    proactivity: 0.56
  },
  recentReplies: []
}
const preferenceBaseline = speaker.generateTemplates(preferenceProbe)
const preferredTemplate = preferenceBaseline.at(-1)
assert(preferredTemplate, 'The preference probe did not generate a candidate')
const preferenceReranked = speaker.generateTemplates({
  ...preferenceProbe,
  templatePreferences: [
    {
      templateFingerprint: remindSpeakTemplateFingerprint(preferredTemplate),
      score: 3
    }
  ]
})
assert(
  preferenceReranked[0] === preferredTemplate,
  'Bounded local feedback did not affect phrase ranking'
)

let validCandidates = 0
let totalCandidates = 0
let factRetained = 0
let unsafeStaticCandidates = 0
let exactReferenceTop = 0
let referenceInTopFive = 0
let repeatedTopReplies = 0
const latencies: number[] = []
const started = performance.now()

for (const [index, row] of rows.entries()) {
  const facts = valuesFor(row, index)
  const request: RemindSpeakRequest = {
    requestId: row.id,
    speechAct: row.speechAct,
    facts,
    style: row.style,
    recentReplies: []
  }
  const generated = speaker.generate(request)
  latencies.push(generated.latencyMs)
  assert(generated.templates.length === 5, `${row.id} did not produce five candidates`)
  if (generated.templates[0] === row.reference) exactReferenceTop += 1
  if (generated.templates.includes(row.reference)) referenceInTopFive += 1
  for (const template of generated.templates) {
    totalCandidates += 1
    const placeholders = template.match(/<[A-Z][A-Z0-9_]*>/gu) ?? []
    const expected = facts.map((fact) => fact.placeholder).sort()
    const actual = [...placeholders].sort()
    const valid =
      JSON.stringify(actual) === JSON.stringify(expected) &&
      new Set(placeholders).size === placeholders.length
    validCandidates += Number(valid)
    const rendered = render(template, facts)
    factRetained += Number(facts.every((fact) => rendered.includes(fact.value)))
    unsafeStaticCandidates += Number(
      /\d/u.test(staticText(template)) ||
        /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|june|july|august|september|october|november|december)\b/iu.test(
          staticText(template)
        )
    )
  }
  if (index < 100) {
    const first = render(generated.templates[0] ?? '', facts)
    const repeated = speaker.generate({ ...request, recentReplies: [first] })
    const second = render(repeated.templates[0] ?? '', facts)
    repeatedTopReplies += Number(first === second)
  }
}

const hostileGenerator = {
  generateTemplates: (): readonly string[] => [
    'Invented Monday at 9:00 AM with <SUMMARY>.',
    'I omitted the protected value.'
  ]
}
const guardedFallback = createGroundedReply({
  requestId: 'request:hostile-generator',
  speechAct: 'schedule-summary',
  facts: [{ key: 'SUMMARY', kind: 'text', value: 'one verified event' }],
  templates: ['Your calendar has <SUMMARY>.'],
  templateGenerator: hostileGenerator
})
assert(guardedFallback.source === 'template', 'Unsafe generated candidates bypassed fallback')
assert(
  guardedFallback.text === 'Your calendar has one verified event.',
  'Fallback response was not preserved exactly'
)

const elapsedMs = performance.now() - started
const metrics = {
  fixtureExamples: rows.length,
  candidateSchemaValidity: validCandidates / Math.max(1, totalCandidates),
  protectedFactRetention: factRetained / Math.max(1, totalCandidates),
  unsafeStaticLiteralRate: unsafeStaticCandidates / Math.max(1, totalCandidates),
  exactReferenceTopRate: exactReferenceTop / Math.max(1, rows.length),
  referenceInTopFiveRate: referenceInTopFive / Math.max(1, rows.length),
  recentExactRepeatRate: repeatedTopReplies / 100,
  latencyMs: {
    median: percentile(latencies, 0.5),
    p95: percentile(latencies, 0.95)
  },
  totalEvaluationMs: elapsedMs
}

assert(metrics.candidateSchemaValidity === 1, 'Candidate schema validity must remain 100%')
assert(metrics.protectedFactRetention === 1, 'Every accepted candidate must retain all facts')
assert(metrics.unsafeStaticLiteralRate === 0, 'Static candidate text introduced a date or number')
assert(metrics.recentExactRepeatRate === 0, 'A recent exact reply was repeated')
assert(metrics.referenceInTopFiveRate >= 0.35, 'Reference top-five coverage fell below 35%')
assert(metrics.latencyMs.p95 <= 50, 'Warm RemindSpeak p95 exceeds 50 ms')

await writeFile(
  runtimeReportPath,
  `${JSON.stringify(
    {
      schemaVersion: 1,
      model: speaker.info,
      metrics,
      assertions: {
        teacherUsed: speaker.info.teacherUsed,
        pretrainedWeightsUsed: false,
        networkRequired: false,
        exactPlaceholderSetRequired: true,
        deterministicFallbackVerified: true,
        protectedSpeechActCount: coveredSpeechActs.size,
        projectAuthoredSurfaceAtoms: artifact.training.projectAuthoredSurfaceAtoms,
        localPreferenceBiasBounded: artifact.safety.localPreferenceBiasBounded === true,
        humanPreferenceStudyStatus: humanStudyReport.status,
        humanPreferenceGatePassed: humanStudyReport.gatePassed
      }
    },
    null,
    2
  )}\n`,
  'utf8'
)

console.log(
  `RemindSpeak: ${(metrics.candidateSchemaValidity * 100).toFixed(1)}% valid, ` +
    `${(metrics.protectedFactRetention * 100).toFixed(1)}% fact retention, ` +
    `${(metrics.referenceInTopFiveRate * 100).toFixed(1)}% reference top-five, ` +
    `${(metrics.recentExactRepeatRate * 100).toFixed(1)}% recent repeats, ` +
    `warm p95 ${metrics.latencyMs.p95.toFixed(1)}ms.`
)
