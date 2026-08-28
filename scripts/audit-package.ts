import { access, readFile, readdir, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { extractFile } from '@electron/asar'
import { loadModelManifest, verifyModelManifest } from '@remind-me/model-runtime'

interface PackageLayout {
  root: string
  resources: string
  executable: string
  fuseBinary: string
}

const fuseSentinel = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX', 'ascii')
const expectedFuseStates = [
  { name: 'RunAsNode', state: 0x30 },
  { name: 'EnableCookieEncryption', state: 0x31 },
  { name: 'EnableNodeOptionsEnvironmentVariable', state: 0x30 },
  { name: 'EnableNodeCliInspectArguments', state: 0x30 },
  { name: 'EnableEmbeddedAsarIntegrityValidation', state: 0x31 },
  { name: 'OnlyLoadAppFromAsar', state: 0x31 },
  { name: 'LoadBrowserProcessSpecificV8Snapshot', state: 0x30 },
  { name: 'GrantFileProtocolExtraPrivileges', state: 0x30 },
  { name: 'WasmTrapHandlers', state: 0x31 }
] as const
const allowedLlamaPackages = new Set([
  'win-x64',
  'win-arm64',
  'linux-x64',
  'linux-arm64',
  'linux-armv7l',
  'mac-x64',
  'mac-arm64-metal'
])

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function findPackageLayout(): Promise<PackageLayout> {
  const explicit = process.argv[2] ? resolve(process.argv[2]) : null
  if (explicit) {
    if (explicit.endsWith('.app')) {
      return {
        root: explicit,
        resources: join(explicit, 'Contents', 'Resources'),
        executable: join(explicit, 'Contents', 'MacOS', 'Remind Me'),
        fuseBinary: join(
          explicit,
          'Contents',
          'Frameworks',
          'Electron Framework.framework',
          'Electron Framework'
        )
      }
    }
    return {
      root: explicit,
      resources: join(explicit, 'resources'),
      executable: join(explicit, process.platform === 'win32' ? 'Remind Me.exe' : 'remind-me'),
      fuseBinary: join(explicit, process.platform === 'win32' ? 'Remind Me.exe' : 'remind-me')
    }
  }
  const dist = resolve(process.cwd(), 'dist')
  if (process.platform === 'win32') {
    return {
      root: join(dist, 'win-unpacked'),
      resources: join(dist, 'win-unpacked', 'resources'),
      executable: join(dist, 'win-unpacked', 'Remind Me.exe'),
      fuseBinary: join(dist, 'win-unpacked', 'Remind Me.exe')
    }
  }
  if (process.platform === 'linux') {
    return {
      root: join(dist, 'linux-unpacked'),
      resources: join(dist, 'linux-unpacked', 'resources'),
      executable: join(dist, 'linux-unpacked', 'remind-me'),
      fuseBinary: join(dist, 'linux-unpacked', 'remind-me')
    }
  }
  const directories = await readdir(dist, { withFileTypes: true })
  for (const directory of directories.filter((entry) => entry.isDirectory())) {
    const parent = join(dist, directory.name)
    const children = await readdir(parent, { withFileTypes: true })
    const app = children.find((entry) => entry.isDirectory() && entry.name.endsWith('.app'))
    if (app) {
      const root = join(parent, app.name)
      return {
        root,
        resources: join(root, 'Contents', 'Resources'),
        executable: join(root, 'Contents', 'MacOS', 'Remind Me'),
        fuseBinary: join(
          root,
          'Contents',
          'Frameworks',
          'Electron Framework.framework',
          'Electron Framework'
        )
      }
    }
  }
  throw new Error('A packaged application directory was not found')
}

async function auditElectronFuses(path: string): Promise<number> {
  const binary = await readFile(path)
  const sentinelOffsets: number[] = []
  let cursor = 0
  while (cursor < binary.length) {
    const offset = binary.indexOf(fuseSentinel, cursor)
    if (offset < 0) break
    sentinelOffsets.push(offset)
    cursor = offset + fuseSentinel.length
  }
  if (sentinelOffsets.length === 0) throw new Error('The Electron fuse sentinel is missing')
  for (const offset of sentinelOffsets) {
    const wireOffset = offset + fuseSentinel.length
    const version = binary[wireOffset]
    const length = binary[wireOffset + 1]
    if (version !== 1) throw new Error(`Unsupported Electron fuse schema version: ${version}`)
    if (length !== expectedFuseStates.length) {
      throw new Error(
        `Electron exposes ${length} fuses but the package policy defines ${expectedFuseStates.length}`
      )
    }
    for (const [index, expected] of expectedFuseStates.entries()) {
      const actual = binary[wireOffset + 2 + index]
      if (actual !== expected.state) {
        throw new Error(
          `Electron fuse ${expected.name} is ${actual === 0x31 ? 'enabled' : 'disabled/unknown'}; expected ${expected.state === 0x31 ? 'enabled' : 'disabled'}`
        )
      }
    }
  }
  return sentinelOffsets.length
}

async function walk(directory: string): Promise<Array<{ path: string; bytes: number }>> {
  const output: Array<{ path: string; bytes: number }> = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) output.push(...(await walk(path)))
    else if (entry.isFile()) output.push({ path, bytes: (await stat(path)).size })
  }
  return output
}

const layout = await findPackageLayout()
if (!(await exists(layout.executable)))
  throw new Error(`Packaged executable is missing: ${layout.executable}`)
if (!(await exists(layout.fuseBinary)))
  throw new Error(`Packaged Electron fuse binary is missing: ${layout.fuseBinary}`)
const fuseSliceCount = await auditElectronFuses(layout.fuseBinary)
const asarPath = join(layout.resources, 'app.asar')
if (!(await exists(asarPath))) throw new Error('The application must load from app.asar')
const llamaReleaseManifestPath = join(
  'node_modules',
  'node-llama-cpp',
  'llama',
  'binariesGithubRelease.json'
)
const llamaSourceInfoPath = join('node_modules', 'node-llama-cpp', 'llama', 'llama.cpp.info.json')
let llamaReleaseManifest: unknown
let llamaSourceInfo: unknown
try {
  llamaReleaseManifest = JSON.parse(
    extractFile(asarPath, llamaReleaseManifestPath).toString('utf8')
  )
  llamaSourceInfo = JSON.parse(extractFile(asarPath, llamaSourceInfoPath).toString('utf8'))
} catch (error) {
  throw new Error(
    `Optional-model runtime metadata is missing or invalid in app.asar (${llamaReleaseManifestPath}, ${llamaSourceInfoPath})`,
    { cause: error }
  )
}
if (
  !llamaReleaseManifest ||
  typeof llamaReleaseManifest !== 'object' ||
  typeof (llamaReleaseManifest as { release?: unknown }).release !== 'string' ||
  !(llamaReleaseManifest as { release: string }).release.trim()
) {
  throw new Error('The packaged optional-model runtime manifest has no pinned release')
}
if (
  !llamaSourceInfo ||
  typeof llamaSourceInfo !== 'object' ||
  (llamaSourceInfo as { tag?: unknown }).tag !==
    (llamaReleaseManifest as { release: string }).release
) {
  throw new Error('The packaged llama.cpp metadata does not match the pinned binary release')
}
const flexWorkerPath = join(layout.resources, 'workers', 'flex-model-worker.cjs')
if (!(await exists(flexWorkerPath)) || (await stat(flexWorkerPath)).size === 0) {
  throw new Error('The isolated optional-model worker is missing from the package')
}
for (const requiredWorkerAsset of [
  'flex-model-prompts.cjs',
  'flex-model-planner-schema.json',
  'flex-model-chat-schema.json',
  'flex-model-document-repair-schema.json',
  'flex-model-document-fallback-schema.json'
]) {
  const requiredPath = join(layout.resources, 'workers', requiredWorkerAsset)
  if (!(await exists(requiredPath)) || (await stat(requiredPath)).size === 0) {
    throw new Error(`The optional-model worker dependency is missing: ${requiredWorkerAsset}`)
  }
}
const appIconPath = join(layout.resources, 'app-icon.png')
if (!(await exists(appIconPath)) || (await stat(appIconPath)).size < 1_024) {
  throw new Error('The packaged taskbar icon is missing or invalid')
}
const llamaNativeRoot = join(
  layout.resources,
  'app.asar.unpacked',
  'node_modules',
  '@node-llama-cpp'
)
const llamaPackages = (await readdir(llamaNativeRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
if (llamaPackages.length !== 1 || !allowedLlamaPackages.has(llamaPackages[0] ?? '')) {
  throw new Error(
    `Expected exactly one supported optional-model native backend, found: ${llamaPackages.join(', ') || 'none'}`
  )
}
const modelRoot = join(layout.resources, 'models')
const manifest = await loadModelManifest(modelRoot)
const verification = await verifyModelManifest(modelRoot, manifest)
if (!verification.valid || verification.artifacts.some((result) => !result.valid)) {
  throw new Error('The packaged model inventory failed full integrity verification')
}
const files = await walk(layout.root)
const totalBytes = files.reduce((total, file) => total + file.bytes, 0)
if (totalBytes > 525 * 1024 * 1024) {
  throw new Error(
    `Unpacked application exceeds 525 MiB: ${(totalBytes / 1024 / 1024).toFixed(1)} MiB`
  )
}
const forbidden = files.filter((file) =>
  /(?:^|[\\/])(?:ml|fixtures)(?:[\\/])|\.py$|\.jsonl$|(?:^|[\\/])\.env(?:\.|$)/iu.test(
    file.path.slice(layout.root.length)
  )
)
if (forbidden.length > 0) {
  throw new Error(`Development/private files entered the package: ${forbidden[0]?.path}`)
}
console.log(
  `Audited ${basename(layout.root)}: ${(totalBytes / 1024 / 1024).toFixed(1)} MiB, ` +
    `${files.length} files, ${verification.artifacts.length} verified model artifacts, ` +
    `${expectedFuseStates.length} hardened fuses across ${fuseSliceCount} binary slice(s), ` +
    `${llamaPackages[0]} optional-model backend, ASAR-only app.`
)
