import type {
  DocumentPage,
  DocumentTextBlock,
  PlanScanAnalysis,
  PlanScanBlockPrediction,
  PlanScanBlockRole,
  PlanScanDocumentType,
  PlanScanEntityRole,
  PlanScanGroup,
  PlanScanRelation,
  PlanScanRelationType,
  PlanScanSpan
} from '@remind-me/contracts'

const blockRoles = [
  'heading',
  'plan-title',
  'plan-field',
  'description',
  'metadata',
  'decorative',
  'other'
] as const satisfies readonly PlanScanBlockRole[]

const entityRoles = [
  'title',
  'date',
  'time',
  'location',
  'description',
  'reminder-cue',
  'recurrence',
  'other'
] as const satisfies readonly PlanScanEntityRole[]

const relationTypes = [
  'none',
  'same-plan',
  'title-field',
  'date-time',
  'field-detail',
  'sequence'
] as const satisfies readonly PlanScanRelationType[]

const documentTypes = [
  'schedule',
  'syllabus',
  'invitation',
  'flyer',
  'itinerary',
  'rotation',
  'table',
  'screenshot'
] as const satisfies readonly PlanScanDocumentType[]

const qualityLabels = [
  'clear',
  'ocr-risk',
  'crowded',
  'ambiguous',
  'decorative',
  'partial',
  'noise'
] as const

const groupLinkLabels = ['none', 'same-group', 'new-group', 'context'] as const

type PlanScanHeadName =
  'blockRole' | 'entityRole' | 'relation' | 'groupLink' | 'documentType' | 'confidence'

interface PlanScanHeadArtifact {
  labels: string[]
  buckets: number
  byteOffset: number
  byteLength: number
  scale: number[]
  bias: number[]
  temperature: number
}

export interface PlanScanArtifact {
  schemaVersion: 1
  id: string
  version: string
  contractVersion: string
  architecture: {
    name: string
    parameterCount: number
    parameterInitialization: 'zero'
    featureEncoder: string
    graphDecoder: string
    quantization: string
  }
  featureBuckets: number
  hashAlgorithm: 'fnv1a-32-utf8'
  heads: Record<PlanScanHeadName, PlanScanHeadArtifact>
  weights: {
    path: string
    compression: 'gzip'
    uncompressedBytes: number
    sha256Uncompressed: string
  }
  thresholds: {
    entity: number
    relation: number
    group: number
    scanReview: number
  }
  training: {
    seed: number
    datasetManifestSha256: string
    teacherUsed: false
    pretrainedWeightsUsed: false
    personalDataUsed: false
  }
  metrics: Record<string, unknown>
}

interface LoadedHead {
  labels: readonly string[]
  buckets: number
  scale: Float32Array
  bias: Float32Array
  temperature: number
  weights: Int8Array
}

interface BlockContext {
  block: DocumentTextBlock
  index: number
  pageBlocks: readonly DocumentTextBlock[]
  features: readonly string[]
  prediction: PlanScanBlockPrediction
}

interface ScoredSpan {
  span: PlanScanSpan
  block: DocumentTextBlock
}

interface LabelScore<T extends string> {
  label: T
  confidence: number
  probabilities: ReadonlyMap<string, number>
}

export interface PlanScanRuntimeInfo {
  available: true
  id: string
  version: string
  architecture: string
  parameterCount: number
  quantization: string
  modelBytes: number
  workingSetBytes: number
  mode: 'evidence-gated-spatial-graph'
  teacherUsed: false
  networkRequired: false
  error: null
}

const encoder = new TextEncoder()
const monthPattern =
  '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)'
const weekdayPattern = '(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)'
const datePatterns = [
  new RegExp(`\\b${monthPattern}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?\\b`, 'iu'),
  new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${monthPattern}(?:,?\\s+\\d{4})?\\b`, 'iu'),
  /\b\d{4}-\d{2}-\d{2}\b/u,
  /\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/u,
  new RegExp(`\\b(?:(?:this|next)\\s+)?${weekdayPattern}\\b`, 'iu'),
  /\b(?:today|tomorrow|day after tomorrow)\b/iu
] as const
const clockWithMinutes = '(?:[01]?\\d|2[0-3]):[0-5]\\d(?:\\s*[ap]\\.?m\\.?)?'
const clockWithMeridiem = '(?:0?[1-9]|1[0-2])(?::[0-5]\\d)?\\s*[ap]\\.?m\\.?'
const clockToken = `(?:${clockWithMinutes}|${clockWithMeridiem}|noon|midnight)`
const timePattern = new RegExp(
  `\\b(?:from\\s+)?(?:${clockToken}(?:\\s*(?:-|–|—|to|until)\\s*${clockToken})?)\\b`,
  'iu'
)
const recurrencePattern =
  /\b(?:every|each|weekly|monthly|daily|weekdays?|biweekly|fortnightly)\b[^.;|]*/iu
const reminderCuePattern = /\b(?:reminder|remind me|due|deadline|to[- ]?do)\b/iu
const locationPattern = /^(?:location|where|room|venue)\s*[:\-–—]\s*(.+)$/iu
const tokenPattern = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function expectString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Invalid PlanScan ${name}`)
  return value
}

function expectNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new Error(`Invalid PlanScan ${name}`)
  return value
}

function expectBooleanFalse(value: unknown, name: string): false {
  if (value !== false) throw new Error(`PlanScan ${name} must be false`)
  return false
}

function sameLabels(actual: unknown, expected: readonly string[], name: string): string[] {
  if (!Array.isArray(actual) || actual.some((value) => typeof value !== 'string')) {
    throw new Error(`Invalid PlanScan ${name} labels`)
  }
  if (actual.join('|') !== expected.join('|')) throw new Error(`Unexpected PlanScan ${name} labels`)
  return [...actual] as string[]
}

function parseHead(
  value: unknown,
  labels: readonly string[],
  featureBuckets: number,
  name: PlanScanHeadName
): PlanScanHeadArtifact {
  if (!isRecord(value)) throw new Error(`Missing PlanScan ${name} head`)
  const scale = value.scale
  const bias = value.bias
  const parsedLabels = sameLabels(value.labels, labels, name)
  if (!Array.isArray(scale) || scale.some((item) => typeof item !== 'number' || item <= 0)) {
    throw new Error(`Invalid PlanScan ${name} scales`)
  }
  if (!Array.isArray(bias) || bias.some((item) => typeof item !== 'number')) {
    throw new Error(`Invalid PlanScan ${name} biases`)
  }
  const buckets = expectNumber(value.buckets, `${name} buckets`)
  const byteOffset = expectNumber(value.byteOffset, `${name} offset`)
  const byteLength = expectNumber(value.byteLength, `${name} length`)
  const temperature = expectNumber(value.temperature, `${name} temperature`)
  if (
    !Number.isInteger(buckets) ||
    buckets !== featureBuckets ||
    !Number.isInteger(byteOffset) ||
    byteOffset < 0 ||
    !Number.isInteger(byteLength) ||
    byteLength !== labels.length * buckets ||
    scale.length !== labels.length ||
    bias.length !== labels.length ||
    temperature <= 0
  ) {
    throw new Error(`PlanScan ${name} dimensions are inconsistent`)
  }
  return {
    labels: parsedLabels,
    buckets,
    byteOffset,
    byteLength,
    scale: scale as number[],
    bias: bias as number[],
    temperature
  }
}

export function parsePlanScanArtifact(value: unknown): PlanScanArtifact {
  if (!isRecord(value) || value.schemaVersion !== 1)
    throw new Error('Unsupported PlanScan artifact')
  if (!isRecord(value.architecture) || !isRecord(value.weights) || !isRecord(value.heads)) {
    throw new Error('Incomplete PlanScan artifact')
  }
  if (!isRecord(value.thresholds) || !isRecord(value.training) || !isRecord(value.metrics)) {
    throw new Error('Incomplete PlanScan training metadata')
  }
  const featureBuckets = expectNumber(value.featureBuckets, 'feature buckets')
  if (!Number.isInteger(featureBuckets) || featureBuckets <= 0) {
    throw new Error('Invalid PlanScan feature buckets')
  }
  const heads = {
    blockRole: parseHead(value.heads.blockRole, blockRoles, featureBuckets, 'blockRole'),
    entityRole: parseHead(value.heads.entityRole, entityRoles, featureBuckets, 'entityRole'),
    relation: parseHead(value.heads.relation, relationTypes, featureBuckets, 'relation'),
    groupLink: parseHead(value.heads.groupLink, groupLinkLabels, featureBuckets, 'groupLink'),
    documentType: parseHead(
      value.heads.documentType,
      documentTypes,
      featureBuckets,
      'documentType'
    ),
    confidence: parseHead(value.heads.confidence, qualityLabels, featureBuckets, 'confidence')
  }
  const thresholds = {
    entity: expectNumber(value.thresholds.entity, 'entity threshold'),
    relation: expectNumber(value.thresholds.relation, 'relation threshold'),
    group: expectNumber(value.thresholds.group, 'group threshold'),
    scanReview: expectNumber(value.thresholds.scanReview, 'scan review threshold')
  }
  if (Object.values(thresholds).some((threshold) => threshold < 0 || threshold > 1)) {
    throw new Error('PlanScan thresholds must be probabilities')
  }
  return {
    schemaVersion: 1,
    id: expectString(value.id, 'id'),
    version: expectString(value.version, 'version'),
    contractVersion: expectString(value.contractVersion, 'contract version'),
    architecture: {
      name: expectString(value.architecture.name, 'architecture name'),
      parameterCount: expectNumber(value.architecture.parameterCount, 'parameter count'),
      parameterInitialization:
        value.architecture.parameterInitialization === 'zero'
          ? 'zero'
          : (() => {
              throw new Error('PlanScan must declare zero initialization')
            })(),
      featureEncoder: expectString(value.architecture.featureEncoder, 'feature encoder'),
      graphDecoder: expectString(value.architecture.graphDecoder, 'graph decoder'),
      quantization: expectString(value.architecture.quantization, 'quantization')
    },
    featureBuckets,
    hashAlgorithm:
      value.hashAlgorithm === 'fnv1a-32-utf8'
        ? value.hashAlgorithm
        : (() => {
            throw new Error('Unsupported PlanScan hash algorithm')
          })(),
    heads,
    weights: {
      path: expectString(value.weights.path, 'weights path'),
      compression:
        value.weights.compression === 'gzip'
          ? 'gzip'
          : (() => {
              throw new Error('PlanScan weights must use gzip')
            })(),
      uncompressedBytes: expectNumber(value.weights.uncompressedBytes, 'weight bytes'),
      sha256Uncompressed: expectString(value.weights.sha256Uncompressed, 'weight digest')
    },
    thresholds,
    training: {
      seed: expectNumber(value.training.seed, 'training seed'),
      datasetManifestSha256: expectString(value.training.datasetManifestSha256, 'dataset digest'),
      teacherUsed: expectBooleanFalse(value.training.teacherUsed, 'teacherUsed'),
      pretrainedWeightsUsed: expectBooleanFalse(
        value.training.pretrainedWeightsUsed,
        'pretrainedWeightsUsed'
      ),
      personalDataUsed: expectBooleanFalse(value.training.personalDataUsed, 'personalDataUsed')
    },
    metrics: value.metrics
  }
}

function fnv1a32(value: string): number {
  let result = 2_166_136_261
  for (const byte of encoder.encode(value)) {
    result ^= byte
    result = Math.imul(result, 16_777_619) >>> 0
  }
  return result
}

function normalizeText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase()
}

function tokens(value: string): string[] {
  return normalizeText(value).match(tokenPattern) ?? []
}

function bucket(value: number, count: number): number {
  return Math.max(0, Math.min(count - 1, Math.floor(value * count)))
}

function confidenceBucket(value: number): number {
  return Math.max(0, Math.min(4, Math.floor(value * 5)))
}

function signedBucket(value: number): number {
  if (value <= -0.24) return -3
  if (value <= -0.08) return -2
  if (value < -0.02) return -1
  if (value <= 0.02) return 0
  if (value < 0.08) return 1
  if (value < 0.24) return 2
  return 3
}

function lexicalFlags(text: string): string[] {
  const flags: string[] = []
  if (datePatterns.some((pattern) => pattern.test(text))) flags.push('flag:date')
  if (timePattern.test(text)) flags.push('flag:time')
  if (locationPattern.test(text)) flags.push('flag:location')
  if (reminderCuePattern.test(text)) flags.push('flag:reminder')
  if (recurrencePattern.test(text)) flags.push('flag:recurrence')
  if (/^[A-Z\d\s&'’\-–—:]{4,}$/u.test(text.trim())) flags.push('flag:uppercase')
  if (/^\s*[•·*\-–—]/u.test(text)) flags.push('flag:bullet')
  if (/\|/u.test(text)) flags.push('flag:pipe')
  if (/\b(?:agenda|schedule|syllabus|itinerary|rotation|important dates)\b/iu.test(text)) {
    flags.push('flag:document-heading')
  }
  return flags
}

export function planScanBlockFeatures(
  block: DocumentTextBlock,
  index: number,
  pageBlocks: readonly DocumentTextBlock[],
  includeGeometry = true
): string[] {
  const normalized = normalizeText(block.text)
  const blockTokens = tokens(block.text)
  const features = new Set<string>([
    'bias',
    `method:${block.method}`,
    `confidence:${confidenceBucket(block.confidence)}`,
    `token-count:${Math.min(12, blockTokens.length)}`,
    `char-count:${Math.min(12, Math.floor(normalized.length / 12))}`,
    ...lexicalFlags(block.text)
  ])
  for (const token of blockTokens.slice(0, 24)) {
    features.add(`token:${token}`)
    features.add(`prefix:${token.slice(0, 3)}`)
    features.add(`suffix:${token.slice(-3)}`)
  }
  if (blockTokens[0]) features.add(`first:${blockTokens[0]}`)
  if (blockTokens.at(-1)) features.add(`last:${blockTokens.at(-1)}`)
  for (let tokenIndex = 0; tokenIndex < Math.min(12, blockTokens.length - 1); tokenIndex += 1) {
    features.add(`bigram:${blockTokens[tokenIndex]}|${blockTokens[tokenIndex + 1]}`)
  }
  if (/\d/u.test(normalized)) features.add('shape:digit')
  if (/\d{4}/u.test(normalized)) features.add('shape:four-digits')
  if (/:/u.test(normalized)) features.add('shape:colon')
  if (/[-–—]/u.test(normalized)) features.add('shape:dash')
  if (includeGeometry) {
    const box = block.boundingBox
    features.add(`x:${bucket(box.x, 8)}`)
    features.add(`y:${bucket(box.y, 10)}`)
    features.add(`width:${bucket(box.width, 6)}`)
    features.add(`height:${bucket(box.height, 6)}`)
    features.add(`column:${bucket(box.x + box.width / 2, 4)}`)
    features.add(`position:${bucket(index / Math.max(1, pageBlocks.length), 10)}`)
  }
  for (const [direction, neighbor] of [
    ['previous', pageBlocks[index - 1]],
    ['next', pageBlocks[index + 1]]
  ] as const) {
    if (!neighbor) continue
    const neighborTokens = tokens(neighbor.text)
    if (neighborTokens[0]) features.add(`${direction}-first:${neighborTokens[0]}`)
    for (const flag of lexicalFlags(neighbor.text)) features.add(`${direction}-${flag}`)
  }
  return [...features].sort()
}

function documentFeatures(contexts: readonly BlockContext[], includeGeometry = true): string[] {
  const features = new Set<string>(['bias', `blocks:${Math.min(12, contexts.length)}`])
  const flags = new Map<string, number>()
  for (const context of contexts) {
    for (const flag of lexicalFlags(context.block.text)) {
      flags.set(flag, (flags.get(flag) ?? 0) + 1)
    }
    for (const token of tokens(context.block.text).slice(0, 8)) features.add(`doc-token:${token}`)
  }
  for (const [flag, count] of flags) features.add(`doc-${flag}:${Math.min(5, count)}`)
  if (includeGeometry && contexts.length > 1) {
    const rowPairs = contexts.slice(1).filter((context, index) => {
      const previous = contexts[index]
      return previous && Math.abs(context.block.boundingBox.y - previous.block.boundingBox.y) < 0.02
    }).length
    features.add(`row-pairs:${Math.min(5, rowPairs)}`)
    const columns = new Set(contexts.map((context) => bucket(context.block.boundingBox.x, 4))).size
    features.add(`columns:${columns}`)
  }
  return [...features].sort()
}

export function planScanPairFeatures(
  from: BlockContext,
  to: BlockContext,
  includeGeometry = true
): string[] {
  const features = new Set<string>([
    'bias',
    `from-entity:${from.prediction.entityRole}`,
    `to-entity:${to.prediction.entityRole}`,
    `entity-pair:${from.prediction.entityRole}|${to.prediction.entityRole}`,
    `block-pair:${from.prediction.blockRole}|${to.prediction.blockRole}`,
    `order-gap:${Math.min(8, Math.abs(to.index - from.index))}`,
    `method-pair:${from.block.method}|${to.block.method}`
  ])
  if (includeGeometry) {
    const fromCenterX = from.block.boundingBox.x + from.block.boundingBox.width / 2
    const fromCenterY = from.block.boundingBox.y + from.block.boundingBox.height / 2
    const toCenterX = to.block.boundingBox.x + to.block.boundingBox.width / 2
    const toCenterY = to.block.boundingBox.y + to.block.boundingBox.height / 2
    const dx = toCenterX - fromCenterX
    const dy = toCenterY - fromCenterY
    features.add(`dx:${signedBucket(dx)}`)
    features.add(`dy:${signedBucket(dy)}`)
    features.add(`same-row:${Number(Math.abs(dy) <= 0.035)}`)
    features.add(`same-column:${Number(Math.abs(dx) <= 0.12)}`)
    features.add(`direction:${Math.abs(dx) > Math.abs(dy) ? 'horizontal' : 'vertical'}`)
  }
  for (const flag of lexicalFlags(from.block.text)) features.add(`from-${flag}`)
  for (const flag of lexicalFlags(to.block.text)) features.add(`to-${flag}`)
  return [...features].sort()
}

function featureIds(features: readonly string[], buckets: number): number[] {
  return [...new Set(features.map((feature) => fnv1a32(feature) % buckets))].sort(
    (left, right) => left - right
  )
}

function scoreHead<T extends string>(head: LoadedHead, features: readonly string[]): LabelScore<T> {
  const ids = featureIds(features, head.buckets)
  const divisor = Math.sqrt(Math.max(1, ids.length))
  const logits = head.labels.map((label, labelIndex) => {
    let score = head.bias[labelIndex] ?? 0
    const offset = labelIndex * head.buckets
    const scale = head.scale[labelIndex] ?? 1
    for (const id of ids) score += ((head.weights[offset + id] ?? 0) * scale) / divisor
    return { label: label as T, score: score / head.temperature }
  })
  const maximum = Math.max(...logits.map((item) => item.score))
  const exponentials = logits.map((item) => Math.exp(item.score - maximum))
  const total = exponentials.reduce((sum, value) => sum + value, 0)
  const probabilities = new Map<string, number>()
  logits.forEach((item, index) => probabilities.set(item.label, (exponentials[index] ?? 0) / total))
  const best = logits.reduce((left, right) => (right.score > left.score ? right : left))
  return {
    label: best.label,
    confidence: probabilities.get(best.label) ?? 0,
    probabilities
  }
}

function matchFirst(text: string, patterns: readonly RegExp[]): RegExpMatchArray | null {
  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (match) return match
  }
  return null
}

function exactSpan(
  block: DocumentTextBlock,
  role: Exclude<PlanScanEntityRole, 'other'>,
  match: RegExpMatchArray,
  confidence: number,
  suffix: string
): PlanScanSpan | null {
  const matched = match[0]
  const start = match.index ?? block.text.indexOf(matched)
  if (start < 0 || !matched.trim()) return null
  const leading = matched.length - matched.trimStart().length
  const trailing = matched.length - matched.trimEnd().length
  const exactStart = start + leading
  const exactEnd = start + matched.length - trailing
  return {
    id: `planscan-span:${block.id}:${suffix}:${exactStart}:${exactEnd}`,
    blockId: block.id,
    page: block.page,
    role,
    text: block.text.slice(exactStart, exactEnd),
    start: exactStart,
    end: exactEnd,
    wordIds: [...block.wordIds],
    boundingBox: block.boundingBox,
    confidence: Math.max(0, Math.min(1, confidence))
  }
}

function spansForContext(context: BlockContext, entityThreshold: number): PlanScanSpan[] {
  const { block, prediction } = context
  const spans: PlanScanSpan[] = []
  const roleConfidence = prediction.roleConfidence
  const push = (span: PlanScanSpan | null): void => {
    if (
      span &&
      !spans.some(
        (item) => item.role === span.role && item.start === span.start && item.end === span.end
      )
    ) {
      spans.push(span)
    }
  }
  const dateMatch = matchFirst(block.text, datePatterns)
  if (dateMatch && prediction.entityRole !== 'recurrence') {
    push(exactSpan(block, 'date', dateMatch, Math.max(0.62, roleConfidence), 'date'))
  }
  const timeMatch = block.text.match(timePattern)
  if (timeMatch) push(exactSpan(block, 'time', timeMatch, Math.max(0.62, roleConfidence), 'time'))
  const recurrenceMatch = block.text.match(recurrencePattern)
  if (
    recurrenceMatch &&
    (prediction.entityRole === 'recurrence' || prediction.blockRole === 'plan-field')
  ) {
    push(
      exactSpan(block, 'recurrence', recurrenceMatch, Math.max(0.58, roleConfidence), 'recurrence')
    )
  }
  const cueMatch = block.text.match(reminderCuePattern)
  if (cueMatch) {
    push(exactSpan(block, 'reminder-cue', cueMatch, Math.max(0.66, roleConfidence), 'reminder'))
  }
  const locationMatch = block.text.match(locationPattern)
  if (locationMatch?.[1]) {
    const valueStart = block.text.lastIndexOf(locationMatch[1])
    const valueMatch = [locationMatch[1]] as unknown as RegExpMatchArray
    valueMatch.index = valueStart
    valueMatch.input = block.text
    push(exactSpan(block, 'location', valueMatch, Math.max(0.65, roleConfidence), 'location'))
  }
  if (
    prediction.roleConfidence >= entityThreshold &&
    (prediction.entityRole === 'title' || prediction.blockRole === 'plan-title')
  ) {
    const whole = block.text.match(/\S(?:[\s\S]*\S)?/u)
    if (whole) push(exactSpan(block, 'title', whole, roleConfidence, 'title'))
  }
  if (prediction.roleConfidence >= entityThreshold && prediction.entityRole === 'description') {
    const whole = block.text.match(/\S(?:[\s\S]*\S)?/u)
    if (whole) push(exactSpan(block, 'description', whole, roleConfidence, 'description'))
  }
  return spans
}

function center(block: DocumentTextBlock): { x: number; y: number } {
  return {
    x: block.boundingBox.x + block.boundingBox.width / 2,
    y: block.boundingBox.y + block.boundingBox.height / 2
  }
}

function geometryAffinity(left: DocumentTextBlock, right: DocumentTextBlock): number {
  const a = center(left)
  const b = center(right)
  const dx = Math.abs(a.x - b.x)
  const dy = Math.abs(a.y - b.y)
  const sameRow = dy <= 0.035 ? 0.96 - Math.min(0.36, dx * 0.4) : 0
  const sameColumn = dx <= 0.16 ? 0.9 - Math.min(0.55, dy * 2.2) : 0
  return Math.max(0, sameRow, sameColumn)
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)]
}

function relationTypeFor(
  left: PlanScanSpan,
  right: PlanScanSpan
): Exclude<PlanScanRelationType, 'none'> {
  const pair = `${left.role}|${right.role}`
  if (pair === 'date|time' || pair === 'time|date') return 'date-time'
  if (left.role === 'title' || right.role === 'title') return 'title-field'
  if (
    left.role === 'description' ||
    right.role === 'description' ||
    left.role === 'location' ||
    right.role === 'location'
  ) {
    return 'field-detail'
  }
  return 'same-plan'
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copied = Uint8Array.from(bytes)
  const digest = await crypto.subtle.digest('SHA-256', copied.buffer)
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')
}

export async function decompressPlanScanWeights(compressed: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This runtime cannot decompress the bundled PlanScan model')
  }
  const source = new Blob([Uint8Array.from(compressed).buffer])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'))
  return new Uint8Array(await new Response(source).arrayBuffer())
}

export class PlanScanRuntime {
  readonly info: PlanScanRuntimeInfo
  private readonly artifact: PlanScanArtifact
  private readonly heads: Record<PlanScanHeadName, LoadedHead>

  private constructor(artifact: PlanScanArtifact, weights: Uint8Array, compressedBytes: number) {
    this.artifact = artifact
    this.heads = Object.fromEntries(
      (Object.keys(artifact.heads) as PlanScanHeadName[]).map((name) => {
        const head = artifact.heads[name]
        return [
          name,
          {
            labels: head.labels,
            buckets: head.buckets,
            scale: Float32Array.from(head.scale),
            bias: Float32Array.from(head.bias),
            temperature: head.temperature,
            weights: new Int8Array(
              weights.buffer,
              weights.byteOffset + head.byteOffset,
              head.byteLength
            )
          } satisfies LoadedHead
        ]
      })
    ) as unknown as Record<PlanScanHeadName, LoadedHead>
    this.info = {
      available: true,
      id: artifact.id,
      version: artifact.version,
      architecture: artifact.architecture.name,
      parameterCount: artifact.architecture.parameterCount,
      quantization: artifact.architecture.quantization,
      modelBytes: compressedBytes,
      workingSetBytes: weights.byteLength,
      mode: 'evidence-gated-spatial-graph',
      teacherUsed: false,
      networkRequired: false,
      error: null
    }
  }

  static async create(
    configuration: unknown,
    compressedWeights: Uint8Array
  ): Promise<PlanScanRuntime> {
    const artifact = parsePlanScanArtifact(configuration)
    const weights = await decompressPlanScanWeights(compressedWeights)
    if (weights.byteLength !== artifact.weights.uncompressedBytes) {
      throw new Error(
        `PlanScan weights are ${weights.byteLength} bytes; expected ${artifact.weights.uncompressedBytes}`
      )
    }
    const digest = await sha256Hex(weights)
    if (digest !== artifact.weights.sha256Uncompressed) {
      throw new Error('PlanScan decompressed weight checksum mismatch')
    }
    const headBytes = Object.values(artifact.heads).reduce(
      (total, head) => total + head.byteLength,
      0
    )
    if (headBytes !== weights.byteLength || artifact.architecture.parameterCount !== headBytes) {
      throw new Error('PlanScan parameter inventory does not match its weight table')
    }
    return new PlanScanRuntime(artifact, weights, compressedWeights.byteLength)
  }

  analyze(pages: readonly DocumentPage[]): PlanScanAnalysis {
    const startedAt = performance.now()
    const predictions: PlanScanBlockPrediction[] = []
    const contexts: BlockContext[] = []
    for (const page of pages) {
      const pageBlocks = [...page.blocks].sort(
        (left, right) =>
          left.boundingBox.y - right.boundingBox.y || left.boundingBox.x - right.boundingBox.x
      )
      for (let index = 0; index < pageBlocks.length; index += 1) {
        const block = pageBlocks[index]
        if (!block) continue
        const features = planScanBlockFeatures(block, index, pageBlocks)
        const blockRole = scoreHead<PlanScanBlockRole>(this.heads.blockRole, features)
        const entityRole = scoreHead<PlanScanEntityRole>(this.heads.entityRole, features)
        const quality = scoreHead<(typeof qualityLabels)[number]>(this.heads.confidence, features)
        const prediction: PlanScanBlockPrediction = {
          blockId: block.id,
          page: block.page,
          blockRole: blockRole.label,
          entityRole: entityRole.label,
          roleConfidence: entityRole.confidence,
          qualityConfidence: quality.probabilities.get('clear') ?? 0
        }
        predictions.push(prediction)
        contexts.push({ block, index, pageBlocks, features, prediction })
      }
    }

    const documentType = scoreHead<PlanScanDocumentType>(
      this.heads.documentType,
      documentFeatures(contexts)
    )
    const spans = contexts.flatMap((context) =>
      spansForContext(context, this.artifact.thresholds.entity)
    )
    const scoredSpans: ScoredSpan[] = spans.flatMap((span) => {
      const context = contexts.find((item) => item.block.id === span.blockId)
      return context ? [{ span, block: context.block }] : []
    })
    const spanById = new Map(scoredSpans.map((item) => [item.span.id, item] as const))
    const contextByBlock = new Map(contexts.map((context) => [context.block.id, context] as const))
    const relations: PlanScanRelation[] = []
    const groups: PlanScanGroup[] = []
    const usedTitles = new Set<string>()
    const usedTimes = new Set<string>()
    const usedLocations = new Set<string>()
    const usedRecurrences = new Set<string>()
    const dates = scoredSpans.filter((item) => item.span.role === 'date')
    const times = scoredSpans.filter((item) => item.span.role === 'time')
    const titles = scoredSpans.filter((item) => item.span.role === 'title')
    const locations = scoredSpans.filter((item) => item.span.role === 'location')
    const descriptions = scoredSpans.filter((item) => item.span.role === 'description')
    const recurrences = scoredSpans.filter((item) => item.span.role === 'recurrence')

    const association = (left: ScoredSpan, right: ScoredSpan): number => {
      const from = contextByBlock.get(left.block.id)
      const to = contextByBlock.get(right.block.id)
      if (!from || !to || left.span.page !== right.span.page) return 0
      const relation = scoreHead<PlanScanRelationType>(
        this.heads.relation,
        planScanPairFeatures(from, to)
      )
      const groupLink = scoreHead<(typeof groupLinkLabels)[number]>(
        this.heads.groupLink,
        planScanPairFeatures(from, to)
      )
      const learned = Math.max(
        relation.probabilities.get('same-plan') ?? 0,
        relation.probabilities.get('title-field') ?? 0,
        relation.probabilities.get('date-time') ?? 0,
        relation.probabilities.get('field-detail') ?? 0
      )
      const link = groupLink.probabilities.get('same-group') ?? 0
      return 0.42 * learned + 0.28 * link + 0.3 * geometryAffinity(left.block, right.block)
    }

    for (const date of dates) {
      const nextAlignedDate = dates
        .filter(
          (candidate) =>
            candidate.span.page === date.span.page &&
            candidate.block.boundingBox.y > date.block.boundingBox.y + 0.004 &&
            Math.abs(candidate.block.boundingBox.x - date.block.boundingBox.x) <= 0.08
        )
        .sort((left, right) => left.block.boundingBox.y - right.block.boundingBox.y)[0]
      const insideDateRow = (item: ScoredSpan): boolean =>
        item.block.boundingBox.y >= date.block.boundingBox.y - 0.025 &&
        (!nextAlignedDate || item.block.boundingBox.y < nextAlignedDate.block.boundingBox.y - 0.002)
      const titleCandidates = titles
        .filter((item) => item.span.page === date.span.page && !usedTitles.has(item.span.id))
        .map((item) => ({ item, score: association(date, item) }))
        .sort((left, right) => right.score - left.score)
      const title = titleCandidates[0]
      if (!title || title.score < this.artifact.thresholds.relation) continue
      const timeCandidates = times
        .filter(
          (item) =>
            item.span.page === date.span.page && !usedTimes.has(item.span.id) && insideDateRow(item)
        )
        .map((item) => ({
          item,
          score: Math.max(association(date, item), association(title.item, item))
        }))
        .sort((left, right) => right.score - left.score)
      const time = timeCandidates[0]
      const allDay = /\ball[- ]day\b/iu.test(`${date.block.text} ${title.item.block.text}`)
      if ((!time || time.score < this.artifact.thresholds.relation) && !allDay) continue
      const selectedTime = time && time.score >= this.artifact.thresholds.relation ? time : null
      const location = locations
        .filter(
          (item) =>
            item.span.page === date.span.page &&
            !usedLocations.has(item.span.id) &&
            insideDateRow(item)
        )
        .map((item) => ({
          item,
          score: Math.max(association(date, item), association(title.item, item)),
          geometry: Math.max(
            geometryAffinity(date.block, item.block),
            geometryAffinity(title.item.block, item.block)
          )
        }))
        .sort((left, right) => right.score - left.score)[0]
      const selectedLocation =
        location &&
        (location.score >= this.artifact.thresholds.relation * 0.72 || location.geometry >= 0.45)
          ? location
          : null
      const recurrence = recurrences
        .filter(
          (item) =>
            item.span.page === date.span.page &&
            !usedRecurrences.has(item.span.id) &&
            insideDateRow(item)
        )
        .map((item) => ({
          item,
          score: Math.max(association(date, item), association(title.item, item))
        }))
        .sort((left, right) => right.score - left.score)[0]
      const selectedRecurrence =
        recurrence && recurrence.score >= this.artifact.thresholds.relation ? recurrence : null
      const selectedDescriptions = descriptions
        .filter(
          (item) =>
            item.span.page === date.span.page &&
            insideDateRow(item) &&
            association(date, item) >= this.artifact.thresholds.relation
        )
        .slice(0, 3)
      const selected = [
        title.item,
        date,
        selectedTime?.item,
        selectedLocation?.item,
        selectedRecurrence?.item,
        ...selectedDescriptions
      ].filter((item): item is ScoredSpan => Boolean(item))
      const sourceText = selected.map((item) => item.block.text).join(' ')
      const kind = reminderCuePattern.test(sourceText) ? 'reminder' : 'event'
      const scanConfidence =
        selected.reduce((total, item) => total + item.block.confidence, 0) / selected.length
      const linkScores = [title.score, selectedTime?.score ?? 0.82]
      const groupConfidence = Math.max(
        0,
        Math.min(
          1,
          (0.34 * (date.span.confidence + title.item.span.confidence)) / 2 +
            0.36 * (linkScores.reduce((total, value) => total + value, 0) / linkScores.length) +
            0.3 * scanConfidence
        )
      )
      if (groupConfidence < this.artifact.thresholds.group) continue
      const groupIndex = groups.length
      const groupId = `planscan-group:${date.span.page}:${groupIndex}`
      groups.push({
        id: groupId,
        page: date.span.page,
        kind,
        confidence: groupConfidence,
        titleSpanId: title.item.span.id,
        dateSpanId: date.span.id,
        timeSpanId: selectedTime?.item.span.id ?? null,
        locationSpanId: selectedLocation?.item.span.id ?? null,
        descriptionSpanIds: selectedDescriptions.map((item) => item.span.id),
        recurrenceSpanId: selectedRecurrence?.item.span.id ?? null,
        evidenceBlockIds: unique(selected.map((item) => item.block.id))
      })
      usedTitles.add(title.item.span.id)
      if (selectedTime) usedTimes.add(selectedTime.item.span.id)
      if (selectedLocation) usedLocations.add(selectedLocation.item.span.id)
      if (selectedRecurrence) usedRecurrences.add(selectedRecurrence.item.span.id)
      for (const item of selected.filter((candidate) => candidate.span.id !== title.item.span.id)) {
        const confidence = association(title.item, item)
        if (confidence < this.artifact.thresholds.relation) continue
        relations.push({
          id: `planscan-relation:${groupIndex}:${relations.length}`,
          page: date.span.page,
          fromSpanId: title.item.span.id,
          toSpanId: item.span.id,
          type: relationTypeFor(title.item.span, item.span),
          confidence
        })
      }
    }

    const scanGroups = groups.filter((group) =>
      group.evidenceBlockIds.some((id) => contextByBlock.get(id)?.block.method === 'ocr')
    )
    const warnings: string[] = []
    if (scanGroups.some((group) => group.confidence < this.artifact.thresholds.scanReview)) {
      warnings.push(
        'PlanScan found a lower-confidence OCR group; compare every field with its highlighted source.'
      )
    }
    if (groups.length === 0 && spans.length > 0) {
      warnings.push(
        'PlanScan found calendar-like fields but withheld grouping because their learned links were uncertain.'
      )
    }
    for (const group of groups) {
      for (const spanId of [
        group.titleSpanId,
        group.dateSpanId,
        group.timeSpanId,
        group.locationSpanId,
        group.recurrenceSpanId,
        ...group.descriptionSpanIds
      ]) {
        if (spanId && !spanById.has(spanId))
          throw new Error('PlanScan emitted an unknown evidence span')
      }
    }
    return {
      modelId: this.artifact.id,
      modelVersion: this.artifact.version,
      architecture: this.artifact.architecture.name,
      parameterCount: this.artifact.architecture.parameterCount,
      quantization: this.artifact.architecture.quantization,
      documentType: documentType.label,
      documentTypeConfidence: documentType.confidence,
      blockPredictions: predictions,
      spans,
      relations,
      groups,
      processingDurationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      warnings
    }
  }
}
