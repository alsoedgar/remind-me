import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import pruneNodeLlamaBinaries, { packagesToKeep } from '../../scripts/prune-node-llama-binaries.mjs'

describe('optional local-model acceleration packages', () => {
  it('keeps the portable CPU runtime in every Windows variant', () => {
    expect(packagesToKeep('win32', 'x64', 'portable')).toEqual(['win-x64'])
    expect(packagesToKeep('win32', 'x64', 'vulkan')).toEqual(['win-x64', 'win-x64-vulkan'])
    expect(packagesToKeep('win32', 'x64', 'cuda')).toEqual([
      'win-x64',
      'win-x64-cuda',
      'win-x64-cuda-ext'
    ])
  })

  it('retains Metal for Apple silicon without accepting impossible variants', () => {
    expect(packagesToKeep('darwin', 'arm64', 'metal')).toEqual(['mac-arm64-metal'])
    expect(() => packagesToKeep('darwin', 'arm64', 'cuda')).toThrow(/not configured/iu)
  })

  it('prunes the nested macOS app bundle staging tree', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'remind-me-mac-prune-'))
    const nativeRoot = resolve(
      root,
      'Remind Me.app',
      'Contents',
      'Resources',
      'app',
      'node_modules',
      '@node-llama-cpp'
    )
    try {
      await mkdir(resolve(nativeRoot, 'mac-x64'), { recursive: true })
      await mkdir(resolve(nativeRoot, 'mac-arm64-metal'), { recursive: true })

      await pruneNodeLlamaBinaries({
        appOutDir: root,
        electronPlatformName: 'darwin',
        arch: 3
      })

      await expect(readdir(nativeRoot)).resolves.toEqual(['mac-arm64-metal'])
      await expect(
        readFile(
          resolve(root, 'Remind Me.app', 'Contents', 'Resources', 'llama-backends.json'),
          'utf8'
        )
      ).resolves.toContain('"variant": "metal"')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
