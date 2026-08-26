import { arch, availableParallelism, freemem, platform, totalmem } from 'node:os'

const GIBIBYTE = 1_024 * 1_024 * 1_024

export type FlexModelRuntimeTier = 'compact' | 'balanced' | 'performance'
export type FlexModelRuntimeBackend = 'cpu' | 'metal'

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
  const backend: FlexModelRuntimeBackend =
    hardware.platform === 'darwin' && hardware.arch === 'arm64' ? 'metal' : 'cpu'
  const tier: FlexModelRuntimeTier =
    totalGiB < 12 || freeGiB < 3
      ? 'compact'
      : totalGiB >= 24 && freeGiB >= 5 && logicalThreads >= 12
        ? 'performance'
        : 'balanced'

  if (tier === 'compact') {
    return {
      id: tier,
      label: 'Automatic compact',
      backend,
      threads: threadCount(logicalThreads, backend === 'metal' ? 6 : 8),
      contextSize: 4096,
      sequences: 1,
      batchSize: 256,
      maxChatTokens: backend === 'metal' ? 80 : 64,
      idleUnloadMs: 90_000,
      requestTimeoutMs: 120_000
    }
  }

  if (tier === 'balanced') {
    return {
      id: tier,
      label: 'Automatic balanced',
      backend,
      threads: threadCount(logicalThreads, backend === 'metal' ? 8 : 12),
      contextSize: 4096,
      sequences: 1,
      batchSize: 512,
      maxChatTokens: backend === 'metal' ? 112 : 80,
      idleUnloadMs: 5 * 60_000,
      requestTimeoutMs: 120_000
    }
  }

  return {
    id: tier,
    label: 'Automatic performance',
    backend,
    threads: threadCount(logicalThreads, backend === 'metal' ? 10 : 16),
    // Two 4K sequences use the same total KV-token budget as the former
    // single 8K context while preserving independent planner and chat prefixes.
    contextSize: 4096,
    sequences: 2,
    batchSize: 512,
    maxChatTokens: backend === 'metal' ? 128 : 96,
    idleUnloadMs: 10 * 60_000,
    requestTimeoutMs: 90_000
  }
}

export function currentFlexModelRuntimeProfile(): FlexModelRuntimeProfile {
  return selectFlexModelRuntimeProfile({
    platform: platform(),
    arch: arch(),
    logicalThreads: availableParallelism(),
    totalMemoryBytes: totalmem(),
    freeMemoryBytes: freemem()
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
