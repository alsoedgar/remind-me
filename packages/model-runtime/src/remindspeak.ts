import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { gunzipSync } from 'node:zlib'
import {
  responseSpeechActSchema,
  responseStyleSchema,
  type ResponsePlan,
  type ResponseStyle
} from '@remind-me/contracts'
import { z } from 'zod'

const surfaceOptionSchema = z
  .object({
    id: z.string().min(1),
    text: z.string().max(1_000),
    speechAct: responseSpeechActSchema,
    signature: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/u)).nullable(),
    style: responseStyleSchema
  })
  .strict()

const surfaceHeadSchema = z
  .object({
    name: z.enum(['lead', 'body', 'close']),
    buckets: z.number().int().positive(),
    byteOffset: z.number().int().nonnegative(),
    byteLength: z.number().int().positive(),
    scale: z.array(z.number().positive()),
    bias: z.array(z.number()),
    temperature: z.number().positive(),
    options: z.array(surfaceOptionSchema).min(2)
  })
  .strict()

const remindSpeakArtifactSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1),
    version: z.string().min(1),
    contractVersion: z.string().min(1),
    architecture: z
      .object({
        name: z.string().min(1),
        parameterCount: z.number().int().positive(),
        parameterInitialization: z.literal('zero'),
        featureEncoder: z.string().min(1),
        decoder: z.string().min(1),
        quantization: z.string().min(1)
      })
      .strict(),
    featureBuckets: z.number().int().positive(),
    hashAlgorithm: z.literal('fnv1a-32-utf8'),
    candidateCount: z.number().int().min(3).max(8),
    heads: z
      .object({
        lead: surfaceHeadSchema,
        body: surfaceHeadSchema,
        close: surfaceHeadSchema
      })
      .strict(),
    weights: z
      .object({
        path: z.string().min(1),
        compression: z.literal('gzip'),
        uncompressedBytes: z.number().int().positive(),
        sha256Uncompressed: z.string().regex(/^[a-f0-9]{64}$/u)
      })
      .strict(),
    safety: z
      .object({
        exactProtectedPlaceholderSet: z.literal(true),
        eachFactExactlyOnce: z.literal(true),
        rejectUnprotectedNumericAndDateLiterals: z.literal(true),
        recentExactReplyRejected: z.literal(true),
        recentSimilarityPenalty: z.literal(true),
        deterministicTemplateFallback: z.literal(true),
        localPreferenceBiasBounded: z.literal(true).optional()
      })
      .strict(),
    training: z
      .object({
        seed: z.number().int(),
        datasetManifestSha256: z.string().regex(/^[a-f0-9]{64}$/u),
        teacherUsed: z.boolean(),
        teacherModelId: z.string().min(1).nullable().optional(),
        teacherCorpusSha256: z
          .string()
          .regex(/^[a-f0-9]{64}$/u)
          .nullable()
          .optional(),
        teacherRole: z.string().min(1).optional(),
        teacherAuthoredSurfaceAtoms: z.number().int().nonnegative().optional(),
        pretrainedWeightsUsed: z.literal(false),
        personalDataUsed: z.literal(false),
        projectAuthoredSurfaceAtoms: z.number().int().positive()
      })
      .strict(),
    metrics: z.record(z.string(), z.unknown())
  })
  .strict()

type SurfaceOption = z.infer<typeof surfaceOptionSchema>

interface ScoredOption {
  option: SurfaceOption
  score: number
  rank: number
}

interface LoadedHead {
  buckets: number
  options: SurfaceOption[]
  scale: Float32Array
  bias: Float32Array
  temperature: number
  weights: Int8Array
}

export interface RemindSpeakFact {
  key: string
  kind: ResponsePlan['facts'][number]['kind']
  placeholder: string
  value: string
}

export interface RemindSpeakRequest {
  requestId: string
  speechAct: ResponsePlan['speechAct']
  facts: readonly RemindSpeakFact[]
  style: ResponseStyle
  recentReplies: readonly string[]
  templatePreferences?: readonly RemindSpeakTemplatePreference[]
}

export interface RemindSpeakTemplatePreference {
  templateFingerprint: string
  score: number
}

export interface RemindSpeakGeneration {
  templates: string[]
  candidatesEvaluated: number
  candidatesRejected: number
  latencyMs: number
}

export interface RemindSpeakInfo {
  available: boolean
  id: string
  version: string
  architecture: string
  parameterCount: number
  quantization: string
  modelBytes: number
  workingSetBytes: number
  mode: 'protected-overgenerate-rerank'
  candidateCount: number
  teacherUsed: boolean
  networkRequired: false
  error: string | null
}

const encoder = new TextEncoder()
const placeholderPattern = /<[A-Z][A-Z0-9_]*>/gu
const unprotectedDatePattern =
  /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|june|july|august|september|october|november|december)\b/iu

function fnv1a32(value: string): number {
  let result = 2_166_136_261
  for (const byte of encoder.encode(value)) {
    result ^= byte
    result = Math.imul(result, 16_777_619) >>> 0
  }
  return result
}

function styleBucket(value: number): number {
  return Math.max(0, Math.min(4, Math.floor(value * 4 + 0.5)))
}

function signature(facts: readonly RemindSpeakFact[]): string {
  return facts.map((fact) => fact.key).join('+')
}

function featureSet(input: RemindSpeakRequest): Set<string> {
  const signatureValue = signature(input.facts)
  const variant = fnv1a32(input.requestId) % 4
  const features = new Set([
    'bias',
    `act:${input.speechAct}`,
    `signature:${signatureValue}`,
    `act+signature:${input.speechAct}|${signatureValue}`,
    `fact-count:${input.facts.length}`,
    `variant:${variant}`,
    `recent:${Math.min(4, Math.floor(input.recentReplies.length / 2))}`,
    `contractions:${Number(input.style.contractions)}`
  ])
  for (const key of ['warmth', 'brevity', 'formality', 'humor', 'emoji', 'proactivity'] as const) {
    const bucket = styleBucket(input.style[key])
    features.add(`style:${key}:${bucket}`)
    features.add(`act+style:${input.speechAct}|${key}:${bucket}`)
  }
  input.facts.forEach((fact, index) => {
    const lengthBucket = Math.min(6, Math.floor(fact.value.length / 12))
    features.add(`fact-key:${fact.key}`)
    features.add(`fact-kind:${fact.kind}`)
    features.add(`fact-position:${index}:${fact.kind}`)
    features.add(`fact-length:${fact.kind}:${lengthBucket}`)
  })
  return features
}

function featureIds(input: RemindSpeakRequest, buckets: number): number[] {
  return [...new Set([...featureSet(input)].map((feature) => fnv1a32(feature) % buckets))].sort(
    (left, right) => left - right
  )
}

function sameSignature(option: SurfaceOption, input: RemindSpeakRequest): boolean {
  if (option.speechAct !== input.speechAct) return false
  if (option.signature === null) return true
  return option.signature.join('+') === signature(input.facts)
}

function scoreHead(head: LoadedHead, input: RemindSpeakRequest): ScoredOption[] {
  const ids = featureIds(input, head.buckets)
  const divisor = Math.sqrt(Math.max(1, ids.length))
  return head.options
    .map((option, optionIndex) => {
      let score = head.bias[optionIndex] ?? 0
      const scale = head.scale[optionIndex] ?? 1
      const offset = optionIndex * head.buckets
      for (const id of ids) score += ((head.weights[offset + id] ?? 0) * scale) / divisor
      return { option, score: score / head.temperature, rank: 0 }
    })
    .filter((item) => sameSignature(item.option, input))
    .sort(
      (left, right) => right.score - left.score || left.option.id.localeCompare(right.option.id)
    )
    .map((item, rank) => ({ ...item, rank }))
}

function styleDistance(left: ResponseStyle, right: ResponseStyle): number {
  const weighted =
    1.2 * Math.abs(left.warmth - right.warmth) +
    1.5 * Math.abs(left.brevity - right.brevity) +
    Math.abs(left.formality - right.formality) +
    0.7 * Math.abs(left.humor - right.humor) +
    0.4 * Math.abs(left.emoji - right.emoji) +
    0.8 * Math.abs(left.proactivity - right.proactivity)
  return weighted + (left.contractions === right.contractions ? 0 : 0.45)
}

function averageStyle(options: readonly SurfaceOption[]): ResponseStyle {
  const continuous = (key: Exclude<keyof ResponseStyle, 'contractions'>): number =>
    options.reduce((sum, option) => sum + option.style[key], 0) / options.length
  return {
    warmth: continuous('warmth'),
    brevity: continuous('brevity'),
    formality: continuous('formality'),
    humor: continuous('humor'),
    emoji: continuous('emoji'),
    contractions:
      options.filter((option) => option.style.contractions).length >= options.length / 2,
    proactivity: continuous('proactivity')
  }
}

function compose(parts: readonly string[]): string {
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce(
      (output, part) =>
        output ? `${output}${/[.!?…:;—]$/u.test(output) ? '' : ' —'} ${part}` : part,
      ''
    )
    .trim()
}

function templateIsGrounded(template: string, input: RemindSpeakRequest): boolean {
  const required = input.facts.map((fact) => fact.placeholder)
  const found = [...template.matchAll(placeholderPattern)].map((match) => match[0])
  if (new Set(found).size !== found.length) return false
  if (found.length !== required.length) return false
  if (required.some((placeholder) => !found.includes(placeholder))) return false
  const staticText = template.replace(placeholderPattern, ' ')
  return !/\d/u.test(staticText) && !unprotectedDatePattern.test(staticText)
}

function renderCandidate(template: string, facts: readonly RemindSpeakFact[]): string {
  let rendered = template
  for (const fact of facts) rendered = rendered.replaceAll(fact.placeholder, fact.value)
  return rendered.replace(/\s+/gu, ' ').trim()
}

function fingerprint(text: string): string {
  return fnv1a32(text.trim().toLocaleLowerCase().replace(/\s+/gu, ' '))
    .toString(16)
    .padStart(8, '0')
}

export function remindSpeakTemplateFingerprint(template: string): string {
  let result = 2_166_136_261
  const normalized = template.trim().toLocaleLowerCase().replace(/\s+/gu, ' ')
  for (let index = 0; index < normalized.length; index += 1) {
    result ^= normalized.charCodeAt(index)
    result = Math.imul(result, 16_777_619)
  }
  return (result >>> 0).toString(16).padStart(8, '0')
}

function ngrams(text: string): Set<string> {
  const words = text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  const output = new Set<string>()
  if (words.length < 3) {
    if (words.length > 0) output.add(words.join('|'))
    return output
  }
  for (let index = 0; index <= words.length - 3; index += 1) {
    output.add(words.slice(index, index + 3).join('|'))
  }
  return output
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0
  let intersection = 0
  for (const value of left) intersection += Number(right.has(value))
  return intersection / (left.size + right.size - intersection)
}

function loadHead(input: z.infer<typeof surfaceHeadSchema>, rawWeights: Buffer): LoadedHead {
  if (input.options.length !== input.scale.length || input.options.length !== input.bias.length) {
    throw new Error(`${input.name} scale/bias length does not match its options`)
  }
  if (input.byteLength !== input.options.length * input.buckets) {
    throw new Error(`${input.name} weight length does not match its option table`)
  }
  if (input.byteOffset + input.byteLength > rawWeights.byteLength) {
    throw new Error(`${input.name} weight range exceeds the decompressed model`)
  }
  return {
    buckets: input.buckets,
    options: input.options,
    scale: Float32Array.from(input.scale),
    bias: Float32Array.from(input.bias),
    temperature: input.temperature,
    weights: new Int8Array(
      rawWeights.buffer,
      rawWeights.byteOffset + input.byteOffset,
      input.byteLength
    )
  }
}

export class RemindSpeakPlanner {
  readonly info: RemindSpeakInfo
  private readonly lead: LoadedHead
  private readonly body: LoadedHead
  private readonly close: LoadedHead
  private readonly candidateCount: number

  private constructor(
    artifact: z.infer<typeof remindSpeakArtifactSchema>,
    rawWeights: Buffer,
    modelBytes: number
  ) {
    this.lead = loadHead(artifact.heads.lead, rawWeights)
    this.body = loadHead(artifact.heads.body, rawWeights)
    this.close = loadHead(artifact.heads.close, rawWeights)
    this.candidateCount = artifact.candidateCount
    this.info = {
      available: true,
      id: artifact.id,
      version: artifact.version,
      architecture: artifact.architecture.name,
      parameterCount: artifact.architecture.parameterCount,
      quantization: artifact.architecture.quantization,
      modelBytes,
      workingSetBytes: rawWeights.byteLength,
      mode: 'protected-overgenerate-rerank',
      candidateCount: artifact.candidateCount,
      teacherUsed: artifact.training.teacherUsed,
      networkRequired: false,
      error: null
    }
  }

  static async load(modelRoot: string): Promise<RemindSpeakPlanner> {
    const configurationPath = resolve(modelRoot, 'remindspeak', 'remindspeak-v0.1-int8.json')
    const configuration = await readFile(configurationPath, 'utf8')
    const artifact = remindSpeakArtifactSchema.parse(JSON.parse(configuration))
    const compressedPath = resolve(modelRoot, 'remindspeak', artifact.weights.path)
    const compressed = await readFile(compressedPath)
    const rawWeights = gunzipSync(compressed)
    if (rawWeights.byteLength !== artifact.weights.uncompressedBytes) {
      throw new Error('RemindSpeak decompressed weights have an unexpected length')
    }
    const digest = createHash('sha256').update(rawWeights).digest('hex')
    if (digest !== artifact.weights.sha256Uncompressed) {
      throw new Error('RemindSpeak decompressed weights failed integrity validation')
    }
    return new RemindSpeakPlanner(
      artifact,
      rawWeights,
      Buffer.byteLength(configuration) + compressed.byteLength
    )
  }

  generate(inputValue: RemindSpeakRequest): RemindSpeakGeneration {
    const started = performance.now()
    const input: RemindSpeakRequest = {
      ...inputValue,
      style: responseStyleSchema.parse(inputValue.style),
      facts: inputValue.facts.map((fact) => ({ ...fact })),
      recentReplies: [...inputValue.recentReplies],
      templatePreferences: (inputValue.templatePreferences ?? [])
        .filter(
          (entry) =>
            /^[a-f0-9]{8}$/u.test(entry.templateFingerprint) && Number.isFinite(entry.score)
        )
        .map((entry) => ({
          templateFingerprint: entry.templateFingerprint,
          score: Math.max(-3, Math.min(3, Math.round(entry.score)))
        }))
    }
    const leads = scoreHead(this.lead, input)
    const bodies = scoreHead(this.body, input)
    const closes = scoreHead(this.close, input)
    if (leads.length === 0 || bodies.length === 0 || closes.length === 0) {
      return {
        templates: [],
        candidatesEvaluated: 0,
        candidatesRejected: 0,
        latencyMs: performance.now() - started
      }
    }

    const recentFingerprints = new Set(input.recentReplies.map(fingerprint))
    const recentNgrams = input.recentReplies.map(ngrams)
    const factWords = input.facts.reduce(
      (total, fact) => total + (fact.value.match(/[\p{L}\p{N}]+/gu)?.length ?? 0),
      0
    )
    const targetWords = factWords + 5 + (1 - input.style.brevity) * 20
    const seenTemplates = new Set<string>()
    const preferenceScores = new Map(
      (input.templatePreferences ?? []).map((entry) => [entry.templateFingerprint, entry.score])
    )
    const candidates: Array<{ template: string; score: number }> = []
    let evaluated = 0
    let rejected = 0

    for (const lead of leads) {
      for (const body of bodies) {
        for (const close of closes) {
          evaluated += 1
          const options = [lead.option, body.option, close.option]
          const template = compose(options.map((option) => option.text))
          if (seenTemplates.has(template) || !templateIsGrounded(template, input)) {
            rejected += 1
            continue
          }
          seenTemplates.add(template)
          const rendered = renderCandidate(template, input.facts)
          if (recentFingerprints.has(fingerprint(rendered))) {
            rejected += 1
            continue
          }
          const similarity = Math.max(
            0,
            ...recentNgrams.map((recent) => jaccard(ngrams(rendered), recent))
          )
          const wordCount = rendered.match(/[\p{L}\p{N}]+/gu)?.length ?? 0
          const modelRankPenalty = (lead.rank + body.rank + close.rank) * 0.22
          const stylePenalty = styleDistance(input.style, averageStyle(options)) * 1.35
          const lengthPenalty = Math.abs(wordCount - targetWords) * 0.035
          const noveltyPenalty = similarity * 2.4
          const preferenceBias =
            (preferenceScores.get(remindSpeakTemplateFingerprint(template)) ?? 0) * 1.25
          const tieBreak = (fnv1a32(`${input.requestId}:${template}`) / 0xffffffff) * 0.04
          candidates.push({
            template,
            score:
              lead.score +
              body.score +
              close.score -
              modelRankPenalty -
              stylePenalty -
              lengthPenalty -
              noveltyPenalty +
              preferenceBias +
              tieBreak
          })
        }
      }
    }

    const templates = candidates
      .sort(
        (left, right) => right.score - left.score || left.template.localeCompare(right.template)
      )
      .slice(0, this.candidateCount)
      .map((candidate) => candidate.template)
    return {
      templates,
      candidatesEvaluated: evaluated,
      candidatesRejected: rejected,
      latencyMs: performance.now() - started
    }
  }

  generateTemplates(input: RemindSpeakRequest): readonly string[] {
    return this.generate(input).templates
  }
}

export function unavailableRemindSpeakInfo(error: unknown): RemindSpeakInfo {
  return {
    available: false,
    id: 'remindspeak-unavailable',
    version: '0.1.0',
    architecture: 'PhraseLattice conditional surface generator',
    parameterCount: 0,
    quantization: 'symmetric-int8-per-output-channel',
    modelBytes: 0,
    workingSetBytes: 0,
    mode: 'protected-overgenerate-rerank',
    candidateCount: 0,
    teacherUsed: false,
    networkRequired: false,
    error:
      error instanceof Error ? error.message : 'The bundled response model could not be loaded.'
  }
}
