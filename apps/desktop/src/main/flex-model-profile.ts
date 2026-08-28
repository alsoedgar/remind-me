import { arch, availableParallelism, freemem, platform, totalmem } from 'node:os'
import type {
  FlexModelAccelerationPreference,
  FlexModelBackend,
  FlexModelWarmthPolicy
} from '@remind-me/contracts'

const GIBIBYTE = 1_024 * 1_024 * 1_024

export type FlexModelRuntimeTier = 'compact' | 'balanced' | 'performance'
export type FlexModelRuntimeBackend = FlexModelBackend

export interface FlexModelRuntimeProfile {
  id: FlexModelRuntimeTier
  label: string
  backend: FlexModelRuntimeBackend
  threads: number
  contextSize: number
  sequences: 1 | 2
  batchSize: 256 | 512
  maxChatTokens: number
  idleUnloadMs: number
  requestTimeoutMs: number
}

export interface FlexModelHardwareSnapshot {
  platform: NodeJS.Platform
  arch: string
  logicalThreads: number
  totalMemoryBytes: number
  freeMemoryBytes: number
  availableBackends?: readonly FlexModelBackend[]
  warmthPolicy?: FlexModelWarmthPolicy
  accelerationPreference?: FlexModelAccelerationPreference
}

function threadCount(logicalThreads: number, cap: number): number {
  const available = Math.max(1, Math.floor(logicalThreads))
  if (available <= 2) return available
  return Math.max(2, Math.min(cap, available - 1, Math.ceil(available * (2 / 3))))
}

export function selectFlexModelRuntimeProfile(
  hardware: FlexModelHardwareSnapshot
): FlexModelRuntimeProfile {
  const logicalThreads = Math.max(1, Math.floor(hardware.logicalThreads))
  const totalGiB = hardware.totalMemoryBytes / GIBIBYTE
  const freeGiB = hardware.freeMemoryBytes / GIBIBYTE
  const availableBackends = new Set<FlexModelBackend>(
    hardware.availableBackends ??
      (hardware.platform === 'darwin' && hardware.arch === 'arm64'
        ? (['cpu', 'metal'] as const)
        : (['cpu'] as const))
  )
  availableBackends.add('cpu')
  const backend: FlexModelRuntimeBackend =
    hardware.accelerationPreference === 'cpu'
      ? 'cpu'
      : availableBackends.has('metal')
        ? 'metal'
        : availableBackends.has('cuda')
          ? 'cuda'
          : availableBackends.has('vulkan')
            ? 'vulkan'
            : 'cpu'
  const accelerated = backend !== 'cpu'
  const tier: FlexModelRuntimeTier =
    totalGiB < 12 || freeGiB < 3
      ? 'compact'
      : totalGiB >= 24 && freeGiB >= 5 && logicalThreads >= 12
        ? 'performance'
        : 'balanced'

  const applyWarmthPolicy = (profile: FlexModelRuntimeProfile): FlexModelRuntimeProfile => {
    const warmthPolicy = hardware.warmthPolicy ?? 'automatic'
    if (warmthPolicy === 'memory-saver') return { ...profile, idleUnloadMs: 30_000 }
    if (warmthPolicy === 'keep-warm' && totalGiB >= 16 && freeGiB >= 4) {
      return { ...profile, idleUnloadMs: 60 * 60_000 }
    }
    return profile
  }

  if (tier === 'compact') {
    return applyWarmthPolicy({
      id: tier,
      label: 'Automatic compact',
      backend,
      threads: threadCount(logicalThreads, accelerated ? 6 : 8),
      contextSize: 4096,
      sequences: 1,
      batchSize: 256,
      maxChatTokens: accelerated ? 80 : 64,
      idleUnloadMs: 90_000,
      requestTimeoutMs: 120_000
    })
  }

  if (tier === 'balanced') {
    return applyWarmthPolicy({
      id: tier,
      label: 'Automatic balanced',
      backend,
      threads: threadCount(logicalThreads, accelerated ? 8 : 12),
      contextSize: 4096,
      sequences: 1,
      batchSize: 512,
      maxChatTokens: accelerated ? 112 : 80,
      idleUnloadMs: 5 * 60_000,
      requestTimeoutMs: 120_000
    })
  }

  return applyWarmthPolicy({
    id: tier,
    label: 'Automatic performance',
    backend,
    threads: threadCount(logicalThreads, accelerated ? 10 : 16),
    // Two 4K sequences use the same total KV-token budget as the former
    // single 8K context while preserving independent planner and chat prefixes.
    contextSize: 4096,
    sequences: 2,
    batchSize: 512,
    maxChatTokens: accelerated ? 128 : 96,
    idleUnloadMs: 10 * 60_000,
    requestTimeoutMs: 90_000
  })
}

export function currentFlexModelRuntimeProfile(options?: {
  availableBackends?: readonly FlexModelBackend[]
  warmthPolicy?: FlexModelWarmthPolicy
  accelerationPreference?: FlexModelAccelerationPreference
}): FlexModelRuntimeProfile {
  return selectFlexModelRuntimeProfile({
    platform: platform(),
    arch: arch(),
    logicalThreads: availableParallelism(),
    totalMemoryBytes: totalmem(),
    freeMemoryBytes: freemem(),
    ...options
  })
}

export function flexModelRuntimeProfileKey(profile: FlexModelRuntimeProfile): string {
  return [
    profile.id,
    profile.backend,
    profile.threads,
    profile.contextSize,
    profile.sequences,
    profile.batchSize,
    profile.maxChatTokens
  ].join(':')
}
