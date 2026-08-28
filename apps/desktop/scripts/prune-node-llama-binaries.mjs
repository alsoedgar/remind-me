import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import process from 'node:process'

const archNames = ['ia32', 'x64', 'armv7l', 'arm64', 'universal']

function basePackage(platform, arch) {
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

export function packagesToKeep(platform, arch, acceleration = 'portable') {
  const base = basePackage(platform, arch)
  if (acceleration === 'portable') return [base]
  if (platform === 'darwin' && arch === 'arm64' && acceleration === 'metal') return [base]
  if ((platform === 'win32' || platform === 'linux') && arch === 'x64') {
    if (acceleration === 'vulkan') return [base, `${base}-vulkan`]
    if (acceleration === 'cuda') return [base, `${base}-cuda`, `${base}-cuda-ext`]
  }
  throw new Error(
    `The ${acceleration} llama.cpp package variant is not configured for ${platform}/${arch}`
  )
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
  const requestedAcceleration = String(
    process.env.REMIND_ME_LLAMA_ACCELERATION ??
      (context.electronPlatformName === 'darwin' && arch === 'arm64' ? 'metal' : 'portable')
  ).toLocaleLowerCase()
  if (!['portable', 'metal', 'vulkan', 'cuda'].includes(requestedAcceleration)) {
    throw new Error(`Unknown REMIND_ME_LLAMA_ACCELERATION value: ${requestedAcceleration}`)
  }
  const keep = packagesToKeep(context.electronPlatformName, arch, requestedAcceleration)
  const keepSet = new Set(keep)
  let entries
  try {
    entries = await readdir(nativeRoot, { withFileTypes: true })
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return
    throw error
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || keepSet.has(entry.name)) continue
    const target = resolve(nativeRoot, entry.name)
    if (!target.startsWith(`${nativeRoot}${sep}`)) {
      throw new Error(`Refusing to remove an unexpected native package path: ${target}`)
    }
    await rm(target, { recursive: true, force: true })
  }

  const backends = ['cpu']
  if (requestedAcceleration === 'metal') backends.push('metal')
  if (requestedAcceleration === 'vulkan') backends.push('vulkan')
  if (requestedAcceleration === 'cuda') backends.push('cuda')
  const resourceRoot = resolve(root, 'resources')
  if (!resourceRoot.startsWith(`${root}${sep}`)) {
    throw new Error('Refusing to write a backend manifest outside the packaged application')
  }
  await mkdir(resourceRoot, { recursive: true })
  await writeFile(
    resolve(resourceRoot, 'llama-backends.json'),
    `${JSON.stringify({ schemaVersion: 1, variant: requestedAcceleration, backends }, null, 2)}\n`,
    'utf8'
  )
}
