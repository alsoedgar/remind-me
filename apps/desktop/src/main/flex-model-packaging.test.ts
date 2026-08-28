import { describe, expect, it } from 'vitest'
import { packagesToKeep } from '../../scripts/prune-node-llama-binaries.mjs'

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
})
