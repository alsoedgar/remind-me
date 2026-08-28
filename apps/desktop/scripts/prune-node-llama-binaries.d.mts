export function packagesToKeep(
  platform: NodeJS.Platform,
  arch: string,
  acceleration?: 'portable' | 'metal' | 'vulkan' | 'cuda'
): string[]

export default function pruneNodeLlamaBinaries(context: {
  appOutDir: string
  arch: number
  electronPlatformName: NodeJS.Platform
}): Promise<void>
