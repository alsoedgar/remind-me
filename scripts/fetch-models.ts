import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { loadModelManifest, resolveModelArtifactPath } from '@remind-me/model-runtime'

const revision = 'd42f2d9f7ca24806fb667456a18a9f1b60f70d16'
const repository = 'csukuangfj/sherpa-onnx-streaming-zipformer-en-20M-2023-02-17'
const modelRoot = resolve(process.cwd(), 'models')
const manifest = await loadModelManifest(modelRoot)

for (const artifact of manifest.artifacts) {
  const destination = resolveModelArtifactPath(modelRoot, artifact.path)
  const currentMatches = await readFile(destination)
    .then(
      (current) =>
        current.byteLength === artifact.byteLength &&
        createHash('sha256').update(current).digest('hex') === artifact.sha256
    )
    .catch(() => false)
  if (currentMatches) {
    console.log(`already verified  ${artifact.path}`)
    continue
  }

  if (artifact.provenance === 'project-trained') {
    if (!artifact.required) {
      console.log(`optional local    ${artifact.path}`)
      continue
    }
    const trainingCommand =
      artifact.role === 'speaker' ? 'pnpm remindspeak:train' : 'pnpm remindcore:train'
    throw new Error(
      `Project-trained artifact is missing or invalid: ${artifact.path}. Run ${trainingCommand} in the development ML environment.`
    )
  }

  const relativePath = artifact.path.split('/').slice(2).join('/')
  const url = `https://huggingface.co/${repository}/resolve/${revision}/${relativePath}?download=true`
  console.log(`downloading       ${artifact.path}`)
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`Download failed (${response.status}) for ${url}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (bytes.byteLength !== artifact.byteLength || sha256 !== artifact.sha256) {
    throw new Error(`Downloaded artifact failed verification: ${artifact.path}`)
  }

  await mkdir(dirname(destination), { recursive: true })
  const temporaryPath = `${destination}.download`
  await writeFile(temporaryPath, bytes, { flag: 'w' })
  await rm(destination, { force: true })
  await rename(temporaryPath, destination)
}

console.log('All required offline models are installed and checksum-verified.')
