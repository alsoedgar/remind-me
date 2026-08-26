import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  loadModelManifest,
  releaseProbeSuiteSchema,
  verifyModelManifest
} from '@remind-me/model-runtime'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

interface ModelConfiguration {
  architecture: { parameterCount: number; quantization: string }
  weights?: { uncompressedBytes: number }
  thresholds?: {
    destructiveAlwaysConfirmationOnly?: boolean
    seriesAlwaysConfirmationOnly?: boolean
  }
  metrics: {
    quantization?: { accuracyReduction: number }
    quantizationAccuracyReduction?: number
    maximumQuantizationDelta?: number
  }
}

const workspace = process.cwd()
const modelRoot = resolve(workspace, 'models')
const manifest = await loadModelManifest(modelRoot)
const verification = await verifyModelManifest(modelRoot, manifest)
assert(verification.valid, 'Required release model artifacts are invalid')
assert(
  verification.artifacts.every((result) => result.valid),
  'Phase 8 requires optional ONNX parity artifacts to be present and valid'
)
assert(manifest.runtime.requiresNetwork === false, 'The primary runtime cannot require a network')
assert(manifest.runtime.cpuFallback === true, 'The primary runtime must retain CPU fallback')
assert(
  Object.values({
    planner: manifest.runtime.planner,
    speaker: manifest.runtime.speaker,
    document: manifest.runtime.document
  }).every((runtime) => runtime.requiresNetwork === false && runtime.cpuFallback === true),
  'Every custom runtime must be offline with CPU fallback'
)

async function readConfiguration(path: string): Promise<ModelConfiguration> {
  return JSON.parse(await readFile(resolve(modelRoot, path), 'utf8')) as ModelConfiguration
}

const [planner, speaker, document]: [ModelConfiguration, ModelConfiguration, ModelConfiguration] =
  await Promise.all([
    readConfiguration('remindcore/remindcore-v0.1-int8.json'),
    readConfiguration('remindspeak/remindspeak-v0.1-int8.json'),
    readConfiguration('planscan/planscan-v0.1-int8.json')
  ])
const accuracyReductions = [
  planner.metrics.quantization?.accuracyReduction ?? Number.POSITIVE_INFINITY,
  speaker.metrics.quantizationAccuracyReduction ?? Number.POSITIVE_INFINITY,
  document.metrics.maximumQuantizationDelta ?? Number.POSITIVE_INFINITY
]
assert(
  accuracyReductions.every((reduction) => reduction <= 0.005),
  `A quantized model exceeds the 0.5-point accuracy budget: ${accuracyReductions.join(', ')}`
)
assert(
  planner.thresholds?.destructiveAlwaysConfirmationOnly === true &&
    planner.thresholds.seriesAlwaysConfirmationOnly === true,
  'Quantization cannot relax destructive or series confirmation policy'
)

const customArtifacts = manifest.artifacts.filter(
  (artifact) => artifact.provenance === 'project-trained' && artifact.role !== 'release-validation'
)
const customInstalledBytes = customArtifacts.reduce(
  (total, artifact) => total + artifact.byteLength,
  0
)
const customWorkingSetBytes =
  planner.architecture.parameterCount +
  (speaker.weights?.uncompressedBytes ?? speaker.architecture.parameterCount) +
  (document.weights?.uncompressedBytes ?? document.architecture.parameterCount)
assert(customInstalledBytes < 100 * 1024 * 1024, 'Custom model artifacts exceed 100 MiB')
assert(customWorkingSetBytes < 100 * 1024 * 1024, 'Custom model working tables exceed 100 MiB')

const onnxArtifacts = manifest.artifacts.filter(
  (artifact) =>
    artifact.format === 'onnx' && ['planner', 'speaker', 'document-layout'].includes(artifact.role)
)
assert(onnxArtifacts.length === 3, 'All three original models require ONNX parity exports')
const probeArtifact = manifest.artifacts.find((artifact) => artifact.role === 'release-validation')
assert(probeArtifact?.component === 'golden-fixture', 'Release probe artifact is missing')
const probes = releaseProbeSuiteSchema.parse(
  JSON.parse(await readFile(resolve(modelRoot, probeArtifact.path), 'utf8'))
)
assert(probes.planner.length >= 3, 'At least three planner release probes are required')
assert(probes.document.expectedGroupTitles.length >= 2, 'Document probe must exercise grouping')

console.log(
  `Phase 8 release: ${verification.artifacts.length} artifacts, ` +
    `${(customInstalledBytes / 1024 / 1024).toFixed(1)} MiB custom installed, ` +
    `${(customWorkingSetBytes / 1024 / 1024).toFixed(1)} MiB bounded working tables, ` +
    `quantization reductions ${accuracyReductions.map((value) => value * 100).join('/')} points.`
)
