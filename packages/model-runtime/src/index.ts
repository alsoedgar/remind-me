import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { z } from 'zod'

export * from './remindcore'
export * from './remindspeak'
export * from './planscan'
export * from './release-probes'

export const modelArtifactComponentSchema = z.enum([
  'encoder',
  'decoder',
  'joiner',
  'tokens',
  'smoke-audio',
  'weights',
  'tokenizer',
  'configuration',
  'golden-fixture'
])

export const modelArtifactSchema = z
  .object({
    id: z.string().min(1),
    role: z.enum([
      'planner',
      'speaker',
      'document-layout',
      'speech-recognition',
      'release-validation'
    ]),
    component: modelArtifactComponentSchema,
    version: z.string().min(1),
    format: z.enum(['onnx', 'ggml', 'text', 'json', 'wav', 'bin']),
    path: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    byteLength: z.number().int().positive(),
    required: z.boolean(),
    contractVersion: z.string().min(1),
    locale: z.string().min(2).max(35).nullable(),
    license: z.string().min(1),
    provenance: z.enum(['upstream', 'project-trained']),
    sourceUrl: z.string().url().nullable(),
    generator: z.string().min(1).nullable()
  })
  .strict()

export const modelManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    runtime: z
      .object({
        primary: z.enum(['onnxruntime-node', 'sherpa-onnx-wasm']),
        version: z.string().min(1),
        isolation: z.literal('electron-utility-process'),
        cpuFallback: z.literal(true),
        requiresNetwork: z.literal(false),
        planner: z
          .object({
            primary: z.literal('typescript-int8'),
            parityFormat: z.literal('onnx'),
            cpuFallback: z.literal(true),
            requiresNetwork: z.literal(false)
          })
          .strict(),
        speaker: z
          .object({
            primary: z.literal('typescript-int8-phrase-lattice'),
            cpuFallback: z.literal(true),
            requiresNetwork: z.literal(false),
            protectedPlaceholderValidation: z.literal(true)
          })
          .strict(),
        document: z
          .object({
            primary: z.literal('typescript-int8-spatial-graph'),
            isolation: z.literal('sandboxed-web-worker'),
            cpuFallback: z.literal(true),
            requiresNetwork: z.literal(false),
            evidenceProjection: z.literal(true),
            repairFallback: z.literal('optional-candidate-only-local-model'),
            repairHasMutationAuthority: z.literal(false)
          })
          .strict()
      })
      .strict(),
    artifacts: z.array(modelArtifactSchema)
  })
  .strict()

export type ModelArtifact = z.infer<typeof modelArtifactSchema>
export type ModelManifest = z.infer<typeof modelManifestSchema>

export interface ModelRuntime<Input, Output> {
  load: () => Promise<void>
  infer: (input: Input, signal: AbortSignal) => Promise<Output>
  unload: () => Promise<void>
}

export interface ArtifactVerification {
  artifact: ModelArtifact
  absolutePath: string
  valid: boolean
  error: string | null
}

export interface ManifestVerification {
  valid: boolean
  totalBytes: number
  artifacts: ArtifactVerification[]
}

export interface SpeechRecognitionModelFiles {
  id: string
  locale: string
  encoder: string
  decoder: string
  joiner: string
  tokens: string
  smokeAudio: string
  totalBytes: number
}

export async function loadModelManifest(modelRoot: string): Promise<ModelManifest> {
  const contents = await readFile(resolve(modelRoot, 'manifest.json'), 'utf8')
  return modelManifestSchema.parse(JSON.parse(contents))
}

export function resolveModelArtifactPath(modelRoot: string, artifactPath: string): string {
  const root = resolve(modelRoot)
  const absolutePath = resolve(root, artifactPath)
  if (absolutePath !== root && !absolutePath.startsWith(`${root}${sep}`)) {
    throw new Error(`Model artifact escapes the model root: ${artifactPath}`)
  }
  return absolutePath
}

async function sha256File(filePath: string): Promise<string> {
  return await new Promise((resolveHash, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.once('error', reject)
    stream.once('end', () => resolveHash(hash.digest('hex')))
  })
}

export async function verifyModelManifest(
  modelRoot: string,
  manifest: ModelManifest
): Promise<ManifestVerification> {
  const artifacts = await Promise.all(
    manifest.artifacts.map(async (artifact): Promise<ArtifactVerification> => {
      let absolutePath: string
      try {
        absolutePath = resolveModelArtifactPath(modelRoot, artifact.path)
      } catch (error) {
        return {
          artifact,
          absolutePath: resolve(modelRoot),
          valid: false,
          error: error instanceof Error ? error.message : 'Invalid artifact path'
        }
      }

      try {
        const file = await stat(absolutePath)
        if (!file.isFile()) throw new Error('Artifact is not a regular file')
        if (file.size !== artifact.byteLength) {
          throw new Error(`Expected ${artifact.byteLength} bytes, found ${file.size}`)
        }
        const actualSha256 = await sha256File(absolutePath)
        if (actualSha256 !== artifact.sha256) throw new Error('SHA-256 checksum mismatch')
        return { artifact, absolutePath, valid: true, error: null }
      } catch (error) {
        return {
          artifact,
          absolutePath,
          valid: false,
          error: error instanceof Error ? error.message : 'Artifact verification failed'
        }
      }
    })
  )

  return {
    valid: artifacts.every((result) => result.valid || !result.artifact.required),
    totalBytes: artifacts.reduce((total, result) => total + result.artifact.byteLength, 0),
    artifacts
  }
}

export function getSpeechRecognitionModel(
  modelRoot: string,
  manifest: ModelManifest
): SpeechRecognitionModelFiles {
  const artifacts = manifest.artifacts.filter((artifact) => artifact.role === 'speech-recognition')
  const component = (name: ModelArtifact['component']): ModelArtifact => {
    const matches = artifacts.filter((artifact) => artifact.component === name)
    if (matches.length !== 1) {
      throw new Error(`Expected exactly one speech-recognition ${name} artifact`)
    }
    const match = matches[0]
    if (!match) throw new Error(`Missing speech-recognition ${name} artifact`)
    return match
  }

  const encoder = component('encoder')
  const decoder = component('decoder')
  const joiner = component('joiner')
  const tokens = component('tokens')
  const smokeAudio = component('smoke-audio')
  const locale = encoder.locale
  if (!locale) throw new Error('Speech-recognition model locale is missing')

  return {
    id: encoder.id.split('.').slice(0, -1).join('.'),
    locale,
    encoder: resolveModelArtifactPath(modelRoot, encoder.path),
    decoder: resolveModelArtifactPath(modelRoot, decoder.path),
    joiner: resolveModelArtifactPath(modelRoot, joiner.path),
    tokens: resolveModelArtifactPath(modelRoot, tokens.path),
    smokeAudio: resolveModelArtifactPath(modelRoot, smokeAudio.path),
    totalBytes: artifacts.reduce((total, artifact) => total + artifact.byteLength, 0)
  }
}

const spokenHours: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12
}

const spokenMinutes: Readonly<Record<string, number>> = {
  ohfive: 5,
  ten: 10,
  fifteen: 15,
  twenty: 20,
  twentyfive: 25,
  thirty: 30,
  thirtyfive: 35,
  forty: 40,
  fortyfive: 45,
  fifty: 50,
  fiftyfive: 55
}

const hourWords = Object.keys(spokenHours).join('|')
const minuteWords =
  'oh\\s+five|ten|fifteen|twenty(?:\\s+five)?|thirty(?:\\s+five)?|forty(?:\\s+five)?|fifty(?:\\s+five)?'

function clockFromWords(hourWord: string, minuteWord: string | undefined): string {
  const hour = spokenHours[hourWord.toLocaleLowerCase()]
  if (!hour) return hourWord
  if (!minuteWord) return String(hour)
  const minute = spokenMinutes[minuteWord.toLocaleLowerCase().replace(/\s+/gu, '')]
  return minute === undefined ? String(hour) : `${hour}:${String(minute).padStart(2, '0')}`
}

/** Converts stable ASR conventions into parser-friendly, still-editable text. */
export function normalizeVoiceTranscript(rawTranscript: string): string {
  let transcript = rawTranscript
    .normalize('NFKC')
    .replace(/^[\s'".,;:!?–—-]+/u, '')
    .replace(/\s+/gu, ' ')
    .trim()

  const letters = transcript.match(/[a-z]/giu) ?? []
  const uppercaseLetters = transcript.match(/[A-Z]/gu) ?? []
  if (letters.length > 0 && uppercaseLetters.length / letters.length > 0.72) {
    transcript = transcript.toLocaleLowerCase()
  }

  transcript = transcript
    .replace(/\bto\s+morrow\b/giu, 'tomorrow')
    .replace(/\b([ap])\s*\.?\s*m\.?\b/giu, '$1m')

  transcript = transcript.replace(
    new RegExp(`\\bhalf\\s+past\\s+(${hourWords})(?:\\s*(am|pm))?\\b`, 'giu'),
    (_match, hour: string, meridiem: string | undefined) =>
      `${clockFromWords(hour, 'thirty')}${meridiem ? ` ${meridiem.toLocaleLowerCase()}` : ''}`
  )
  transcript = transcript.replace(
    new RegExp(`\\bquarter\\s+past\\s+(${hourWords})(?:\\s*(am|pm))?\\b`, 'giu'),
    (_match, hour: string, meridiem: string | undefined) =>
      `${clockFromWords(hour, 'fifteen')}${meridiem ? ` ${meridiem.toLocaleLowerCase()}` : ''}`
  )
  transcript = transcript.replace(
    new RegExp(`\\bquarter\\s+to\\s+(${hourWords})(?:\\s*(am|pm))?\\b`, 'giu'),
    (_match, hour: string, meridiem: string | undefined) => {
      const numericHour = spokenHours[hour.toLocaleLowerCase()]
      if (!numericHour) return `quarter to ${hour}`
      return `${numericHour === 1 ? 12 : numericHour - 1}:45${
        meridiem ? ` ${meridiem.toLocaleLowerCase()}` : ''
      }`
    }
  )

  transcript = transcript.replace(
    new RegExp(
      `\\b(${hourWords})(?:\\s+(${minuteWords}))?\\s+(?:in\\s+the\\s+)?(morning|afternoon|evening|night)\\b`,
      'giu'
    ),
    (_match, hour: string, minute: string | undefined, period: string) => {
      const meridiem = period.toLocaleLowerCase() === 'morning' ? 'am' : 'pm'
      return `${clockFromWords(hour, minute)} ${meridiem}`
    }
  )
  transcript = transcript.replace(
    new RegExp(`\\b(${hourWords})(?:\\s+(${minuteWords}))?\\s*(am|pm)\\b`, 'giu'),
    (_match, hour: string, minute: string | undefined, meridiem: string) =>
      `${clockFromWords(hour, minute)} ${meridiem.toLocaleLowerCase()}`
  )
  transcript = transcript.replace(
    new RegExp(`\\b(at|from|to|until|between|and)\\s+(${hourWords})(?:\\s+o['’]?clock)?\\b`, 'giu'),
    (_match, connector: string, hour: string) => `${connector} ${clockFromWords(hour, undefined)}`
  )

  transcript = transcript.replace(/\s+([,.;:!?])/gu, '$1').trim()
  if (!transcript) return ''
  return transcript[0]?.toLocaleUpperCase() + transcript.slice(1)
}

export function confidenceFromLogProbabilities(probabilities: readonly number[]): number | null {
  if (probabilities.length === 0) return null
  const meanProbability =
    probabilities.reduce((total, logProbability) => total + Math.exp(logProbability), 0) /
    probabilities.length
  return Math.max(0, Math.min(1, meanProbability))
}
