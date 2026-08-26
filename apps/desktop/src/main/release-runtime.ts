import { createHash } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { resolve } from 'node:path'
import type { AppInfo } from '@remind-me/contracts'
import { PlanScanRuntime } from '@remind-me/importers/document'
import {
  loadModelManifest,
  loadPlanScanInfo,
  releaseProbeSuiteSchema,
  RemindCorePlanner,
  RemindSpeakPlanner,
  unavailablePlanScanInfo,
  unavailableRemindCoreInfo,
  unavailableRemindSpeakInfo,
  verifyModelManifest,
  type ModelArtifact,
  type PlanScanInfo,
  type RemindCoreInfo,
  type RemindSpeakInfo,
  type RemindSpeakRequest
} from '@remind-me/model-runtime'

const customModelBudgetBytes = 100 * 1024 * 1024
const emptyDigest = '0'.repeat(64)

interface ProviderCache {
  schemaVersion: 1
  manifestSha256: string
  providers: AppInfo['release']['providers']
}

export interface LoadedLocalRelease {
  planner: RemindCorePlanner | null
  plannerInfo: RemindCoreInfo
  speaker: RemindSpeakPlanner | null
  speakerInfo: RemindSpeakInfo
  planScanInfo: PlanScanInfo
  release: AppInfo['release']
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown release verification error'
}

function hasValidRequiredRole(
  role: ModelArtifact['role'],
  artifacts: Awaited<ReturnType<typeof verifyModelManifest>>['artifacts']
): boolean {
  const required = artifacts.filter(
    (result) => result.artifact.role === role && result.artifact.required
  )
  return required.length > 0 && required.every((result) => result.valid)
}

function exactPlaceholderSet(template: string, placeholders: readonly string[]): boolean {
  const found: string[] = template.match(/<[A-Z][A-Z0-9_]*>/gu) ?? []
  return (
    found.length === placeholders.length &&
    new Set(found).size === found.length &&
    placeholders.every((placeholder) => found.includes(placeholder))
  )
}

async function loadProviderCache(
  cachePath: string | null,
  manifestSha256: string
): Promise<ProviderCache | null> {
  if (!cachePath) return null
  try {
    const value = JSON.parse(await readFile(cachePath, 'utf8')) as ProviderCache
    if (
      value.schemaVersion === 1 &&
      value.manifestSha256 === manifestSha256 &&
      value.providers.cpuFallback === true
    ) {
      return value
    }
  } catch {
    // A missing or malformed cache simply triggers a fresh bounded benchmark.
  }
  return null
}

async function saveProviderCache(cachePath: string | null, value: ProviderCache): Promise<void> {
  if (!cachePath) return
  const temporaryPath = `${cachePath}.tmp-${process.pid}`
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await rename(temporaryPath, cachePath)
  } catch {
    // Provider caching is an optimization; failure never blocks the offline CPU path.
  }
}

export async function loadAndAttestLocalRelease(options: {
  modelRoot: string
  providerCachePath: string | null
}): Promise<LoadedLocalRelease> {
  const startedAt = performance.now()
  let manifestSha256 = emptyDigest
  let planner: RemindCorePlanner | null = null
  let plannerInfo = unavailableRemindCoreInfo('Rules-only mode')
  let speaker: RemindSpeakPlanner | null = null
  let speakerInfo = unavailableRemindSpeakInfo('Template response mode')
  let planScanInfo = unavailablePlanScanInfo('Deterministic document rules are active')
  let requiredArtifactCount = 0
  let verifiedArtifactCount = 0
  let installedModelBytes = 0
  let customModelBytes = 0
  let customWorkingSetBytes = 0
  let cacheHit = false
  let benchmarkDurationMs = 0
  const goldenProbes = { planner: false, speaker: false, document: false }
  const errors: string[] = []

  try {
    const manifestPath = resolve(options.modelRoot, 'manifest.json')
    const manifestBytes = await readFile(manifestPath)
    manifestSha256 = createHash('sha256').update(manifestBytes).digest('hex')
    const manifest = await loadModelManifest(options.modelRoot)
    const verification = await verifyModelManifest(options.modelRoot, manifest)
    requiredArtifactCount = manifest.artifacts.filter((artifact) => artifact.required).length
    verifiedArtifactCount = verification.artifacts.filter((result) => result.valid).length
    installedModelBytes = verification.totalBytes
    customModelBytes = manifest.artifacts
      .filter(
        (artifact) =>
          artifact.provenance === 'project-trained' && artifact.role !== 'release-validation'
      )
      .reduce((total, artifact) => total + artifact.byteLength, 0)
    for (const result of verification.artifacts) {
      if (!result.valid && result.artifact.required) {
        errors.push(`${result.artifact.id}: ${result.error ?? 'invalid'}`)
      }
    }

    if (hasValidRequiredRole('planner', verification.artifacts)) {
      try {
        planner = await RemindCorePlanner.load(options.modelRoot)
        plannerInfo = planner.info
      } catch (error) {
        plannerInfo = unavailableRemindCoreInfo(error)
        errors.push(`RemindCore: ${message(error)}`)
      }
    } else {
      plannerInfo = unavailableRemindCoreInfo('RemindCore failed release integrity validation')
    }
    if (hasValidRequiredRole('speaker', verification.artifacts)) {
      try {
        speaker = await RemindSpeakPlanner.load(options.modelRoot)
        speakerInfo = speaker.info
      } catch (error) {
        speakerInfo = unavailableRemindSpeakInfo(error)
        errors.push(`RemindSpeak: ${message(error)}`)
      }
    } else {
      speakerInfo = unavailableRemindSpeakInfo('RemindSpeak failed release integrity validation')
    }
    if (hasValidRequiredRole('document-layout', verification.artifacts)) {
      try {
        planScanInfo = await loadPlanScanInfo(options.modelRoot)
      } catch (error) {
        planScanInfo = unavailablePlanScanInfo(error)
        errors.push(`PlanScan: ${message(error)}`)
      }
    } else {
      planScanInfo = unavailablePlanScanInfo('PlanScan failed release integrity validation')
    }

    customWorkingSetBytes =
      plannerInfo.parameterCount + speakerInfo.workingSetBytes + planScanInfo.workingSetBytes
    const probeIsValid = hasValidRequiredRole('release-validation', verification.artifacts)
    if (probeIsValid) {
      const suite = releaseProbeSuiteSchema.parse(
        JSON.parse(await readFile(resolve(options.modelRoot, 'release-probes.v0.1.json'), 'utf8'))
      )
      const benchmarkStarted = performance.now()
      if (planner) {
        goldenProbes.planner = suite.planner.every((probe) => {
          const prediction = planner?.predict(probe.text)
          return (
            prediction?.operation === probe.expectedOperation &&
            prediction.eligibleForAssistance === probe.expectedEligibleForAssistance
          )
        })
      }
      if (speaker) {
        const request = suite.speaker as RemindSpeakRequest
        const generation = speaker.generate(request)
        const placeholders = request.facts.map((fact) => fact.placeholder)
        goldenProbes.speaker =
          generation.templates.length === suite.speaker.expectedCandidateCount &&
          generation.templates.every((template) => exactPlaceholderSet(template, placeholders))
      }
      if (planScanInfo.available) {
        try {
          const [configuration, compressedWeights] = await Promise.all([
            readFile(resolve(options.modelRoot, 'planscan/planscan-v0.1-int8.json'), 'utf8'),
            readFile(resolve(options.modelRoot, 'planscan/planscan-v0.1-int8.bin.gz'))
          ])
          const runtime = await PlanScanRuntime.create(
            JSON.parse(configuration),
            new Uint8Array(compressedWeights)
          )
          const analysis = runtime.analyze([suite.document.page])
          const spans = new Map(analysis.spans.map((span) => [span.id, span.text]))
          const titles = new Set(
            analysis.groups.map((group) => spans.get(group.titleSpanId)).filter(Boolean)
          )
          goldenProbes.document =
            analysis.documentType === suite.document.expectedDocumentType &&
            suite.document.expectedGroupTitles.every((title) => titles.has(title))
        } catch (error) {
          errors.push(`PlanScan probe: ${message(error)}`)
        }
      }
      benchmarkDurationMs = performance.now() - benchmarkStarted
    } else {
      errors.push('The packaged release probe suite failed integrity validation')
    }

    if (!goldenProbes.planner && planner) {
      planner = null
      plannerInfo = unavailableRemindCoreInfo('The first-launch RemindCore probe did not match')
      errors.push('RemindCore golden prediction mismatch')
    }
    if (!goldenProbes.speaker && speaker) {
      speaker = null
      speakerInfo = unavailableRemindSpeakInfo('The first-launch RemindSpeak probe did not match')
      errors.push('RemindSpeak golden prediction mismatch')
    }
    if (!goldenProbes.document && planScanInfo.available) {
      planScanInfo = unavailablePlanScanInfo('The first-launch PlanScan probe did not match')
      errors.push('PlanScan golden prediction mismatch')
    }

    const cached = await loadProviderCache(options.providerCachePath, manifestSha256)
    cacheHit = cached !== null
    const providers: AppInfo['release']['providers'] = cached?.providers ?? {
      planner: 'typescript-int8-cpu',
      speaker: 'typescript-int8-cpu',
      document: 'typescript-int8-cpu',
      speech: 'sherpa-onnx-wasm-cpu',
      cpuFallback: true,
      cacheHit: false,
      benchmarkDurationMs
    }
    await saveProviderCache(options.providerCachePath, {
      schemaVersion: 1,
      manifestSha256,
      providers: { ...providers, cacheHit: false, benchmarkDurationMs }
    })
  } catch (error) {
    errors.push(message(error))
  }

  if (customModelBytes > customModelBudgetBytes) {
    errors.push(
      `Project-trained model artifacts exceed the ${customModelBudgetBytes}-byte release budget`
    )
  }
  const probePass = Object.values(goldenProbes).every(Boolean)
  const status: AppInfo['release']['status'] =
    errors.length === 0 && probePass ? 'verified' : 'degraded'
  return {
    planner,
    plannerInfo,
    speaker,
    speakerInfo,
    planScanInfo,
    release: {
      status,
      manifestSha256,
      verifiedAt: new Date().toISOString(),
      verificationDurationMs: performance.now() - startedAt,
      requiredArtifactCount,
      verifiedArtifactCount,
      installedModelBytes,
      customModelBytes,
      customWorkingSetBytes,
      customModelBudgetBytes,
      goldenProbes,
      providers: {
        planner: 'typescript-int8-cpu',
        speaker: 'typescript-int8-cpu',
        document: 'typescript-int8-cpu',
        speech: 'sherpa-onnx-wasm-cpu',
        cpuFallback: true,
        cacheHit,
        benchmarkDurationMs: cacheHit ? 0 : benchmarkDurationMs
      },
      error: errors.length > 0 ? errors.join('; ') : null
    }
  }
}
