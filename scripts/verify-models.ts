import { resolve } from 'node:path'
import { loadModelManifest, verifyModelManifest } from '@remind-me/model-runtime'

const modelRoot = resolve(process.cwd(), 'models')
const manifest = await loadModelManifest(modelRoot)
const verification = await verifyModelManifest(modelRoot, manifest)

for (const result of verification.artifacts) {
  const mark = result.valid ? 'ok' : result.artifact.required ? 'missing/invalid' : 'optional'
  console.log(`${mark.padEnd(15)} ${result.artifact.path}`)
  if (result.error) console.log(`                ${result.error}`)
}

if (!verification.valid) {
  console.error('Required local model artifacts failed verification. Run pnpm models:fetch.')
  process.exitCode = 1
} else {
  console.log(
    `Verified ${verification.artifacts.length} offline model artifacts (${(
      verification.totalBytes /
      1024 /
      1024
    ).toFixed(1)} MiB).`
  )
}
