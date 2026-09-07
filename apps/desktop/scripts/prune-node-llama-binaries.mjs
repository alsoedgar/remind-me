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

async function resourceRootsFor(root, platform) {
  const roots = [resolve(root, 'resources')]
  if (platform !== 'darwin') return roots

  // electron-builder's mac afterPack appOutDir is the architecture directory
  // (for example dist/mac-arm64), while Windows/Linux use the unpacked app
  // directory directly. Resolve the bundle resources in both forms so the
  // native-package pruning hook works before and after asar staging.
  if (root.toLocaleLowerCase().endsWith('.app')) {
    roots.unshift(resolve(root, 'Contents', 'Resources'))
  } else {
    let entries
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') return roots
      throw error
    }
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.toLocaleLowerCase().endsWith('.app')) {
        roots.unshift(resolve(root, entry.name, 'Contents', 'Resources'))
      }
    }
  }
  return [...new Set(roots)]
}

export default async function pruneNodeLlamaBinaries(context) {
  const root = resolve(context.appOutDir)
  // afterPack runs before electron-builder creates app.asar and app.asar.unpacked.
  // Prune the staged app tree so excluded optional packages cannot be copied into
  // app.asar.unpacked later. Keep the unpacked path as a compatibility fallback.
  const resourceRoots = await resourceRootsFor(root, context.electronPlatformName)
  const nativeRootCandidates = resourceRoots.flatMap((resourceRoot) => [
    resolve(resourceRoot, 'app', 'node_modules', '@node-llama-cpp'),
    resolve(resourceRoot, 'app.asar.unpacked', 'node_modules', '@node-llama-cpp')
  ])
  for (const candidate of nativeRootCandidates) {
    if (!candidate.startsWith(`${root}${sep}`)) {
      throw new Error('Refusing to prune native packages outside the packaged application')
    }
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
  let nativeRoot
  let entries
  for (const candidate of nativeRootCandidates) {
    try {
      entries = await readdir(candidate, { withFileTypes: true })
      nativeRoot = candidate
      break
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') continue
      throw error
    }
  }
  if (!nativeRoot || !entries) {
    throw new Error('The packaged application has no @node-llama-cpp native package staging tree')
  }

  for (const entry of entries) {
    if (keepSet.has(entry.name)) continue
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
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
  const resourceRoot =
    resourceRoots.find((candidate) => nativeRoot?.startsWith(`${candidate}${sep}`)) ??
    resourceRoots[0]
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
