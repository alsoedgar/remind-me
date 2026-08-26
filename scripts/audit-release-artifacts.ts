import { spawnSync } from 'node:child_process'
import { access, readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const maximumArtifactBytes = 300 * 1024 * 1024
const requireSignature = process.argv.includes('--require-signature')
const dist = resolve(process.cwd(), 'dist')

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function allFiles(directory: string): Promise<string[]> {
  const output: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) output.push(...(await allFiles(path)))
    else if (entry.isFile()) output.push(path)
  }
  return output
}

function execute(command: string, args: string[], environment?: NodeJS.ProcessEnv): string {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: environment ?? process.env,
    windowsHide: true
  })
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args[0] ?? ''} failed: ${(result.stderr || result.stdout).trim()}`
    )
  }
  return result.stdout.trim()
}

async function checkSizes(paths: string[]): Promise<string[]> {
  const descriptions: string[] = []
  for (const path of paths) {
    const metadata = await stat(path)
    assert(metadata.size > 0, `Release artifact is empty: ${path}`)
    assert(metadata.size <= maximumArtifactBytes, `Release artifact exceeds 300 MiB: ${path}`)
    descriptions.push(
      `${path.split(/[\\/]/u).at(-1)} ${(metadata.size / 1024 / 1024).toFixed(1)} MiB`
    )
  }
  return descriptions
}

const files = await allFiles(dist)
let signature: string
let releaseArtifacts: string[]

if (process.platform === 'win32') {
  releaseArtifacts = files.filter((path) => path.endsWith('.exe') && !path.includes('win-unpacked'))
  assert(releaseArtifacts.length === 1, 'Expected exactly one Windows NSIS installer')
  const installer = releaseArtifacts[0]
  assert(installer, 'The Windows NSIS installer is missing')
  const blockmap = `${installer}.blockmap`
  assert(await exists(blockmap), 'The Windows update blockmap is missing')
  assert((await stat(blockmap)).size > 0, 'The Windows update blockmap is empty')
  const result = execute(
    'pwsh',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '[Console]::Write((Get-AuthenticodeSignature -LiteralPath $env:REMIND_ME_RELEASE_ARTIFACT).Status.ToString())'
    ],
    { ...process.env, REMIND_ME_RELEASE_ARTIFACT: installer }
  )
  signature = `Authenticode ${result}`
  if (requireSignature) assert(result === 'Valid', `Windows installer signature is ${result}`)
} else if (process.platform === 'darwin') {
  const dmgs = files.filter((path) => path.endsWith('.dmg'))
  const zips = files.filter((path) => path.endsWith('.zip'))
  assert(dmgs.length === 1 && zips.length === 1, 'Expected one macOS DMG and one ZIP')
  releaseArtifacts = [...dmgs, ...zips]
  const apps = files
    .filter((path) => path.endsWith('/Contents/MacOS/Remind Me'))
    .map((path) => resolve(path, '..', '..', '..'))
  assert(apps.length >= 1, 'The packaged macOS application is missing')
  const app = apps[0]
  assert(app, 'The packaged macOS application is missing')
  if (requireSignature) {
    execute('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app])
    execute('spctl', ['--assess', '--type', 'execute', '--verbose=2', app])
    execute('xcrun', ['stapler', 'validate', app])
    signature = 'Developer ID valid; Gatekeeper accepted; notarization ticket stapled'
  } else {
    signature = 'signature not required for this local audit'
  }
} else if (process.platform === 'linux') {
  const appImages = files.filter((path) => path.endsWith('.AppImage'))
  const debs = files.filter((path) => path.endsWith('.deb'))
  assert(
    appImages.length === 1 && debs.length === 1,
    'Expected one AppImage and one Debian package'
  )
  const appImage = appImages[0]
  const deb = debs[0]
  assert(appImage && deb, 'The Linux release artifacts are missing')
  assert(((await stat(appImage)).mode & 0o111) !== 0, 'The AppImage is not executable')
  execute('dpkg-deb', ['--info', deb])
  releaseArtifacts = [...appImages, ...debs]
  signature = 'not applicable'
} else {
  throw new Error(`Unsupported release platform: ${process.platform}`)
}

const descriptions = await checkSizes(releaseArtifacts)
console.log(`Audited release artifacts: ${descriptions.join(', ')}; ${signature}.`)
