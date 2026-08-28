import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'

const planScanInfoArtifactSchema = z
  .object({
    id: z.string().min(1),
    version: z.string().min(1),
    architecture: z
      .object({
        name: z.string().min(1),
        parameterCount: z.number().int().positive(),
        parameterInitialization: z.literal('zero'),
        quantization: z.string().min(1)
      })
      .passthrough(),
    weights: z
      .object({
        path: z.string().min(1),
        compression: z.literal('gzip'),
        uncompressedBytes: z.number().int().positive()
      })
      .passthrough(),
    training: z
      .object({
        seed: z.number().int().nonnegative(),
        datasetManifestSha256: z.string().regex(/^[a-f0-9]{64}$/u),
        challengeSlices: z
          .array(
            z.enum([
              'baseline',
              'ocr-corruption',
              'neighboring-row-negatives',
              'repeated-titles',
              'unfamiliar-column-order',
              'header-footer-distractions'
            ])
          )
          .length(6),
        hardNeighborNegativeMining: z.literal(true),
        teacherUsed: z.literal(false),
        pretrainedWeightsUsed: z.literal(false),
        personalDataUsed: z.literal(false)
      })
      .strict(),
    safety: z
      .object({
        exactSourceProjectionRequired: z.literal(true),
        crossPageLinksAllowed: z.literal(false),
        deterministicSemanticCompilerRequired: z.literal(true),
        explicitConfirmationRequired: z.literal(true),
        repairFallbackCandidateSelectionOnly: z.literal(true),
        repairFallbackHasMutationAuthority: z.literal(false)
      })
      .strict()
  })
  .passthrough()

export interface PlanScanInfo {
  available: boolean
  id: string
  version: string
  architecture: string
  parameterCount: number
  quantization: string
  modelBytes: number
  workingSetBytes: number
  mode: 'evidence-gated-spatial-graph'
  teacherUsed: false
  networkRequired: false
  error: string | null
}

export async function loadPlanScanInfo(modelRoot: string): Promise<PlanScanInfo> {
  const configurationPath = resolve(modelRoot, 'planscan', 'planscan-v0.1-int8.json')
  const artifact = planScanInfoArtifactSchema.parse(
    JSON.parse(await readFile(configurationPath, 'utf8'))
  )
  const weightsPath = resolve(modelRoot, 'planscan', artifact.weights.path)
  const weights = await stat(weightsPath)
  if (!weights.isFile()) throw new Error('PlanScan weights are not a regular file')
  return {
    available: true,
    id: artifact.id,
    version: artifact.version,
    architecture: artifact.architecture.name,
    parameterCount: artifact.architecture.parameterCount,
    quantization: artifact.architecture.quantization,
    modelBytes: weights.size + (await stat(configurationPath)).size,
    workingSetBytes: artifact.weights.uncompressedBytes,
    mode: 'evidence-gated-spatial-graph',
    teacherUsed: false,
    networkRequired: false,
    error: null
  }
}

export function unavailablePlanScanInfo(error: unknown): PlanScanInfo {
  return {
    available: false,
    id: 'planscan-unavailable',
    version: '0.0.0',
    architecture: 'rules fallback',
    parameterCount: 0,
    quantization: 'none',
    modelBytes: 0,
    workingSetBytes: 0,
    mode: 'evidence-gated-spatial-graph',
    teacherUsed: false,
    networkRequired: false,
    error: error instanceof Error ? error.message : 'The bundled PlanScan model could not load.'
  }
}
