import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { assistantCapabilityIdSchema, type AssistantCapabilityId } from '@remind-me/contracts'
import { z } from 'zod'

const remindCoreHeadSchema = z
  .object({
    name: z.string().min(1),
    labels: z.array(z.string().min(1)).min(2),
    buckets: z.number().int().positive(),
    scale: z.array(z.number().positive()).min(2),
    bias: z.array(z.number()),
    temperature: z.number().positive(),
    weightsBase64: z.string().min(1)
  })
  .strict()

const remindCoreThresholdsSchema = z
  .object({
    operationConfidence: z.number().min(0).max(1),
    ambiguityProbability: z.number().min(0).max(1),
    oodProbability: z.number().min(0).max(1),
    safeAssistedOperations: z.array(z.string().min(1)),
    destructiveAlwaysConfirmationOnly: z.literal(true),
    seriesAlwaysConfirmationOnly: z.literal(true),
    teacherDistillation: z
      .object({
        method: z.string().min(1),
        baseExamples: z.number().int().positive(),
        teacherExamples: z.number().int().nonnegative(),
        teacherExamplesWithNovelFeatures: z.number().int().nonnegative(),
        novelBuckets: z.number().int().nonnegative(),
        baseDevelopmentAccuracy: z.number().min(0).max(1),
        maximumDevelopmentAccuracyDrop: z.number().min(0).max(1),
        selectedStrength: z.number().nonnegative(),
        candidates: z.array(
          z
            .object({
              strength: z.number().nonnegative(),
              developmentAccuracy: z.number().min(0).max(1),
              teacherChallengeAccuracy: z.number().min(0).max(1),
              eligible: z.boolean()
            })
            .strict()
        )
      })
      .strict()
      .optional()
  })
  .strict()

const assistantRouteSchema = z.enum([
  'calendar',
  'conversation',
  'memory',
  'broad-chat',
  'app',
  'document'
])

const remindCoreAssistantSchema = z
  .object({
    schemaVersion: z.literal(1),
    buckets: z.number().int().positive(),
    maximumActions: z.literal(3),
    routes: z.array(assistantRouteSchema).length(6),
    capabilityOrder: z.array(assistantCapabilityIdSchema).length(42),
    capabilityRoutes: z.array(assistantRouteSchema).length(42),
    capabilityCues: z.array(z.array(z.string().min(1)).min(1)).length(42),
    featureEncoder: z
      .object({
        normalization: z.string().min(1),
        hashAlgorithm: z.literal('FNV-1a 32-bit over UTF-8'),
        wordNgrams: z.tuple([z.literal(1), z.literal(2)]),
        skipBigrams: z.literal(2),
        characterNgrams: z.array(z.union([z.literal(3), z.literal(4), z.literal(5)])).max(3),
        projectSignals: z.boolean(),
        typedContext: z.boolean(),
        segmenter: z.string().min(1)
      })
      .strict(),
    heads: z
      .object({
        route: remindCoreHeadSchema,
        capability: remindCoreHeadSchema,
        actionCount: remindCoreHeadSchema,
        context: remindCoreHeadSchema
      })
      .strict(),
    thresholds: z
      .object({
        routingAssistanceConfidence: z.number().min(0).max(1),
        safeAdvisoryRoutes: z.array(assistantRouteSchema).min(1),
        minimumDevelopmentPrecision: z.number().min(0).max(1),
        contextRequiredNeedsTypedContext: z.literal(true),
        neverCreatesPlans: z.literal(true),
        neverWritesDatabase: z.literal(true)
      })
      .strict(),
    training: z.record(z.string(), z.unknown()),
    metrics: z.record(z.string(), z.unknown())
  })
  .strict()

const remindCoreArtifactSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1),
    version: z.string().min(1),
    contractVersion: z.string().min(1),
    architecture: z
      .object({
        name: z.string().min(1),
        parameterCount: z.number().int().positive(),
        parameterInitialization: z.string().min(1),
        featureEncoder: z.string().min(1),
        heads: z.array(z.string().min(1)),
        quantization: z.string().min(1)
      })
      .strict(),
    globalBuckets: z.number().int().positive(),
    tokenBuckets: z.number().int().positive(),
    hashAlgorithm: z.literal('fnv1a-32-utf8'),
    heads: z
      .object({
        operation: remindCoreHeadSchema,
        ambiguity: remindCoreHeadSchema,
        ood: remindCoreHeadSchema,
        risk: remindCoreHeadSchema,
        token: remindCoreHeadSchema
      })
      .strict(),
    thresholds: remindCoreThresholdsSchema,
    training: z
      .object({
        seed: z.number().int(),
        operationOrderSeedOffsets: z.array(z.number().int()).min(1),
        datasetManifestSha256: z.string().regex(/^[a-f0-9]{64}$/u),
        teacherUsed: z.boolean(),
        teacherModelId: z.string().min(1).nullable().optional(),
        teacherCorpusSha256: z
          .string()
          .regex(/^[a-f0-9]{64}$/u)
          .nullable()
          .optional(),
        teacherRole: z.string().min(1).optional(),
        pretrainedWeightsUsed: z.literal(false),
        personalDataUsed: z.literal(false),
        assistantCorpusManifestSha256: z
          .string()
          .regex(/^[a-f0-9]{64}$/u)
          .optional(),
        assistantCorpusVersion: z.string().min(1).optional(),
        capabilityMetadataSha256: z
          .string()
          .regex(/^[a-f0-9]{64}$/u)
          .optional(),
        assistantTeacherRole: z.string().min(1).optional(),
        assistantTeacherOutputSha256: z
          .string()
          .regex(/^[a-f0-9]{64}$/u)
          .optional(),
        assistantStudentInitialization: z.string().min(1).optional()
      })
      .strict(),
    metrics: z.record(z.string(), z.unknown()),
    assistant: remindCoreAssistantSchema.optional()
  })
  .strict()

interface LoadedHead {
  labels: string[]
  buckets: number
  scale: Float32Array
  bias: Float32Array
  temperature: number
  weights: Int8Array
}

export interface RemindCoreSpan {
  kind: 'TITLE' | 'TARGET' | 'DATE' | 'TIME' | 'RECURRENCE'
  start: number
  end: number
  text: string
  confidence: number
  decoder: 'bio' | 'constrained-copy'
}

export interface RemindCorePrediction {
  operation: string
  operationConfidence: number
  ambiguityProbability: number
  oodProbability: number
  risk: string
  riskConfidence: number
  spans: RemindCoreSpan[]
  eligibleForAssistance: boolean
  latencyMs: number
}

export interface RemindCoreAssistantContext {
  focusedKind: 'event' | 'reminder' | 'mixed' | 'memory'
  focusedCount: number
  ordinal: number | null
  priorCapabilityId: AssistantCapabilityId | null
  pendingCapabilityId: AssistantCapabilityId | null
}

export interface RemindCoreAssistantPrediction {
  route: z.infer<typeof assistantRouteSchema>
  routeConfidence: number
  actionCount: 1 | 2 | 3
  actionCountConfidence: number
  capabilities: AssistantCapabilityId[]
  capabilityConfidences: number[]
  contextRequired: boolean
  contextRequiredProbability: number
  planConfidence: number
  eligibleForRoutingAssistance: boolean
  latencyMs: number
}

export interface RemindCoreInfo {
  available: boolean
  id: string
  version: string
  architecture: string
  parameterCount: number
  quantization: string
  modelBytes: number
  mode: 'confidence-gated-hybrid'
  teacherUsed: boolean
  assistantPlanAvailable: boolean
  nativeCapabilityCount: number
  networkRequired: false
  error: string | null
}

interface TextToken {
  text: string
  normalized: string
  start: number
  end: number
}

interface PredictedToken extends TextToken {
  label: string
  confidence: number
}

const tokenPattern = /[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*|[^\s]/gu
const encoder = new TextEncoder()

interface LoadedAssistant {
  route: LoadedHead
  capability: LoadedHead
  actionCount: LoadedHead
  context: LoadedHead
  routes: Array<z.infer<typeof assistantRouteSchema>>
  capabilityOrder: AssistantCapabilityId[]
  capabilityRoutes: Map<AssistantCapabilityId, z.infer<typeof assistantRouteSchema>>
  capabilityCues: Map<AssistantCapabilityId, string[]>
  characterNgrams: number[]
  projectSignals: boolean
  typedContext: boolean
  routingAssistanceConfidence: number
  safeAdvisoryRoutes: Set<z.infer<typeof assistantRouteSchema>>
}

const temporalWords = new Set([
  'next',
  'this',
  'after',
  'from',
  'through',
  'until',
  'today',
  'tomorrow',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
  'am',
  'pm',
  'noon',
  'midnight',
  'morning',
  'afternoon',
  'evening',
  'night',
  'daily',
  'weekly',
  'monthly',
  'yearly',
  'weekday',
  'weekdays'
])

const copyFillers = new Set([
  'a',
  'about',
  'add',
  'agenda',
  'an',
  'any',
  'at',
  'booked',
  'calendar',
  'can',
  'carve',
  'create',
  'day',
  'do',
  'don',
  'event',
  'for',
  'forget',
  'give',
  'have',
  'hold',
  'i',
  'in',
  'into',
  'is',
  'it',
  'jog',
  'let',
  'make',
  'me',
  'memory',
  'my',
  'nudge',
  'of',
  'on',
  'out',
  'pencil',
  'please',
  'prompt',
  'remind',
  'reminder',
  'room',
  'schedule',
  'set',
  'something',
  'sure',
  'the',
  'time',
  'to',
  'what',
  'where',
  'would',
  'you',
  'track',
  'down',
  'find',
  'locate',
  'hunt'
])

const semanticCuePatterns: ReadonlyArray<[string, RegExp]> = [
  ['event.create', /\b(?:carve|pencil|penciled|make room|hold)\b/u],
  ['reminder.create', /\b(?:nudge|jog my memory|forget|prompt me|give me a prompt)\b/u],
  [
    'calendar.list',
    /\b(?:what do i have|show me my schedule|what(?:'s| is) on my|rundown|agenda|walk me through|how is .+ looking|(?:first|second|third|fourth|fifth|earliest|next|previous|last|final|latest) (?:class|course|lecture|lab|discussion|event|meeting|appointment|reminder))\b/u
  ],
  ['calendar.search', /\b(?:locate|hunt down|hunt for|track down|where did i put)\b/u],
  ['calendar.availability', /\b(?:squeeze|space in my day|calendar look clear|have room)\b/u],
  ['calendar.conflicts', /\b(?:clashes|collisions|bump into|competing plans)\b/u],
  ['event.move', /\b(?:move|reschedule|shift|slide)\b/u],
  ['event.duplicate', /\b(?:duplicate|copy|clone|another|second)\b/u],
  ['event.update', /\b(?:retitle|new name)\b/u],
  ['event.delete', /\b(?:scrap|take .+ off)\b/u],
  ['reminder.update', /\b(?:reword|edit .+ say|change reminder)\b/u],
  ['reminder.complete', /\b(?:cross .+ off|tick .+ off|mark .+ done|check off)\b/u],
  ['reminder.delete', /\b(?:drop (?:the )?reminder|erase (?:the )?reminder|remove my reminder)\b/u],
  [
    'assistant.unsupported',
    /\b(?:debug|email|flight|grocery list|rain|recipe|restaurant|reserve a table|ticket|translate|weather)\b/u
  ]
]

function normalizeText(text: string): string {
  return text.normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu, ' ').trim()
}

function tokenize(text: string): TextToken[] {
  const tokens: TextToken[] = []
  tokenPattern.lastIndex = 0
  for (const match of text.matchAll(tokenPattern)) {
    const start = match.index
    tokens.push({
      text: match[0],
      normalized: normalizeText(match[0]),
      start,
      end: start + match[0].length
    })
  }
  return tokens
}

function tokenShape(token: string): string {
  const output: string[] = []
  for (const character of token) {
    const shape = /[A-Z]/u.test(character)
      ? 'A'
      : /[a-z]/u.test(character)
        ? 'a'
        : /\d/u.test(character)
          ? '0'
          : 'x'
    if (output.at(-1) !== shape) output.push(shape)
  }
  return output.join('').slice(0, 8)
}

function fnv1a32(text: string): number {
  let value = 2_166_136_261
  for (const byte of encoder.encode(text)) {
    value ^= byte
    value = Math.imul(value, 16_777_619) >>> 0
  }
  return value
}

function idsFor(features: ReadonlySet<string>, buckets: number): number[] {
  return [...new Set([...features].map((feature) => fnv1a32(feature) % buckets))].sort(
    (left, right) => left - right
  )
}

function globalFeatures(text: string): Set<string> {
  const normalized = normalizeText(text).slice(0, 320)
  const tokens = tokenize(normalized)
    .slice(0, 64)
    .map((token) => token.normalized)
  const dateSignal =
    /\b(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2})\b/u.test(
      normalized
    )
  const timeSignal =
    /\b(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)|noon|midnight|morning|afternoon|evening|night)\b/u.test(
      normalized
    )
  const calendarSignal =
    /\b(?:calendar|schedule|agenda|plan|plans|remind|reminder|free|available|event|meeting|appointment|conflict|overlap|booked|move|shift|duplicate|copy|clone|delete|cancel|done)\b/u.test(
      normalized
    )
  const features = new Set([
    'bias',
    `length:${Math.min(12, Math.floor(tokens.length / 3))}`,
    `date-signal:${Number(dateSignal)}`,
    `time-signal:${Number(timeSignal)}`,
    `calendar-signal:${Number(calendarSignal)}`,
    `temporal-pair:${Number(dateSignal)}${Number(timeSignal)}`
  ])
  for (const [operation, pattern] of semanticCuePatterns) {
    if (pattern.test(normalized)) {
      features.add(`semantic-cue:${operation}`)
      for (let rank = 0; rank < 4; rank += 1) {
        features.add(`semantic-cue-boost:${operation}:${rank}`)
      }
    }
  }
  tokens.forEach((token, index) => {
    features.add(`w:${token}`)
    features.add(`shape:${tokenShape(token)}`)
    features.add(`p2:${token.slice(0, 2)}`)
    features.add(`p3:${token.slice(0, 3)}`)
    features.add(`s2:${token.slice(-2)}`)
    features.add(`s3:${token.slice(-3)}`)
    const previous = tokens[index - 1]
    if (previous !== undefined) features.add(`w2:${previous}|${token}`)
  })
  const padded = `^^${normalized}$$`
  for (const size of [3, 4, 5]) {
    for (let index = 0; index <= padded.length - size; index += 1) {
      features.add(`c${size}:${padded.slice(index, index + size)}`)
    }
  }
  return features
}

const assistantSignalPatterns = new Map<string, RegExp>([
  [
    'calendar',
    /\b(?:agenda|appointment|book|calendar|class|course|event|meeting|plan|schedule)\w*\b/iu
  ],
  ['reminder', /\b(?:alert|nudge|remind|reminder|task)\w*\b/iu],
  [
    'query',
    /\b(?:available|availability|busy|conflict|details?|find|free|list|locate|next|overview|search|show|summari[sz]e|what|when|where|which)\b/iu
  ],
  ['memory', /\b(?:call me|forget|memory|preference|remember|stored)\b/iu],
  [
    'app',
    /\b(?:appearance|color|density|glance|navigate|open|pin|settings|startup|theme|view|widget|window)\b/iu
  ],
  ['document', /\b(?:attach|document|file|ics|image|import|pdf|scan)\b/iu],
  ['model', /\b(?:fallback|install|language pack|local model|model|qwen|uninstall)\b/iu],
  [
    'conversation',
    /\b(?:appreciate|chat|encouragement|explain|goodbye|hello|help|how are you|thank|who are you)\b/iu
  ],
  [
    'mutation',
    /\b(?:add|book|cancel|change|clear|complete|copy|create|delete|dismiss|duplicate|edit|move|remove|rename|repeat|reschedule|set|shift|update|wipe)\w*\b/iu
  ],
  ['destructive', /\b(?:cancel|clear|delete|dismiss|erase|forget|remove|uninstall|wipe)\w*\b/iu],
  ['recurrence', /\b(?:daily|every|monthly|repeat|weekly|weekday|yearly)\w*\b/iu],
  ['bulk', /\b(?:all|both|each|entire|every|everything|full|multiple)\b/iu],
  [
    'date',
    /\b(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|\d{1,4}[/-]\d{1,2})\b/iu
  ],
  [
    'time',
    /\b(?:\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)|noon|midnight|morning|afternoon|evening|night)\b/iu
  ]
])

function assistantBaseFeatures(
  text: string,
  options: { characterNgrams: readonly number[]; projectSignals: boolean }
): Set<string> {
  const normalized = normalizeText(text).slice(0, 400)
  const tokens = tokenize(normalized)
    .slice(0, 80)
    .map((token) => token.normalized)
  const features = new Set([
    'bias',
    `length:${Math.min(16, Math.floor(tokens.length / 3))}`,
    `question:${Number(text.includes('?'))}`,
    `exclamation:${Number(text.includes('!'))}`
  ])
  if (options.projectSignals) {
    for (const [name, pattern] of assistantSignalPatterns) {
      features.add(`signal:${name}:${Number(pattern.test(normalized))}`)
    }
  }
  tokens.forEach((token, index) => {
    features.add(`w:${token}`)
    features.add(`shape:${tokenShape(token)}`)
    features.add(`p2:${token.slice(0, 2)}`)
    features.add(`p3:${token.slice(0, 3)}`)
    features.add(`p4:${token.slice(0, 4)}`)
    features.add(`s2:${token.slice(-2)}`)
    features.add(`s3:${token.slice(-3)}`)
    features.add(`s4:${token.slice(-4)}`)
    const previous = tokens[index - 1]
    const skipPrevious = tokens[index - 2]
    if (previous !== undefined) features.add(`w2:${previous}|${token}`)
    if (skipPrevious !== undefined) features.add(`skip2:${skipPrevious}|${token}`)
  })
  const padded = `^^${normalized}$$`
  for (const size of options.characterNgrams) {
    for (let index = 0; index <= padded.length - size; index += 1) {
      features.add(`c${size}:${padded.slice(index, index + size)}`)
    }
  }
  return features
}

function assistantContextFeatures(context: RemindCoreAssistantContext | null): Set<string> {
  if (!context) return new Set(['ctx:none'])
  const count = Math.min(4, Math.max(0, Math.trunc(context.focusedCount)))
  const ordinal = context.ordinal ?? 'none'
  const prior = context.priorCapabilityId ?? 'none'
  const pending = context.pendingCapabilityId ?? 'none'
  return new Set([
    'ctx:present',
    `ctx:kind:${context.focusedKind}`,
    `ctx:count:${count}`,
    `ctx:ordinal:${ordinal}`,
    `ctx:prior:${prior}`,
    `ctx:pending:${pending}`,
    `ctx:kind+count:${context.focusedKind}|${count}`
  ])
}

function assistantTurnFeatures(
  text: string,
  context: RemindCoreAssistantContext | null,
  assistant: LoadedAssistant
): Set<string> {
  const features = assistantBaseFeatures(text, assistant)
  if (assistant.typedContext) {
    for (const feature of assistantContextFeatures(context)) features.add(feature)
  }
  return features
}

const assistantSeparatorPattern = /;\s*|,\s*(?:and\s+|then\s+)?|\s+then\s+|\s+and\s+/giu

function assistantActionSegments(text: string, count: 1 | 2 | 3): string[] {
  if (count === 1) return [text.trim()]
  assistantSeparatorPattern.lastIndex = 0
  const matches = [...text.matchAll(assistantSeparatorPattern)].filter((match) => {
    const start = match.index
    return (
      text.slice(0, start).trim().length > 0 &&
      text.slice(start + match[0].length).trim().length > 0
    )
  })
  const selected = matches.slice(-(count - 1))
  const parts: string[] = []
  let start = 0
  for (const match of selected) {
    const left = match.index
    const right = left + match[0].length
    parts.push(text.slice(start, left).replace(/^[\s,;]+|[\s,;]+$/gu, ''))
    start = right
  }
  parts.push(text.slice(start).replace(/^[\s,;]+|[\s,;]+$/gu, ''))
  const compact = parts.filter(Boolean)
  while (compact.length < count) {
    let longestIndex = 0
    for (let index = 1; index < compact.length; index += 1) {
      if ((compact[index]?.length ?? 0) > (compact[longestIndex]?.length ?? 0)) longestIndex = index
    }
    const value = compact.splice(longestIndex, 1)[0] ?? text
    const words = tokenize(value)
    if (words.length < 2) {
      compact.splice(longestIndex, 0, value)
      compact.push(value)
      continue
    }
    const pivot = words[Math.floor(words.length / 2)]?.start ?? Math.floor(value.length / 2)
    compact.splice(longestIndex, 0, value.slice(0, pivot).trim(), value.slice(pivot).trim())
  }
  return compact.slice(0, count)
}

function assistantCapabilityFeatures(
  text: string,
  segment: string,
  actionIndex: number,
  actionCount: 1 | 2 | 3,
  assistant: LoadedAssistant
): Set<string> {
  const turn = new Set(
    [
      ...assistantBaseFeatures(text, {
        characterNgrams: [],
        projectSignals: assistant.projectSignals
      })
    ].filter(
      (feature) =>
        feature.startsWith('signal:') ||
        feature.startsWith('length:') ||
        feature.startsWith('question:') ||
        feature.startsWith('exclamation:')
    )
  )
  const local = assistantBaseFeatures(segment, assistant)
  const features = new Set([...turn].map((feature) => `turn:${feature}`))
  for (const feature of local) features.add(`segment:${feature}`)
  features.add(`action-index:${actionIndex}`)
  features.add(`action-count:${actionCount}`)
  features.add(`action-position:${actionIndex}/${actionCount}`)
  const normalizedSegment = normalizeText(segment)
  for (const [capabilityId, cues] of assistant.capabilityCues) {
    if (cues.some((cue) => assistantCueMatches(normalizedSegment, cue))) {
      for (let rank = 0; rank < 4; rank += 1) {
        features.add(`capability-cue:${capabilityId}:${rank}`)
      }
    }
  }
  return features
}

function assistantCueMatches(normalizedText: string, cue: string): boolean {
  const escaped = cue.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return new RegExp(`\\b${escaped}\\w*\\b`, 'iu').test(normalizedText)
}

const assistantActionCuePattern =
  /\b(?:add|backup|book|cancel|change|check|clear|complete|copy|delete|details?|dismiss|duplicate|edit|enable|explain|export|find|finish|forget|free|gap|help|import|install|introduce|launch|list|load|locate|mark|mirror|move|next|nudge|open|overview|pin|read|recall|remember|remind|remove|rename|repeat|reschedule|restore|save|scan|search|set|shift|show|summari[sz]e|switch|tell|theme|uninstall|update|where|wipe|window)\w*\b/iu

const assistantGroundedTimePattern =
  /\b(?:\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)|noon|midnight)\b/giu

function assistantDeterministicActionCount(text: string): 1 | 2 | 3 | null {
  const normalized = normalizeText(text)
  assistantSeparatorPattern.lastIndex = 0
  const separators = [...normalized.matchAll(assistantSeparatorPattern)]
  const explicitTransitions = separators.filter((match) => {
    const tail = normalized.slice(match.index + match[0].length).trimStart()
    return new RegExp(
      `^(?:${assistantActionCuePattern.source})`,
      assistantActionCuePattern.flags
    ).test(tail)
  }).length
  if (explicitTransitions > 0) return Math.min(3, explicitTransitions + 1) as 2 | 3

  if (/\bremind\w*\b/iu.test(normalized) && /\s+and\s+to\s+/iu.test(normalized)) return 2
  if (/\bthen\s+(?:also\s+)?put\b/iu.test(normalized)) return 2

  if (/\b(?:add|book|create|schedule)\w*\b/iu.test(normalized) && separators.length > 0) {
    assistantGroundedTimePattern.lastIndex = 0
    const groundedTimes = [...normalized.matchAll(assistantGroundedTimePattern)].length
    if (groundedTimes >= 2) return Math.min(3, groundedTimes) as 2 | 3
  }
  return null
}

function tokenFeatures(
  tokens: readonly TextToken[],
  index: number,
  operation: string
): Set<string> {
  const token = tokens[index]
  if (!token) return new Set()
  const previous = tokens[index - 1]?.normalized ?? '<s>'
  const following = tokens[index + 1]?.normalized ?? '</s>'
  const value = token.normalized
  const features = new Set([
    'bias',
    `tok:${value}`,
    `prev:${previous}`,
    `next:${following}`,
    `prev+tok:${previous}|${value}`,
    `tok+next:${value}|${following}`,
    `shape:${tokenShape(token.text)}`,
    `p2:${value.slice(0, 2)}`,
    `p3:${value.slice(0, 3)}`,
    `s2:${value.slice(-2)}`,
    `s3:${value.slice(-3)}`,
    `position:${Math.min(7, Math.floor((index * 8) / Math.max(1, tokens.length)))}`,
    `intent:${operation}`,
    `intent+prev:${operation}|${previous}`,
    `intent+next:${operation}|${following}`
  ])
  const wrapped = `^${value}$`
  for (const size of [2, 3, 4]) {
    for (let start = 0; start <= wrapped.length - size; start += 1) {
      features.add(`tc${size}:${wrapped.slice(start, start + size)}`)
    }
  }
  return features
}

function loadHead(input: z.infer<typeof remindCoreHeadSchema>): LoadedHead {
  if (input.bias.length !== input.labels.length || input.scale.length !== input.labels.length) {
    throw new Error(`${input.name} scale/bias length does not match its labels`)
  }
  const bytes = Buffer.from(input.weightsBase64, 'base64')
  if (bytes.byteLength !== input.labels.length * input.buckets) {
    throw new Error(`${input.name} INT8 table has an unexpected length`)
  }
  return {
    labels: input.labels,
    buckets: input.buckets,
    scale: Float32Array.from(input.scale),
    bias: Float32Array.from(input.bias),
    temperature: input.temperature,
    weights: new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }
}

function logits(head: LoadedHead, ids: readonly number[]): number[] {
  const divisor = Math.sqrt(Math.max(1, ids.length))
  return head.labels.map((_label, labelIndex) => {
    let score = head.bias[labelIndex] ?? 0
    const offset = labelIndex * head.buckets
    const scale = head.scale[labelIndex] ?? 1
    for (const id of ids) score += ((head.weights[offset + id] ?? 0) * scale) / divisor
    return score
  })
}

function probabilities(head: LoadedHead, ids: readonly number[]): number[] {
  const values = logits(head, ids).map((value) => value / Math.max(0.05, head.temperature))
  const maximum = Math.max(...values)
  const exponentials = values.map((value) => Math.exp(value - maximum))
  const total = exponentials.reduce((sum, value) => sum + value, 0)
  return exponentials.map((value) => value / total)
}

function topPrediction(head: LoadedHead, ids: readonly number[]): [string, number] {
  const values = probabilities(head, ids)
  let top = 0
  for (let index = 1; index < values.length; index += 1) {
    if ((values[index] ?? 0) > (values[top] ?? 0)) top = index
  }
  return [head.labels[top] ?? head.labels[0] ?? 'unknown', values[top] ?? 0]
}

function decodeBio(tokens: readonly PredictedToken[], source: string): RemindCoreSpan[] {
  const spans: RemindCoreSpan[] = []
  let active: RemindCoreSpan | null = null
  for (const token of tokens) {
    if (token.label === 'O') {
      if (active) spans.push(active)
      active = null
      continue
    }
    const [prefix, rawKind] = token.label.split('-')
    const kind = rawKind as RemindCoreSpan['kind'] | undefined
    if (!kind) continue
    if (prefix === 'B' || !active || active.kind !== kind) {
      if (active) spans.push(active)
      active = {
        kind,
        start: token.start,
        end: token.end,
        text: source.slice(token.start, token.end),
        confidence: token.confidence,
        decoder: 'bio'
      }
    } else {
      active.end = token.end
      active.text = source.slice(active.start, active.end)
      active.confidence = Math.min(active.confidence, token.confidence)
    }
  }
  if (active) spans.push(active)
  return spans
}

function constrainedCopy(
  tokens: readonly PredictedToken[],
  source: string,
  kind: 'TITLE' | 'TARGET'
): RemindCoreSpan | null {
  const candidates: Array<{ index: number; token: PredictedToken; selected: boolean }> = []
  let recurrenceActive = false
  tokens.forEach((token, index) => {
    const value = token.normalized.replace(/^[.,?!:]+|[.,?!:]+$/gu, '')
    recurrenceActive ||= ['every', 'daily', 'weekly', 'monthly', 'yearly'].includes(value)
    const temporal =
      recurrenceActive ||
      temporalWords.has(value) ||
      /^\d+(?::\d+)?$/u.test(value) ||
      /^\d{1,4}[-/]\d{1,2}(?:[-/]\d{1,4})?$/u.test(value)
    const filler = copyFillers.has(value) || !/[A-Za-z0-9]/u.test(value)
    if (!temporal && !filler) {
      candidates.push({ index, token, selected: token.label.endsWith(`-${kind}`) })
    }
  })
  const groups: Array<typeof candidates> = []
  for (const candidate of candidates) {
    const lastGroup = groups.at(-1)
    if (!lastGroup || candidate.index !== (lastGroup.at(-1)?.index ?? -2) + 1) {
      groups.push([candidate])
    } else {
      lastGroup.push(candidate)
    }
  }
  const preferred = groups.sort((left, right) => {
    const length = (group: typeof candidates): number =>
      group.reduce((total, item) => total + item.token.text.length, 0)
    const selected = (group: typeof candidates): number =>
      group.reduce((total, item) => total + Number(item.selected), 0)
    return length(right) - length(left) || selected(right) - selected(left)
  })[0]
  const first = preferred?.[0]?.token
  const last = preferred?.at(-1)?.token
  if (!first || !last) return null
  return {
    kind,
    start: first.start,
    end: last.end,
    text: source.slice(first.start, last.end),
    confidence: Math.min(...preferred.map((item) => item.token.confidence)),
    decoder: 'constrained-copy'
  }
}

export class RemindCorePlanner {
  readonly info: RemindCoreInfo
  private readonly operation: LoadedHead
  private readonly ambiguity: LoadedHead
  private readonly ood: LoadedHead
  private readonly risk: LoadedHead
  private readonly token: LoadedHead
  private readonly assistant: LoadedAssistant | null
  private readonly thresholds: z.infer<typeof remindCoreThresholdsSchema>

  private constructor(artifact: z.infer<typeof remindCoreArtifactSchema>, modelBytes: number) {
    this.operation = loadHead(artifact.heads.operation)
    this.ambiguity = loadHead(artifact.heads.ambiguity)
    this.ood = loadHead(artifact.heads.ood)
    this.risk = loadHead(artifact.heads.risk)
    this.token = loadHead(artifact.heads.token)
    const assistantArtifact = artifact.assistant
    if (assistantArtifact) {
      const route = loadHead(assistantArtifact.heads.route)
      const capability = loadHead(assistantArtifact.heads.capability)
      const actionCount = loadHead(assistantArtifact.heads.actionCount)
      const context = loadHead(assistantArtifact.heads.context)
      if (
        route.labels.join('\u0000') !== assistantArtifact.routes.join('\u0000') ||
        capability.labels.join('\u0000') !== assistantArtifact.capabilityOrder.join('\u0000') ||
        actionCount.labels.join('\u0000') !== '1\u00002\u00003' ||
        context.labels.join('\u0000') !== 'standalone\u0000contextual'
      ) {
        throw new Error('RemindCore Next head labels drifted from its assistant contract')
      }
      this.assistant = {
        route,
        capability,
        actionCount,
        context,
        routes: [...assistantArtifact.routes],
        capabilityOrder: [...assistantArtifact.capabilityOrder],
        capabilityRoutes: new Map(
          assistantArtifact.capabilityOrder.map((capability, index) => [
            capability,
            assistantArtifact.capabilityRoutes[index] ?? 'broad-chat'
          ])
        ),
        capabilityCues: new Map(
          assistantArtifact.capabilityOrder.map((capability, index) => [
            capability,
            assistantArtifact.capabilityCues[index] ?? []
          ])
        ),
        characterNgrams: [...assistantArtifact.featureEncoder.characterNgrams],
        projectSignals: assistantArtifact.featureEncoder.projectSignals,
        typedContext: assistantArtifact.featureEncoder.typedContext,
        routingAssistanceConfidence: assistantArtifact.thresholds.routingAssistanceConfidence,
        safeAdvisoryRoutes: new Set(assistantArtifact.thresholds.safeAdvisoryRoutes)
      }
    } else {
      this.assistant = null
    }
    this.thresholds = artifact.thresholds
    this.info = {
      available: true,
      id: artifact.id,
      version: artifact.version,
      architecture: artifact.architecture.name,
      parameterCount: artifact.architecture.parameterCount,
      quantization: artifact.architecture.quantization,
      modelBytes,
      mode: 'confidence-gated-hybrid',
      teacherUsed: artifact.training.teacherUsed,
      assistantPlanAvailable: this.assistant !== null,
      nativeCapabilityCount: this.assistant?.capabilityOrder.length ?? 13,
      networkRequired: false,
      error: null
    }
  }

  static async load(modelRoot: string): Promise<RemindCorePlanner> {
    const path = resolve(modelRoot, 'remindcore', 'remindcore-v0.1-int8.json')
    const contents = await readFile(path, 'utf8')
    const artifact = remindCoreArtifactSchema.parse(JSON.parse(contents))
    return new RemindCorePlanner(artifact, Buffer.byteLength(contents))
  }

  predict(text: string): RemindCorePrediction {
    const started = performance.now()
    const globalIds = idsFor(globalFeatures(text), this.operation.buckets)
    const [operation, operationConfidence] = topPrediction(this.operation, globalIds)
    const ambiguityValues = probabilities(this.ambiguity, globalIds)
    const oodValues = probabilities(this.ood, globalIds)
    const [risk, riskConfidence] = topPrediction(this.risk, globalIds)
    const sourceTokens = tokenize(text)
    const predictedTokens: PredictedToken[] = sourceTokens.map((sourceToken, index) => {
      const ids = idsFor(tokenFeatures(sourceTokens, index, operation), this.token.buckets)
      const [label, confidence] = topPrediction(this.token, ids)
      return { ...sourceToken, label, confidence }
    })
    const spans = decodeBio(predictedTokens, text)
    const desiredCopyKind = ['event.create', 'reminder.create'].includes(operation)
      ? 'TITLE'
      : operation === 'calendar.search'
        ? 'TARGET'
        : null
    if (desiredCopyKind) {
      const copied = constrainedCopy(predictedTokens, text, desiredCopyKind)
      if (copied) {
        const existingIndex = spans.findIndex((span) => span.kind === desiredCopyKind)
        if (existingIndex >= 0) spans.splice(existingIndex, 1, copied)
        else spans.push(copied)
      }
    }
    const ambiguityProbability = ambiguityValues[1] ?? 0
    const oodProbability = oodValues[1] ?? 0
    const requiredCopyPresent =
      desiredCopyKind === null || spans.some((span) => span.kind === desiredCopyKind)
    const eligibleForAssistance =
      operationConfidence >= this.thresholds.operationConfidence &&
      ambiguityProbability < this.thresholds.ambiguityProbability &&
      oodProbability < this.thresholds.oodProbability &&
      this.thresholds.safeAssistedOperations.includes(operation) &&
      requiredCopyPresent
    return {
      operation,
      operationConfidence,
      ambiguityProbability,
      oodProbability,
      risk,
      riskConfidence,
      spans: spans.sort((left, right) => left.start - right.start),
      eligibleForAssistance,
      latencyMs: performance.now() - started
    }
  }

  classifyAssistant(
    text: string,
    context: RemindCoreAssistantContext | null = null
  ): RemindCoreAssistantPrediction | null {
    const started = performance.now()
    const assistant = this.assistant
    if (!assistant) return null
    const turnIds = idsFor(assistantTurnFeatures(text, context, assistant), assistant.route.buckets)
    const [rawRoute, routeConfidence] = topPrediction(assistant.route, turnIds)
    const route = assistantRouteSchema.parse(rawRoute)
    const [rawCount, actionCountConfidence] = topPrediction(assistant.actionCount, turnIds)
    const countNumber = Number.parseInt(rawCount, 10)
    const learnedActionCount = (countNumber >= 1 && countNumber <= 3 ? countNumber : 1) as 1 | 2 | 3
    const actionCount = assistantDeterministicActionCount(text) ?? learnedActionCount
    const contextProbabilities = probabilities(assistant.context, turnIds)
    const contextRequiredProbability = contextProbabilities[1] ?? 0
    const contextRequired = contextRequiredProbability >= (contextProbabilities[0] ?? 1)
    const capabilities: AssistantCapabilityId[] = []
    const capabilityConfidences: number[] = []
    for (const [actionIndex, segment] of assistantActionSegments(text, actionCount).entries()) {
      const featureIds = idsFor(
        assistantCapabilityFeatures(text, segment, actionIndex, actionCount, assistant),
        assistant.capability.buckets
      )
      const capabilityProbabilities = probabilities(assistant.capability, featureIds)
      const allowed = assistant.capability.labels
        .map((label, index) => ({ label: assistantCapabilityIdSchema.parse(label), index }))
        .filter(({ label }) => assistant.capabilityRoutes.get(label) === route)
      const candidates =
        allowed.length > 0
          ? allowed
          : assistant.capability.labels.map((label, index) => ({
              label: assistantCapabilityIdSchema.parse(label),
              index
            }))
      const normalizedSegment = normalizeText(segment)
      const cueMatched = candidates.filter(({ label }) =>
        (assistant.capabilityCues.get(label) ?? []).some((cue) =>
          assistantCueMatches(normalizedSegment, cue)
        )
      )
      const selected =
        cueMatched.length === 1
          ? cueMatched[0]
          : candidates.reduce((best, candidate) =>
              (capabilityProbabilities[candidate.index] ?? 0) >
              (capabilityProbabilities[best.index] ?? 0)
                ? candidate
                : best
            )
      if (!selected) throw new Error('RemindCore Next had no capability candidate')
      let capability = selected.label
      let confidence = capabilityProbabilities[selected.index] ?? 0
      if (actionIndex > 0 && !assistantActionCuePattern.test(normalizeText(segment))) {
        capability = capabilities.at(-1) ?? capability
        confidence = capabilityConfidences.at(-1) ?? confidence
      }
      capabilities.push(capability)
      capabilityConfidences.push(confidence)
    }
    const planConfidence = Math.min(
      routeConfidence,
      actionCountConfidence,
      Math.max(contextProbabilities[0] ?? 0, contextProbabilities[1] ?? 0),
      ...capabilityConfidences
    )
    const typedContextAvailable = context !== null
    const eligibleForRoutingAssistance =
      routeConfidence >= assistant.routingAssistanceConfidence &&
      assistant.safeAdvisoryRoutes.has(route) &&
      (!contextRequired || typedContextAvailable)
    return {
      route,
      routeConfidence,
      actionCount,
      actionCountConfidence,
      capabilities,
      capabilityConfidences,
      contextRequired,
      contextRequiredProbability,
      planConfidence,
      eligibleForRoutingAssistance,
      latencyMs: performance.now() - started
    }
  }
}

export function unavailableRemindCoreInfo(error: unknown): RemindCoreInfo {
  return {
    available: false,
    id: 'remindcore-unavailable',
    version: '0.1.0',
    architecture: 'HashFrame joint semantic planner',
    parameterCount: 0,
    quantization: 'symmetric-int8-per-output-channel',
    modelBytes: 0,
    mode: 'confidence-gated-hybrid',
    teacherUsed: false,
    assistantPlanAvailable: false,
    nativeCapabilityCount: 0,
    networkRequired: false,
    error: error instanceof Error ? error.message : 'The bundled planner could not be loaded.'
  }
}
