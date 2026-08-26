import { readdir, rm } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

const archNames = ['ia32', 'x64', 'armv7l', 'arm64', 'universal']

function packageToKeep(platform, arch) {
  if (platform === 'win32') {
    if (arch === 'x64' || arch === 'arm64') return `win-${arch}`
  }
  if (platform === 'linux') {
    if (arch === 'x64' || arch === 'arm64' || arch === 'armv7l') return `linux-${arch}`
  }
  if (platform === 'darwin') {
    if (arch === 'arm64') return 'mac-arm64-metal'
    if (arch === 'x64') return 'mac-x64'
  }
  throw new Error(`No pinned llama.cpp runtime package is configured for ${platform}/${arch}`)
}

export default async function pruneNodeLlamaBinaries(context) {
  const root = resolve(context.appOutDir)
  const nativeRoot = resolve(
    root,
    'resources',
    'app.asar.unpacked',
    'node_modules',
    '@node-llama-cpp'
  )
  if (!nativeRoot.startsWith(`${root}${sep}`)) {
    throw new Error('Refusing to prune native packages outside the packaged application')
  }

  const arch = archNames[context.arch]
  if (!arch) throw new Error(`Unknown electron-builder architecture: ${context.arch}`)
  const keep = packageToKeep(context.electronPlatformName, arch)
  let entries
  try {
    entries = await readdir(nativeRoot, { withFileTypes: true })
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return
    throw error
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === keep) continue
    const target = resolve(nativeRoot, entry.name)
    if (!target.startsWith(`${nativeRoot}${sep}`)) {
      throw new Error(`Refusing to remove an unexpected native package path: ${target}`)
    }
    await rm(target, { recursive: true, force: true })
  }
}
