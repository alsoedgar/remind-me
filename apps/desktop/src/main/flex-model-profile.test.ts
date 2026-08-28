import { describe, expect, it } from 'vitest'
import { selectFlexModelRuntimeProfile } from './flex-model-profile'

const GiB = 1_024 * 1_024 * 1_024

describe('optional flex-model hardware profiles', () => {
  it('protects constrained computers with one compact sequence and prompt headroom', () => {
    expect(
      selectFlexModelRuntimeProfile({
        platform: 'win32',
        arch: 'x64',
        logicalThreads: 4,
        totalMemoryBytes: 8 * GiB,
        freeMemoryBytes: 2 * GiB
      })
    ).toEqual({
      id: 'compact',
      label: 'Automatic compact',
      backend: 'cpu',
      threads: 3,
      contextSize: 4096,
      sequences: 1,
      batchSize: 256,
      maxChatTokens: 64,
      idleUnloadMs: 90_000,
      requestTimeoutMs: 120_000
    })
  })

  it('uses a balanced portable CPU profile for ordinary laptops', () => {
    const profile = selectFlexModelRuntimeProfile({
      platform: 'linux',
      arch: 'x64',
      logicalThreads: 8,
      totalMemoryBytes: 16 * GiB,
      freeMemoryBytes: 5 * GiB
    })

    expect(profile).toMatchObject({
      id: 'balanced',
      backend: 'cpu',
      threads: 6,
      contextSize: 4096,
      sequences: 1,
      batchSize: 512,
      maxChatTokens: 80
    })
  })

  it('spends the former 8K KV budget on independent planner and chat caches', () => {
    const profile = selectFlexModelRuntimeProfile({
      platform: 'win32',
      arch: 'x64',
      logicalThreads: 24,
      totalMemoryBytes: 32 * GiB,
      freeMemoryBytes: 8 * GiB
    })

    expect(profile).toMatchObject({
      id: 'performance',
      backend: 'cpu',
      threads: 16,
      contextSize: 4096,
      sequences: 2,
      batchSize: 512,
      maxChatTokens: 96,
      requestTimeoutMs: 90_000
    })
    expect(profile.contextSize * profile.sequences).toBe(8192)
  })

  it('selects the packaged Metal path only for Apple silicon', () => {
    const profile = selectFlexModelRuntimeProfile({
      platform: 'darwin',
      arch: 'arm64',
      logicalThreads: 12,
      totalMemoryBytes: 32 * GiB,
      freeMemoryBytes: 8 * GiB
    })

    expect(profile).toMatchObject({
      id: 'performance',
      backend: 'metal',
      threads: 8,
      sequences: 2,
      maxChatTokens: 128
    })
  })

  it('backs down under live memory pressure even on a large-memory machine', () => {
    expect(
      selectFlexModelRuntimeProfile({
        platform: 'win32',
        arch: 'x64',
        logicalThreads: 24,
        totalMemoryBytes: 32 * GiB,
        freeMemoryBytes: 2.5 * GiB
      }).id
    ).toBe('compact')
  })

  it('prefers a packaged CUDA or Vulkan backend while retaining a CPU override', () => {
    const hardware = {
      platform: 'win32' as const,
      arch: 'x64',
      logicalThreads: 16,
      totalMemoryBytes: 32 * GiB,
      freeMemoryBytes: 8 * GiB
    }
    expect(
      selectFlexModelRuntimeProfile({
        ...hardware,
        availableBackends: ['cpu', 'vulkan']
      }).backend
    ).toBe('vulkan')
    expect(
      selectFlexModelRuntimeProfile({
        ...hardware,
        availableBackends: ['cpu', 'vulkan', 'cuda']
      }).backend
    ).toBe('cuda')
    expect(
      selectFlexModelRuntimeProfile({
        ...hardware,
        availableBackends: ['cpu', 'vulkan', 'cuda'],
        accelerationPreference: 'cpu'
      }).backend
    ).toBe('cpu')
  })

  it('applies memory-aware warmth settings without pinning the model on small machines', () => {
    const hardware = {
      platform: 'win32' as const,
      arch: 'x64',
      logicalThreads: 8,
      totalMemoryBytes: 16 * GiB,
      freeMemoryBytes: 5 * GiB
    }
    expect(
      selectFlexModelRuntimeProfile({ ...hardware, warmthPolicy: 'memory-saver' }).idleUnloadMs
    ).toBe(30_000)
    expect(
      selectFlexModelRuntimeProfile({ ...hardware, warmthPolicy: 'keep-warm' }).idleUnloadMs
    ).toBe(60 * 60_000)
    expect(
      selectFlexModelRuntimeProfile({
        ...hardware,
        totalMemoryBytes: 8 * GiB,
        freeMemoryBytes: 2 * GiB,
        warmthPolicy: 'keep-warm'
      }).idleUnloadMs
    ).toBe(90_000)
  })
})
