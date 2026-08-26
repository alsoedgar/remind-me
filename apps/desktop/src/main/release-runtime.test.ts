import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { loadAndAttestLocalRelease } from './release-runtime'

const modelRoot = fileURLToPath(new URL('../../../../models/', import.meta.url))
const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

describe('first-launch local release attestation', () => {
  it('verifies required assets, golden predictions, budgets, and cached CPU providers', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'remind-me-release-'))
    temporaryDirectories.push(directory)
    const providerCachePath = join(directory, 'provider-cache.json')

    const first = await loadAndAttestLocalRelease({ modelRoot, providerCachePath })
    expect(first.release).toMatchObject({
      status: 'verified',
      goldenProbes: { planner: true, speaker: true, document: true },
      providers: { cpuFallback: true, cacheHit: false },
      error: null
    })
    expect(first.release.customModelBytes).toBeLessThan(first.release.customModelBudgetBytes)
    expect(first.plannerInfo.available).toBe(true)
    expect(first.speakerInfo.available).toBe(true)
    expect(first.planScanInfo.available).toBe(true)

    const second = await loadAndAttestLocalRelease({ modelRoot, providerCachePath })
    expect(second.release.status).toBe('verified')
    expect(second.release.providers.cacheHit).toBe(true)
  }, 30_000)

  it('degrades to deterministic fallbacks instead of failing startup', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'remind-me-release-missing-'))
    temporaryDirectories.push(directory)
    const result = await loadAndAttestLocalRelease({
      modelRoot: directory,
      providerCachePath: null
    })

    expect(result.release.status).toBe('degraded')
    expect(result.release.error).not.toBeNull()
    expect(result.planner).toBeNull()
    expect(result.speaker).toBeNull()
    expect(result.plannerInfo.available).toBe(false)
    expect(result.planScanInfo.available).toBe(false)
  })
})
