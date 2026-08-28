import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { z } from 'zod'

const workspace = process.cwd()
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u)
const tierSchema = z
  .object({
    fullRequestP95Ms: z.number().int().positive().max(300_000),
    warmPlanP95Ms: z.number().int().positive().max(300_000),
    warmChatP95Ms: z.number().int().positive().max(300_000),
    firstTokenP95Ms: z.number().int().positive().max(300_000),
    peakWorkerRssMiB: z.number().int().positive().max(32_768)
  })
  .strict()
const gatesSchema = z
  .object({
    schemaVersion: z.literal(1),
    tiers: z.object({ compact: tierSchema, balanced: tierSchema, performance: tierSchema }).strict()
  })
  .strict()
const reportSchema = z
  .object({
    schemaVersion: z.literal(1),
    measuredAt: z.string().datetime(),
    suite: z
      .object({
        version: z.string().min(1),
        sha256: digestSchema,
        cases: z.number().int().positive(),
        trainingExcluded: z.literal(true),
        syntheticPromptsOnly: z.literal(true)
      })
      .strict(),
    model: z
      .object({
        id: z.literal('qwen3-1.7b-q4'),
        quantization: z.literal('Q4_K_M'),
        bytes: z.literal(1_282_439_264),
        sha256: digestSchema,
        realModelVerified: z.literal(true),
        mocked: z.literal(false)
      })
      .strict(),
    hardware: z
      .object({
        platform: z.enum(['win32', 'linux', 'darwin']),
        arch: z.string().min(1),
        logicalThreads: z.number().int().positive(),
        totalMemoryMiB: z.number().int().positive(),
        freeMemoryMiB: z.number().int().nonnegative()
      })
      .strict(),
    artifacts: z.record(
      z.string(),
      z.object({ path: z.string().min(1), sha256: digestSchema }).strict()
    ),
    runtimeProfile: z
      .object({
        id: z.enum(['compact', 'balanced', 'performance']),
        backend: z.enum(['cpu', 'metal', 'cuda', 'vulkan'])
      })
      .passthrough(),
    metrics: z
      .object({
        passRate: z.number().min(0).max(1),
        latencyMs: z
          .object({
            median: z.number().nonnegative(),
            p95: z.number().nonnegative(),
            max: z.number().nonnegative()
          })
          .strict(),
        warmLatencyMs: z
          .object({
            planP95: z.number().nonnegative(),
            chatP95: z.number().nonnegative(),
            firstTokenP95: z.number().nonnegative()
          })
          .strict(),
        memoryMiB: z.object({ peakWorkerRss: z.number().positive() }).strict(),
        benignResolutionRate: z.number().min(0).max(1),
        groundingRate: z.number().min(0).max(1),
        falseWriteClaims: z.number().int().nonnegative(),
        truncatedInputs: z.number().int().nonnegative()
      })
      .passthrough(),
    cases: z.array(z.unknown()).min(1),
    privacy: z.string().min(1)
  })
  .strict()

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

const qualityRoot = resolve(workspace, 'evals/flex-model/phase0-quality')
const manifest = JSON.parse(await readFile(resolve(qualityRoot, 'manifest.json'), 'utf8')) as {
  sha256: string
  cases: number
  modelSha256: string
}
const caseContents = await readFile(resolve(qualityRoot, 'cases.json'), 'utf8')
assert(sha256Text(caseContents) === manifest.sha256, 'The real-Qwen quality suite hash changed')

function sha256Text(contents: string): string {
  return createHash('sha256').update(contents).digest('hex')
}

const report = reportSchema.parse(
  JSON.parse(await readFile(resolve(qualityRoot, 'real-qwen.latest.json'), 'utf8'))
)
const gates = gatesSchema.parse(
  JSON.parse(
    await readFile(resolve(workspace, 'evals/flex-model/phase7/hardware-gates.json'), 'utf8')
  )
)
assert(report.suite.sha256 === manifest.sha256, 'The real-Qwen report used a different suite')
assert(report.suite.cases === manifest.cases, 'The real-Qwen report did not run every case')
assert(report.cases.length === manifest.cases, 'The real-Qwen report has missing case results')
assert(report.model.sha256 === manifest.modelSha256, 'The real-Qwen report used another model')

const expectedArtifacts = [
  'apps/desktop/resources/workers/flex-model-worker.cjs',
  'apps/desktop/resources/workers/flex-model-prompts.cjs',
  'apps/desktop/resources/workers/flex-model-planner-schema.json',
  'apps/desktop/resources/workers/flex-model-chat-schema.json'
]
const reportedArtifactPaths = Object.values(report.artifacts).map((artifact) => artifact.path)
for (const path of expectedArtifacts) {
  assert(reportedArtifactPaths.includes(path), `The real-Qwen report did not bind ${path}`)
}
for (const artifact of Object.values(report.artifacts)) {
  const path = resolve(workspace, artifact.path)
  assert(path.startsWith(`${workspace}${sep}`), 'A measured artifact escaped the workspace')
  assert((await sha256(path)) === artifact.sha256, `Measured artifact changed: ${artifact.path}`)
}

const budget = gates.tiers[report.runtimeProfile.id]
const failures = [
  report.metrics.benignResolutionRate >= 0.99
    ? null
    : 'benign installed-fallback resolution is below 99%',
  report.metrics.groundingRate === 1 ? null : 'real-Qwen grounding is below 100%',
  report.metrics.falseWriteClaims === 0 ? null : 'a real-Qwen chat output claimed a write',
  report.metrics.truncatedInputs === 0 ? null : 'a frozen real-Qwen input was truncated',
  report.metrics.latencyMs.p95 <= budget.fullRequestP95Ms
    ? null
    : 'full-request p95 exceeds the selected hardware-tier budget',
  report.metrics.warmLatencyMs.planP95 <= budget.warmPlanP95Ms
    ? null
    : 'warm planner p95 exceeds the selected hardware-tier budget',
  report.metrics.warmLatencyMs.chatP95 <= budget.warmChatP95Ms
    ? null
    : 'warm chat p95 exceeds the selected hardware-tier budget',
  report.metrics.warmLatencyMs.firstTokenP95 <= budget.firstTokenP95Ms
    ? null
    : 'first-token p95 exceeds the selected hardware-tier budget',
  report.metrics.memoryMiB.peakWorkerRss <= budget.peakWorkerRssMiB
    ? null
    : 'worker memory exceeds the selected hardware-tier budget'
].filter((failure): failure is string => failure !== null)
if (failures.length > 0)
  throw new Error(`Phase 7 optional-model gate failed:\n- ${failures.join('\n- ')}`)

console.log(
  JSON.stringify(
    {
      phase: 7,
      status: 'passed',
      measuredHardware: report.hardware,
      runtimeTier: report.runtimeProfile.id,
      backend: report.runtimeProfile.backend,
      benignResolutionRate: report.metrics.benignResolutionRate,
      groundingRate: report.metrics.groundingRate,
      qualityPassRateReportedSeparately: report.metrics.passRate,
      latencyMs: report.metrics.latencyMs,
      warmLatencyMs: report.metrics.warmLatencyMs,
      peakWorkerRssMiB: report.metrics.memoryMiB.peakWorkerRss,
      budgets: budget,
      independentHumanBlindEvidence: 'pending'
    },
    null,
    2
  )
)
