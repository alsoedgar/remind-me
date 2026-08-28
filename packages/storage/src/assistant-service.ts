import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { Temporal } from '@js-temporal/polyfill'
import {
  assistantPlanForCapability,
  assistantPlanFromCalendarDrafts,
  createGroundedReply,
  getActionDisposition,
  normalizeAssistantText,
  parseBulkClearIntent,
  parseProposalReviewCorrection,
  parseProposalReviewQuery,
  parseScopedBulkClearRequest,
  planCalendarTextHybrid,
  parseScheduleReplicationRequest,
  repairKnownMutationTargets,
  resolveContextualRequest,
  routeAssistantRequest,
  splitCalendarRequests,
  typoPhraseSimilarity,
  type ConversationIntent,
  type ContextualItemDescriptor,
  type ContextualResolution,
  type BulkClearIntent,
  type MemoryIntent,
  type ProposalReviewCorrection,
  type ProposalReviewQuery,
  type ScheduleReplicationIntent,
  type SemanticPlannerPrediction
} from '@remind-me/assistant-core'
import {
  dryRunCalendarCommand,
  expandEventOccurrences,
  expandEventsInRange,
  resolveCalendarIR
} from '@remind-me/calendar-engine'
import {
  unavailableRemindCoreInfo,
  type RemindCoreInfo,
  type RemindCoreAssistantContext,
  type RemindCoreAssistantPrediction,
  type RemindCorePlanner,
  type RemindCorePrediction,
  unavailableRemindSpeakInfo,
  type RemindSpeakInfo,
  type RemindSpeakPlanner
} from '@remind-me/model-runtime'
import {
  assistantConfirmRequestSchema,
  assistantConversationSchema,
  assistantExchangeSchema,
  assistantFeedbackRequestSchema,
  assistantFeedbackResponseSchema,
  assistantProposalSchema,
  assistantRejectRequestSchema,
  assistantSendRequestSchema,
  calendarIRResolvedSchema,
  conversationTurnEntitySchema,
  eventFormSchema,
  flexModelCalendarFactPacketSchema,
  flexModelCalendarFallbackResultSchema,
  flexModelGeneralFallbackResultSchema,
  reminderFormSchema,
  type AssistantConfirmRequest,
  type AssistantConversation,
  type AssistantDialogueState,
  type AssistantExchange,
  type AssistantFeedbackRequest,
  type AssistantPendingClarification,
  type AssistantProposal,
  type AssistantProposalPayload,
  type AssistantRejectRequest,
  type AssistantResponse,
  type AssistantQueryFrameItem,
  type AssistantRequestedField,
  type AssistantSendRequest,
  type CalendarIRDraft,
  type CalendarIRResolved,
  type CalendarMutationResult,
  type CalendarSnapshotRequest,
  type ConversationTurnEntity,
  type EventEntity,
  type EventOccurrence,
  type EventForm,
  type FlexModelChatRequest,
  type FlexModelCalendarFact,
  type FlexModelCalendarFactPacket,
  type FlexModelCalendarFallbackResult,
  type FlexModelAction,
  type FlexModelFallbackFailureKind,
  type FlexModelGeneralFallbackResult,
  type FlexModelJobStatus,
  type FlexModelPlan,
  type FlexModelPlanContext,
  type FlexModelStatus,
  type ReminderEntity,
  type ReminderForm,
  type ResponsePlan
} from '@remind-me/contracts'
import { PersistentCalendarService } from './calendar-service'
import {
  renderGroundedAnswer,
  type GroundedAnswerItem,
  type GroundedAttributeField
} from './grounded-answer'
import { groundFlexChatResponse, safeGeneralChatStreamPrefix } from './flex-chat-grounding'
import type { SqliteCalendarRepository } from './sqlite-repository'

const defaultConversationId = 'conversation:local'

export interface FlexibleCalendarPlanner {
  plan(text: string, context: FlexModelPlanContext): Promise<FlexModelPlan | null>
  chat?(input: FlexModelChatRequest, onChunk?: (text: string) => void): Promise<string | null>
  getStatus?(): Promise<Pick<FlexModelStatus, 'state' | 'enabled' | 'error' | 'lastRequest'>>
}

export interface CalendarFallbackPlanner {
  planCalendar(
    text: string,
    context: FlexModelPlanContext,
    options?: FallbackInferenceOptions
  ): Promise<FlexModelCalendarFallbackResult>
  getStatus?(): Promise<Pick<FlexModelStatus, 'state' | 'enabled' | 'error' | 'lastRequest'>>
}

export interface GeneralFallbackResponder {
  respondGeneral(
    input: FlexModelChatRequest,
    onChunk?: (text: string) => void,
    options?: FallbackInferenceOptions
  ): Promise<FlexModelGeneralFallbackResult>
  getStatus?(): Promise<Pick<FlexModelStatus, 'state' | 'enabled' | 'error' | 'lastRequest'>>
}

export interface AssistantFallbackServices {
  calendarPlanner: CalendarFallbackPlanner | null
  generalResponder: GeneralFallbackResponder | null
}

export interface FallbackInferenceOptions {
  cancellationId?: string
  onStatus?: (status: FlexModelJobStatus) => void
}

export interface AssistantSendRuntimeOptions {
  onFlexibleChatChunk?: (text: string) => void
  onFlexibleModelStatus?: (status: FlexModelJobStatus) => void
}

export type AssistantContextFrame =
  'none' | 'active-review' | 'pending-clarification' | 'last-query' | 'focused-items'

export type AssistantFallbackReason =
  | 'not-needed'
  | 'not-configured'
  | 'not-calendar'
  | 'missing'
  | 'disabled'
  | 'timeout'
  | 'cancelled'
  | 'invalid-output'
  | 'unavailable'
  | 'answered'
  | 'clarified'
  | 'offline-limit'
  | 'refused'
  | 'plan-accepted'
  | 'grounding-rejected'
  | 'fact-rejected'
  | 'write-claim-rejected'

export interface AssistantExecutionTrace {
  schemaVersion: 1
  route: 'conversation' | 'memory' | 'calendar' | 'broad-chat'
  contextFrame: AssistantContextFrame
  fallbackWorkload: 'none' | 'plan' | 'chat'
  fallbackReason: AssistantFallbackReason
  truncated: boolean
  latencyMs: number
}

interface MutableAssistantExecutionTrace {
  route: AssistantExecutionTrace['route']
  contextFrame: AssistantContextFrame
  fallbackWorkload: AssistantExecutionTrace['fallbackWorkload']
  fallbackReason: AssistantFallbackReason
  truncated: boolean
}

function fallbackErrorReason(error: unknown): AssistantFallbackReason {
  const message = error instanceof Error ? error.message : String(error)
  return /tim(?:e|ed)[ -]?out/iu.test(message) ? 'timeout' : 'unavailable'
}

type FallbackStatus = Pick<FlexModelStatus, 'state' | 'enabled' | 'error' | 'lastRequest'>
type FallbackStatusProvider = { getStatus?: () => Promise<FallbackStatus> }
type TypedFallbackFailure = FlexModelFallbackFailureKind

function typedFallbackFailureFromError(error: unknown): TypedFallbackFailure {
  return fallbackErrorReason(error) === 'timeout' ? 'timeout' : 'unavailable'
}

async function typedFallbackFailureFromLegacyStatus(
  provider: Pick<FlexibleCalendarPlanner, 'getStatus'>,
  defaultKind: TypedFallbackFailure | 'not-calendar'
): Promise<TypedFallbackFailure | 'not-calendar'> {
  let status: FallbackStatus | null
  try {
    status = (await provider.getStatus?.()) ?? null
  } catch {
    return 'unavailable'
  }
  if (!status) return defaultKind
  if (status.state === 'not-installed') return 'missing'
  if (!status.enabled) return 'disabled'
  if (/tim(?:e|ed)[ -]?out/iu.test(status.error ?? '')) return 'timeout'
  if (status.state === 'error' || status.error) return 'unavailable'
  return defaultKind
}

function adaptLegacyCalendarFallback(provider: FlexibleCalendarPlanner): CalendarFallbackPlanner {
  return {
    ...(provider.getStatus ? { getStatus: provider.getStatus.bind(provider) } : {}),
    planCalendar: async (text, context) => {
      let plan: FlexModelPlan | null
      try {
        plan = await provider.plan(text, context)
      } catch (error) {
        return flexModelCalendarFallbackResultSchema.parse({
          kind: typedFallbackFailureFromError(error)
        })
      }
      if (plan) return { kind: 'plan', plan }
      return flexModelCalendarFallbackResultSchema.parse({
        kind: await typedFallbackFailureFromLegacyStatus(provider, 'not-calendar')
      })
    }
  }
}

function adaptLegacyGeneralFallback(
  provider: FlexibleCalendarPlanner
): GeneralFallbackResponder | null {
  if (!provider.chat) return null
  return {
    ...(provider.getStatus ? { getStatus: provider.getStatus.bind(provider) } : {}),
    respondGeneral: async (input, onChunk) => {
      let text: string | null
      try {
        text = await provider.chat!(input, onChunk)
      } catch (error) {
        return flexModelGeneralFallbackResultSchema.parse({
          kind: typedFallbackFailureFromError(error)
        })
      }
      if (text?.trim()) {
        return {
          kind: 'answer',
          text: text.trim(),
          factRefs: [],
          writeClaim: false
        }
      }
      const kind = await typedFallbackFailureFromLegacyStatus(provider, 'invalid-output')
      return flexModelGeneralFallbackResultSchema.parse({
        kind: kind === 'not-calendar' ? 'invalid-output' : kind
      })
    }
  }
}

function isAssistantFallbackServices(
  value: AssistantFallbackServices | FlexibleCalendarPlanner
): value is AssistantFallbackServices {
  return 'calendarPlanner' in value || 'generalResponder' in value
}

function generalFallbackLimitation(reason: AssistantFallbackReason): string {
  switch (reason) {
    case 'missing':
    case 'not-configured':
      return 'The optional local language pack is not installed, so I cannot answer that open-ended request offline yet. Calendar and reminder features still work without it.'
    case 'disabled':
      return 'The optional local language pack is disabled. Enable it in Settings if you want an answer to that open-ended request.'
    case 'timeout':
      return 'The local language model took too long to answer. Please try once more or ask for a shorter response.'
    case 'cancelled':
      return 'I stopped that local response. Nothing was changed.'
    case 'invalid-output':
      return 'I could not finish that response with the local language model because its output was not usable. Please try rephrasing it.'
    case 'unavailable':
      return 'I could not finish that response with the local language model because it is unavailable right now. Please try again.'
    case 'fact-rejected':
      return 'I left out the local response because I could not verify every calendar detail it mentioned. Please ask again and name the event, reminder, or date you want checked.'
    case 'write-claim-rejected':
      return 'I left out the local response because it claimed a calendar change that did not occur. Nothing was changed.'
    default:
      return 'I could not finish that response with the local language model. Please try again.'
  }
}

function calendarFallbackLimitation(reason: AssistantFallbackReason, mutation: boolean): string {
  const outcome =
    reason === 'missing' || reason === 'not-configured'
      ? 'the optional calendar language planner is not installed'
      : reason === 'disabled'
        ? 'the optional calendar language planner is disabled'
        : reason === 'timeout'
          ? 'the local calendar planner timed out'
          : reason === 'cancelled'
            ? 'the local calendar request was stopped'
            : reason === 'invalid-output'
              ? 'the local calendar planner returned an unusable translation'
              : reason === 'unavailable'
                ? 'the local calendar planner is unavailable right now'
                : 'I could not translate the request into a complete calendar plan'
  return mutation
    ? `I did not stage a change because ${outcome}. Nothing was changed. Please restate each event or reminder with its title and any date or time you know.`
    : `I could not resolve that calendar question because ${outcome}. Please include the event, reminder, date, or range you want me to check.`
}

interface GroundedFlexibleAction {
  sourceText: string
  sourceStart: number
  parserText: string
  translated: boolean
  prediction: SemanticPlannerPrediction
}

type AssistantAtomicProposalPayload = Exclude<
  AssistantProposalPayload,
  { kind: 'batch' } | { kind: 'bulk-delete' }
>

interface ProposalReviewEntry {
  payload: AssistantAtomicProposalPayload
  summary: string
  position: number
}

type ProposalItemRevision =
  { ok: true; payload: AssistantAtomicProposalPayload } | { ok: false; message: string }

interface ProposalReviewFacts {
  title: string
  kind: 'event' | 'reminder'
  action: string
  date: string
  time: string
  location: string
  notes: string
  recurrence: string
  details: string
}

const flexibleAssistedOperations = new Set<FlexModelAction['operation']>([
  'event.create',
  'event.duplicate',
  'event.update',
  'event.move',
  'event.delete',
  'reminder.create',
  'reminder.update',
  'reminder.complete',
  'reminder.delete',
  'calendar.list',
  'calendar.search',
  'calendar.availability',
  'calendar.conflicts'
])

const flexibleTemporalOperations = new Set<FlexModelAction['operation']>([
  'event.create',
  'event.duplicate',
  'event.update',
  'event.move',
  'reminder.create',
  'reminder.update',
  'calendar.list',
  'calendar.search',
  'calendar.availability',
  'calendar.conflicts'
])

function exactExcerpt(source: string, excerpt: string): { text: string; start: number } | null {
  const start = source.toLocaleLowerCase().indexOf(excerpt.toLocaleLowerCase())
  if (start < 0) return null
  return { text: source.slice(start, start + excerpt.length), start }
}

function groundedActionSource(
  source: string,
  action: FlexModelAction,
  inferredSegment: { text: string; start: number } | null = null
): { text: string; start: number } | null {
  const exact = exactExcerpt(source, action.sourceText)
  if (
    inferredSegment &&
    (!exact || inferredSegment.text.toLocaleLowerCase().includes(exact.text.toLocaleLowerCase()))
  ) {
    return inferredSegment
  }
  if (exact) return exact
  const anchor = [action.targetText, action.titleText]
    .filter((value): value is string => Boolean(value))
    .map((value) => exactExcerpt(source, value))
    .find((value): value is { text: string; start: number } => Boolean(value))
  if (!anchor) return null
  const words = action.sourceText.trim().split(/\s+/u)
  const candidates: string[] = []
  for (let start = 1; start < words.length; start += 1) {
    candidates.push(words.slice(start).join(' '))
  }
  for (let end = words.length - 1; end > 0; end -= 1) {
    candidates.push(words.slice(0, end).join(' '))
  }
  candidates.sort((left, right) => right.length - left.length)
  for (const candidate of candidates) {
    if (!candidate.toLocaleLowerCase().includes(anchor.text.toLocaleLowerCase())) continue
    const repaired = exactExcerpt(source, candidate)
    if (repaired) return repaired
  }
  return null
}

function inferredFlexibleActionSegments(
  source: string,
  actions: readonly FlexModelAction[]
): Array<{ text: string; start: number } | null> {
  if (actions.length < 2) return actions.map(() => null)
  const anchors = actions.map((action) => {
    const candidates =
      action.operation === 'event.create' || action.operation === 'reminder.create'
        ? [action.titleText, action.targetText]
        : [action.targetText, action.titleText]
    return candidates
      .filter((value): value is string => Boolean(value?.trim()))
      .map((value) => exactExcerpt(source, value))
      .find((value): value is { text: string; start: number } => Boolean(value))
  })
  if (anchors.some((anchor) => !anchor)) return actions.map(() => null)
  for (let index = 1; index < anchors.length; index += 1) {
    const previous = anchors[index - 1]
    const current = anchors[index]
    if (!previous || !current || current.start <= previous.start) return actions.map(() => null)
  }
  const segments = anchors.map((anchor, index) => {
    if (!anchor) return null
    const next = anchors[index + 1]
    let end = next?.start ?? source.length
    if (next) {
      const between = source.slice(anchor.start + anchor.text.length, next.start)
      const separator =
        /(?:\s*[,;]\s*|\s+\b(?:and\s+then|and\s+also|then|also|plus|and)\s+)(?:(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+)?(?:add|create|schedule|book|put|block|make|remind(?:\s+me)?(?:\s+(?:to|about))?|remember(?:\s+to)?|set|move|reschedule|shift|rename|duplicate|copy|clone|delete|remove|cancel|mark|complete|finish|check|change|modify|update)\s+)?$/iu.exec(
          between
        )
      if (separator?.index === undefined) return null
      end = anchor.start + anchor.text.length + separator.index
    }
    const raw = source.slice(anchor.start, end)
    const leading = raw.length - raw.trimStart().length
    const text = raw.trim()
    return text ? { text, start: anchor.start + leading } : null
  })
  return segments.some((segment) => !segment) ? actions.map(() => null) : segments
}

const canonicalDateSource = '\\d{4}-\\d{2}-\\d{2}'
const canonicalClockSource = '(?:1[0-2]|[1-9]):[0-5]\\d (?:AM|PM)'
const canonicalWhenPatterns = [
  new RegExp(`^${canonicalDateSource}$`, 'u'),
  new RegExp(`^${canonicalDateSource} all day$`, 'iu'),
  new RegExp(`^${canonicalDateSource} through ${canonicalDateSource} all day$`, 'iu'),
  new RegExp(`^${canonicalDateSource} at ${canonicalClockSource}$`, 'iu'),
  new RegExp(
    `^${canonicalDateSource} from ${canonicalClockSource} to ${canonicalClockSource}$`,
    'iu'
  ),
  new RegExp(`^at ${canonicalClockSource}$`, 'iu'),
  new RegExp(`^from ${canonicalClockSource} to ${canonicalClockSource}$`, 'iu')
]
const canonicalWeekdays = new Set(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])

function validCanonicalDate(value: string): boolean {
  try {
    Temporal.PlainDate.from(value)
    return true
  } catch {
    return false
  }
}

function normalizeCanonicalWhen(value: string): string | null {
  const normalized = value
    .trim()
    .replace(/\s+/gu, ' ')
    .replace(/\b(?:am|pm)\b/giu, (period) => period.toLocaleUpperCase())
  if (!canonicalWhenPatterns.some((pattern) => pattern.test(normalized))) return null
  const dates = normalized.match(/\b\d{4}-\d{2}-\d{2}\b/gu) ?? []
  if (!dates.every(validCanonicalDate)) return null
  if (dates.length === 2 && Temporal.PlainDate.compare(dates[1] ?? '', dates[0] ?? '') < 0) {
    return null
  }
  return normalized
}

function normalizeCanonicalRecurrence(value: string): string | null {
  const normalized = value.trim().replace(/\s+/gu, ' ')
  const ending = /\s+(until\s+(\d{4}-\d{2}-\d{2})|for\s+(\d+)\s+occurrences?)$/iu.exec(normalized)
  if (ending?.[2] && !validCanonicalDate(ending[2])) return null
  if (ending?.[3] && Number(ending[3]) < 1) return null
  const base = ending ? normalized.slice(0, ending.index) : normalized
  if (
    /^every\s+(?:day|weekday|week|month|year)$/iu.test(base) ||
    /^every\s+[1-9]\d{0,3}\s+(?:days?|weeks?|months?|years?)$/iu.test(base)
  ) {
    return normalized
  }
  const weekdayList = /^weekly\s+on\s+(.+)$/iu.exec(base)?.[1]
  if (!weekdayList) return null
  const days = weekdayList
    .split(/\s*(?:,|\band\b)\s*/iu)
    .map((day) => day.toLocaleLowerCase())
    .filter(Boolean)
  if (days.length < 1 || days.some((day) => !canonicalWeekdays.has(day))) return null
  if (new Set(days).size !== days.length) return null
  return normalized
}

const monthNumberByName: Record<string, number> = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sep: 9,
  sept: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12
}
const weekdayNumberByName: Record<string, number> = {
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
  sunday: 7
}
const ordinalNumberByName: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
  eleventh: 11,
  twelfth: 12,
  thirteenth: 13,
  fourteenth: 14,
  fifteenth: 15,
  sixteenth: 16,
  seventeenth: 17,
  eighteenth: 18,
  nineteenth: 19,
  twentieth: 20,
  'twenty-first': 21,
  'twenty-second': 22,
  'twenty-third': 23,
  'twenty-fourth': 24,
  'twenty-fifth': 25,
  'twenty-sixth': 26,
  'twenty-seventh': 27,
  'twenty-eighth': 28,
  'twenty-ninth': 29,
  thirtieth: 30,
  'thirty-first': 31
}
const clockNumberByName: Record<string, number> = {
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

function contextLocalDate(context: FlexModelPlanContext | undefined): Temporal.PlainDate | null {
  try {
    return context ? Temporal.PlainDate.from(context.currentLocalDateTime.slice(0, 10)) : null
  } catch {
    return null
  }
}

function inferredMonthDate(
  month: number,
  day: number,
  explicitYear: number | null,
  current: Temporal.PlainDate | null
): string | null {
  try {
    let date = Temporal.PlainDate.from({ year: explicitYear ?? current?.year ?? 2000, month, day })
    if (!explicitYear && current && Temporal.PlainDate.compare(date, current) < 0) {
      date = date.add({ years: 1 })
    }
    return date.toString()
  } catch {
    return null
  }
}

function sourceDateCandidates(
  source: string,
  context: FlexModelPlanContext | undefined
): Set<string> {
  const dates = new Set<string>()
  const current = contextLocalDate(context)
  for (const match of source.matchAll(/\b\d{4}-\d{2}-\d{2}\b/gu)) {
    if (validCanonicalDate(match[0])) dates.add(match[0])
  }
  for (const match of source.matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/gu)) {
    const rawYear = match[3] ? Number(match[3]) : null
    const date = inferredMonthDate(
      Number(match[1]),
      Number(match[2]),
      rawYear === null ? null : rawYear < 100 ? 2000 + rawYear : rawYear,
      current
    )
    if (date) dates.add(date)
  }
  const monthNames = Object.keys(monthNumberByName).join('|')
  const ordinalNames = Object.keys(ordinalNumberByName)
    .map((name) => name.replace('-', '[- ]'))
    .join('|')
  const daySource = `(?:\\d{1,2}(?:st|nd|rd|th)?|${ordinalNames})`
  const monthFirst = new RegExp(
    `\\b(${monthNames})\\.?\\s+(${daySource})(?:,?\\s+(\\d{4}))?\\b`,
    'giu'
  )
  const dayFirst = new RegExp(
    `\\b(?:the\\s+)?(${daySource})(?:\\s+day\\s+of|\\s+of)\\s+(${monthNames})\\.?(?:,?\\s+(\\d{4}))?\\b`,
    'giu'
  )
  const dayValue = (raw: string): number => {
    const numeric = /^\d+/u.exec(raw)?.[0]
    if (numeric) return Number(numeric)
    return ordinalNumberByName[raw.toLocaleLowerCase().replace(/\s+/gu, '-')] ?? 0
  }
  for (const match of source.matchAll(monthFirst)) {
    const month = monthNumberByName[match[1]?.toLocaleLowerCase() ?? '']
    const date = month
      ? inferredMonthDate(
          month,
          dayValue(match[2] ?? ''),
          match[3] ? Number(match[3]) : null,
          current
        )
      : null
    if (date) dates.add(date)
  }
  for (const match of source.matchAll(dayFirst)) {
    const month = monthNumberByName[match[2]?.toLocaleLowerCase() ?? '']
    const date = month
      ? inferredMonthDate(
          month,
          dayValue(match[1] ?? ''),
          match[3] ? Number(match[3]) : null,
          current
        )
      : null
    if (date) dates.add(date)
  }
  if (current) {
    for (const [pattern, days] of [
      [/\bday before yesterday\b/iu, -2],
      [/\bday after tomorrow\b/iu, 2],
      [/\byesterday\b/iu, -1],
      [/\b(?:tomorrow|tmr|tmrw|tmw)\b/iu, 1],
      [/\btoday\b/iu, 0]
    ] as const) {
      if (pattern.test(source)) dates.add(current.add({ days }).toString())
    }
    for (const match of source.matchAll(
      /\\b(?:(last|next|this)\\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\\b/giu
    )) {
      const target = weekdayNumberByName[match[2]?.toLocaleLowerCase() ?? '']
      if (!target) continue
      const relation = match[1]?.toLocaleLowerCase()
      let offset = (target - current.dayOfWeek + 7) % 7
      if (relation === 'last') offset = offset === 0 ? -7 : offset - 7
      else if (relation === 'next' && offset === 0) offset = 7
      dates.add(current.add({ days: offset }).toString())
    }
  }
  return dates
}

function sourceClockCandidates(source: string): Set<string> {
  const clocks = new Set<string>()
  const add = (hour: number, minute: number, meridiem: 'am' | 'pm'): void => {
    if (hour < 1 || hour > 12 || minute < 0 || minute > 59) return
    const adjusted = meridiem === 'am' ? (hour === 12 ? 0 : hour) : hour === 12 ? 12 : hour + 12
    clocks.add(`${String(adjusted).padStart(2, '0')}:${String(minute).padStart(2, '0')}`)
  }
  for (const match of source.matchAll(/\b(\d{1,2})(?::(\d{1,2}))?\s*(a\.?m\.?|p\.?m\.?)\b/giu)) {
    add(
      Number(match[1]),
      Number(match[2] ?? 0),
      match[3]?.toLocaleLowerCase().startsWith('p') ? 'pm' : 'am'
    )
  }
  if (/\bnoon\b/iu.test(source)) add(12, 0, 'pm')
  if (/\bmidnight\b/iu.test(source)) add(12, 0, 'am')
  for (const match of source.matchAll(
    /\b(half|quarter)\s+(past|after|to)\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?:\s*(a\.?m\.?|p\.?m\.?)|\s+in\s+the\s+(morning|afternoon|evening|night))?\b/giu
  )) {
    const rawHour = match[3]?.toLocaleLowerCase() ?? ''
    const hour = /^\d+$/u.test(rawHour) ? Number(rawHour) : (clockNumberByName[rawHour] ?? 0)
    const direction = match[2]?.toLocaleLowerCase()
    const quarter = match[1]?.toLocaleLowerCase() === 'quarter'
    const namedPeriod = match[5]?.toLocaleLowerCase()
    const meridiem =
      match[4]?.toLocaleLowerCase().startsWith('p') ||
      namedPeriod === 'afternoon' ||
      namedPeriod === 'evening' ||
      namedPeriod === 'night'
        ? 'pm'
        : match[4] || namedPeriod === 'morning'
          ? 'am'
          : null
    if (meridiem) {
      add(
        direction === 'to' ? (hour === 1 ? 12 : hour - 1) : hour,
        direction === 'to' ? 45 : quarter ? 15 : 30,
        meridiem
      )
    }
  }
  return clocks
}

function needsFlexibleTemporalRepair(source: string, draft: CalendarIRDraft): boolean {
  if (
    draft.operation === 'event.delete' ||
    draft.operation === 'reminder.delete' ||
    draft.operation === 'reminder.complete'
  ) {
    return false
  }
  const targetSpan = draft.selection?.query?.sourceSpan
  const mutationWithDescriptiveTarget =
    targetSpan &&
    (draft.operation === 'event.move' ||
      draft.operation === 'event.duplicate' ||
      draft.operation === 'event.update' ||
      draft.operation === 'reminder.update')
  const temporalSource = mutationWithDescriptiveTarget
    ? `${source.slice(0, targetSpan.start)}${' '.repeat(targetSpan.end - targetSpan.start)}${source.slice(targetSpan.end)}`
    : source
  const sourceClocks = sourceClockCandidates(temporalSource)
  if (sourceClocks.size === 0) return false
  const when = draft.fields.when?.value
  const parsedClocks = new Set(
    [when?.start?.time, when?.end?.time].filter((value): value is string => Boolean(value))
  )
  return [...sourceClocks].some((clock) => !parsedClocks.has(clock))
}

function needsFlexiblePlanRepair(
  source: string,
  parsed: { draft: CalendarIRDraft; matchedPattern: string }
): boolean {
  const disposition = getActionDisposition(parsed.draft)
  return (
    disposition === 'clarify' ||
    disposition === 'reject' ||
    parsed.matchedPattern === 'event-create-inferred' ||
    needsFlexibleTemporalRepair(source, parsed.draft)
  )
}

function canonicalClockLabel(value: string): string | null {
  const match = /^(\d{2}):(\d{2})$/u.exec(value)
  if (!match?.[1] || !match[2]) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return null
  const period = hour < 12 ? 'AM' : 'PM'
  const displayHour = hour % 12 || 12
  return `${displayHour}:${match[2]} ${period}`
}

function deterministicCanonicalWhen(
  source: string,
  context: FlexModelPlanContext | undefined
): string | null {
  if (!/\b(?:half|quarter)\s+(?:past|after|to)\b/iu.test(source)) return null
  if (/\b(?:either|or)\b/iu.test(source) || /\b(?:from|between)\b/iu.test(source)) return null
  const dates = [...sourceDateCandidates(source, context)]
  const clocks = [...sourceClockCandidates(source)]
  if (dates.length > 1 || clocks.length !== 1) return null
  const clock = canonicalClockLabel(clocks[0] ?? '')
  if (!clock) return null
  return dates[0] ? `${dates[0]} at ${clock}` : `at ${clock}`
}

function canonicalClockCandidates(source: string): Set<string> {
  const clocks = new Set<string>()
  for (const match of source.matchAll(/\b(1[0-2]|[1-9]):([0-5]\d)\s+(AM|PM)\b/giu)) {
    const hour = Number(match[1])
    const adjusted =
      match[3]?.toLocaleUpperCase() === 'AM'
        ? hour === 12
          ? 0
          : hour
        : hour === 12
          ? 12
          : hour + 12
    clocks.add(`${String(adjusted).padStart(2, '0')}:${match[2]}`)
  }
  return clocks
}

function canUseTemporalTranslation(
  fullSource: string,
  actionSource: string,
  copiedWhen: { text: string; start: number } | null,
  suppliedWhen: string | null | undefined,
  normalizedWhen: string,
  context: FlexModelPlanContext | undefined
): boolean {
  if (!suppliedWhen) return false
  if (/\b(?:either|or)\b/iu.test(copiedWhen?.text ?? actionSource)) return false
  const normalizedDates = normalizedWhen.match(/\b\d{4}-\d{2}-\d{2}\b/gu) ?? []
  let availableDates = sourceDateCandidates(copiedWhen?.text ?? actionSource, context)
  if (availableDates.size === 0) {
    const fullSourceDates = sourceDateCandidates(fullSource, context)
    if (fullSourceDates.size === 1) availableDates = fullSourceDates
  }
  if (!copiedWhen && normalizedDates.length > 0 && availableDates.size > 1) return false
  if (normalizedDates.some((date) => !availableDates.has(date))) return false
  const normalizedClocks = canonicalClockCandidates(normalizedWhen)
  let availableClocks = sourceClockCandidates(copiedWhen?.text ?? actionSource)
  if ([...normalizedClocks].some((clock) => !availableClocks.has(clock))) {
    const fullSourceClocks = sourceClockCandidates(fullSource)
    const hasExplicitSharedClockCue =
      /\b(?:both|all|each)\b.{0,40}\b(?:at|from|between)\b|\b(?:at|from|between)\b.{0,40}\b(?:for\s+)?(?:both|all|each)\b|\b(?:at|from|between)\s+the\s+same\s+time\b/iu.test(
        fullSource
      )
    const exactSharedClockSet =
      hasExplicitSharedClockCue &&
      fullSourceClocks.size === normalizedClocks.size &&
      [...normalizedClocks].every((clock) => fullSourceClocks.has(clock))
    if (exactSharedClockSet || (!copiedWhen && fullSourceClocks.size === 1)) {
      availableClocks = new Set([...availableClocks, ...fullSourceClocks])
    }
  }
  if ([...normalizedClocks].some((clock) => !availableClocks.has(clock))) return false
  return normalizedDates.length + normalizedClocks.size > 0
}

function canonicalRecurrenceFromSource(source: string): string | null {
  if (/\b(?:every weekday|weekdays)\b/iu.test(source)) return 'every weekday'
  if (/\b(?:every day|daily)\b/iu.test(source)) return 'every day'
  if (/\b(?:every week|weekly)\b/iu.test(source)) return 'every week'
  if (/\b(?:every month|monthly)\b/iu.test(source)) return 'every month'
  if (/\b(?:every year|yearly|annually)\b/iu.test(source)) return 'every year'
  const interval = /\bevery\s+([1-9]\d{0,3})\s+(days?|weeks?|months?|years?)\b/iu.exec(source)
  if (interval?.[1] && interval[2]) return `every ${interval[1]} ${interval[2].toLocaleLowerCase()}`
  const weekdayToken =
    '(?:M|Mon(?:day)?|T|Tu|Tue(?:sday)?|W|Wed(?:nesday)?|Th|Thu(?:rsday)?|F|Fri(?:day)?|Sa|Sat(?:urday)?|Su|Sun(?:day)?)'
  const list = new RegExp(
    `\\b(${weekdayToken}(?:\\s*(?:,\\s*(?:and\\s+)?|/|&|\\band\\b\\s+)${weekdayToken}){1,6})\\b`,
    'iu'
  ).exec(source)?.[1]
  if (!list) return null
  const tokenMap: Record<string, string> = {
    m: 'Mon',
    mon: 'Mon',
    monday: 'Mon',
    t: 'Tue',
    tu: 'Tue',
    tue: 'Tue',
    tuesday: 'Tue',
    w: 'Wed',
    wed: 'Wed',
    wednesday: 'Wed',
    th: 'Thu',
    thu: 'Thu',
    thursday: 'Thu',
    f: 'Fri',
    fri: 'Fri',
    friday: 'Fri',
    sa: 'Sat',
    sat: 'Sat',
    saturday: 'Sat',
    su: 'Sun',
    sun: 'Sun',
    sunday: 'Sun'
  }
  const days = list
    .split(/\s*(?:,\s*(?:and\s+)?|\/|&|\band\b\s+)\s*/iu)
    .map((value) => tokenMap[value.toLocaleLowerCase()])
    .filter((value): value is string => Boolean(value))
  const unique = [...new Set(days)]
  return unique.length > 1 ? `weekly on ${unique.join(', ')}` : null
}

function fieldApplies(operation: FlexModelAction['operation'], kind: string): boolean {
  const fieldsByOperation: Record<FlexModelAction['operation'], readonly string[]> = {
    'event.create': ['TITLE', 'DESCRIPTION', 'LOCATION'],
    'event.duplicate': ['TARGET'],
    'event.update': ['TITLE', 'TARGET', 'DESCRIPTION', 'LOCATION'],
    'event.move': ['TARGET'],
    'event.delete': ['TARGET'],
    'reminder.create': ['TITLE', 'DESCRIPTION'],
    'reminder.update': ['TITLE', 'TARGET', 'DESCRIPTION'],
    'reminder.complete': ['TARGET'],
    'reminder.delete': ['TARGET'],
    'calendar.list': [],
    'calendar.search': ['TITLE', 'TARGET'],
    'calendar.availability': [],
    'calendar.conflicts': []
  }
  return fieldsByOperation[operation].includes(kind)
}

function fieldHasCue(
  source: string,
  match: { text: string; start: number },
  kind: string
): boolean {
  const prefix = source.slice(Math.max(0, match.start - 40), match.start)
  if (kind === 'DESCRIPTION') {
    return /\b(?:note|notes|description|details?)\b.{0,24}(?:\b(?:as|to|with)\b\s*)?(?::|-)?\s*$|\bwith\s*(?::|-)?\s*$/iu.test(
      prefix
    )
  }
  if (kind === 'LOCATION') {
    return (
      /\b(?:in|inside)\s+(?:the\s+)?$/iu.test(prefix) ||
      /\b(?:location|place|room)\b.{0,16}\b(?:as|at|is|to)\s+(?:the\s+)?$/iu.test(prefix) ||
      (/\bat\s+(?:the\s+)?$/iu.test(prefix) &&
        !/^\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)$/iu.test(match.text.trim()))
    )
  }
  return true
}

interface CanonicalToken {
  text: string
  kind?: SemanticPlannerPrediction['spans'][number]['kind']
}

function assembleCanonical(tokens: readonly CanonicalToken[]): {
  text: string
  spans: SemanticPlannerPrediction['spans']
} | null {
  let text = ''
  const spans: Array<SemanticPlannerPrediction['spans'][number]> = []
  for (const token of tokens) {
    const value = token.text.trim()
    if (!value) continue
    if (text) text += ' '
    const start = text.length
    text += value
    if (token.kind) spans.push({ kind: token.kind, start, end: text.length })
  }
  return text ? { text, spans } : null
}

function compileFlexibleAction(
  action: FlexModelAction,
  sourceText: string,
  fields: {
    title: string | null
    target: string | null
    description: string | null
    location: string | null
  },
  normalizedWhen: string | null,
  normalizedRecurrence: string | null
): { text: string; spans: SemanticPlannerPrediction['spans'] } | null {
  const title = fields.title ? { text: fields.title, kind: 'TITLE' as const } : null
  const target = fields.target ? { text: fields.target, kind: 'TARGET' as const } : null
  const description = fields.description
    ? { text: fields.description, kind: 'DESCRIPTION' as const }
    : null
  const location = fields.location ? { text: fields.location, kind: 'LOCATION' as const } : null
  const when = normalizedWhen ? { text: normalizedWhen } : null
  const recurrence = normalizedRecurrence ? { text: normalizedRecurrence } : null
  const seriesScope = /\b(?:(?:the\s+)?(?:whole|entire)\s+series|all\s+occurrences)\b/iu.exec(
    sourceText
  )?.[0]
  const details = [
    title,
    when,
    recurrence,
    location ? { text: 'location' } : null,
    location,
    description ? { text: 'notes' } : null,
    description
  ].filter((token): token is CanonicalToken => Boolean(token))
  let tokens: Array<CanonicalToken | null>
  switch (action.operation) {
    case 'event.create':
    case 'reminder.create':
      tokens = details
      break
    case 'event.update':
    case 'reminder.update':
      tokens = [
        target,
        title ? { text: 'new title' } : null,
        title,
        when,
        recurrence,
        location ? { text: 'location' } : null,
        location,
        description ? { text: 'notes' } : null,
        description,
        seriesScope ? { text: seriesScope } : null
      ]
      break
    case 'event.move':
      tokens = [
        { text: 'move' },
        target,
        { text: 'to' },
        when,
        seriesScope ? { text: seriesScope } : null
      ]
      break
    case 'event.duplicate':
      tokens = [{ text: 'duplicate' }, target, { text: 'to' }, when, recurrence]
      break
    case 'event.delete':
      tokens = [{ text: 'delete event' }, target, seriesScope ? { text: seriesScope } : null]
      break
    case 'reminder.delete':
      tokens = [{ text: 'delete reminder' }, target, seriesScope ? { text: seriesScope } : null]
      break
    case 'reminder.complete':
      tokens = [{ text: 'complete reminder' }, target]
      break
    case 'calendar.list':
      tokens = [{ text: 'what do I have' }, when]
      break
    case 'calendar.search':
      tokens = [{ text: 'find' }, target ?? title, when]
      break
    case 'calendar.availability':
      tokens = [{ text: 'am I free' }, when]
      break
    case 'calendar.conflicts':
      tokens = [{ text: 'are there conflicts' }, when]
      break
    default:
      return null
  }
  return assembleCanonical(tokens.filter((token): token is CanonicalToken => Boolean(token)))
}

/** Rejects invented or overlapping model text before it can influence the deterministic parser. */
export function groundFlexiblePlan(
  source: string,
  plan: FlexModelPlan,
  context?: FlexModelPlanContext
): GroundedFlexibleAction[] | null {
  const grounded: GroundedFlexibleAction[] = []
  const inferredSegments = inferredFlexibleActionSegments(source, plan.actions)
  for (const [actionIndex, action] of plan.actions.entries()) {
    if (!flexibleAssistedOperations.has(action.operation)) return null
    const segment = groundedActionSource(source, action, inferredSegments[actionIndex] ?? null)
    if (!segment) return null
    const spans: Array<SemanticPlannerPrediction['spans'][number]> = []
    const groundedFields: {
      title: string | null
      target: string | null
      description: string | null
      location: string | null
    } = { title: null, target: null, description: null, location: null }
    for (const [kind, excerpt] of [
      ['TITLE', action.titleText],
      ['TARGET', action.targetText],
      ['DESCRIPTION', action.descriptionText ?? null],
      ['LOCATION', action.locationText ?? null]
    ] as const) {
      if (!excerpt) continue
      if (!fieldApplies(action.operation, kind)) continue
      if (
        kind === 'TITLE' &&
        action.targetText &&
        excerpt.toLocaleLowerCase() === action.targetText.toLocaleLowerCase() &&
        (action.operation === 'event.update' || action.operation === 'reminder.update') &&
        Boolean(
          action.descriptionText ||
          action.locationText ||
          action.whenText ||
          action.normalizedWhenText ||
          action.recurrenceText ||
          action.normalizedRecurrenceText
        )
      ) {
        continue
      }
      const match = exactExcerpt(segment.text, excerpt)
      if (!match) {
        if (kind === 'TITLE' || kind === 'TARGET') return null
        continue
      }
      if (!fieldHasCue(segment.text, match, kind)) continue
      spans.push({ kind, start: match.start, end: match.start + match.text.length })
      if (kind === 'TITLE') groundedFields.title = match.text
      else if (kind === 'TARGET') groundedFields.target = match.text
      else if (kind === 'DESCRIPTION') groundedFields.description = match.text
      else groundedFields.location = match.text
    }
    const orderedSpans = [...spans].sort((left, right) => left.start - right.start)
    for (let index = 1; index < orderedSpans.length; index += 1) {
      const previous = orderedSpans[index - 1]
      const current = orderedSpans[index]
      if (!previous || !current || current.start < previous.end) return null
    }
    const whenExcerpt = action.whenText ? exactExcerpt(segment.text, action.whenText) : null
    const recurrenceExcerpt = action.recurrenceText
      ? exactExcerpt(segment.text, action.recurrenceText)
      : null
    const normalizedWhenCandidate = action.normalizedWhenText
      ? normalizeCanonicalWhen(action.normalizedWhenText)
      : null
    const derivedWhen =
      flexibleTemporalOperations.has(action.operation) &&
      Boolean(action.whenText || action.normalizedWhenText)
        ? deterministicCanonicalWhen(segment.text, context)
        : null
    const normalizedWhen =
      derivedWhen ??
      (normalizedWhenCandidate &&
      canUseTemporalTranslation(
        source,
        segment.text,
        whenExcerpt,
        action.whenText,
        normalizedWhenCandidate,
        context
      )
        ? normalizedWhenCandidate
        : null)
    const normalizedRecurrenceCandidate = action.normalizedRecurrenceText
      ? normalizeCanonicalRecurrence(action.normalizedRecurrenceText)
      : null
    const derivedRecurrence = canonicalRecurrenceFromSource(segment.text)
    const normalizedRecurrence =
      derivedRecurrence ?? (recurrenceExcerpt ? normalizedRecurrenceCandidate : null)
    const translated = Boolean(normalizedWhen || normalizedRecurrence)
    const compiled = translated
      ? compileFlexibleAction(
          action,
          segment.text,
          groundedFields,
          normalizedWhen,
          normalizedRecurrence
        )
      : null
    if (translated && !compiled) return null
    grounded.push({
      sourceText: segment.text,
      sourceStart: segment.start,
      parserText: compiled?.text ?? segment.text,
      translated,
      prediction: {
        operation: action.operation,
        operationConfidence: 0.9,
        ambiguityProbability: 0.05,
        oodProbability: 0.02,
        spans: compiled?.spans ?? spans,
        eligibleForAssistance: true
      }
    })
  }
  grounded.sort((left, right) => left.sourceStart - right.sourceStart)
  for (let index = 1; index < grounded.length; index += 1) {
    const previous = grounded[index - 1]
    const current = grounded[index]
    if (!previous || !current) return null
    if (current.sourceStart < previous.sourceStart + previous.sourceText.length) return null
  }
  return grounded
}

function localParts(instant: string, timezone: string): { date: string; time: string } {
  const zoned = Temporal.Instant.from(instant).toZonedDateTimeISO(timezone)
  return {
    date: zoned.toPlainDate().toString(),
    time: zoned.toPlainTime().toString({ smallestUnit: 'minute' })
  }
}

function eventToForm(event: EventEntity): EventForm {
  const start = localParts(event.startUtc, event.timezone)
  const endInstant = event.allDay
    ? Temporal.Instant.from(event.endUtc).subtract({ nanoseconds: 1 }).toString()
    : event.endUtc
  const end = localParts(endInstant, event.timezone)
  return eventFormSchema.parse({
    id: event.id,
    calendarId: event.calendarId,
    title: event.title,
    description: event.description,
    location: event.location,
    startDate: start.date,
    startTime: event.allDay ? null : start.time,
    endDate: end.date,
    endTime: event.allDay ? null : end.time,
    timezone: event.timezone,
    allDay: event.allDay,
    recurrence: event.recurrence
  })
}

function sameIdSet(currentIds: readonly string[], capturedIds: readonly string[]): boolean {
  if (currentIds.length !== capturedIds.length) return false
  const captured = new Set(capturedIds)
  return currentIds.every((id) => captured.has(id))
}

function localInstant(date: string, time: string, timezone: string): string {
  return Temporal.PlainDate.from(date)
    .toZonedDateTime({ timeZone: timezone, plainTime: Temporal.PlainTime.from(time) })
    .toInstant()
    .toString({ fractionalSecondDigits: 3 })
}

function scheduleDuplicateCommand(
  requestId: string,
  sourceText: string,
  source: EventEntity,
  form: EventForm,
  now: string
): CalendarIRResolved {
  if (!form.recurrence) throw new Error('A repeated schedule needs a recurrence rule')
  const startUtc = localInstant(form.startDate, form.startTime ?? '00:00', form.timezone)
  const endUtc = form.allDay
    ? localInstant(
        Temporal.PlainDate.from(form.endDate).add({ days: 1 }).toString(),
        '00:00',
        form.timezone
      )
    : localInstant(form.endDate, form.endTime ?? form.startTime ?? '00:00', form.timezone)
  const evidenceText = sourceText.slice(0, 2_000)
  return calendarIRResolvedSchema.parse({
    version: '0.1',
    requestId,
    operation: 'event.duplicate',
    selection: { eventIds: [source.id], reminderIds: [], query: null },
    fields: {
      title: null,
      description: null,
      location: null,
      startUtc,
      endUtc,
      dueAtUtc: null,
      rangeStartUtc: null,
      rangeEndUtc: null,
      timezone: form.timezone,
      allDay: form.allDay,
      reminderOffsetMinutes: null,
      status: null
    },
    recurrence: form.recurrence,
    scope: 'series',
    risk: 'high',
    confidence: 0.97,
    requiresConfirmation: true,
    evidence: [
      {
        id: `evidence:${requestId.replace(/[^a-zA-Z0-9._:-]/gu, '-')}`,
        sourceKind: 'text',
        sourceId: null,
        page: null,
        boundingBox: null,
        text: evidenceText,
        sourceSpan: evidenceText ? { start: 0, end: evidenceText.length } : null
      }
    ],
    resolvedAt: now
  })
}

function bulkClearCommand(
  requestId: string,
  sourceText: string,
  eventIds: readonly string[],
  reminderIds: readonly string[],
  now: string
): CalendarIRResolved {
  const evidenceText = sourceText.slice(0, 2_000)
  return calendarIRResolvedSchema.parse({
    version: '0.1',
    requestId,
    operation: eventIds.length > 0 ? 'event.delete' : 'reminder.delete',
    selection: {
      eventIds: eventIds.slice(0, 100),
      reminderIds: reminderIds.slice(0, 100),
      query: null
    },
    fields: {
      title: null,
      description: null,
      location: null,
      startUtc: null,
      endUtc: null,
      dueAtUtc: null,
      rangeStartUtc: null,
      rangeEndUtc: null,
      timezone: null,
      allDay: null,
      reminderOffsetMinutes: null,
      status: null
    },
    recurrence: null,
    scope: 'series',
    risk: 'destructive',
    confidence: 0.99,
    requiresConfirmation: true,
    evidence: [
      {
        id: `evidence:${requestId.replace(/[^a-zA-Z0-9._:-]/gu, '-')}`,
        sourceKind: 'text',
        sourceId: null,
        page: null,
        boundingBox: null,
        text: evidenceText,
        sourceSpan: evidenceText ? { start: 0, end: evidenceText.length } : null
      }
    ],
    resolvedAt: now
  })
}

function reminderToForm(reminder: ReminderEntity): ReminderForm {
  const due = localParts(reminder.dueAtUtc, reminder.timezone)
  return reminderFormSchema.parse({
    id: reminder.id,
    calendarId: reminder.calendarId,
    title: reminder.title,
    notes: reminder.notes,
    dueDate: due.date,
    dueTime: due.time,
    timezone: reminder.timezone,
    recurrence: reminder.recurrence
  })
}

function requestId(): string {
  return `request:${randomUUID()}`
}

function turnId(): string {
  return `turn:${randomUUID()}`
}

function proposalId(): string {
  return `proposal:${randomUUID()}`
}

function overlaps(startA: string, endA: string, startB: string, endB: string): boolean {
  return Date.parse(startA) < Date.parse(endB) && Date.parse(startB) < Date.parse(endA)
}

function formatDateTime(
  instant: string,
  locale: string,
  timezone: string,
  includeDate = true
): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: timezone,
    ...(includeDate ? { weekday: 'short', month: 'short', day: 'numeric' } : {}),
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(instant))
}

function formatDate(instant: string, locale: string, timezone: string): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: timezone,
    weekday: 'long',
    month: 'long',
    day: 'numeric'
  }).format(new Date(instant))
}

function formatTime(instant: string, locale: string, timezone: string): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(instant))
}

function clippedDetail(value: string, maximum = 120): string {
  const normalized = value.trim().replace(/\s+/gu, ' ')
  return normalized.length > maximum ? `${normalized.slice(0, maximum - 1)}…` : normalized
}

function normalizedMemory(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase()
}

function looksLikeCalendarMutation(value: string): boolean {
  return (
    /\b(?:add|block|book|bump|cancel|change|clone|complete|copy|create|delete|ditch|drop|duplicate|finish|mark|modify|move|postpone|push|put|remind|remove|rename|repeat|reschedule|save|schedule|scrap|set|shift|update)\b/iu.test(
      value
    ) ||
    /\b(?:bring\s+forward|check\s+off|cross\s+off|take\s+off)\b/iu.test(value) ||
    /\bmake\s+(?:(?:an?|the|my)\s+)?(?:appointment|calendar item|event|plan|reminder|room\s+for)\b/iu.test(
      value
    )
  )
}

function likelyRequestedItemCount(value: string): number {
  if (
    !/\b(?:add|book|create|make|put|remind|remember|schedule|set)\b/iu.test(value) ||
    !/\b(?:and|also|plus|then)\b/iu.test(value)
  ) {
    return 1
  }
  const anchors = [
    ...value.matchAll(
      /\b(?:today|tomorrow|tmr|tmrw|tmw|monday|tuesday|wednesday|thursday|friday|saturday|sunday|(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?)\b/giu
    )
  ].filter((match) => match.index !== undefined)
  if (anchors.length < 2) return 1
  const weekdayListSpans = [
    ...value.matchAll(
      /\bevery\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s*,\s*(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))*(?:\s*,?\s*and\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))?/giu
    )
  ].flatMap((match) =>
    match.index === undefined ? [] : [{ start: match.index, end: match.index + match[0].length }]
  )
  for (let index = 1; index < anchors.length; index += 1) {
    const previous = anchors[index - 1]
    const current = anchors[index]
    if (previous?.index === undefined || current?.index === undefined) continue
    const between = value.slice(previous.index + previous[0].length, current.index)
    if (!/\b(?:and|also|plus|then)\b/iu.test(between)) continue
    const belongsToOneWeekdayList = weekdayListSpans.some(
      (span) => previous.index >= span.start && current.index < span.end
    )
    if (!belongsToOneWeekdayList) return anchors.length
  }
  return 1
}

function isRejectedFlexibleChatTurn(value: string): boolean {
  return /could not finish that response with the local language model|could not map that request safely yet|left out the local response because/iu.test(
    value
  )
}

function looksLikeCalendarRequest(value: string): boolean {
  return (
    looksLikeCalendarMutation(value) ||
    /\b(?:agenda|appointment|availability|available|calendar|class|conflict|course|event|meeting|plans?|reminder|schedule|today|tomorrow|tmr|tmrw|tmw|yesterday|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b|\b(?:am|will|would|could)\s+i\s+(?:be\s+)?(?:free|busy)\b|\bwhat (?:do|did) i have\b|\bwhat(?:'s|s| is) (?:on|coming up|next|tomorrow|tmr|tmrw|tmw|today)\b|^(?:when|where)\s+is\b|^(?:find|search(?:\s+for)?|look\s+up)\b|\b(?:at|around|before|after|from|between|until|by)\s+\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?\b|\b\d{1,4}[/-]\d{1,2}(?:[/-]\d{1,4})?\b/iu.test(
      value
    )
  )
}

type CalendarDetailRequest =
  'details' | 'location' | 'time' | 'start' | 'end' | 'duration' | 'date' | 'notes' | 'recurrence'

function calendarDetailFollowUp(value: string): CalendarDetailRequest | null {
  const normalized = value
    .normalize('NFKC')
    .trim()
    .replace(/[.!?]+$/gu, '')
    .replace(/\s+/gu, ' ')
  if (
    /^(?:(?:in|at)\s+)?(?:(?:what|which)\s+(?:room|building|location|place)(?:\s+(?:is|was)\s+(?:it|that|this|that one|the (?:class|course|lecture|lab|event|meeting|appointment)))?(?:\s+in)?|where(?:\s+(?:is|was))?\s*(?:it|that|this|that one|the (?:class|course|lecture|lab|event|meeting|appointment))?|location)$/iu.test(
      normalized
    )
  ) {
    return 'location'
  }
  if (
    /^(?:how long(?:\s+(?:is|was|does))?\s*(?:it|that|this|that one|the (?:class|course|lecture|lab|event|meeting|appointment))?(?:\s+last)?|what(?:'s| is) (?:its|the) duration|duration)$/iu.test(
      normalized
    )
  ) {
    return 'duration'
  }
  if (
    /^(?:(?:what|which) time (?:does|did|will) (?:it|that|this|that one|the (?:class|course|lecture|lab|event|meeting|appointment)) end|when (?:does|did|will) (?:it|that|this|that one|the (?:class|course|lecture|lab|event|meeting|appointment)) end|(?:what(?:'s| is) )?(?:its|the)?\s*end time)$/iu.test(
      normalized
    )
  ) {
    return 'end'
  }
  if (
    /^(?:(?:what|which) time (?:does|did|will) (?:it|that|this|that one|the (?:class|course|lecture|lab|event|meeting|appointment)) start|when (?:does|did|will) (?:it|that|this|that one|the (?:class|course|lecture|lab|event|meeting|appointment)) start|(?:what(?:'s| is) )?(?:its|the)?\s*start time)$/iu.test(
      normalized
    )
  ) {
    return 'start'
  }
  if (
    /^(?:(?:what|which) time(?:\s+(?:is|was)\s+(?:it|that|this|that one|the (?:class|course|lecture|lab|event|meeting|appointment)))?|when(?:\s+(?:is|was))?\s+(?:it|that|this|that one|the (?:class|course|lecture|lab|event|meeting|appointment))|time)$/iu.test(
      normalized
    )
  ) {
    return 'time'
  }
  const referencesPriorResults =
    /\b(?:they|them|their|these|those|these ones|those ones|the ones|these (?:classes|courses|lectures|labs|events|meetings|appointments|reminders|items)|those (?:classes|courses|lectures|labs|events|meetings|appointments|reminders|items))\b/iu.test(
      normalized
    )
  const asksForTheirTimes =
    /\b(?:when|times?\s+(?:for|of))\b|\b(?:what|which)\b.{0,48}\btimes?\b/iu.test(normalized)
  if (
    /^(?:at\s+)?(?:what|which) times?$/iu.test(normalized) ||
    (referencesPriorResults && asksForTheirTimes)
  ) {
    return 'time'
  }
  if (
    /^(?:(?:what|which) (?:day|date)(?:\s+(?:is|was)\s+(?:it|that|this|that one|the (?:class|course|lecture|lab|event|meeting|appointment)))?|date)$/iu.test(
      normalized
    )
  ) {
    return 'date'
  }
  if (
    /^(?:what (?:should|do) i (?:bring|prepare|need)|(?:are there |any )?(?:notes?|instructions?)|what(?:'s| is) (?:it|that|this|the (?:class|course|lecture|lab|event|meeting|appointment)) about)$/iu.test(
      normalized
    )
  ) {
    return 'notes'
  }
  if (
    /^(?:how often(?: does)? (?:it|that|this|the (?:class|course|lecture|lab|event|meeting|appointment))? ?(?:repeat)?|(?:what|which) days?(?: of the week)?(?: does)? (?:it|that|this)? ?(?:repeat|happen|meet)?|recurrence|repeat pattern)$/iu.test(
      normalized
    )
  ) {
    return 'recurrence'
  }
  if (
    /^(?:more|more please|details?|show (?:me )?(?:more|details?)|tell me more|go (?:deeper|on)|expand(?: on that)?|what about the (?:times?|locations?|details?))$/iu.test(
      normalized
    )
  ) {
    return 'details'
  }
  return null
}

interface FocusedDialogueItem {
  id: string
  kind: 'event' | 'reminder'
  title: string
  at: string
  timezone: string
  location: string
  stableIndex: number
}

function focusedDialogueItems(
  state: AssistantDialogueState,
  events: readonly EventEntity[],
  reminders: readonly ReminderEntity[]
): FocusedDialogueItem[] {
  const eventById = new Map(events.map((event) => [event.id, event]))
  const reminderById = new Map(reminders.map((reminder) => [reminder.id, reminder]))
  const activeFrame = state.queryFrames.find((frame) => frame.frameId === state.activeQueryFrameId)
  if (activeFrame) {
    return activeFrame.orderedItems.flatMap<FocusedDialogueItem>((item, index) => {
      if (item.kind === 'event') {
        const event = eventById.get(item.id)
        return event?.status === 'active'
          ? [
              {
                id: item.id,
                kind: 'event' as const,
                title: event.title,
                at: item.occurrenceStart ?? event.startUtc,
                timezone: event.timezone,
                location: event.location,
                stableIndex: index
              }
            ]
          : []
      }
      const reminder = reminderById.get(item.id)
      return reminder?.status === 'active'
        ? [
            {
              id: item.id,
              kind: 'reminder' as const,
              title: reminder.title,
              at: item.occurrenceStart ?? reminder.dueAtUtc,
              timezone: reminder.timezone,
              location: '',
              stableIndex: index
            }
          ]
        : []
    })
  }
  const focusedEvents = state.focusedEventIds.flatMap((id, index) => {
    const event = eventById.get(id)
    return event?.status === 'active'
      ? [
          {
            id,
            kind: 'event' as const,
            title: event.title,
            at: event.startUtc,
            timezone: event.timezone,
            location: event.location,
            stableIndex: index
          }
        ]
      : []
  })
  const focusedReminders = state.focusedReminderIds.flatMap((id, index) => {
    const reminder = reminderById.get(id)
    return reminder?.status === 'active'
      ? [
          {
            id,
            kind: 'reminder' as const,
            title: reminder.title,
            at: reminder.dueAtUtc,
            timezone: reminder.timezone,
            location: '',
            stableIndex: focusedEvents.length + index
          }
        ]
      : []
  })
  const focusedItems = [...focusedEvents, ...focusedReminders]
  if (focusedEvents.length === 0 || focusedReminders.length === 0) return focusedItems
  return focusedItems.sort(
    (left, right) =>
      Date.parse(left.at) - Date.parse(right.at) || left.stableIndex - right.stableIndex
  )
}

function dialogueFrameItemKey(item: AssistantQueryFrameItem): string {
  return `${item.kind}:${item.id}:${item.occurrenceStart ?? ''}`
}

function contextualItemDescriptors(
  state: AssistantDialogueState,
  events: readonly EventEntity[],
  reminders: readonly ReminderEntity[]
): ContextualItemDescriptor[] {
  const eventById = new Map(events.map((event) => [event.id, event]))
  const reminderById = new Map(reminders.map((reminder) => [reminder.id, reminder]))
  const seen = new Set<string>()
  return state.queryFrames.flatMap<ContextualItemDescriptor>((frame) =>
    frame.orderedItems.flatMap<ContextualItemDescriptor>((item) => {
      const key = dialogueFrameItemKey(item)
      if (seen.has(key)) return []
      seen.add(key)
      if (item.kind === 'reminder') {
        const reminder = reminderById.get(item.id)
        return reminder ? [{ item, title: reminder.title, categories: ['reminder'] }] : []
      }
      const event = eventById.get(item.id)
      if (!event) return []
      const text = `${event.title} ${event.description}`
      const categories: ContextualItemDescriptor['categories'][number][] = ['event']
      if (/\b(?:lab|laboratory|practicum)\b/iu.test(text)) categories.push('lab')
      if (/\blecture\b/iu.test(text)) categories.push('lecture')
      const academic =
        /\b(?:class|course|lecture|laboratory|lab|discussion|seminar|practicum|recitation|tutorial|calculus|algebra|geometry|statistics|physics|chemistry|biology|anatomy|economics|psychology|sociology|history|literature|composition|programming|computer science|data structures|engineering)\b|\b[A-Z]{2,6}\s*[- ]?\d{2,4}[A-Z]?\b/iu.test(
          text
        ) || event.provenance === 'import'
      if (academic) categories.push('class')
      return [{ item, title: event.title, categories }]
    })
  )
}

function expandContextualMutationReference(
  value: string,
  resolution: ContextualResolution | null,
  descriptors: readonly ContextualItemDescriptor[]
): string {
  if (
    resolution?.kind !== 'resolved' ||
    (resolution.intent !== 'modify' && resolution.intent !== 'delete')
  ) {
    return value
  }
  const descriptorByKey = new Map(
    descriptors.map((descriptor) => [dialogueFrameItemKey(descriptor.item), descriptor])
  )
  const titles = resolution.selectedItems.flatMap((item) => {
    const title = descriptorByKey.get(dialogueFrameItemKey(item))?.title.trim()
    return title ? [title] : []
  })
  if (titles.length === 0 || titles.length > 50 || new Set(titles).size !== titles.length) {
    return value
  }
  const target = resolution.selectedItems.length === 1 ? 'it' : titles.join(' and ')
  const referencePatterns = [
    /\b(?:the\s+)?(?:first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|last|final)(?:\s+(?:ones?|items?|events?|classes?|courses?|labs?|lectures?|reminders?))?(?:\s*(?:,\s*(?:and\s+)?|\band\s+)(?:the\s+)?(?:first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|last|final)(?:\s+(?:ones?|items?|events?|classes?|courses?|labs?|lectures?|reminders?))?)+\b/iu,
    /\b(?:all(?:\s+\d+)?\s+of\s+(?:them|these|those)|every\s+one\s+of\s+(?:them|these|those)|both\s+of\s+(?:them|these|those)|both|them|these\s+ones|those\s+ones|these|those|it|that one|this one)\b/iu,
    /\b(?:(?:all|both|the)\s+)?(?:classes?|courses?|labs?|laborator(?:y|ies)|lectures?|reminders?|tasks?|events?|meetings?|appointments?)\b/iu,
    /\b(?:the\s+)?(?:first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|last|final)(?:\s+(?:one|item|event|class|course|lab|lecture|reminder))?\b/iu
  ]
  const pattern = referencePatterns.find((candidate) => candidate.test(value))
  return pattern ? value.replace(pattern, target) : value
}

const dialogueOrdinalSource = '(?:first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|last|final)'
const dialogueOrdinalNounSource =
  '(?:\\s+(?:ones?|items?|events?|meetings?|appointments?|classes?|courses?|reminders?|tasks?))?'
const dialogueOrdinalList = new RegExp(
  `\\b(?:the\\s+)?${dialogueOrdinalSource}${dialogueOrdinalNounSource}(?:\\s*(?:,\\s*(?:and\\s+)?|\\band\\s+)(?:the\\s+)?${dialogueOrdinalSource}${dialogueOrdinalNounSource})+\\b`,
  'iu'
)
const dialogueOrdinalToken = new RegExp(`\\b(${dialogueOrdinalSource})\\b`, 'giu')

function focusedPeriodItems(
  items: readonly FocusedDialogueItem[],
  period: string,
  noun: string
): FocusedDialogueItem[] {
  const ranges: Readonly<Record<string, readonly [number, number]>> = {
    morning: [9, 12],
    afternoon: [12, 17],
    evening: [17, 21],
    night: [19, 22]
  }
  const range = ranges[period.toLocaleLowerCase()]
  if (!range) return []
  const [startHour, endHour] = range
  const requestedKind = /^(?:reminder|task)/iu.test(noun)
    ? 'reminder'
    : /^(?:event|class|course|meeting|appointment)/iu.test(noun)
      ? 'event'
      : null
  return items.filter((item) => {
    if (requestedKind && item.kind !== requestedKind) return false
    const hour = Temporal.Instant.from(item.at).toZonedDateTimeISO(item.timezone).hour
    return hour >= startHour && hour < endHour
  })
}

function expandDescriptivePluralReference(
  value: string,
  items: readonly FocusedDialogueItem[]
): string | null {
  const periodReference =
    /\b(?:the\s+)?(morning|afternoon|evening|night)\s+(ones?|items?|events?|meetings?|appointments?|classes?|courses?|reminders?|tasks?)\b/iu.exec(
      value
    )
  if (periodReference?.[0] && periodReference[1] && periodReference[2]) {
    const selected = focusedPeriodItems(items, periodReference[1], periodReference[2])
    const titles = selected.map((item) => item.title)
    if (titles.length >= 2 && titles.length <= 50 && new Set(titles).size === titles.length) {
      return value.replace(periodReference[0], titles.join(' and '))
    }
    return null
  }
  const locationReference =
    /\b(?:the\s+)?(?:ones?|items?|events?|meetings?|appointments?|classes?|courses?)\s+(?:in|at)\s+(.+?)[.!?]*$/iu.exec(
      value
    )
  if (locationReference?.[0] && locationReference[1]) {
    const selected = items.filter(
      (item) =>
        item.kind === 'event' &&
        item.location.trim().length > 0 &&
        typoPhraseSimilarity(locationReference[1] ?? '', item.location) >= 0.78
    )
    const titles = selected.map((item) => item.title)
    if (titles.length >= 2 && titles.length <= 50 && new Set(titles).size === titles.length) {
      return value.replace(locationReference[0], titles.join(' and '))
    }
  }
  return null
}

function dialogueOrdinalIndex(value: string, itemCount: number): number | null {
  const normalized = value.toLocaleLowerCase()
  if (normalized === 'last' || normalized === 'final') return itemCount - 1
  const index = {
    first: 0,
    '1st': 0,
    second: 1,
    '2nd': 1,
    third: 2,
    '3rd': 2,
    fourth: 3,
    '4th': 3,
    fifth: 4,
    '5th': 4
  }[normalized]
  return index ?? null
}

function expandDialogueMutationReferences(
  value: string,
  state: AssistantDialogueState,
  events: readonly EventEntity[],
  reminders: readonly ReminderEntity[]
): string {
  if (!looksLikeCalendarMutation(value)) return value
  const items = focusedDialogueItems(state, events, reminders)
  const descriptivePlural = expandDescriptivePluralReference(value, items)
  if (descriptivePlural) return descriptivePlural
  const ordinalList = dialogueOrdinalList.exec(value)
  if (ordinalList?.[0]) {
    const positions = [...ordinalList[0].matchAll(dialogueOrdinalToken)].map((match) =>
      dialogueOrdinalIndex(match[1] ?? '', items.length)
    )
    const selectedPositions = positions.filter((position): position is number => position !== null)
    const validSelection =
      selectedPositions.length >= 2 &&
      selectedPositions.length <= 50 &&
      selectedPositions.length === positions.length &&
      new Set(selectedPositions).size === selectedPositions.length &&
      selectedPositions.every((position) => position >= 0 && position < items.length)
    if (validSelection) {
      const selectedTitles = selectedPositions.flatMap((position) => {
        const item = items[position]
        return item ? [item.title] : []
      })
      if (
        selectedTitles.length === selectedPositions.length &&
        new Set(selectedTitles).size === selectedTitles.length
      ) {
        return value.replace(dialogueOrdinalList, selectedTitles.join(' and '))
      }
    }
    return value
  }
  const reference =
    /\b(?:all(?:\s+\d+)?\s+of\s+(?:them|these|those)|every\s+one\s+of\s+(?:them|these|those)|both\s+of\s+(?:them|these|those)|both|them|these\s+ones|those\s+ones|these|those)\b/iu
  if (!reference.test(value)) return value
  const titles = items.map((item) => item.title)
  const uniqueTitles = [...new Set(titles)]
  if (
    uniqueTitles.length < 2 ||
    uniqueTitles.length > 50 ||
    uniqueTitles.length !== titles.length
  ) {
    return value
  }
  return value.replace(reference, uniqueTitles.join(' and '))
}

function normalizedChoice(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/^["“”']+|["“”'.!?]+$/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

function selectedClarificationOption(value: string, options: readonly string[]): string | null {
  const normalized = normalizedChoice(value)
  const exact = options.find((option) => normalizedChoice(option) === normalized)
  if (exact) return exact
  const ordinal =
    /^(?:the\s+)?(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th)(?:\s+one)?$/u.exec(
      normalized
    )?.[1]
  const index = ordinal
    ? ['first', '1st', 'second', '2nd', 'third', '3rd', 'fourth', '4th', 'fifth', '5th'].indexOf(
        ordinal
      )
    : -1
  const optionIndex = index < 0 ? -1 : Math.floor(index / 2)
  return optionIndex >= 0 ? (options[optionIndex] ?? null) : null
}

function isClarificationContinuation(
  value: string,
  clarification: AssistantPendingClarification
): boolean {
  const normalized = normalizedChoice(value)
  if (!normalized || normalized.length > 500) return false
  if (selectedClarificationOption(value, clarification.options)) return true
  switch (clarification.code) {
    case 'missing-date':
      return /\b(?:today|tomorrow|tmr|yesterday|this|next|coming|monday|tuesday|wednesday|thursday|friday|saturday|sunday|week|weekend|month|year|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b|\b\d{1,4}[/-]\d{1,2}(?:[/-]\d{1,4})?\b/iu.test(
        normalized
      )
    case 'missing-time':
      return /\b(?:noon|midnight|morning|afternoon|evening|night|am|pm)\b|\b\d{1,2}(?::\d{2})?\b/iu.test(
        normalized
      )
    case 'multiple-targets':
    case 'unclear-reference':
      return normalized.split(' ').length <= 12 && !looksLikeCalendarMutation(normalized)
    case 'unclear-scope':
      return /\b(?:one|single|occurrence|instance|this|future|following|series|all|every|whole|entire|event|events|reminder|reminders|both|cancel)\b/iu.test(
        normalized
      )
    case 'timezone-conflict':
      return /\b(?:time|timezone|utc|gmt|central|eastern|mountain|pacific|chicago|new york|denver|los angeles)\b/iu.test(
        normalized
      )
    case 'calendar-conflict':
      return /^(?:yes|no|move it|keep it|continue|cancel|choose another time)$/iu.test(normalized)
    case 'unsupported-expression':
      return /^(?:and|at|on|in|for|to|every|until|with|without)\b/iu.test(normalized)
  }
}

function reminderRequestsAsEvents(value: string): string {
  const reminderPrefix =
    /^(\s*(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+|i(?:'d| would)\s+like\s+(?:you\s+)?to\s+)?)(?:(?:add|create|set)\s+(?:a\s+)?reminder(?:\s+(?:to|for|about))?|remind\s+me(?:\s+(?:to|about))?|remember\s+to)\s+/iu
  return splitCalendarRequests(value)
    .map((part) => part.replace(reminderPrefix, '$1add '))
    .join('; ')
}

function mergeClarificationAnswer(
  clarification: AssistantPendingClarification,
  answer: string
): string {
  const source = clarification.sourceText.trim().replace(/[.!?]+$/gu, '')
  const option = selectedClarificationOption(answer, clarification.options)
  if (
    clarification.code === 'unsupported-expression' &&
    option &&
    normalizedChoice(option) === 'create calendar events'
  ) {
    return reminderRequestsAsEvents(source)
  }
  if (
    clarification.code === 'missing-time' &&
    /^(?:am|pm)$/iu.test(normalizedChoice(option ?? answer))
  ) {
    const period = normalizedChoice(option ?? answer).toLocaleUpperCase()
    const parts = splitCalendarRequests(source)
    if (parts.length > 1) return parts.map((part) => `${part} ${period}`).join('; ')
  }
  if (
    option &&
    (clarification.code === 'multiple-targets' || clarification.code === 'unclear-reference')
  ) {
    const move =
      /^(.*?\b(?:move|reschedule|shift|duplicate|copy|clone)\s+).+?(\s+(?:to|for|on)\s+.+)$/iu.exec(
        source
      )
    if (move?.[1] && move[2]) return `${move[1]}${option}${move[2]}`
    const direct = /^(.*?\b(?:delete|remove|cancel|complete|finish|check\s+off)\s+).+$/iu.exec(
      source
    )
    if (direct?.[1]) return `${direct[1]}${option}`
  }
  return `${source} ${option ?? answer.trim()}`
}

function looksLikeCalendarReadRequest(value: string): boolean {
  return (
    !looksLikeCalendarMutation(value) &&
    (looksLikeCalendarRequest(value) ||
      /^(?:find|search(?: for)?|look up|when is|where is|tell me (?:more )?about|give me (?:the )?details?)/iu.test(
        value.trim()
      ))
  )
}

type CalendarListItemKind = 'class' | 'event' | 'reminder' | 'item'

type CalendarListPosition =
  { kind: 'ordinal'; index: number } | { kind: 'next' } | { kind: 'previous' } | { kind: 'last' }

interface CalendarListSelection {
  itemKind: CalendarListItemKind
  position: CalendarListPosition
}

function calendarListSelection(value: string): CalendarListSelection | null {
  const normalized = value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[‘’]/gu, "'")
    .replace(/[.!?]+$/gu, '')
    .trim()
  if (
    /^(?:what(?:'s|s| is) (?:my )?next|what(?:'s|s| is) coming up next|show (?:me )?(?:my )?next)$/u.test(
      normalized
    )
  ) {
    return { itemKind: 'item', position: { kind: 'next' } }
  }

  const direct =
    /\b(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|earliest|next|previous|last|final|latest)\s+(class(?:es)?|courses?|lectures?|labs?|discussions?|seminars?|practicums?|recitations?|tutorials?|events?|meetings?|appointments?|plans?|items?|reminders?|tasks?|things?)\b/u.exec(
      normalized
    )
  const inverse =
    /\b(class(?:es)?|courses?|lectures?|labs?|discussions?|seminars?|practicums?|recitations?|tutorials?|events?|meetings?|appointments?|plans?|items?|reminders?|tasks?|things?)\s+(?:comes?|is)\s+(first|second|third|fourth|fifth|earliest|next|previous|last|final|latest)\b/u.exec(
      normalized
    )
  const ordinal = direct?.[1] ?? inverse?.[2]
  const noun = direct?.[2] ?? inverse?.[1]
  if (!ordinal || !noun) return null

  const itemKind: CalendarListItemKind =
    /^(?:class|course|lecture|lab|discussion|seminar|practicum|recitation|tutorial)/u.test(noun)
      ? 'class'
      : /^(?:reminder|task)/u.test(noun)
        ? 'reminder'
        : /^(?:event|meeting|appointment)/u.test(noun)
          ? 'event'
          : 'item'
  const position: CalendarListPosition =
    ordinal === 'next'
      ? { kind: 'next' }
      : ordinal === 'previous'
        ? { kind: 'previous' }
        : /^(?:last|final|latest)$/u.test(ordinal)
          ? { kind: 'last' }
          : {
              kind: 'ordinal',
              index:
                {
                  first: 0,
                  '1st': 0,
                  earliest: 0,
                  second: 1,
                  '2nd': 1,
                  third: 2,
                  '3rd': 2,
                  fourth: 3,
                  '4th': 3,
                  fifth: 4,
                  '5th': 4
                }[ordinal] ?? 0
            }
  return { itemKind, position }
}

function isLikelyClassOccurrence(event: EventOccurrence, entity: EventEntity | null): boolean {
  const academicText = `${event.title} ${event.description}`
  const explicitAcademicSignal =
    /\b(?:class|course|lecture|laboratory|lab|discussion|seminar|practicum|recitation|tutorial|calculus|algebra|geometry|statistics|physics|chemistry|biology|anatomy|economics|psychology|sociology|history|literature|composition|programming|computer science|data structures|engineering)\b|\b[A-Z]{2,6}\s*[- ]?\d{2,4}[A-Z]?\b/iu.test(
      academicText
    )
  if (explicitAcademicSignal) return true
  const explicitNonClassSignal =
    /\b(?:breakfast|brunch|lunch|dinner|coffee|gym|workout|doctor|dentist|appointment|birthday|concert|flight|interview|standup|sync|review|check-?in)\b/iu.test(
      event.title
    )
  return !explicitNonClassSignal && (event.recurring || entity?.provenance === 'import')
}

function eventAnswerFact(
  event: EventOccurrence,
  locale: string,
  options: { includeDate: boolean; includeDescription: boolean }
): string {
  const when = event.allDay
    ? options.includeDate
      ? `${formatDate(event.startUtc, locale, event.timezone)}, all day`
      : 'all day'
    : `${
        options.includeDate ? `${formatDate(event.startUtc, locale, event.timezone)} at ` : ''
      }${formatTime(event.startUtc, locale, event.timezone)}–${formatTime(event.endUtc, locale, event.timezone)}`
  const place = event.location.trim() ? ` at ${event.location.trim()}` : ''
  const description =
    options.includeDescription && event.description.trim()
      ? ` — ${clippedDetail(event.description)}`
      : ''
  const recurrence = options.includeDescription && event.recurring ? ' (repeats)' : ''
  return `${when}, “${event.title}”${place}${recurrence}${description}`
}

function formatDurationMinutes(minutes: number): string {
  const safeMinutes = Math.max(1, Math.round(minutes))
  const hours = Math.floor(safeMinutes / 60)
  const remainder = safeMinutes % 60
  if (hours === 0) return `${remainder} minute${remainder === 1 ? '' : 's'}`
  if (remainder === 0) return `${hours} hour${hours === 1 ? '' : 's'}`
  return `${hours} hour${hours === 1 ? '' : 's'} ${remainder} minute${remainder === 1 ? '' : 's'}`
}

function eventAttributeValue(
  event: EventOccurrence,
  detail: Exclude<CalendarDetailRequest, 'details'>,
  locale: string,
  recurrence: EventForm['recurrence'] = null
): string {
  switch (detail) {
    case 'location':
      return event.location.trim() || 'no room or location saved'
    case 'time':
      return event.allDay
        ? 'all day'
        : `${formatTime(event.startUtc, locale, event.timezone)}–${formatTime(event.endUtc, locale, event.timezone)}`
    case 'start':
      return event.allDay ? 'all day' : formatTime(event.startUtc, locale, event.timezone)
    case 'end':
      return event.allDay ? 'all day' : formatTime(event.endUtc, locale, event.timezone)
    case 'duration':
      return event.allDay
        ? 'all day'
        : formatDurationMinutes((Date.parse(event.endUtc) - Date.parse(event.startUtc)) / 60_000)
    case 'date':
      return formatDate(event.startUtc, locale, event.timezone)
    case 'notes':
      return event.description.trim() ? clippedDetail(event.description) : 'no notes saved'
    case 'recurrence':
      return recurrenceDetail(recurrence, locale)
  }
}

function reminderAttributeValue(
  reminder: ReminderEntity,
  detail: Exclude<CalendarDetailRequest, 'details'>,
  locale: string
): string {
  switch (detail) {
    case 'location':
      return 'reminders do not have rooms or locations'
    case 'date':
      return formatDate(reminder.dueAtUtc, locale, reminder.timezone)
    case 'notes':
      return reminder.notes.trim() ? clippedDetail(reminder.notes) : 'no notes saved'
    case 'duration':
      return 'reminders do not have a duration'
    case 'end':
      return 'reminders have a due time, not an end time'
    case 'recurrence':
      return recurrenceDetail(reminder.recurrence, locale)
    case 'time':
    case 'start':
      return formatTime(reminder.dueAtUtc, locale, reminder.timezone)
  }
}

function groundedEventAnswerItem(
  event: EventOccurrence,
  locale: string,
  recurrence: EventForm['recurrence'] = null
): GroundedAnswerItem {
  const frameItem: AssistantQueryFrameItem = {
    kind: 'event',
    id: event.eventId,
    occurrenceStart: event.startUtc
  }
  const attributes: Record<GroundedAttributeField, string> = {
    time: eventAttributeValue(event, 'time', locale, recurrence),
    start: eventAttributeValue(event, 'start', locale, recurrence),
    end: eventAttributeValue(event, 'end', locale, recurrence),
    date: eventAttributeValue(event, 'date', locale, recurrence),
    location: eventAttributeValue(event, 'location', locale, recurrence),
    duration: eventAttributeValue(event, 'duration', locale, recurrence),
    notes: eventAttributeValue(event, 'notes', locale, recurrence),
    recurrence: eventAttributeValue(event, 'recurrence', locale, recurrence)
  }
  return {
    key: dialogueFrameItemKey(frameItem),
    kind: 'event',
    title: event.title,
    dateLabel: formatDate(event.startUtc, locale, event.timezone),
    timeLabel: event.allDay ? 'all day' : formatTime(event.startUtc, locale, event.timezone),
    detail: eventAnswerFact(event, locale, { includeDate: true, includeDescription: true }),
    attributes
  }
}

function eventEntityOccurrence(event: EventEntity, startUtc = event.startUtc): EventOccurrence {
  return {
    occurrenceId: `context:${event.id}:${startUtc}`,
    eventId: event.id,
    calendarId: event.calendarId,
    title: event.title,
    description: event.description,
    location: event.location,
    startUtc,
    endUtc: new Date(
      Date.parse(startUtc) + Date.parse(event.endUtc) - Date.parse(event.startUtc)
    ).toISOString(),
    timezone: event.timezone,
    allDay: event.allDay,
    originalDate: Temporal.Instant.from(startUtc)
      .toZonedDateTimeISO(event.timezone)
      .toPlainDate()
      .toString(),
    recurring: event.recurrence !== null
  }
}

function groundedReminderAnswerItem(reminder: ReminderEntity, locale: string): GroundedAnswerItem {
  const frameItem: AssistantQueryFrameItem = {
    kind: 'reminder',
    id: reminder.id,
    occurrenceStart: reminder.dueAtUtc
  }
  const attributes: Record<GroundedAttributeField, string> = {
    time: reminderAttributeValue(reminder, 'time', locale),
    start: reminderAttributeValue(reminder, 'start', locale),
    end: reminderAttributeValue(reminder, 'end', locale),
    date: reminderAttributeValue(reminder, 'date', locale),
    location: reminderAttributeValue(reminder, 'location', locale),
    duration: reminderAttributeValue(reminder, 'duration', locale),
    notes: reminderAttributeValue(reminder, 'notes', locale),
    recurrence: reminderAttributeValue(reminder, 'recurrence', locale)
  }
  return {
    key: dialogueFrameItemKey(frameItem),
    kind: 'reminder',
    title: reminder.title,
    dateLabel: formatDate(reminder.dueAtUtc, locale, reminder.timezone),
    timeLabel: formatTime(reminder.dueAtUtc, locale, reminder.timezone),
    detail: `${formatDateTime(
      reminder.dueAtUtc,
      locale,
      reminder.timezone
    )}, reminder: “${reminder.title}”${
      reminder.notes.trim() ? ` — ${clippedDetail(reminder.notes)}` : ''
    }`,
    attributes
  }
}

function commandQuestion(command: CalendarIRResolved): string {
  return command.evidence
    .map((item) => item.text)
    .filter(Boolean)
    .join(' ')
}

const dialogueQueryCapabilities = {
  'calendar.list': 'calendar.query.list',
  'calendar.search': 'calendar.query.search',
  'calendar.availability': 'calendar.query.availability',
  'calendar.conflicts': 'calendar.query.conflicts'
} as const

function nativeAssistantContext(state: AssistantDialogueState): RemindCoreAssistantContext | null {
  const eventCount = state.focusedEventIds.length
  const reminderCount = state.focusedReminderIds.length
  const focusedCount = eventCount + reminderCount
  const priorCapabilityId = state.lastQuery
    ? dialogueQueryCapabilities[state.lastQuery.operation]
    : null
  if (focusedCount === 0 && priorCapabilityId === null && state.pendingClarification === null) {
    return null
  }
  return {
    focusedKind:
      eventCount > 0 && reminderCount > 0 ? 'mixed' : reminderCount > 0 ? 'reminder' : 'event',
    focusedCount,
    ordinal: null,
    priorCapabilityId,
    pendingCapabilityId: null
  }
}

function recurrenceLabel(recurrence: EventForm['recurrence']): string {
  if (!recurrence) return ''
  const interval = recurrence.interval === 1 ? '' : ` ${recurrence.interval}`
  const unit = {
    daily: 'day',
    weekly: 'week',
    monthly: 'month',
    yearly: 'year'
  }[recurrence.frequency]
  const ending =
    recurrence.end.kind === 'count'
      ? ` for ${recurrence.end.count} occurrences`
      : recurrence.end.kind === 'until'
        ? ` until ${recurrence.end.date}`
        : ''
  return `, repeating every${interval} ${unit}${recurrence.interval === 1 ? '' : 's'}${ending}`
}

function recurrenceDetail(recurrence: EventForm['recurrence'], locale: string): string {
  if (!recurrence) return 'does not repeat'
  const unit = {
    daily: 'day',
    weekly: 'week',
    monthly: 'month',
    yearly: 'year'
  }[recurrence.frequency]
  const cadence =
    recurrence.interval === 1
      ? recurrence.frequency === 'daily'
        ? 'daily'
        : recurrence.frequency === 'weekly'
          ? 'weekly'
          : recurrence.frequency === 'monthly'
            ? 'monthly'
            : 'yearly'
      : `every ${recurrence.interval} ${unit}s`
  const weekdays = recurrence.byWeekday.map(
    (weekday) => `${weekday.slice(0, 1).toLocaleUpperCase()}${weekday.slice(1)}`
  )
  const days =
    weekdays.length > 0
      ? ` on ${new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(weekdays)}`
      : recurrence.byMonthDay.length > 0
        ? ` on day ${recurrence.byMonthDay.join(', ')}`
        : ''
  const ending =
    recurrence.end.kind === 'count'
      ? ` for ${recurrence.end.count} occurrences`
      : recurrence.end.kind === 'until'
        ? ` until ${recurrence.end.date}`
        : ''
  return `${cadence}${days}${ending}`
}

export class PersistentAssistantService {
  private readonly calendar: PersistentCalendarService
  private readonly plannerInfo: RemindCoreInfo
  private readonly speakerInfo: RemindSpeakInfo
  private readonly calendarFallbackPlanner: CalendarFallbackPlanner | null
  private readonly generalFallbackResponder: GeneralFallbackResponder | null
  /**
   * Bounded, process-local diagnostics. These records intentionally contain no
   * prompt text, calendar facts, stable item IDs, or conversation identifiers.
   */
  private readonly executionTraces: AssistantExecutionTrace[] = []
  private readonly responseTraces = new Map<
    string,
    {
      conversationId: string
      speechAct: ResponsePlan['speechAct']
      templateFingerprint: string
      rating: 'helpful' | 'unhelpful' | null
    }
  >()

  constructor(
    private readonly repository: SqliteCalendarRepository,
    private readonly planner: RemindCorePlanner | null = null,
    plannerInfo: RemindCoreInfo | null = null,
    private readonly speaker: RemindSpeakPlanner | null = null,
    speakerInfo: RemindSpeakInfo | null = null,
    fallbackServices: AssistantFallbackServices | FlexibleCalendarPlanner | null = null
  ) {
    this.calendar = new PersistentCalendarService(repository)
    this.plannerInfo = plannerInfo ?? planner?.info ?? unavailableRemindCoreInfo('Rules-only mode')
    this.speakerInfo =
      speakerInfo ?? speaker?.info ?? unavailableRemindSpeakInfo('Template response mode')
    if (!fallbackServices) {
      this.calendarFallbackPlanner = null
      this.generalFallbackResponder = null
    } else if (isAssistantFallbackServices(fallbackServices)) {
      this.calendarFallbackPlanner = fallbackServices.calendarPlanner
      this.generalFallbackResponder = fallbackServices.generalResponder
    } else {
      this.calendarFallbackPlanner = adaptLegacyCalendarFallback(fallbackServices)
      this.generalFallbackResponder = adaptLegacyGeneralFallback(fallbackServices)
    }
  }

  getPlannerInfo(): RemindCoreInfo {
    return this.plannerInfo
  }

  getSpeakerInfo(): RemindSpeakInfo {
    return this.speakerInfo
  }

  getExecutionTraces(): readonly AssistantExecutionTrace[] {
    return this.executionTraces.map((trace) => ({ ...trace }))
  }

  getLastExecutionTrace(): AssistantExecutionTrace | null {
    const trace = this.executionTraces.at(-1)
    return trace ? { ...trace } : null
  }

  getConversation(conversationId: string | null = null): AssistantConversation {
    const id = conversationId ?? defaultConversationId
    let conversation = this.repository.ensureAssistantConversation(id)
    if (conversation.turns.length === 0) {
      this.appendTurn(
        id,
        'assistant',
        'text',
        'What can I help you make room for? I can add or move plans, set reminders, check your availability, summarize a day, and undo changes.',
        null
      )
      conversation = this.repository.getAssistantConversation(id)
    }
    return assistantConversationSchema.parse(conversation)
  }

  clearConversation(conversationId: string): AssistantConversation {
    this.repository.clearAssistantConversation(conversationId)
    for (const [key, trace] of this.responseTraces) {
      if (trace.conversationId === conversationId) this.responseTraces.delete(key)
    }
    return this.getConversation(conversationId)
  }

  rateReply(input: AssistantFeedbackRequest) {
    const request = assistantFeedbackRequestSchema.parse(input)
    const preferences = this.repository.getPreferences()
    const adaptation = preferences.responseAdaptation
    const traceKey = `${request.conversationId}:${request.requestId}`
    const trace = this.responseTraces.get(traceKey)
    if (!adaptation.enabled) {
      return assistantFeedbackResponseSchema.parse({
        accepted: false,
        learnedPreferences: adaptation.entries.length,
        message: 'Personal response learning is turned off in Settings.'
      })
    }
    if (!trace || trace.conversationId !== request.conversationId) {
      return assistantFeedbackResponseSchema.parse({
        accepted: false,
        learnedPreferences: adaptation.entries.length,
        message: 'That reply is no longer in the private learning window.'
      })
    }

    const previousDelta = trace.rating === 'helpful' ? 1 : trace.rating === 'unhelpful' ? -1 : 0
    const nextDelta = request.rating === 'helpful' ? 1 : -1
    const existing = adaptation.entries.find(
      (entry) =>
        entry.templateFingerprint === trace.templateFingerprint &&
        entry.speechAct === trace.speechAct
    )
    const score = Math.max(-3, Math.min(3, (existing?.score ?? 0) + nextDelta - previousDelta))
    const updatedAt = new Date().toISOString()
    const entries = [
      {
        templateFingerprint: trace.templateFingerprint,
        speechAct: trace.speechAct,
        score,
        updatedAt
      },
      ...adaptation.entries.filter(
        (entry) =>
          entry.templateFingerprint !== trace.templateFingerprint ||
          entry.speechAct !== trace.speechAct
      )
    ].slice(0, 64)
    this.calendar.updatePreferences({
      responseAdaptation: {
        enabled: true,
        feedbackCount: Math.min(10_000, adaptation.feedbackCount + (trace.rating === null ? 1 : 0)),
        entries
      }
    })
    trace.rating = request.rating
    return assistantFeedbackResponseSchema.parse({
      accepted: true,
      learnedPreferences: entries.length,
      message: 'Saved privately on this device.'
    })
  }

  async send(
    input: AssistantSendRequest,
    runtime: AssistantSendRuntimeOptions = {}
  ): Promise<AssistantExchange> {
    const started = performance.now()
    const trace: MutableAssistantExecutionTrace = {
      route: 'broad-chat',
      contextFrame: 'none',
      fallbackWorkload: 'none',
      fallbackReason: 'not-needed',
      truncated: false
    }
    try {
      return await this.sendWithTrace(input, runtime, trace)
    } finally {
      this.executionTraces.push({
        schemaVersion: 1,
        ...trace,
        latencyMs: Math.max(0, performance.now() - started)
      })
      if (this.executionTraces.length > 200) this.executionTraces.shift()
    }
  }

  private async sendWithTrace(
    input: AssistantSendRequest,
    runtime: AssistantSendRuntimeOptions,
    trace: MutableAssistantExecutionTrace
  ): Promise<AssistantExchange> {
    const request = assistantSendRequestSchema.parse(input)
    const conversation = this.getConversation(request.conversationId)
    trace.contextFrame = this.executionContextFrame(conversation)
    const id = requestId()
    const earlierTurns = conversation.turns
    this.appendTurn(conversation.id, 'user', 'text', request.text, id)

    let requestRoute = routeAssistantRequest(request.text)
    trace.route = requestRoute.route
    let prefetchedEvents: EventEntity[] | null = null
    let prefetchedReminders: ReminderEntity[] | null = null
    if (/\b(?:get\s+rid\s+of|push)\b/iu.test(requestRoute.originalText)) {
      prefetchedEvents = this.repository.listEvents()
      prefetchedReminders = this.repository.listReminders()
      requestRoute = routeAssistantRequest(request.text, {
        knownTitles: [
          ...prefetchedEvents.map((event) => event.title),
          ...prefetchedReminders.map((reminder) => reminder.title)
        ]
      })
    }
    trace.route = requestRoute.route
    const normalizedInput = requestRoute.normalizedText
    const previousUser = [...earlierTurns].reverse().find((turn) => turn.role === 'user')
    const normalizedPreviousUser = previousUser ? normalizeAssistantText(previousUser.text) : null

    if (/^(?:undo|undo that|take that back|revert that)[.!]*$/iu.test(normalizedInput)) {
      trace.route = 'calendar'
      return this.undo(conversation.id, id, request.range)
    }

    const activeProposal = conversation.activeProposal
    if (
      activeProposal &&
      /^(?:actually[, ]+)?(?:yes|confirm|do it|save it|looks good)[.!]*$/iu.test(normalizedInput)
    ) {
      trace.route = 'calendar'
      return this.applyProposal(activeProposal, request.range, id)
    }
    if (
      activeProposal &&
      /^(?:actually[, ]+)?(?:no|cancel|never mind|reject it)[.!]*$/iu.test(normalizedInput)
    ) {
      trace.route = 'calendar'
      return this.rejectExistingProposal(activeProposal, request.range, id)
    }
    if (activeProposal) {
      const revisedReview = this.reviseActiveProposal(
        activeProposal,
        normalizedInput,
        request.text,
        request.range,
        id
      )
      if (revisedReview) {
        trace.route = 'calendar'
        return revisedReview
      }

      const reviewAnswer = this.answerActiveProposalQuestion(
        activeProposal,
        normalizedInput,
        request.range,
        id
      )
      if (reviewAnswer) {
        trace.route = 'calendar'
        return reviewAnswer
      }
    }

    const currentEvents = prefetchedEvents ?? this.repository.listEvents()
    const currentReminders = prefetchedReminders ?? this.repository.listReminders()
    const contextualDescriptors = contextualItemDescriptors(
      conversation.dialogueState,
      currentEvents,
      currentReminders
    )
    const contextualResolution = resolveContextualRequest({
      text: normalizedInput,
      state: conversation.dialogueState,
      items: contextualDescriptors
    })
    if (contextualResolution?.kind === 'clarification') {
      trace.route = 'calendar'
      return this.respond(conversation.id, id, request.range, {
        kind: 'clarification',
        text: contextualResolution.message,
        relatedEventIds: [],
        relatedReminderIds: [],
        receipt: null
      })
    }
    if (
      contextualResolution?.kind === 'resolved' &&
      contextualResolution.intent !== 'modify' &&
      contextualResolution.intent !== 'delete'
    ) {
      trace.route = 'calendar'
      return this.answerContextualRequest(conversation.id, id, contextualResolution, request.range)
    }
    if (contextualResolution?.kind === 'resolved') {
      const selectedEventIds = [
        ...new Set(
          contextualResolution.selectedItems
            .filter((item) => item.kind === 'event')
            .map((item) => item.id)
        )
      ]
      const selectedReminderIds = [
        ...new Set(
          contextualResolution.selectedItems
            .filter((item) => item.kind === 'reminder')
            .map((item) => item.id)
        )
      ]
      const updatedAt = new Date().toISOString()
      this.repository.saveAssistantDialogueState(conversation.id, {
        ...conversation.dialogueState,
        focusedEventIds: selectedEventIds,
        focusedReminderIds: selectedReminderIds,
        queryFrames: conversation.dialogueState.queryFrames.map((frame) =>
          frame.frameId === contextualResolution.frameId
            ? {
                ...frame,
                selectedItems: contextualResolution.selectedItems,
                requestedFields: contextualResolution.fields,
                resultCursor: contextualResolution.resultCursor,
                continuationCursor: null
              }
            : frame
        ),
        activeQueryFrameId: contextualResolution.frameId,
        updatedAt
      })
    }

    let nativeAssistantPrediction: RemindCoreAssistantPrediction | null
    try {
      nativeAssistantPrediction =
        this.planner?.classifyAssistant(
          requestRoute.normalizedText,
          nativeAssistantContext(conversation.dialogueState)
        ) ?? null
    } catch {
      nativeAssistantPrediction = null
    }

    const memoryIntent = requestRoute.memoryIntent
    if (memoryIntent && contextualResolution === null) {
      return this.answerMemory(conversation.id, id, memoryIntent, request.range)
    }

    const conversationIntent = requestRoute.conversationIntent
    if (conversationIntent && contextualResolution === null) {
      return this.answerConversation(conversation.id, id, conversationIntent, request.range)
    }

    const scopedBulkClear = parseScopedBulkClearRequest(normalizedInput)
    if (scopedBulkClear) {
      const ambiguity = {
        code: 'unclear-scope' as const,
        message: scopedBulkClear.message,
        options: scopedBulkClear.options,
        sourceSpan: null
      }
      this.rememberClarification(conversation.id, id, normalizedInput, ambiguity)
      return this.respond(conversation.id, id, request.range, {
        kind: 'clarification',
        text: this.groundedReply(
          conversation.id,
          id,
          'clarification',
          [{ key: 'DETAIL', kind: 'text', value: scopedBulkClear.message }],
          ['<DETAIL>', 'I kept this scoped safely: <DETAIL>']
        ),
        relatedEventIds: [],
        relatedReminderIds: [],
        receipt: null
      })
    }

    const bulkClearIntent = parseBulkClearIntent(normalizedInput)
    if (bulkClearIntent) {
      return this.stageBulkClear(conversation.id, id, request.text, bulkClearIntent, request.range)
    }

    const pendingClarification = conversation.dialogueState.pendingClarification
    const clarificationContinuation =
      pendingClarification !== null &&
      isClarificationContinuation(normalizedInput, pendingClarification)
    if (pendingClarification && !clarificationContinuation) {
      const clearedAt = new Date().toISOString()
      this.repository.saveAssistantDialogueState(conversation.id, {
        ...this.repository.getAssistantDialogueState(conversation.id),
        pendingClarification: null,
        updatedAt: clearedAt
      })
    }
    const contextualInput = clarificationContinuation
      ? mergeClarificationAnswer(pendingClarification, normalizedInput)
      : normalizedInput
    const previousReadText =
      conversation.dialogueState.lastQuery?.sourceText ??
      (normalizedPreviousUser && looksLikeCalendarReadRequest(normalizedPreviousUser)
        ? normalizedPreviousUser
        : null)
    const requestedDetailFollowUp = calendarDetailFollowUp(normalizedInput)
    if (requestedDetailFollowUp && previousReadText === null) {
      trace.route = 'calendar'
      return this.respond(conversation.id, id, request.range, {
        kind: 'clarification',
        text: 'Which event, class, or reminder do you mean?',
        relatedEventIds: [],
        relatedReminderIds: [],
        receipt: null
      })
    }
    const detailFollowUp = previousReadText === null ? null : requestedDetailFollowUp
    const interpretedText = detailFollowUp ? (previousReadText ?? contextualInput) : contextualInput
    const contextualReferenceExpandedText = expandContextualMutationReference(
      interpretedText,
      contextualResolution,
      contextualDescriptors
    )
    const referenceExpandedText =
      contextualResolution?.kind === 'resolved'
        ? contextualReferenceExpandedText
        : expandDialogueMutationReferences(
            contextualReferenceExpandedText,
            conversation.dialogueState,
            currentEvents,
            currentReminders
          )
    const knownTitles = [
      ...currentEvents.map((event) => event.title),
      ...currentReminders.map((reminder) => reminder.title)
    ]
    const contextRoutedText = routeAssistantRequest(referenceExpandedText, {
      knownTitles
    }).normalizedText
    const targetRepairedText = repairKnownMutationTargets(contextRoutedText, knownTitles)
    const routedText = routeAssistantRequest(targetRepairedText, { knownTitles }).normalizedText
    const effectiveSourceText = clarificationContinuation ? routedText : request.text
    const normalizedRequest = routedText.toLocaleLowerCase()
    const mentionsKnownItem = knownTitles.some(
      (title) => title.trim().length >= 2 && normalizedRequest.includes(title.toLocaleLowerCase())
    )
    const routedAsCalendar =
      contextualResolution?.kind === 'resolved' ||
      requestRoute.route === 'calendar' ||
      requestRoute.rewrites.some((rewrite) => rewrite.kind === 'calendar-reflection') ||
      looksLikeCalendarRequest(routedText) ||
      mentionsKnownItem ||
      (requestRoute.route === 'broad-chat' &&
        nativeAssistantPrediction?.route === 'calendar' &&
        nativeAssistantPrediction.eligibleForRoutingAssistance &&
        nativeAssistantPrediction.dialogueRelation !== 'new-topic' &&
        (nativeAssistantPrediction.turnKind === 'calendar-read' ||
          nativeAssistantPrediction.turnKind === 'calendar-write') &&
        nativeAssistantPrediction.capabilities.every((capability) =>
          capability.startsWith('calendar.')
        ))
    if (routedAsCalendar) trace.route = 'calendar'
    if (!routedAsCalendar) {
      const conversational = await this.generalFallbackAnswer(
        conversation.id,
        id,
        normalizedInput,
        earlierTurns,
        request.range,
        runtime.onFlexibleChatChunk,
        request.streamId ?? undefined,
        runtime.onFlexibleModelStatus,
        trace
      )
      if (conversational) return conversational
      const detail = generalFallbackLimitation(trace.fallbackReason)
      return this.respond(conversation.id, id, request.range, {
        kind: 'unsupported',
        text: this.groundedReply(
          conversation.id,
          id,
          'runtime-unavailable',
          [{ key: 'DETAIL', kind: 'text', value: detail }],
          ['<DETAIL>', 'The optional local responder is unavailable: <DETAIL>']
        ),
        relatedEventIds: [],
        relatedReminderIds: [],
        receipt: null
      })
    }

    const preferences = this.repository.getPreferences()
    const now = new Date().toISOString()
    const zonedNow = Temporal.Instant.from(now).toZonedDateTimeISO(preferences.timezone)
    const dialogueContext = this.dialogueContextForPlanner(conversation.id, trace)
    const flexiblePlanContext: FlexModelPlanContext = {
      currentLocalDateTime: zonedNow.toPlainDateTime().toString({ smallestUnit: 'minute' }),
      timezone: preferences.timezone,
      locale: preferences.locale,
      dialogueContext
    }
    const lastAssistant = [...earlierTurns].reverse().find((turn) => turn.role === 'assistant')
    const contextualFollowUp = /^(?:and\b|what about\b|how about\b)/iu.test(normalizedInput)
    const contextualFocusedEventIds =
      contextualResolution?.kind === 'resolved'
        ? [
            ...new Set(
              contextualResolution.selectedItems
                .filter((item) => item.kind === 'event')
                .map((item) => item.id)
            )
          ]
        : conversation.dialogueState.focusedEventIds
    const contextualFocusedReminderIds =
      contextualResolution?.kind === 'resolved'
        ? [
            ...new Set(
              contextualResolution.selectedItems
                .filter((item) => item.kind === 'reminder')
                .map((item) => item.id)
            )
          ]
        : conversation.dialogueState.focusedReminderIds
    const parserContext = {
      requestId: id,
      text: routedText,
      previousUserText:
        detailFollowUp === null &&
        (lastAssistant?.text.trim().endsWith('?') || contextualFollowUp) &&
        previousUser
          ? normalizedPreviousUser
          : null,
      nowUtc: now,
      localDate: zonedNow.toPlainDate().toString(),
      timezone: preferences.timezone,
      locale: preferences.locale,
      events: currentEvents,
      reminders: currentReminders,
      focusedEventIds: contextualFocusedEventIds,
      focusedReminderIds: contextualFocusedReminderIds
    }
    const scheduleReplication = parseScheduleReplicationRequest(
      routedText,
      zonedNow.toPlainDate().toString()
    )
    if (scheduleReplication?.kind === 'clarification') {
      return this.respond(conversation.id, id, request.range, {
        kind: 'clarification',
        text: this.groundedReply(
          conversation.id,
          id,
          'clarification',
          [{ key: 'DETAIL', kind: 'text', value: scheduleReplication.message }],
          ['<DETAIL>', 'One detail will make that schedule copy safe: <DETAIL>']
        ),
        relatedEventIds: [],
        relatedReminderIds: [],
        receipt: null
      })
    }
    if (scheduleReplication?.kind === 'intent') {
      return this.stageScheduleReplication(
        conversation.id,
        id,
        effectiveSourceText,
        scheduleReplication,
        request.range,
        now
      )
    }
    const requestParts = splitCalendarRequests(routedText, knownTitles)
    if (requestParts.length > 1) {
      return this.stageBatchRequest(
        conversation.id,
        id,
        effectiveSourceText,
        requestParts,
        request.range,
        now,
        zonedNow.toPlainDate().toString(),
        null,
        trace,
        request.streamId ?? undefined,
        runtime.onFlexibleModelStatus
      )
    }
    const expectedActionCount = likelyRequestedItemCount(routedText)
    const requiresMultipleActionCoverage = expectedActionCount > 1
    let semanticPrediction: RemindCorePrediction | null
    try {
      semanticPrediction = this.planner?.predict(routedText) ?? null
    } catch {
      semanticPrediction = null
    }
    let parseResult = planCalendarTextHybrid(parserContext, semanticPrediction)
    let disposition = getActionDisposition(parseResult.draft)
    let usedFlexibleFallback = false
    let calendarFallbackResult: FlexModelCalendarFallbackResult | null = null
    const needsCalendarFallback =
      needsFlexiblePlanRepair(routedText, parseResult) || requiresMultipleActionCoverage

    if (needsCalendarFallback && this.calendarFallbackPlanner) {
      trace.fallbackWorkload = 'plan'
      let fallbackResult: FlexModelCalendarFallbackResult
      try {
        fallbackResult = await this.calendarFallbackPlanner.planCalendar(
          routedText,
          flexiblePlanContext,
          {
            ...(request.streamId ? { cancellationId: request.streamId } : {}),
            ...(runtime.onFlexibleModelStatus ? { onStatus: runtime.onFlexibleModelStatus } : {})
          }
        )
      } catch (error) {
        fallbackResult = flexModelCalendarFallbackResultSchema.parse({
          kind: typedFallbackFailureFromError(error)
        })
      }
      calendarFallbackResult = fallbackResult
      await this.recordFallbackTruncation(trace, this.calendarFallbackPlanner)
      if (fallbackResult.kind === 'cancelled') {
        trace.fallbackReason = 'cancelled'
        return this.respond(conversation.id, id, request.range, {
          kind: 'answer',
          text: 'Stopped that local request. Nothing was changed.',
          relatedEventIds: [],
          relatedReminderIds: [],
          receipt: null
        })
      }
      const flexiblePlan = fallbackResult.kind === 'plan' ? fallbackResult.plan : null
      if (fallbackResult.kind !== 'plan') trace.fallbackReason = fallbackResult.kind
      const grounded = flexiblePlan
        ? groundFlexiblePlan(routedText, flexiblePlan, flexiblePlanContext)
        : null
      if (grounded && grounded.length > 1) {
        trace.fallbackReason = 'plan-accepted'
        return this.stageBatchRequest(
          conversation.id,
          id,
          effectiveSourceText,
          grounded.map((action) => action.parserText),
          request.range,
          now,
          zonedNow.toPlainDate().toString(),
          grounded.map((action) => action.prediction),
          trace,
          request.streamId ?? undefined,
          runtime.onFlexibleModelStatus
        )
      }
      const action = grounded?.[0]
      if (action) {
        trace.fallbackReason = 'plan-accepted'
        usedFlexibleFallback = true
        parseResult = planCalendarTextHybrid(
          { ...parserContext, text: action.parserText, previousUserText: null },
          action.prediction
        )
        disposition = getActionDisposition(parseResult.draft)
      } else if (flexiblePlan) {
        trace.fallbackReason = 'grounding-rejected'
      }
    } else if (needsCalendarFallback && !this.calendarFallbackPlanner) {
      trace.fallbackWorkload = 'plan'
      trace.fallbackReason = 'not-configured'
    }

    if (requiresMultipleActionCoverage) {
      return this.respond(conversation.id, id, request.range, {
        kind: 'clarification',
        text: `I found ${expectedActionCount} possible calendar items, but I could not safely separate every one. Nothing was staged. Please confirm them as a short list or give each item its own date and time.`,
        relatedEventIds: [],
        relatedReminderIds: [],
        receipt: null
      })
    }

    if (
      disposition !== 'clarify' &&
      disposition !== 'reject' &&
      needsFlexibleTemporalRepair(routedText, parseResult.draft)
    ) {
      const detail =
        'I found a precise time phrase, but I could not translate it without changing its meaning. Please restate that time with AM or PM; nothing was staged.'
      return this.respond(conversation.id, id, request.range, {
        kind: 'clarification',
        text: this.groundedReply(
          conversation.id,
          id,
          'clarification',
          [{ key: 'DETAIL', kind: 'text', value: detail }],
          ['<DETAIL>', 'I paused on the time: <DETAIL>', 'One time detail needs care: <DETAIL>']
        ),
        relatedEventIds: [],
        relatedReminderIds: [],
        receipt: null
      })
    }

    if (disposition === 'clarify') {
      const ambiguity = parseResult.draft.ambiguities[0]
      const detail = ambiguity?.message ?? 'Could you say a little more about the date or time?'
      if (ambiguity) {
        this.rememberClarification(conversation.id, id, routedText, ambiguity)
      }
      const text = this.groundedReply(
        conversation.id,
        id,
        'clarification',
        [{ key: 'DETAIL', kind: 'text', value: clippedDetail(detail, 1_900) }],
        ['<DETAIL>', 'I need one more detail: <DETAIL>', 'Before I continue, <DETAIL>']
      )
      return this.respond(conversation.id, id, request.range, {
        kind: 'clarification',
        text,
        relatedEventIds: [],
        relatedReminderIds: [],
        receipt: null
      })
    }

    if (disposition === 'reject') {
      const unsupported = parseResult.draft.operation === 'assistant.unsupported'
      const mutation = looksLikeCalendarMutation(routedText)
      if (unsupported && !mutation && calendarFallbackResult?.kind === 'not-calendar') {
        const conversational = await this.generalFallbackAnswer(
          conversation.id,
          id,
          request.text,
          earlierTurns,
          request.range,
          runtime.onFlexibleChatChunk,
          request.streamId ?? undefined,
          runtime.onFlexibleModelStatus,
          trace
        )
        if (conversational) return conversational
        const detail = generalFallbackLimitation(trace.fallbackReason)
        return this.respond(conversation.id, id, request.range, {
          kind: 'unsupported',
          text: this.groundedReply(
            conversation.id,
            id,
            'runtime-unavailable',
            [{ key: 'DETAIL', kind: 'text', value: detail }],
            ['<DETAIL>', 'The optional local responder is unavailable: <DETAIL>']
          ),
          relatedEventIds: [],
          relatedReminderIds: [],
          receipt: null
        })
      }
      const detail = unsupported
        ? calendarFallbackLimitation(trace.fallbackReason, mutation)
        : 'I did not make a change because that request did not pass the local safety checks.'
      const text = this.groundedReply(
        conversation.id,
        id,
        unsupported ? (mutation ? 'clarification' : 'runtime-unavailable') : 'policy-boundary',
        [{ key: 'DETAIL', kind: 'text', value: detail }],
        unsupported
          ? [
              '<DETAIL>',
              'Here’s the honest limit: <DETAIL>',
              'I can’t verify more locally yet. <DETAIL>'
            ]
          : ['<DETAIL>', 'The safe result is: <DETAIL>', 'I stopped there. <DETAIL>']
      )
      return this.respond(conversation.id, id, request.range, {
        kind: unsupported ? (mutation ? 'clarification' : 'unsupported') : 'rejected',
        text,
        relatedEventIds: [],
        relatedReminderIds: [],
        receipt: null
      })
    }

    const selectedEvent = parseResult.draft.selection?.eventIds[0]
      ? this.repository.getEvent(parseResult.draft.selection.eventIds[0])
      : null
    const defaultDuration =
      (parseResult.draft.operation === 'event.move' ||
        parseResult.draft.operation === 'event.duplicate' ||
        parseResult.draft.operation === 'event.update') &&
      selectedEvent
        ? selectedEvent.allDay && parseResult.draft.fields.when?.value.allDay === false
          ? 60
          : Math.max(
              1,
              Math.round(
                (Date.parse(selectedEvent.endUtc) - Date.parse(selectedEvent.startUtc)) / 60_000
              )
            )
        : 60
    let resolved: CalendarIRResolved
    try {
      resolved = resolveCalendarIR(parseResult.draft, {
        nowUtc: now,
        localDate: zonedNow.toPlainDate().toString(),
        timezone: preferences.timezone,
        utcOffsetMinutes: Math.round(zonedNow.offsetNanoseconds / 60_000_000_000),
        defaultCalendarId: this.repository.listCalendars()[0]?.id ?? 'calendar:local',
        defaultEventDurationMinutes: defaultDuration
      })
      const rememberedQuery = detailFollowUp ? conversation.dialogueState.lastQuery : null
      if (rememberedQuery && resolved.operation === rememberedQuery.operation) {
        resolved = calendarIRResolvedSchema.parse({
          ...resolved,
          fields: {
            ...resolved.fields,
            rangeStartUtc: rememberedQuery.rangeStartUtc,
            rangeEndUtc: rememberedQuery.rangeEndUtc
          }
        })
      }
    } catch (error) {
      const detail =
        error instanceof Error
          ? `I need a clearer date or time before I can continue: ${error.message}`
          : 'I need a clearer date or time before I can continue.'
      return this.respond(conversation.id, id, request.range, {
        kind: 'clarification',
        text: this.groundedReply(
          conversation.id,
          id,
          'clarification',
          [{ key: 'DETAIL', kind: 'text', value: detail }],
          ['<DETAIL>', 'I paused here: <DETAIL>', 'One quick correction will help: <DETAIL>']
        ),
        relatedEventIds: [],
        relatedReminderIds: [],
        receipt: null
      })
    }

    const dryRun = dryRunCalendarCommand(
      resolved,
      { events: this.repository.listEvents(), reminders: this.repository.listReminders() },
      {
        nowUtc: now,
        localDate: zonedNow.toPlainDate().toString(),
        timezone: preferences.timezone,
        utcOffsetMinutes: Math.round(zonedNow.offsetNanoseconds / 60_000_000_000),
        defaultCalendarId: this.repository.listCalendars()[0]?.id ?? 'calendar:local',
        defaultEventDurationMinutes: defaultDuration
      }
    )
    if (!dryRun.accepted) {
      const detail = 'The local command engine could not validate that request, so nothing changed.'
      return this.respond(conversation.id, id, request.range, {
        kind: 'rejected',
        text: this.groundedReply(
          conversation.id,
          id,
          'error',
          [{ key: 'DETAIL', kind: 'text', value: detail }],
          ['<DETAIL>', 'I stopped safely: <DETAIL>', 'The local check failed, so <DETAIL>']
        ),
        relatedEventIds: [],
        relatedReminderIds: [],
        receipt: null
      })
    }

    if (disposition === 'answer') {
      return this.answerQuery(conversation.id, resolved, request.range, detailFollowUp)
    }

    let payload: AssistantProposalPayload
    try {
      payload = this.payloadFor(resolved)
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : 'I need a clearer target before continuing.'
      return this.respond(conversation.id, id, request.range, {
        kind: 'clarification',
        text: this.groundedReply(
          conversation.id,
          id,
          'clarification',
          [{ key: 'DETAIL', kind: 'text', value: detail }],
          ['<DETAIL>', 'I need one more detail: <DETAIL>', 'Before I continue, <DETAIL>']
        ),
        relatedEventIds: [],
        relatedReminderIds: [],
        receipt: null
      })
    }
    const summary = this.proposalSummary(payload, resolved)
    const createdAt = new Date().toISOString()
    const proposal = assistantProposalSchema.parse({
      id: proposalId(),
      conversationId: conversation.id,
      requestId: id,
      operation: resolved.operation,
      risk: resolved.risk,
      status: 'pending',
      payload,
      resolvedCommand: resolved,
      summary,
      requiresConfirmation: resolved.requiresConfirmation,
      sourceText: effectiveSourceText,
      createdAt,
      updatedAt: createdAt
    })
    this.repository.saveAssistantProposal(proposal)
    const reply = this.groundedReply(
      conversation.id,
      id,
      'proposal',
      [{ key: 'SUMMARY', kind: 'text', value: summary }],
      usedFlexibleFallback
        ? [
            'I read that as: <SUMMARY> Take a look before I change anything.',
            'Here’s how I understood you: <SUMMARY> Nothing changes until you approve it.',
            'I translated that into this local calendar action: <SUMMARY> You’re still in control of the save.'
          ]
        : [
            'Here’s what I understood: <SUMMARY> Review it before I save anything.',
            'I’ve prepared this locally: <SUMMARY> Nothing changes until you approve it.',
            'This is ready for your review: <SUMMARY> You’re still in control of the save.'
          ]
    )
    return this.respond(conversation.id, id, request.range, {
      kind: 'preview',
      text: reply,
      relatedEventIds: resolved.selection?.eventIds ?? [],
      relatedReminderIds: resolved.selection?.reminderIds ?? [],
      receipt: null
    })
  }

  private stageBulkClear(
    conversationId: string,
    id: string,
    sourceText: string,
    intent: BulkClearIntent,
    range: CalendarSnapshotRequest
  ): AssistantExchange {
    const allEvents = this.repository.listEvents()
    const allReminders = this.repository.listReminders()
    const eventIds = intent.scope === 'reminders' ? [] : allEvents.map((event) => event.id)
    const reminderIds = intent.scope === 'events' ? [] : allReminders.map((reminder) => reminder.id)
    const selectedCount = eventIds.length + reminderIds.length

    if (selectedCount === 0) {
      const detail =
        intent.scope === 'events'
          ? `Your calendar already has no events. ${allReminders.length} reminder${allReminders.length === 1 ? '' : 's'} will stay as-is.`
          : intent.scope === 'reminders'
            ? `You already have no reminders. ${allEvents.length} event${allEvents.length === 1 ? '' : 's'} will stay as-is.`
            : 'Your calendar already has no events or reminders.'
      return this.respond(conversationId, id, range, {
        kind: 'answer',
        text: this.groundedReply(
          conversationId,
          id,
          'schedule-summary',
          [{ key: 'SUMMARY', kind: 'text', value: detail }],
          ['<SUMMARY> Nothing changed.', 'I checked first: <SUMMARY>']
        ),
        relatedEventIds: [],
        relatedReminderIds: [],
        receipt: null
      })
    }

    if (eventIds.length > 50_000 || reminderIds.length > 50_000) {
      return this.respond(conversationId, id, range, {
        kind: 'clarification',
        text: 'That calendar is too large to place into one safe review. Export a backup in Settings before clearing it in smaller groups.',
        relatedEventIds: [],
        relatedReminderIds: [],
        receipt: null
      })
    }

    assistantPlanForCapability({
      requestId: id,
      sourceText,
      capabilityId: 'calendar.schedule.clear',
      target: { kind: 'calendar-bulk', scope: intent.scope, eventIds, reminderIds },
      arguments: {
        kind: 'calendar',
        fields: {
          title: null,
          description: null,
          location: null,
          when: null,
          reminderOffsetMinutes: null,
          status: null
        },
        recurrence: null,
        ambiguities: []
      },
      scope: 'series',
      risk: 'destructive',
      review: 'explicit-confirmation',
      responseGoal: {
        mode: 'preview',
        detail: 'standard',
        include: ['count'],
        maxItems: 1,
        maxWords: 160
      }
    })

    const eventLabel = `${eventIds.length} event${eventIds.length === 1 ? '' : 's'}`
    const reminderLabel = `${reminderIds.length} reminder${reminderIds.length === 1 ? '' : 's'}`
    const summary =
      intent.scope === 'events'
        ? `Delete all ${eventLabel}. ${allReminders.length} reminder${allReminders.length === 1 ? '' : 's'} will stay.`
        : intent.scope === 'reminders'
          ? `Delete all ${reminderLabel}. ${allEvents.length} event${allEvents.length === 1 ? '' : 's'} will stay.`
          : `Delete all ${eventLabel} and all ${reminderLabel}.`
    const createdAt = new Date().toISOString()
    const resolved = bulkClearCommand(id, sourceText, eventIds, reminderIds, createdAt)
    const proposal = assistantProposalSchema.parse({
      id: proposalId(),
      conversationId,
      requestId: id,
      operation: resolved.operation,
      risk: 'destructive',
      status: 'pending',
      payload: { kind: 'bulk-delete', scope: intent.scope, eventIds, reminderIds },
      resolvedCommand: resolved,
      summary,
      requiresConfirmation: true,
      sourceText,
      createdAt,
      updatedAt: createdAt
    })
    this.repository.saveAssistantProposal(proposal)
    const reply = this.groundedReply(
      conversationId,
      id,
      'proposal',
      [{ key: 'SUMMARY', kind: 'text', value: summary }],
      [
        'I found the items for this destructive review: <SUMMARY> Nothing has changed yet.',
        'I captured the exact items currently in scope: <SUMMARY> Confirm below only if that is right.',
        'This clear is ready for review: <SUMMARY> It will be one undoable action after confirmation.'
      ]
    )
    return this.respond(conversationId, id, range, {
      kind: 'preview',
      text: reply,
      relatedEventIds: eventIds.slice(0, 100),
      relatedReminderIds: reminderIds.slice(0, 100),
      receipt: null
    })
  }

  private stageScheduleReplication(
    conversationId: string,
    id: string,
    sourceText: string,
    intent: ScheduleReplicationIntent,
    range: CalendarSnapshotRequest,
    now: string
  ): AssistantExchange {
    const preferences = this.repository.getPreferences()
    const sourceDate = Temporal.PlainDate.from(intent.sourceDate)
    const sourceRangeStart = sourceDate
      .subtract({ days: 1 })
      .toZonedDateTime({ timeZone: preferences.timezone, plainTime: '00:00' })
      .toInstant()
      .toString({ fractionalSecondDigits: 3 })
    const sourceRangeEnd = sourceDate
      .add({ days: 2 })
      .toZonedDateTime({ timeZone: preferences.timezone, plainTime: '00:00' })
      .toInstant()
      .toString({ fractionalSecondDigits: 3 })
    const sourceSnapshot = this.calendar.getSnapshot({
      rangeStartUtc: sourceRangeStart,
      rangeEndUtc: sourceRangeEnd
    })
    const sourceEventIds = [
      ...new Set(
        sourceSnapshot.occurrences
          .filter((occurrence) => occurrence.originalDate === intent.sourceDate)
          .map((occurrence) => occurrence.eventId)
      )
    ]
    const dateLabel = new Intl.DateTimeFormat(preferences.locale, {
      timeZone: 'UTC',
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric'
    }).format(new Date(`${intent.sourceDate}T12:00:00.000Z`))

    if (sourceEventIds.length === 0) {
      const detail = `I found the whole-day copy request, but ${dateLabel} has no events that begin on that day.`
      return this.respond(conversationId, id, range, {
        kind: 'clarification',
        text: this.groundedReply(
          conversationId,
          id,
          'clarification',
          [{ key: 'DETAIL', kind: 'text', value: detail }],
          ['<DETAIL>', 'I checked the source day first: <DETAIL>']
        ),
        relatedEventIds: [],
        relatedReminderIds: [],
        receipt: null
      })
    }
    if (sourceEventIds.length > 50) {
      return this.respond(conversationId, id, range, {
        kind: 'clarification',
        text: `${dateLabel} has more than 50 events. Select the events from the calendar’s Repeat this day dialog instead.`,
        relatedEventIds: sourceEventIds.slice(0, 100),
        relatedReminderIds: [],
        receipt: null
      })
    }

    assistantPlanForCapability({
      requestId: id,
      sourceText,
      capabilityId: 'calendar.schedule.copy-day',
      target: {
        kind: 'calendar',
        selection: { eventIds: sourceEventIds, reminderIds: [], query: null },
        references: []
      },
      arguments: {
        kind: 'calendar',
        fields: {
          title: null,
          description: null,
          location: null,
          when: null,
          reminderOffsetMinutes: null,
          status: null
        },
        recurrence: {
          frequency: 'weekly',
          interval: 1,
          byWeekday: intent.targetWeekdays,
          byMonthDay: [],
          end: intent.recurrenceEnd
        },
        ambiguities: []
      },
      scope: 'series',
      risk: 'high',
      review: 'explicit-confirmation',
      responseGoal: {
        mode: 'preview',
        detail: 'standard',
        include: ['title', 'time', 'location', 'recurrence', 'count'],
        maxItems: sourceEventIds.length,
        maxWords: Math.min(600, 100 + sourceEventIds.length * 40)
      }
    })

    const resolvedCommands: CalendarIRResolved[] = []
    const items: AssistantAtomicProposalPayload[] = []
    const itemSummaries: string[] = []
    for (const [index, eventId] of sourceEventIds.entries()) {
      const source = this.repository.getEvent(eventId)
      if (!source) continue
      const sourceForm = eventToForm(source)
      const spanDays = Temporal.PlainDate.from(sourceForm.startDate).until(
        Temporal.PlainDate.from(sourceForm.endDate),
        { largestUnit: 'day' }
      ).days
      const form = eventFormSchema.parse({
        ...sourceForm,
        id: null,
        startDate: intent.firstTargetDate,
        endDate: Temporal.PlainDate.from(intent.firstTargetDate).add({ days: spanDays }).toString(),
        recurrence: {
          frequency: 'weekly',
          interval: 1,
          byWeekday: intent.targetWeekdays,
          byMonthDay: [],
          end: intent.recurrenceEnd
        }
      })
      const resolved = scheduleDuplicateCommand(
        `${id}:schedule:${index + 1}`,
        sourceText,
        source,
        form,
        now
      )
      const dryRun = dryRunCalendarCommand(
        resolved,
        { events: this.repository.listEvents(), reminders: this.repository.listReminders() },
        {
          nowUtc: now,
          localDate: Temporal.Instant.from(now)
            .toZonedDateTimeISO(preferences.timezone)
            .toPlainDate()
            .toString(),
          timezone: preferences.timezone,
          utcOffsetMinutes: Math.round(
            Temporal.Instant.from(now).toZonedDateTimeISO(preferences.timezone).offsetNanoseconds /
              60_000_000_000
          ),
          defaultCalendarId: this.repository.listCalendars()[0]?.id ?? 'calendar:local',
          defaultEventDurationMinutes: Math.max(
            1,
            Math.round((Date.parse(source.endUtc) - Date.parse(source.startUtc)) / 60_000)
          )
        }
      )
      if (!dryRun.accepted || dryRun.mutationCount !== 1) {
        return this.respond(conversationId, id, range, {
          kind: 'rejected',
          text: `I could not validate “${source.title}”, so I did not stage any part of the schedule copy.`,
          relatedEventIds: sourceEventIds,
          relatedReminderIds: [],
          receipt: null
        })
      }
      const payload = this.payloadFor(resolved)
      resolvedCommands.push(resolved)
      items.push(payload)
      itemSummaries.push(this.proposalSummary(payload, resolved))
    }

    return this.stagePreparedChanges(
      conversationId,
      id,
      sourceText,
      range,
      resolvedCommands,
      items,
      itemSummaries
    )
  }

  private answerMemory(
    conversationId: string,
    id: string,
    intent: MemoryIntent,
    range: CalendarSnapshotRequest
  ): AssistantExchange {
    const preferences = this.repository.getPreferences()
    const current = preferences.assistantProfile
    const save = (profile: typeof current): void => {
      this.repository.updatePreferences({
        ...preferences,
        assistantProfile: profile,
        updatedAt: new Date().toISOString()
      })
    }
    let detail: string

    switch (intent.kind) {
      case 'set-name': {
        if (!current.memoryEnabled) {
          detail =
            'Personal memory is off, so I did not save your name. You can enable it in Settings and try again.'
          break
        }
        save({ ...current, preferredName: intent.name })
        detail = `I’ll call you ${intent.name}. That preference stays in this app on this device, and you can remove it whenever you like.`
        break
      }
      case 'remember': {
        if (!current.memoryEnabled) {
          detail =
            'Personal memory is off, so I did not save that. You can enable it in Settings if you want me to use approved details in future replies.'
          break
        }
        const key = normalizedMemory(intent.memory)
        if (current.memories.some((memory) => normalizedMemory(memory) === key)) {
          detail = `I already have this approved memory: ${intent.memory}.`
          break
        }
        if (current.memories.length >= 20) {
          detail =
            'Your local memory list is full. Remove one in Settings or ask me to forget one before adding another.'
          break
        }
        save({ ...current, memories: [...current.memories, intent.memory] })
        detail = `I’ll remember that ${intent.memory}. It is stored locally as an editable, user-approved preference—not silently learned into model weights.`
        break
      }
      case 'recall': {
        if (!current.memoryEnabled) {
          detail =
            'Personal memory is currently off. I won’t use stored personal details in replies until you enable it again in Settings.'
          break
        }
        const pieces = [
          current.preferredName ? `your preferred name is ${current.preferredName}` : null,
          ...current.memories.map((memory) => memory)
        ].filter((item): item is string => Boolean(item))
        detail = pieces.length
          ? `Here’s what you explicitly asked me to keep locally: ${pieces.join('; ')}.`
          : 'You have not asked me to keep any personal details yet.'
        break
      }
      case 'forget': {
        const target = normalizedMemory(intent.memory)
        const matches = current.memories.filter((memory) => {
          const candidate = normalizedMemory(memory)
          return candidate === target || candidate.includes(target) || target.includes(candidate)
        })
        const forgetsName =
          Boolean(current.preferredName) &&
          (target === normalizedMemory(current.preferredName) ||
            /\b(?:my )?name\b/iu.test(intent.memory))
        if (matches.length === 0 && !forgetsName) {
          detail = `I could not find an approved memory matching “${intent.memory},” so nothing changed.`
          break
        }
        const matched = new Set(matches)
        save({
          ...current,
          preferredName: forgetsName ? '' : current.preferredName,
          memories: current.memories.filter((memory) => !matched.has(memory))
        })
        detail = `Forgotten locally: ${forgetsName ? 'your preferred name' : matches.join('; ')}.`
        break
      }
      case 'forget-all': {
        save({ ...current, preferredName: '', customInstructions: '', memories: [] })
        detail =
          'I removed your preferred name, custom guidance, and approved memories from the local profile. Your calendar and reminders were not changed.'
        break
      }
    }

    return this.respond(conversationId, id, range, {
      kind: 'answer',
      text: this.groundedReply(
        conversationId,
        id,
        'memory-answer',
        [{ key: 'DETAIL', kind: 'text', value: detail }],
        ['<DETAIL>', 'Of course. <DETAIL>', 'Here’s the local memory update: <DETAIL>']
      ),
      relatedEventIds: [],
      relatedReminderIds: [],
      receipt: null
    })
  }

  private answerConversation(
    conversationId: string,
    id: string,
    intent: ConversationIntent,
    range: CalendarSnapshotRequest
  ): AssistantExchange {
    const preferences = this.repository.getPreferences()
    const profile = preferences.assistantProfile
    const name = profile.memoryEnabled && profile.preferredName ? `${profile.preferredName}, ` : ''
    const localDateTime = new Intl.DateTimeFormat(preferences.locale, {
      timeZone: preferences.timezone,
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short'
    }).format(new Date())
    const content: Record<ConversationIntent, { detail: string; templates: readonly string[] }> = {
      greeting: {
        detail: `${name}I’m here and ready to help with your time. Ask naturally, or ask what I can do if you want a quick tour.`,
        templates: [
          'Hi — <DETAIL>',
          'Hello! <DETAIL>',
          'Hey, good to hear from you. <DETAIL>',
          '<DETAIL>'
        ]
      },
      capabilities: {
        detail:
          'I can create, move, rename, repeat, duplicate, and delete events; set, update, complete, and remove reminders; answer schedule, search, free-time, and conflict questions; copy whole-day schedules; and turn images or PDFs into reviewed plans. Try “make room for lunch tomorrow at noon,” “push my check-in later,” or “am I free this afternoon?” I’ll ask when something is ambiguous, and no calendar write is saved until you approve it.',
        templates: [
          '<DETAIL>',
          'Absolutely. <DETAIL>',
          'Here’s my wheelhouse: <DETAIL>',
          'I can give you the quick tour. <DETAIL>'
        ]
      },
      identity: {
        detail:
          'I’m Remind Me, a private calendar and reminder assistant. My original RemindCore and RemindSpeak models handle safe scheduling and varied grounded replies on this device; an optional local language pack can add broader conversation.',
        templates: [
          '<DETAIL>',
          'Nice to meet you. <DETAIL>',
          'I’m your local timekeeper: <DETAIL>',
          'In a sentence: <DETAIL>'
        ]
      },
      architecture: {
        detail:
          'The always-installed core is original project work: RemindCore is a scratch-trained calendar intent and span model, and RemindSpeak is a scratch-trained grounded response model. Deterministic code validates calendar math, previews every write, and keeps it undoable. If you install it, Qwen3 1.7B Q4 adds broader local conversation for capable hardware, but it has no direct database authority.',
        templates: [
          '<DETAIL>',
          'Under the hood, <DETAIL>',
          'The short technical tour: <DETAIL>',
          'Here’s how I’m put together: <DETAIL>'
        ]
      },
      'local-time': {
        detail: `On this device, it’s ${localDateTime}. Your calendar timezone is ${preferences.timezone}.`,
        templates: [
          '<DETAIL>',
          'Right now, <DETAIL>',
          'By your local calendar settings, <DETAIL>',
          'The local clock says: <DETAIL>'
        ]
      },
      wellbeing: {
        detail:
          'I’m doing well—quietly running on this device and ready to untangle a schedule whenever you are.',
        templates: [
          '<DETAIL>',
          'Doing nicely, thanks for asking. <DETAIL>',
          'All good here. <DETAIL>',
          'Ready and caffeinated in spirit. <DETAIL>'
        ]
      },
      encouragement: {
        detail:
          'You do not need to finish everything at once. Pick the smallest useful next step, give it your full attention, and let that bit of progress create the momentum.',
        templates: [
          '<DETAIL>',
          'A gentle nudge: <DETAIL>',
          'Here’s one thought to carry with you: <DETAIL>',
          'You’ve got room to begin small. <DETAIL>'
        ]
      },
      joke: {
        detail:
          'Why did the homework bring a calendar? It wanted all its problems to have due dates.',
        templates: [
          '<DETAIL>',
          'A tiny one: <DETAIL>',
          'Here’s a study-break joke: <DETAIL>',
          'One quick bit of calendar humor: <DETAIL>'
        ]
      },
      thanks: {
        detail: 'You’re welcome. I’ll be here when the next plan needs a home.',
        templates: [
          '<DETAIL>',
          'Anytime. <DETAIL>',
          'Glad to help. <DETAIL>',
          'Of course. <DETAIL>'
        ]
      },
      goodbye: {
        detail: 'Take care. Your calendar will be right here when you come back.',
        templates: [
          '<DETAIL>',
          'See you later. <DETAIL>',
          'Bye for now. <DETAIL>',
          'Until next time. <DETAIL>'
        ]
      }
    }
    const selected = content[intent]
    const text = this.groundedReply(
      conversationId,
      id,
      'conversation-answer',
      [{ key: 'DETAIL', kind: 'text', value: selected.detail }],
      selected.templates
    )
    return this.respond(conversationId, id, range, {
      kind: 'answer',
      text,
      relatedEventIds: [],
      relatedReminderIds: [],
      receipt: null
    })
  }

  private eventFactForChat(
    event: EventEntity,
    occurrenceStartUtc: string,
    priority: FlexModelCalendarFact['priority'],
    provenance: FlexModelCalendarFact['provenance'] = event.provenance
  ): Omit<FlexModelCalendarFact, 'ref'> {
    const preferences = this.repository.getPreferences()
    const occurrence = eventEntityOccurrence(event, occurrenceStartUtc)
    const grounded = groundedEventAnswerItem(occurrence, preferences.locale, event.recurrence)
    return {
      factId: `${event.id}:${occurrenceStartUtc}`,
      entityId: event.id,
      kind: 'event',
      priority,
      provenance,
      occurrenceStartUtc,
      fields: {
        title: grounded.title,
        date: grounded.attributes.date ?? null,
        time: grounded.attributes.time ?? null,
        start: grounded.attributes.start ?? null,
        end: grounded.attributes.end ?? null,
        duration: grounded.attributes.duration ?? null,
        location: grounded.attributes.location ?? null,
        notes: grounded.attributes.notes ?? null,
        recurrence: grounded.attributes.recurrence ?? null,
        details: grounded.detail,
        action: null,
        status: event.status
      }
    }
  }

  private reminderFactForChat(
    reminder: ReminderEntity,
    priority: FlexModelCalendarFact['priority'],
    provenance: FlexModelCalendarFact['provenance'] = reminder.provenance
  ): Omit<FlexModelCalendarFact, 'ref'> {
    const preferences = this.repository.getPreferences()
    const grounded = groundedReminderAnswerItem(reminder, preferences.locale)
    return {
      factId: `${reminder.id}:${reminder.dueAtUtc}`,
      entityId: reminder.id,
      kind: 'reminder',
      priority,
      provenance,
      occurrenceStartUtc: reminder.dueAtUtc,
      fields: {
        title: grounded.title,
        date: grounded.attributes.date ?? null,
        time: grounded.attributes.time ?? null,
        start: grounded.attributes.start ?? null,
        end: grounded.attributes.end ?? null,
        duration: grounded.attributes.duration ?? null,
        location: grounded.attributes.location ?? null,
        notes: grounded.attributes.notes ?? null,
        recurrence: grounded.attributes.recurrence ?? null,
        details: grounded.detail,
        action: null,
        status: reminder.status
      }
    }
  }

  private calendarFactPacketForChat(
    conversationId: string,
    sourceText: string,
    trace?: MutableAssistantExecutionTrace
  ): FlexModelCalendarFactPacket {
    const state = this.repository.getAssistantDialogueState(conversationId)
    const preferences = this.repository.getPreferences()
    const candidates: Array<Omit<FlexModelCalendarFact, 'ref'>> = []
    const seen = new Set<string>()
    const add = (fact: Omit<FlexModelCalendarFact, 'ref'>): void => {
      const key = `${fact.kind}:${fact.factId}:${fact.occurrenceStartUtc ?? ''}`
      if (seen.has(key)) return
      seen.add(key)
      candidates.push(fact)
    }

    const activeProposal = this.repository.getActiveAssistantProposal(conversationId)
    if (activeProposal) {
      if (activeProposal.payload.kind === 'bulk-delete') {
        for (const eventId of activeProposal.payload.eventIds) {
          const event = this.repository.getEvent(eventId)
          if (!event) continue
          const fact = this.eventFactForChat(event, event.startUtc, 'review', 'review')
          fact.fields.action = activeProposal.summary
          fact.fields.status = 'pending removal review'
          add(fact)
        }
        for (const reminderId of activeProposal.payload.reminderIds) {
          const reminder = this.repository.getReminder(reminderId)
          if (!reminder) continue
          const fact = this.reminderFactForChat(reminder, 'review', 'review')
          fact.fields.action = activeProposal.summary
          fact.fields.status = 'pending removal review'
          add(fact)
        }
      }
      const entries = this.proposalReviewEntries(activeProposal)
      for (const entry of entries) {
        const facts = this.proposalReviewFacts(entry, preferences.locale)
        const entityId =
          entry.payload.kind === 'event-delete' ||
          entry.payload.kind === 'reminder-complete' ||
          entry.payload.kind === 'reminder-delete'
            ? entry.payload.id
            : entry.payload.form.id
        add({
          factId: `review:${activeProposal.id}:${entry.position + 1}`,
          entityId,
          kind: 'review',
          priority: 'review',
          provenance: 'review',
          occurrenceStartUtc: null,
          fields: {
            title: facts.title,
            date: facts.date,
            time: facts.time,
            start: null,
            end: null,
            duration: null,
            location: facts.location,
            notes: facts.notes,
            recurrence: facts.recurrence,
            details: facts.details,
            action: facts.action,
            status: 'pending review'
          }
        })
      }
    }

    const activeFrame =
      state.queryFrames.find((frame) => frame.frameId === state.activeQueryFrameId) ?? null
    const addFrameItem = (
      item: AssistantQueryFrameItem,
      priority: FlexModelCalendarFact['priority']
    ): void => {
      if (item.kind === 'event') {
        const event = this.repository.getEvent(item.id)
        if (event?.status === 'active') {
          add(this.eventFactForChat(event, item.occurrenceStart ?? event.startUtc, priority))
        }
        return
      }
      const reminder = this.repository.getReminder(item.id)
      if (reminder && reminder.status !== 'cancelled') {
        add(this.reminderFactForChat(reminder, priority))
      }
    }
    for (const item of activeFrame?.selectedItems ?? []) addFrameItem(item, 'focused')
    for (const item of activeFrame?.orderedItems ?? []) addFrameItem(item, 'range')

    const activeRange = activeFrame?.range ?? state.activeRange
    const events = this.repository.listEvents().filter((event) => event.status === 'active')
    const reminders = this.repository
      .listReminders()
      .filter((reminder) => reminder.status !== 'cancelled')
    if (activeRange) {
      const occurrences = expandEventsInRange(
        events,
        activeRange.rangeStartUtc,
        activeRange.rangeEndUtc,
        this.repository.listRecurrenceExceptions()
      )
      for (const occurrence of occurrences) {
        const event = this.repository.getEvent(occurrence.eventId)
        if (event) add(this.eventFactForChat(event, occurrence.startUtc, 'range'))
      }
      for (const reminder of reminders) {
        if (
          Date.parse(reminder.dueAtUtc) >= Date.parse(activeRange.rangeStartUtc) &&
          Date.parse(reminder.dueAtUtc) < Date.parse(activeRange.rangeEndUtc)
        ) {
          add(this.reminderFactForChat(reminder, 'range'))
        }
      }
    }

    const now = Date.now()
    const nearbyEnd = new Date(now + 45 * 24 * 60 * 60 * 1_000).toISOString()
    const nearbyStart = new Date(now - 24 * 60 * 60 * 1_000).toISOString()
    const nearbyOccurrences = expandEventsInRange(
      events,
      nearbyStart,
      nearbyEnd,
      this.repository.listRecurrenceExceptions()
    )
      .sort(
        (left, right) =>
          Math.abs(Date.parse(left.startUtc) - now) - Math.abs(Date.parse(right.startUtc) - now)
      )
      .slice(0, 36)
    for (const occurrence of nearbyOccurrences) {
      const event = this.repository.getEvent(occurrence.eventId)
      if (event) add(this.eventFactForChat(event, occurrence.startUtc, 'nearby'))
    }
    for (const reminder of reminders
      .slice()
      .sort(
        (left, right) =>
          Math.abs(Date.parse(left.dueAtUtc) - now) - Math.abs(Date.parse(right.dueAtUtc) - now)
      )
      .slice(0, 24)) {
      add(this.reminderFactForChat(reminder, 'nearby'))
    }

    const normalizedRequest = sourceText.normalize('NFKC').trim()
    const pluralRequest =
      /\b(?:all|both|each|every|multiple|they|them|their|those|these|agenda|schedule|classes|courses|events|meetings|appointments|reminders|times|locations|rooms|summari[sz]e|summary|recap)\b/iu.test(
        normalizedRequest
      )
    const singularRequest = /\b(?:first|last|next|one|which|where|room|location)\b/iu.test(
      normalizedRequest
    )
    const factLimit = pluralRequest ? 12 : singularRequest ? 3 : 6
    const requestedFields = new Set<keyof FlexModelCalendarFact['fields']>(['title'])
    const includeTemporal =
      /\b(?:what|when|time|times|timing|start|end|finish|date|day|today|tomorrow|yesterday|agenda|schedule|calendar|free|busy)\b/iu.test(
        normalizedRequest
      )
    if (includeTemporal) {
      requestedFields.add('date')
      requestedFields.add('time')
      requestedFields.add('start')
      requestedFields.add('end')
      requestedFields.add('duration')
    }
    if (/\b(?:where|room|rooms|location|locations|place)\b/iu.test(normalizedRequest)) {
      requestedFields.add('location')
    }
    if (/\b(?:note|notes|instruction|instructions)\b/iu.test(normalizedRequest)) {
      requestedFields.add('notes')
    }
    if (/\b(?:detail|details|why|explain|summari[sz]e|summary|recap)\b/iu.test(normalizedRequest)) {
      requestedFields.add('details')
    }
    if (/\b(?:repeat|repeats|recurrence|often|weekdays?|which days)\b/iu.test(normalizedRequest)) {
      requestedFields.add('recurrence')
    }
    if (activeProposal) {
      requestedFields.add('action')
      requestedFields.add('status')
    }
    const facts = candidates.slice(0, factLimit).map((fact, index) => ({
      ref: `F${index + 1}`,
      ...fact,
      fields: {
        title: fact.fields.title,
        date: requestedFields.has('date') ? fact.fields.date : null,
        time: requestedFields.has('time') ? fact.fields.time : null,
        start: requestedFields.has('start') ? fact.fields.start : null,
        end: requestedFields.has('end') ? fact.fields.end : null,
        duration: requestedFields.has('duration') ? fact.fields.duration : null,
        location: requestedFields.has('location') ? fact.fields.location : null,
        notes: requestedFields.has('notes') ? fact.fields.notes : null,
        recurrence: requestedFields.has('recurrence') ? fact.fields.recurrence : null,
        details: requestedFields.has('details') ? fact.fields.details : null,
        action: requestedFields.has('action') ? fact.fields.action : null,
        status: requestedFields.has('status') ? fact.fields.status : null
      }
    }))
    const packet: FlexModelCalendarFactPacket = {
      schemaVersion: 1,
      range: activeRange
        ? {
            startUtc: activeRange.rangeStartUtc,
            endUtc: activeRange.rangeEndUtc,
            timezone: activeRange.timezone
          }
        : null,
      facts,
      truncated: candidates.length > facts.length
    }
    while (JSON.stringify(packet).length > 5_800 && packet.facts.length > 0) {
      packet.facts.pop()
      packet.truncated = true
    }
    if (packet.truncated && trace) trace.truncated = true
    return flexModelCalendarFactPacketSchema.parse(packet)
  }

  private executionContextFrame(conversation: AssistantConversation): AssistantContextFrame {
    if (conversation.activeProposal) return 'active-review'
    if (conversation.dialogueState.pendingClarification) return 'pending-clarification'
    if (conversation.dialogueState.lastQuery) return 'last-query'
    if (
      conversation.dialogueState.focusedEventIds.length > 0 ||
      conversation.dialogueState.focusedReminderIds.length > 0
    ) {
      return 'focused-items'
    }
    return 'none'
  }

  private async recordFallbackTruncation(
    trace: MutableAssistantExecutionTrace,
    provider: FallbackStatusProvider
  ): Promise<void> {
    let status: FallbackStatus | null
    try {
      status = (await provider.getStatus?.()) ?? null
    } catch {
      if (trace.fallbackReason === 'not-needed') trace.fallbackReason = 'unavailable'
      return
    }
    if (status?.lastRequest?.inputTruncated) trace.truncated = true
  }

  private dialogueContextForPlanner(
    conversationId: string,
    trace?: MutableAssistantExecutionTrace
  ): string {
    const state = this.repository.getAssistantDialogueState(conversationId)
    const focusedEvents = new Set(state.focusedEventIds)
    const focusedReminders = new Set(state.focusedReminderIds)
    const activeProposal = this.repository.getActiveAssistantProposal(conversationId)
    const locale = this.repository.getPreferences().locale
    const activeReview = activeProposal
      ? activeProposal.payload.kind === 'bulk-delete'
        ? {
            operation: activeProposal.operation,
            summary: activeProposal.summary,
            itemCount:
              activeProposal.payload.eventIds.length + activeProposal.payload.reminderIds.length,
            exactBulkSelection: true,
            items: [] as Array<Record<string, unknown>>,
            truncated: false
          }
        : (() => {
            const entries = this.proposalReviewEntries(activeProposal)
            return {
              operation: activeProposal.operation,
              summary: activeProposal.summary,
              itemCount: entries.length,
              exactBulkSelection: false,
              items: entries.slice(0, 10).map((entry) => ({
                position: entry.position + 1,
                ...this.proposalReviewFacts(entry, locale)
              })),
              truncated: entries.length > 10
            }
          })()
      : null
    const payload = {
      focusedItems: [
        ...this.repository
          .listEvents()
          .filter((event) => focusedEvents.has(event.id))
          .map((event) => ({ kind: 'event', id: event.id, title: event.title })),
        ...this.repository
          .listReminders()
          .filter((reminder) => focusedReminders.has(reminder.id))
          .map((reminder) => ({ kind: 'reminder', id: reminder.id, title: reminder.title }))
      ].slice(0, 20),
      activeRange: state.activeRange,
      lastQuery: state.lastQuery
        ? {
            operation: state.lastQuery.operation,
            rangeStartUtc: state.lastQuery.rangeStartUtc,
            rangeEndUtc: state.lastQuery.rangeEndUtc,
            queryText: state.lastQuery.queryText
          }
        : null,
      pendingClarification: state.pendingClarification
        ? {
            code: state.pendingClarification.code,
            message: state.pendingClarification.message,
            options: state.pendingClarification.options
          }
        : null,
      activeReview
    }
    if (focusedEvents.size + focusedReminders.size > 20 && trace) trace.truncated = true
    let context = JSON.stringify(payload)
    while (context.length > 4_000 && payload.activeReview?.items.length) {
      if (trace) trace.truncated = true
      payload.activeReview.items.pop()
      payload.activeReview.truncated = true
      context = JSON.stringify(payload)
    }
    if (context.length > 4_000 && trace) trace.truncated = true
    return context.slice(0, 4_000)
  }

  private derivedConversationSummary(
    usableTurns: readonly ConversationTurnEntity[],
    trace?: MutableAssistantExecutionTrace
  ): string {
    const olderTurns = usableTurns.slice(0, Math.max(0, usableTurns.length - 8)).slice(-12)
    const lines = olderTurns.map((turn) => {
      const role = turn.role === 'user' ? 'USER' : 'REMIND ME'
      return `${role}: ${clippedDetail(turn.text, 180)}`
    })
    let summary = lines.join('\n')
    if (summary.length > 2_000) {
      summary = `[…] ${summary.slice(-(2_000 - 4))}`
      if (trace) trace.truncated = true
    }
    if (olderTurns.length < Math.max(0, usableTurns.length - 8) && trace) trace.truncated = true
    return summary
  }

  private async streamValidatedFallbackAnswer(
    text: string,
    onChunk?: (text: string) => void
  ): Promise<void> {
    if (!onChunk) return
    const tokens = text.match(/\S+\s*/gu) ?? [text]
    const groupSize = Math.max(1, Math.ceil(tokens.length / 24))
    let visible = ''
    for (let index = 0; index < tokens.length; index += groupSize) {
      visible += tokens.slice(index, index + groupSize).join('')
      onChunk(visible.trimEnd())
      if (index + groupSize < tokens.length) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 8))
      }
    }
  }

  private async generalFallbackAnswer(
    conversationId: string,
    id: string,
    sourceText: string,
    earlierTurns: readonly ConversationTurnEntity[],
    range: CalendarSnapshotRequest,
    onChunk?: (text: string) => void,
    cancellationId?: string,
    onStatus?: (status: FlexModelJobStatus) => void,
    trace?: MutableAssistantExecutionTrace
  ): Promise<AssistantExchange | null> {
    if (trace) trace.fallbackWorkload = 'chat'
    if (!this.generalFallbackResponder) {
      if (trace) trace.fallbackReason = 'not-configured'
      return null
    }
    if (looksLikeCalendarMutation(routeAssistantRequest(sourceText).normalizedText)) {
      if (trace) trace.fallbackReason = 'write-claim-rejected'
      return null
    }
    const preferences = this.repository.getPreferences()
    const now = Temporal.Now.instant().toZonedDateTimeISO(preferences.timezone)
    const profile = preferences.assistantProfile.memoryEnabled
      ? preferences.assistantProfile
      : { ...preferences.assistantProfile, preferredName: '', memories: [] }
    const turns: Array<{ role: 'user' | 'assistant'; text: string }> = []
    let turnBudget = 4_000
    const usableTurns = earlierTurns.filter((turn, index, allTurns) => {
      if (turn.role === 'assistant' && isRejectedFlexibleChatTurn(turn.text)) return false
      const followingTurn = allTurns[index + 1]
      return !(
        turn.role === 'user' &&
        followingTurn?.role === 'assistant' &&
        isRejectedFlexibleChatTurn(followingTurn.text)
      )
    })
    for (const turn of [...usableTurns].reverse()) {
      if (turns.length >= 8 || turnBudget <= 0) break
      if ((turn.role !== 'user' && turn.role !== 'assistant') || !turn.text.trim()) continue
      const text = turn.text.trim().slice(0, Math.min(2_000, turnBudget))
      if (text.length < turn.text.trim().length && trace) trace.truncated = true
      if (!text) continue
      turns.unshift({ role: turn.role, text })
      turnBudget -= text.length
    }
    if (turns.length < usableTurns.length && trace) trace.truncated = true
    const hasActiveReview = this.repository.getActiveAssistantProposal(conversationId) !== null
    const includeCalendarFacts = looksLikeCalendarRequest(sourceText) || hasActiveReview
    const factPacket = includeCalendarFacts
      ? this.calendarFactPacketForChat(conversationId, sourceText, trace)
      : flexModelCalendarFactPacketSchema.parse({
          schemaVersion: 1,
          range: null,
          facts: [],
          truncated: false
        })
    let result: FlexModelGeneralFallbackResult
    let lastLiveText = ''
    const liveChunk =
      factPacket.facts.length === 0 && onChunk
        ? (text: string): void => {
            const safeText = safeGeneralChatStreamPrefix(text, sourceText)
            if (!safeText || safeText === lastLiveText) return
            lastLiveText = safeText
            onChunk(safeText)
          }
        : undefined
    try {
      result = await this.generalFallbackResponder.respondGeneral(
        {
          text: sourceText,
          turns,
          conversationSummary: this.derivedConversationSummary(usableTurns, trace),
          calendarContext: includeCalendarFacts ? JSON.stringify(factPacket) : '',
          currentLocalDateTime: now.toString({ smallestUnit: 'minute' }),
          timezone: preferences.timezone,
          profile,
          style: preferences.responseStyle
        },
        liveChunk,
        {
          ...(cancellationId ? { cancellationId } : {}),
          ...(onStatus ? { onStatus } : {})
        }
      )
    } catch (error) {
      result = flexModelGeneralFallbackResultSchema.parse({
        kind: typedFallbackFailureFromError(error)
      })
    }
    if (trace) await this.recordFallbackTruncation(trace, this.generalFallbackResponder)
    switch (result.kind) {
      case 'missing':
      case 'disabled':
      case 'timeout':
      case 'unavailable':
      case 'invalid-output':
        if (trace) trace.fallbackReason = result.kind
        return null
      case 'cancelled':
        if (trace) trace.fallbackReason = 'cancelled'
        return this.respond(conversationId, id, range, {
          kind: 'answer',
          text: 'Stopped that local response. Nothing was changed.',
          relatedEventIds: [],
          relatedReminderIds: [],
          receipt: null
        })
    }
    const grounded = groundFlexChatResponse(result, factPacket, sourceText)
    if (!grounded.ok) {
      if (trace) trace.fallbackReason = grounded.reason
      return null
    }
    const responseKind =
      grounded.response.kind === 'answer'
        ? 'answer'
        : grounded.response.kind === 'clarification'
          ? 'clarification'
          : grounded.response.kind === 'offline-limit'
            ? 'answer'
            : 'rejected'
    if (trace) {
      trace.fallbackReason =
        grounded.response.kind === 'answer'
          ? 'answered'
          : grounded.response.kind === 'clarification'
            ? 'clarified'
            : grounded.response.kind === 'offline-limit'
              ? 'offline-limit'
              : 'refused'
    }
    if (onChunk && lastLiveText) onChunk(grounded.response.text)
    else await this.streamValidatedFallbackAnswer(grounded.response.text, onChunk)
    return this.respond(conversationId, id, range, {
      kind: responseKind,
      text: grounded.response.text,
      relatedEventIds: grounded.response.relatedEventIds,
      relatedReminderIds: grounded.response.relatedReminderIds,
      receipt: null
    })
  }

  private proposalReviewEntries(proposal: AssistantProposal): ProposalReviewEntry[] {
    if (proposal.payload.kind === 'bulk-delete') return []
    if (proposal.payload.kind !== 'batch') {
      return [{ payload: proposal.payload, summary: proposal.summary, position: 0 }]
    }
    return proposal.payload.items.map((payload, position) => ({
      payload,
      summary:
        proposal.payload.kind === 'batch' ? (proposal.payload.itemSummaries[position] ?? '') : '',
      position
    }))
  }

  private proposalReviewLabel(entry: ProposalReviewEntry): string {
    switch (entry.payload.kind) {
      case 'event-save':
        return entry.payload.form.title
      case 'event-delete':
        return this.repository.getEvent(entry.payload.id)?.title ?? `Event ${entry.position + 1}`
      case 'reminder-save':
        return entry.payload.form.title
      case 'reminder-complete':
      case 'reminder-delete':
        return (
          this.repository.getReminder(entry.payload.id)?.title ?? `Reminder ${entry.position + 1}`
        )
    }
  }

  private proposalCorrectionClarification(
    proposal: AssistantProposal,
    id: string,
    range: CalendarSnapshotRequest,
    message: string
  ): AssistantExchange {
    return this.respond(proposal.conversationId, id, range, {
      kind: 'clarification',
      text: message,
      relatedEventIds: [],
      relatedReminderIds: [],
      receipt: null
    })
  }

  private proposalReviewFacts(entry: ProposalReviewEntry, locale: string): ProposalReviewFacts {
    const action = entry.summary.replace(/[.!?]+$/gu, '')
    if (entry.payload.kind === 'event-save') {
      const form = entry.payload.form
      const startUtc = localInstant(form.startDate, form.startTime ?? '00:00', form.timezone)
      const endUtc = form.allDay
        ? localInstant(
            Temporal.PlainDate.from(form.endDate).add({ days: 1 }).toString(),
            '00:00',
            form.timezone
          )
        : localInstant(form.endDate, form.endTime ?? form.startTime ?? '00:00', form.timezone)
      const date =
        form.startDate === form.endDate
          ? formatDate(startUtc, locale, form.timezone)
          : `${formatDate(startUtc, locale, form.timezone)} through ${formatDate(
              Temporal.Instant.from(endUtc).subtract({ nanoseconds: 1 }).toString(),
              locale,
              form.timezone
            )}`
      const time = form.allDay
        ? 'all day'
        : `${formatTime(startUtc, locale, form.timezone)}–${formatTime(
            endUtc,
            locale,
            form.timezone
          )}`
      const location = form.location.trim() || 'no location saved'
      const notes = form.description.trim() ? clippedDetail(form.description) : 'no notes saved'
      const recurrence = recurrenceDetail(form.recurrence, locale)
      return {
        title: form.title,
        kind: 'event',
        action,
        date,
        time,
        location,
        notes,
        recurrence,
        details: `${date}, ${time}${form.location.trim() ? ` at ${form.location.trim()}` : ''}; ${recurrence}`
      }
    }
    if (entry.payload.kind === 'reminder-save') {
      const form = entry.payload.form
      const dueAtUtc = localInstant(form.dueDate, form.dueTime, form.timezone)
      const date = formatDate(dueAtUtc, locale, form.timezone)
      const time = formatTime(dueAtUtc, locale, form.timezone)
      const notes = form.notes.trim() ? clippedDetail(form.notes) : 'no notes saved'
      const recurrence = recurrenceDetail(form.recurrence, locale)
      return {
        title: form.title,
        kind: 'reminder',
        action,
        date,
        time,
        location: 'reminders do not have a location',
        notes,
        recurrence,
        details: `${date} at ${time}; ${recurrence}`
      }
    }
    if (entry.payload.kind === 'event-delete') {
      const event = this.repository.getEvent(entry.payload.id)
      if (!event) {
        return {
          title: this.proposalReviewLabel(entry),
          kind: 'event',
          action,
          date: 'the saved event is no longer available',
          time: 'the saved event is no longer available',
          location: 'the saved event is no longer available',
          notes: 'the saved event is no longer available',
          recurrence: 'the saved event is no longer available',
          details: 'the saved event is no longer available'
        }
      }
      const date = formatDate(event.startUtc, locale, event.timezone)
      const time = event.allDay
        ? 'all day'
        : `${formatTime(event.startUtc, locale, event.timezone)}–${formatTime(
            event.endUtc,
            locale,
            event.timezone
          )}`
      const recurrence = recurrenceDetail(event.recurrence, locale)
      return {
        title: event.title,
        kind: 'event',
        action,
        date,
        time,
        location: event.location.trim() || 'no location saved',
        notes: event.description.trim() ? clippedDetail(event.description) : 'no notes saved',
        recurrence,
        details: `${date}, ${time}${event.location.trim() ? ` at ${event.location.trim()}` : ''}; ${recurrence}`
      }
    }

    const reminder = this.repository.getReminder(entry.payload.id)
    if (!reminder) {
      return {
        title: this.proposalReviewLabel(entry),
        kind: 'reminder',
        action,
        date: 'the saved reminder is no longer available',
        time: 'the saved reminder is no longer available',
        location: 'reminders do not have a location',
        notes: 'the saved reminder is no longer available',
        recurrence: 'the saved reminder is no longer available',
        details: 'the saved reminder is no longer available'
      }
    }
    const date = formatDate(reminder.dueAtUtc, locale, reminder.timezone)
    const time = formatTime(reminder.dueAtUtc, locale, reminder.timezone)
    const recurrence = recurrenceDetail(reminder.recurrence, locale)
    return {
      title: reminder.title,
      kind: 'reminder',
      action,
      date,
      time,
      location: 'reminders do not have a location',
      notes: reminder.notes.trim() ? clippedDetail(reminder.notes) : 'no notes saved',
      recurrence,
      details: `${date} at ${time}; ${recurrence}`
    }
  }

  private proposalReviewAttribute(
    facts: ProposalReviewFacts,
    attribute: Extract<ProposalReviewQuery, { kind: 'detail' }>['attribute']
  ): string {
    switch (attribute) {
      case 'details':
        return facts.details
      case 'title':
        return facts.title
      case 'kind':
        return facts.kind
      case 'action':
        return facts.action
      case 'date':
        return facts.date
      case 'time':
        return facts.time
      case 'location':
        return facts.location
      case 'notes':
        return facts.notes
      case 'recurrence':
        return facts.recurrence
    }
  }

  private reviewEventEntity(entry: ProposalReviewEntry, now: string): EventEntity | null {
    if (entry.payload.kind !== 'event-save') return null
    const form = entry.payload.form
    const calendarId = form.calendarId ?? this.repository.listCalendars()[0]?.id ?? 'calendar:local'
    const startUtc = localInstant(form.startDate, form.startTime ?? '00:00', form.timezone)
    const endUtc = form.allDay
      ? localInstant(
          Temporal.PlainDate.from(form.endDate).add({ days: 1 }).toString(),
          '00:00',
          form.timezone
        )
      : localInstant(form.endDate, form.endTime ?? form.startTime ?? '00:00', form.timezone)
    return {
      id: `review:event:${entry.position + 1}`,
      calendarId,
      title: form.title,
      description: form.description,
      location: form.location,
      startUtc,
      endUtc,
      timezone: form.timezone,
      allDay: form.allDay,
      recurrence: form.recurrence,
      status: 'active',
      provenance: 'assistant',
      createdAt: now,
      updatedAt: now
    }
  }

  private proposalConflictAnswer(
    entries: readonly ProposalReviewEntry[],
    selectedIndexes: readonly number[] | null,
    locale: string
  ): { detail: string; hasConflicts: boolean } {
    const now = new Date().toISOString()
    const proposed = entries
      .map((entry) => ({ entry, event: this.reviewEventEntity(entry, now) }))
      .filter(
        (candidate): candidate is { entry: ProposalReviewEntry; event: EventEntity } =>
          candidate.event !== null
      )
    const selected = new Set(selectedIndexes ?? entries.map((entry) => entry.position))
    const selectedProposed = proposed.filter((candidate) => selected.has(candidate.entry.position))
    if (selectedProposed.length === 0) {
      return {
        detail:
          'The selected review rows do not add or move an event time, so there is no proposed time window to compare.',
        hasConflicts: false
      }
    }
    const recurring = selectedProposed.some((candidate) => candidate.event.recurrence !== null)
    const deletedEventIds = new Set(
      entries
        .filter((entry) => entry.payload.kind === 'event-delete')
        .map((entry) => (entry.payload.kind === 'event-delete' ? entry.payload.id : ''))
    )
    const replacedEventIds = new Set(
      entries
        .filter((entry) => entry.payload.kind === 'event-save' && entry.payload.form.id !== null)
        .map((entry) => (entry.payload.kind === 'event-save' ? (entry.payload.form.id ?? '') : ''))
    )
    const savedEvents = this.repository
      .listEvents()
      .filter((event) => !deletedEventIds.has(event.id) && !replacedEventIds.has(event.id))
    const recurrenceExceptions = this.repository.listRecurrenceExceptions()
    const seen = new Set<string>()
    const conflicts: Array<{
      left: EventOccurrence
      right: EventOccurrence
    }> = []

    for (const candidate of selectedProposed) {
      const checkStartUtc = candidate.event.startUtc
      const checkEndUtc = candidate.event.recurrence
        ? Temporal.Instant.from(checkStartUtc)
            .toZonedDateTimeISO(candidate.event.timezone)
            .add({ days: 90 })
            .toInstant()
            .toString({ fractionalSecondDigits: 3 })
        : candidate.event.endUtc
      const selectedOccurrences = expandEventOccurrences(
        candidate.event,
        checkStartUtc,
        checkEndUtc
      )
      const comparisonOccurrences = [
        ...expandEventsInRange(savedEvents, checkStartUtc, checkEndUtc, recurrenceExceptions),
        ...proposed
          .filter((other) => other.event.id !== candidate.event.id)
          .flatMap((other) => expandEventOccurrences(other.event, checkStartUtc, checkEndUtc))
      ]
      for (const left of selectedOccurrences) {
        for (const right of comparisonOccurrences) {
          if (!overlaps(left.startUtc, left.endUtc, right.startUtc, right.endUtc)) continue
          const key = [left.occurrenceId, right.occurrenceId].sort().join('|')
          if (seen.has(key)) continue
          seen.add(key)
          conflicts.push({ left, right })
        }
      }
    }
    conflicts.sort(
      (left, right) => Date.parse(left.left.startUtc) - Date.parse(right.left.startUtc)
    )
    const horizonDetail = recurring ? ' within the first 90 days of the proposed repeat' : ''
    if (conflicts.length === 0) {
      return {
        detail: `I found no overlap with your saved calendar or another reviewed event${horizonDetail}`,
        hasConflicts: false
      }
    }
    const visible = conflicts.slice(0, 5).map(({ left, right }) => {
      const when = left.allDay
        ? `${formatDate(left.startUtc, locale, left.timezone)}, all day`
        : formatDateTime(left.startUtc, locale, left.timezone)
      return `“${left.title}” overlaps “${right.title}” at ${when}`
    })
    const more =
      conflicts.length > visible.length ? `; ${conflicts.length - visible.length} more` : ''
    return {
      detail: `${visible.join('; ')}${more}${horizonDetail}`,
      hasConflicts: true
    }
  }

  private answerActiveProposalQuestion(
    proposal: AssistantProposal,
    normalizedInput: string,
    range: CalendarSnapshotRequest,
    id: string
  ): AssistantExchange | null {
    const entries = this.proposalReviewEntries(proposal)
    const labels = entries.map((entry) => this.proposalReviewLabel(entry))
    const query = parseProposalReviewQuery(normalizedInput, labels)
    if (!query) return null
    if (query.kind === 'clarify') {
      return this.proposalCorrectionClarification(proposal, id, range, query.message)
    }

    const preferences = this.repository.getPreferences()
    const respondWithFact = (
      detail: string,
      speechAct: ResponsePlan['speechAct'],
      templates: readonly string[]
    ): AssistantExchange =>
      this.respond(proposal.conversationId, id, range, {
        kind: 'answer',
        text: this.groundedReply(
          proposal.conversationId,
          id,
          speechAct,
          [{ key: 'DETAIL', kind: 'text', value: detail.slice(0, 2_000) }],
          templates
        ),
        relatedEventIds: [],
        relatedReminderIds: [],
        receipt: null
      })

    if (proposal.payload.kind === 'bulk-delete') {
      const count = proposal.payload.eventIds.length + proposal.payload.reminderIds.length
      if (query.kind === 'count') {
        return respondWithFact(
          `${count} item${count === 1 ? '' : 's'} in the bulk-clear review`,
          'item-details-answer',
          ['<DETAIL>. Nothing is saved yet.', 'The current preview has <DETAIL>.']
        )
      }
      if (query.kind === 'overview') {
        return respondWithFact(proposal.summary, 'schedule-summary', [
          '<DETAIL> Nothing is saved yet.',
          'The current review would <DETAIL> It still needs confirmation.'
        ])
      }
      return this.proposalCorrectionClarification(
        proposal,
        id,
        range,
        'This bulk-clear preview captures an exact set rather than individually editable rows. Cancel it and ask for a narrower clear if you want item-level details.'
      )
    }

    if (query.kind === 'count') {
      const count = entries.length
      return respondWithFact(
        `${count} change${count === 1 ? '' : 's'} in the current review`,
        'item-details-answer',
        ['<DETAIL>. Nothing is saved yet.', 'The preview has <DETAIL>. It still needs approval.']
      )
    }
    if (query.kind === 'overview') {
      const visible = entries.slice(0, 10)
      const detail =
        query.mode === 'actions'
          ? visible.map((entry) => entry.summary).join(' ')
          : query.mode === 'details'
            ? visible
                .map((entry) => {
                  const facts = this.proposalReviewFacts(entry, preferences.locale)
                  return `${entry.position + 1}. ${facts.title} — ${facts.details}`
                })
                .join('; ')
            : visible
                .map(
                  (entry) =>
                    `${entries.length > 1 ? `${entry.position + 1}. ` : ''}${this.proposalReviewLabel(entry)}`
                )
                .join('; ')
      const more =
        entries.length > visible.length ? `; ${entries.length - visible.length} more` : ''
      return respondWithFact(`${detail}${more}`, 'schedule-summary', [
        '<DETAIL>. Nothing is saved yet.',
        'Here’s the current review: <DETAIL>. It still needs approval.',
        'The unsaved preview contains <DETAIL>.'
      ])
    }
    if (query.kind === 'conflicts') {
      const result = this.proposalConflictAnswer(entries, query.indexes, preferences.locale)
      return respondWithFact(
        result.detail,
        result.hasConflicts ? 'conflict-warning' : 'availability-answer',
        result.hasConflicts
          ? [
              '<DETAIL>. Nothing has been saved yet.',
              'I found a collision in the current review: <DETAIL>.',
              'Before you approve it: <DETAIL>.'
            ]
          : [
              '<DETAIL>. Nothing has been saved yet.',
              'The current review is clear: <DETAIL>.',
              '<DETAIL>. The preview still needs approval.'
            ]
      )
    }

    const selectedEntries = query.indexes
      .map((index) => entries[index])
      .filter((entry): entry is ProposalReviewEntry => Boolean(entry))
    if (selectedEntries.length !== query.indexes.length) {
      return this.proposalCorrectionClarification(
        proposal,
        id,
        range,
        'That position is outside the current review. Nothing was changed.'
      )
    }
    const detail = selectedEntries
      .map((entry) => {
        const facts = this.proposalReviewFacts(entry, preferences.locale)
        const value = this.proposalReviewAttribute(facts, query.attribute)
        return `${selectedEntries.length > 1 ? `${entry.position + 1}. ` : ''}${facts.title} — ${value}`
      })
      .join('; ')
    return respondWithFact(detail, 'item-details-answer', [
      '<DETAIL>.',
      'In the current review, <DETAIL>.',
      '<DETAIL>. It is still only a preview.'
    ])
  }

  private reviseActiveProposal(
    proposal: AssistantProposal,
    normalizedInput: string,
    sourceText: string,
    range: CalendarSnapshotRequest,
    id: string
  ): AssistantExchange | null {
    const entries = this.proposalReviewEntries(proposal)
    if (entries.length === 0) {
      if (
        /\b(?:review|proposal|preview|batch)\b/iu.test(normalizedInput) &&
        /\b(?:change|drop|edit|exclude|keep|make|remove|update)\b/iu.test(normalizedInput)
      ) {
        return this.proposalCorrectionClarification(
          proposal,
          id,
          range,
          'This is an exact bulk-clear review, so its captured item set cannot be edited in place. Cancel it and ask for the narrower clear you want.'
        )
      }
      return null
    }
    const correction = parseProposalReviewCorrection(
      normalizedInput,
      entries.map((entry) => this.proposalReviewLabel(entry))
    )
    if (!correction) return null
    if (correction.kind === 'clarify') {
      return this.proposalCorrectionClarification(proposal, id, range, correction.message)
    }

    let nextEntries: ProposalReviewEntry[]
    if (correction.kind === 'keep' || correction.kind === 'remove') {
      const selected = new Set(correction.indexes)
      nextEntries = entries.filter((entry) =>
        correction.kind === 'keep' ? selected.has(entry.position) : !selected.has(entry.position)
      )
    } else {
      const revisions = new Map<number, AssistantAtomicProposalPayload>()
      for (const index of correction.indexes) {
        const entry = entries[index]
        if (!entry) {
          return this.proposalCorrectionClarification(
            proposal,
            id,
            range,
            `That position is outside this ${entries.length}-item review. Nothing in the current review changed.`
          )
        }
        const revision = this.reviseProposalItem(entry.payload, correction, id, index)
        if (!revision.ok) {
          return this.proposalCorrectionClarification(proposal, id, range, revision.message)
        }
        revisions.set(index, revision.payload)
      }
      nextEntries = entries.map((entry) => ({
        ...entry,
        payload: revisions.get(entry.position) ?? entry.payload
      }))
    }

    if (nextEntries.length === 0) {
      this.repository.setAssistantProposalStatus(proposal.id, 'rejected')
      return this.respond(proposal.conversationId, id, range, {
        kind: 'rejected',
        text: 'I removed every item from that review. Nothing was saved to your calendar.',
        relatedEventIds: [],
        relatedReminderIds: [],
        receipt: null
      })
    }

    const correctionLine = `Review correction: ${sourceText}`.slice(0, 10_000)
    const priorBudget = Math.max(0, 50_000 - correctionLine.length - 1)
    const revisionSourceText =
      `${correctionLine}\n${proposal.sourceText.slice(0, priorBudget)}`.trim()
    const now = new Date().toISOString()
    const commands = nextEntries.map((entry, index) =>
      this.commandForProposalItem(
        entry.payload,
        `${id}:review:${index + 1}`,
        revisionSourceText,
        now
      )
    )
    const preferences = this.repository.getPreferences()
    const localDate = Temporal.Instant.from(now)
      .toZonedDateTimeISO(preferences.timezone)
      .toPlainDate()
      .toString()
    const validationContext = {
      nowUtc: now,
      localDate,
      timezone: preferences.timezone,
      utcOffsetMinutes: Math.round(
        Temporal.Instant.from(now).toZonedDateTimeISO(preferences.timezone).offsetNanoseconds /
          60_000_000_000
      ),
      defaultCalendarId: this.repository.listCalendars()[0]?.id ?? 'calendar:local',
      defaultEventDurationMinutes: 60
    }
    let validationState = {
      events: this.repository.listEvents(),
      reminders: this.repository.listReminders()
    }
    try {
      for (const command of commands) {
        const validation = dryRunCalendarCommand(command, validationState, validationContext)
        if (!validation.accepted || validation.mutationCount < 1) {
          return this.proposalCorrectionClarification(
            proposal,
            id,
            range,
            'I could not validate every revised row, so the current review is untouched.'
          )
        }
        validationState = validation.state
      }
    } catch (error) {
      return this.proposalCorrectionClarification(
        proposal,
        id,
        range,
        error instanceof Error
          ? `I could not validate the revised review: ${error.message}. The current review is untouched.`
          : 'I could not validate the revised review, so the current review is untouched.'
      )
    }
    const summaries = nextEntries.map((entry, index) =>
      this.proposalSummary(entry.payload, commands[index] ?? commands[0]!)
    )
    return this.stagePreparedChanges(
      proposal.conversationId,
      id,
      revisionSourceText,
      range,
      commands,
      nextEntries.map((entry) => entry.payload),
      summaries,
      false,
      true
    )
  }

  private reviseProposalItem(
    payload: AssistantAtomicProposalPayload,
    correction: Extract<ProposalReviewCorrection, { kind: 'edit' }>,
    id: string,
    position: number
  ): ProposalItemRevision {
    if (payload.kind !== 'event-save' && payload.kind !== 'reminder-save') {
      return {
        ok: false,
        message:
          'That reviewed row is an action on an existing item, not an editable event form. You can remove it from this review or cancel the review and make a new request.'
      }
    }

    const instruction = normalizeAssistantText(correction.instruction)
      .replace(/^(?:be\s+)?/iu, '')
      .trim()
    const noLongerRepeats =
      /(?:\b(?:stop|remove|clear)\b.*\b(?:repeat|recurrence|recurring)\b|\b(?:do not|don't|does not|doesn't|no longer|never|not)\s+repeat(?:ing)?\b)/iu.test(
        instruction
      )
    if (noLongerRepeats) {
      if (payload.kind === 'event-save') {
        return {
          ok: true,
          payload: { kind: 'event-save', form: { ...payload.form, recurrence: null } }
        }
      }
      return {
        ok: true,
        payload: { kind: 'reminder-save', form: { ...payload.form, recurrence: null } }
      }
    }

    const temporal =
      /\b(?:today|tomorrow|tmr|tmrw|tmw|morning|afternoon|evening|night|noon|midnight|all[- ]day|monday|tuesday|wednesday|thursday|friday|saturday|sunday|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|am|pm|daily|weekly|monthly|yearly|every|repeat|recur)\b|\b\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)\b|\b\d{1,4}[/-]\d{1,2}(?:[/-]\d{1,4})?\b/iu.test(
        instruction
      )
    const titleMatch = /^(?:called|named|title(?:d)?(?:\s+to)?)\s+(.+)$/iu.exec(instruction)
    const locationMatch = /^(?:(?:in|inside|location(?:\s+to)?|room(?:\s+to)?)\s+)(.+)$/iu.exec(
      instruction
    )
    const notesMatch =
      /^(?:(?:notes?|description)(?:\s+to)?|with\s+(?:the\s+)?notes?)\s+(.+)$/iu.exec(instruction)
    const editKind =
      correction.verb === 'rename' || titleMatch
        ? 'title'
        : locationMatch
          ? 'location'
          : notesMatch
            ? 'description'
            : temporal
              ? 'temporal'
              : null
    if (!editKind) {
      return {
        ok: false,
        message:
          'What should change in that reviewed item: its name, notes, location, day, time, or repeat pattern? I left the current review untouched.'
      }
    }
    if (payload.kind === 'reminder-save' && editKind === 'location') {
      return {
        ok: false,
        message:
          'Reminders do not have a location field. I left the current review untouched; you can turn it into an event or change its name, notes, or due time.'
      }
    }

    const target = 'that one'
    const value =
      editKind === 'title'
        ? (titleMatch?.[1] ?? instruction).trim()
        : editKind === 'location'
          ? (locationMatch?.[1] ?? instruction).trim()
          : editKind === 'description'
            ? (notesMatch?.[1] ?? instruction).trim()
            : instruction
    if (!value) {
      return { ok: false, message: 'What should I change it to? The current review is untouched.' }
    }
    const fieldLead =
      editKind === 'title'
        ? 'title '
        : editKind === 'location'
          ? 'location '
          : editKind === 'description'
            ? 'notes '
            : 'to '
    const parserText = `Update ${target} ${fieldLead}${value}`
    const targetStart = parserText.indexOf(target)
    const valueStart = parserText.lastIndexOf(value)
    const operation = payload.kind === 'event-save' ? 'event.update' : 'reminder.update'
    const spans: SemanticPlannerPrediction['spans'] = [
      { kind: 'TARGET', start: targetStart, end: targetStart + target.length },
      ...(editKind === 'title'
        ? [{ kind: 'TITLE' as const, start: valueStart, end: valueStart + value.length }]
        : editKind === 'location'
          ? [{ kind: 'LOCATION' as const, start: valueStart, end: valueStart + value.length }]
          : editKind === 'description'
            ? [{ kind: 'DESCRIPTION' as const, start: valueStart, end: valueStart + value.length }]
            : [])
    ]
    const prediction: SemanticPlannerPrediction = {
      operation,
      operationConfidence: 0.99,
      ambiguityProbability: 0.01,
      oodProbability: 0,
      spans,
      eligibleForAssistance: true
    }
    const now = new Date().toISOString()
    const preferences = this.repository.getPreferences()
    const localDate = Temporal.Instant.from(now)
      .toZonedDateTimeISO(preferences.timezone)
      .toPlainDate()
      .toString()
    const calendarId = this.repository.listCalendars()[0]?.id ?? 'calendar:local'
    const transientId = `review:item:${position + 1}`
    const events: EventEntity[] = []
    const reminders: ReminderEntity[] = []
    let defaultDuration = 60
    if (payload.kind === 'event-save') {
      const startUtc = localInstant(
        payload.form.startDate,
        payload.form.startTime ?? '00:00',
        payload.form.timezone
      )
      const endUtc = payload.form.allDay
        ? localInstant(
            Temporal.PlainDate.from(payload.form.endDate).add({ days: 1 }).toString(),
            '00:00',
            payload.form.timezone
          )
        : localInstant(
            payload.form.endDate,
            payload.form.endTime ?? payload.form.startTime ?? '00:00',
            payload.form.timezone
          )
      defaultDuration = Math.max(
        1,
        Math.round((Date.parse(endUtc) - Date.parse(startUtc)) / 60_000)
      )
      events.push({
        id: transientId,
        calendarId: payload.form.calendarId ?? calendarId,
        title: payload.form.title,
        description: payload.form.description,
        location: payload.form.location,
        startUtc,
        endUtc,
        timezone: payload.form.timezone,
        allDay: payload.form.allDay,
        recurrence: null,
        status: 'active',
        provenance: 'assistant',
        createdAt: now,
        updatedAt: now
      })
    } else {
      reminders.push({
        id: transientId,
        calendarId: payload.form.calendarId ?? calendarId,
        title: payload.form.title,
        notes: payload.form.notes,
        dueAtUtc: localInstant(payload.form.dueDate, payload.form.dueTime, payload.form.timezone),
        timezone: payload.form.timezone,
        recurrence: null,
        status: 'active',
        completedAt: null,
        provenance: 'assistant',
        createdAt: now,
        updatedAt: now
      })
    }

    const parsed = planCalendarTextHybrid(
      {
        requestId: `${id}:review-edit:${position + 1}`,
        text: parserText,
        previousUserText: null,
        nowUtc: now,
        localDate,
        timezone: preferences.timezone,
        locale: preferences.locale,
        events,
        reminders,
        focusedEventIds: events.map((event) => event.id),
        focusedReminderIds: reminders.map((reminder) => reminder.id)
      },
      prediction
    )
    const disposition = getActionDisposition(parsed.draft)
    if (disposition !== 'preview' && disposition !== 'confirm') {
      return {
        ok: false,
        message:
          parsed.draft.ambiguities[0]?.message ??
          'I could not validate that correction, so the current review is untouched.'
      }
    }

    let resolved: CalendarIRResolved
    try {
      resolved = resolveCalendarIR(parsed.draft, {
        nowUtc: now,
        localDate,
        timezone: preferences.timezone,
        utcOffsetMinutes: Math.round(
          Temporal.Instant.from(now).toZonedDateTimeISO(preferences.timezone).offsetNanoseconds /
            60_000_000_000
        ),
        defaultCalendarId: calendarId,
        defaultEventDurationMinutes: defaultDuration
      })
    } catch (error) {
      return {
        ok: false,
        message:
          error instanceof Error
            ? `I could not validate that correction: ${error.message}. The current review is untouched.`
            : 'I could not validate that correction, so the current review is untouched.'
      }
    }

    if (payload.kind === 'event-save') {
      const form = { ...payload.form }
      if (resolved.fields.title !== null) form.title = resolved.fields.title
      if (resolved.fields.description !== null) form.description = resolved.fields.description
      if (resolved.fields.location !== null) form.location = resolved.fields.location
      if (resolved.fields.startUtc && resolved.fields.endUtc) {
        const timezone = resolved.fields.timezone ?? form.timezone
        const allDay = resolved.fields.allDay ?? form.allDay
        const start = localParts(resolved.fields.startUtc, timezone)
        const endInstant = allDay
          ? Temporal.Instant.from(resolved.fields.endUtc).subtract({ nanoseconds: 1 }).toString()
          : resolved.fields.endUtc
        const end = localParts(endInstant, timezone)
        form.startDate = start.date
        form.startTime = allDay ? null : start.time
        form.endDate = end.date
        form.endTime = allDay ? null : end.time
        form.timezone = timezone
        form.allDay = allDay
      }
      if (resolved.recurrence !== null) form.recurrence = resolved.recurrence
      try {
        return { ok: true, payload: { kind: 'event-save', form: eventFormSchema.parse(form) } }
      } catch {
        return {
          ok: false,
          message:
            'That correction would make the event timing invalid, so the current review is untouched.'
        }
      }
    }

    const form = { ...payload.form }
    if (resolved.fields.title !== null) form.title = resolved.fields.title
    if (resolved.fields.description !== null) form.notes = resolved.fields.description
    if (resolved.fields.dueAtUtc) {
      const timezone = resolved.fields.timezone ?? form.timezone
      const due = localParts(resolved.fields.dueAtUtc, timezone)
      form.dueDate = due.date
      form.dueTime = due.time
      form.timezone = timezone
    }
    if (resolved.recurrence !== null) form.recurrence = resolved.recurrence
    try {
      return {
        ok: true,
        payload: { kind: 'reminder-save', form: reminderFormSchema.parse(form) }
      }
    } catch {
      return {
        ok: false,
        message:
          'That correction would make the reminder invalid, so the current review is untouched.'
      }
    }
  }

  private commandForProposalItem(
    payload: AssistantAtomicProposalPayload,
    requestId: string,
    sourceText: string,
    now: string
  ): CalendarIRResolved {
    const evidenceText = sourceText.slice(0, 2_000)
    const evidence = [
      {
        id: `evidence:${requestId.replace(/[^a-zA-Z0-9._:-]/gu, '-')}`,
        sourceKind: 'text' as const,
        sourceId: null,
        page: null,
        boundingBox: null,
        text: evidenceText,
        sourceSpan: evidenceText ? { start: 0, end: evidenceText.length } : null
      }
    ]
    const emptyFields = {
      title: null,
      description: null,
      location: null,
      startUtc: null,
      endUtc: null,
      dueAtUtc: null,
      rangeStartUtc: null,
      rangeEndUtc: null,
      timezone: null,
      allDay: null,
      reminderOffsetMinutes: null,
      status: null
    }
    if (payload.kind === 'event-save') {
      const form = payload.form
      const startUtc = localInstant(form.startDate, form.startTime ?? '00:00', form.timezone)
      const endUtc = form.allDay
        ? localInstant(
            Temporal.PlainDate.from(form.endDate).add({ days: 1 }).toString(),
            '00:00',
            form.timezone
          )
        : localInstant(form.endDate, form.endTime ?? form.startTime ?? '00:00', form.timezone)
      return calendarIRResolvedSchema.parse({
        version: '0.1',
        requestId,
        operation: form.id ? 'event.update' : 'event.create',
        selection: form.id ? { eventIds: [form.id], reminderIds: [], query: null } : null,
        fields: {
          ...emptyFields,
          title: form.title,
          description: form.description,
          location: form.location,
          startUtc,
          endUtc,
          timezone: form.timezone,
          allDay: form.allDay
        },
        recurrence: form.recurrence,
        scope: form.recurrence ? 'series' : 'single',
        risk: form.id ? 'medium' : 'low',
        confidence: 0.99,
        requiresConfirmation: true,
        evidence,
        resolvedAt: now
      })
    }
    if (payload.kind === 'reminder-save') {
      const form = payload.form
      return calendarIRResolvedSchema.parse({
        version: '0.1',
        requestId,
        operation: form.id ? 'reminder.update' : 'reminder.create',
        selection: form.id ? { eventIds: [], reminderIds: [form.id], query: null } : null,
        fields: {
          ...emptyFields,
          title: form.title,
          description: form.notes,
          dueAtUtc: localInstant(form.dueDate, form.dueTime, form.timezone),
          timezone: form.timezone,
          allDay: false
        },
        recurrence: form.recurrence,
        scope: form.recurrence ? 'series' : 'single',
        risk: form.id ? 'medium' : 'low',
        confidence: 0.99,
        requiresConfirmation: true,
        evidence,
        resolvedAt: now
      })
    }
    const eventId = payload.kind === 'event-delete' ? payload.id : null
    const reminderId = eventId === null ? payload.id : null
    const operation =
      payload.kind === 'event-delete'
        ? 'event.delete'
        : payload.kind === 'reminder-complete'
          ? 'reminder.complete'
          : 'reminder.delete'
    return calendarIRResolvedSchema.parse({
      version: '0.1',
      requestId,
      operation,
      selection: {
        eventIds: eventId ? [eventId] : [],
        reminderIds: reminderId ? [reminderId] : [],
        query: null
      },
      fields: {
        ...emptyFields,
        status: payload.kind === 'reminder-complete' ? 'completed' : null
      },
      recurrence: null,
      scope: 'single',
      risk: operation.endsWith('.delete') ? 'destructive' : 'low',
      confidence: 0.99,
      requiresConfirmation: true,
      evidence,
      resolvedAt: now
    })
  }

  private async stageBatchRequest(
    conversationId: string,
    id: string,
    sourceText: string,
    requestParts: readonly string[],
    range: CalendarSnapshotRequest,
    now: string,
    localDate: string,
    semanticPredictions: readonly SemanticPlannerPrediction[] | null = null,
    trace: MutableAssistantExecutionTrace | null = null,
    cancellationId?: string,
    onStatus?: (status: FlexModelJobStatus) => void
  ): Promise<AssistantExchange> {
    const preferences = this.repository.getPreferences()
    const zonedNow = Temporal.Instant.from(now).toZonedDateTimeISO(preferences.timezone)
    const dialogueState = this.repository.getAssistantDialogueState(conversationId)
    const flexiblePlanContext: FlexModelPlanContext = {
      currentLocalDateTime: zonedNow.toPlainDateTime().toString({ smallestUnit: 'minute' }),
      timezone: preferences.timezone,
      locale: preferences.locale,
      dialogueContext: this.dialogueContextForPlanner(conversationId, trace ?? undefined)
    }
    const events = this.repository.listEvents()
    const reminders = this.repository.listReminders()
    const calendars = this.repository.listCalendars()
    const resolvedCommands: CalendarIRResolved[] = []
    const plannedDrafts: CalendarIRDraft[] = []
    const items: AssistantAtomicProposalPayload[] = []
    const itemSummaries: string[] = []
    let usedFlexibleFallback = Boolean(semanticPredictions?.length)

    const parsePart = (text: string, index: number, prediction: SemanticPlannerPrediction | null) =>
      planCalendarTextHybrid(
        {
          requestId: `${id}:${index + 1}`,
          text,
          previousUserText: null,
          nowUtc: now,
          localDate,
          timezone: preferences.timezone,
          locale: preferences.locale,
          events,
          reminders,
          focusedEventIds: dialogueState.focusedEventIds,
          focusedReminderIds: dialogueState.focusedReminderIds
        },
        prediction
      )

    const nativeBatch = requestParts.map((part, index) => {
      let prediction: SemanticPlannerPrediction | null = semanticPredictions?.[index] ?? null
      if (!prediction) {
        try {
          prediction = this.planner?.predict(part) ?? null
        } catch {
          prediction = null
        }
      }
      return { part, parsed: parsePart(part, index, prediction) }
    })
    const batchNeedsFallback = nativeBatch.some(({ part, parsed }) =>
      needsFlexiblePlanRepair(part, parsed)
    )
    let groundedBatchFallback: GroundedFlexibleAction[] | null = null
    let fallbackFailureDetail: string | null = null

    if (batchNeedsFallback && this.calendarFallbackPlanner && !semanticPredictions?.length) {
      if (trace) trace.fallbackWorkload = 'plan'
      const fallbackSource = requestParts.join('; ')
      let fallbackResult: FlexModelCalendarFallbackResult
      try {
        fallbackResult = await this.calendarFallbackPlanner.planCalendar(
          fallbackSource,
          flexiblePlanContext,
          {
            ...(cancellationId ? { cancellationId } : {}),
            ...(onStatus ? { onStatus } : {})
          }
        )
      } catch (error) {
        fallbackResult = flexModelCalendarFallbackResultSchema.parse({
          kind: typedFallbackFailureFromError(error)
        })
      }
      if (trace) await this.recordFallbackTruncation(trace, this.calendarFallbackPlanner)
      if (fallbackResult.kind === 'cancelled') {
        if (trace) trace.fallbackReason = 'cancelled'
        return this.respond(conversationId, id, range, {
          kind: 'answer',
          text: 'Stopped that local request. Nothing was changed.',
          relatedEventIds: [],
          relatedReminderIds: [],
          receipt: null
        })
      }
      if (fallbackResult.kind !== 'plan') {
        if (trace) trace.fallbackReason = fallbackResult.kind
        fallbackFailureDetail = `The local fallback did not return a translation for all ${requestParts.length} requested items.`
      } else {
        const flexiblePlan = fallbackResult.plan
        if (flexiblePlan.actions.length !== requestParts.length) {
          if (trace) trace.fallbackReason = 'grounding-rejected'
          fallbackFailureDetail = `The local fallback returned ${flexiblePlan.actions.length} of ${requestParts.length} requested items.`
        } else {
          const grounded = groundFlexiblePlan(fallbackSource, flexiblePlan, flexiblePlanContext)
          if (grounded?.length === requestParts.length) {
            if (trace) trace.fallbackReason = 'plan-accepted'
            groundedBatchFallback = grounded
            usedFlexibleFallback = true
          } else {
            if (trace) trace.fallbackReason = 'grounding-rejected'
            fallbackFailureDetail = `The local fallback could not ground all ${requestParts.length} requested items in your message.`
          }
        }
      }
    } else if (
      batchNeedsFallback &&
      !this.calendarFallbackPlanner &&
      !semanticPredictions?.length
    ) {
      if (trace) {
        trace.fallbackWorkload = 'plan'
        trace.fallbackReason = 'not-configured'
      }
      fallbackFailureDetail = `The optional local calendar planner is not installed, so I could not translate all ${requestParts.length} requested items.`
    }

    for (let index = 0; index < requestParts.length; index += 1) {
      const part = requestParts[index]
      if (!part) continue
      const native = nativeBatch[index]
      if (!native) continue
      let parsed = native.parsed
      let disposition = getActionDisposition(parsed.draft)
      const fallbackAction = groundedBatchFallback?.[index]
      if (fallbackAction && needsFlexiblePlanRepair(part, parsed)) {
        parsed = parsePart(fallbackAction.parserText, index, fallbackAction.prediction)
        disposition = getActionDisposition(parsed.draft)
      }
      const unresolvedPreciseTime = needsFlexibleTemporalRepair(part, parsed.draft)
      if (
        disposition === 'clarify' ||
        disposition === 'reject' ||
        disposition === 'answer' ||
        unresolvedPreciseTime
      ) {
        const ambiguity = parsed.draft.ambiguities[0]
        const itemDetail =
          ambiguity?.message ??
          fallbackFailureDetail ??
          (unresolvedPreciseTime
            ? `I could not safely translate the precise time in item ${index + 1}: “${part}”.`
            : disposition === 'answer'
              ? 'Questions and calendar changes need separate messages.'
              : `I could not safely understand item ${index + 1}: “${part}”.`)
        if (ambiguity) {
          this.rememberClarification(conversationId, id, requestParts.join('; '), ambiguity)
        }
        const detail = `I found ${requestParts.length} requested items. Item ${index + 1} needs one detail: ${itemDetail} I kept the full group together and staged nothing.`
        return this.respond(conversationId, id, range, {
          kind: 'clarification',
          text: this.groundedReply(
            conversationId,
            id,
            'clarification',
            [{ key: 'DETAIL', kind: 'text', value: detail }],
            [
              'I kept the batch unchanged because <DETAIL>',
              'Before I stage the group, <DETAIL>',
              'One part needs attention: <DETAIL>'
            ]
          ),
          relatedEventIds: [],
          relatedReminderIds: [],
          receipt: null
        })
      }
      const selectedEvent = parsed.draft.selection?.eventIds[0]
        ? this.repository.getEvent(parsed.draft.selection.eventIds[0])
        : null
      const defaultDuration = selectedEvent
        ? Math.max(
            1,
            Math.round(
              (Date.parse(selectedEvent.endUtc) - Date.parse(selectedEvent.startUtc)) / 60_000
            )
          )
        : 60
      let resolved: CalendarIRResolved
      try {
        resolved = resolveCalendarIR(parsed.draft, {
          nowUtc: now,
          localDate,
          timezone: preferences.timezone,
          utcOffsetMinutes: Math.round(
            Temporal.Instant.from(now).toZonedDateTimeISO(preferences.timezone).offsetNanoseconds /
              60_000_000_000
          ),
          defaultCalendarId: calendars[0]?.id ?? 'calendar:local',
          defaultEventDurationMinutes: defaultDuration
        })
      } catch (error) {
        const detail =
          error instanceof Error
            ? `Item ${index + 1} needs a clearer date or time: ${error.message}`
            : `Item ${index + 1} needs a clearer date or time.`
        return this.respond(conversationId, id, range, {
          kind: 'clarification',
          text: detail,
          relatedEventIds: [],
          relatedReminderIds: [],
          receipt: null
        })
      }
      const dryRun = dryRunCalendarCommand(
        resolved,
        { events, reminders },
        {
          nowUtc: now,
          localDate,
          timezone: preferences.timezone,
          utcOffsetMinutes: Math.round(
            Temporal.Instant.from(now).toZonedDateTimeISO(preferences.timezone).offsetNanoseconds /
              60_000_000_000
          ),
          defaultCalendarId: calendars[0]?.id ?? 'calendar:local',
          defaultEventDurationMinutes: defaultDuration
        }
      )
      if (!dryRun.accepted || dryRun.mutationCount < 1) {
        return this.respond(conversationId, id, range, {
          kind: 'rejected',
          text: `I could not validate item ${index + 1}, so I did not stage any part of the batch.`,
          relatedEventIds: [],
          relatedReminderIds: [],
          receipt: null
        })
      }
      const payload = this.payloadFor(resolved)
      plannedDrafts.push(parsed.draft)
      resolvedCommands.push(resolved)
      items.push(payload)
      itemSummaries.push(this.proposalSummary(payload, resolved))
    }

    if (items.length < 2) {
      throw new Error('A multi-action request did not contain enough valid changes')
    }
    const batchPlan = assistantPlanFromCalendarDrafts(plannedDrafts, sourceText, {
      requestId: id,
      plannerSource: usedFlexibleFallback ? 'qwen-fallback' : 'hybrid'
    })
    if (batchPlan.actions.length !== items.length) {
      throw new Error('The multi-action assistant plan did not preserve every reviewed change')
    }
    return this.stagePreparedChanges(
      conversationId,
      id,
      sourceText,
      range,
      resolvedCommands,
      items,
      itemSummaries,
      usedFlexibleFallback
    )
  }

  private stagePreparedChanges(
    conversationId: string,
    id: string,
    sourceText: string,
    range: CalendarSnapshotRequest,
    resolvedCommands: readonly CalendarIRResolved[],
    items: readonly AssistantAtomicProposalPayload[],
    itemSummaries: readonly string[],
    usedFlexibleFallback = false,
    reviewRevision = false
  ): AssistantExchange {
    const first = resolvedCommands[0]
    const firstSummary = itemSummaries[0]
    if (!first || !firstSummary || items.length === 0 || items.length !== resolvedCommands.length) {
      throw new Error('A prepared assistant change group is incomplete')
    }
    if (items.length !== itemSummaries.length) {
      throw new Error('A prepared assistant change is missing its review summary')
    }
    const riskOrder = { read: 0, low: 1, medium: 2, high: 3, destructive: 4 } as const
    const risk = resolvedCommands.reduce(
      (highest, command) => (riskOrder[command.risk] > riskOrder[highest] ? command.risk : highest),
      'low' as CalendarIRResolved['risk']
    )
    const multiple = items.length > 1
    const summary = (
      multiple ? `Apply ${items.length} changes together: ${itemSummaries.join(' ')}` : firstSummary
    ).slice(0, 2_000)
    const createdAt = new Date().toISOString()
    const proposal = assistantProposalSchema.parse({
      id: proposalId(),
      conversationId,
      requestId: id,
      operation: first.operation,
      risk,
      status: 'pending',
      payload: multiple
        ? { kind: 'batch', items: [...items], itemSummaries: [...itemSummaries] }
        : items[0],
      resolvedCommand: first,
      summary,
      requiresConfirmation: resolvedCommands.some((command) => command.requiresConfirmation),
      sourceText,
      createdAt,
      updatedAt: createdAt
    })
    this.repository.saveAssistantProposal(proposal)
    const reply = reviewRevision
      ? this.groundedReply(
          conversationId,
          id,
          'proposal',
          [{ key: 'SUMMARY', kind: 'text', value: summary }],
          multiple
            ? [
                'I updated the review without saving anything yet: <SUMMARY>',
                'Here’s the revised group to approve: <SUMMARY>',
                'I replaced the earlier preview with this one: <SUMMARY>'
              ]
            : [
                'I narrowed the review to this change without saving it yet: <SUMMARY>',
                'Here’s the revised item to approve: <SUMMARY>',
                'I replaced the earlier preview with this change: <SUMMARY>'
              ]
        )
      : multiple
        ? this.groundedReply(
            conversationId,
            id,
            'proposal',
            [{ key: 'SUMMARY', kind: 'text', value: summary }],
            usedFlexibleFallback
              ? [
                  'I grouped those changes into one local review: <SUMMARY>',
                  'Here’s how I translated the requested actions: <SUMMARY>',
                  'I understood the changes and prepared one undoable review: <SUMMARY>'
                ]
              : [
                  'I grouped the changes into one local review: <SUMMARY>',
                  'Here are the changes to approve together: <SUMMARY>',
                  'I prepared one undoable batch: <SUMMARY>'
                ]
          )
        : this.groundedReply(
            conversationId,
            id,
            'proposal',
            [{ key: 'SUMMARY', kind: 'text', value: summary }],
            [
              'Here’s the schedule copy for review: <SUMMARY>',
              'I prepared this repeated plan locally: <SUMMARY>'
            ]
          )
    return this.respond(conversationId, id, range, {
      kind: 'preview',
      text: reply,
      relatedEventIds: resolvedCommands.flatMap((command) => command.selection?.eventIds ?? []),
      relatedReminderIds: resolvedCommands.flatMap(
        (command) => command.selection?.reminderIds ?? []
      ),
      receipt: null
    })
  }

  confirm(input: AssistantConfirmRequest): AssistantExchange {
    const request = assistantConfirmRequestSchema.parse(input)
    const proposal = this.repository.getAssistantProposal(request.proposalId)
    if (!proposal) throw new Error('That proposal no longer exists')
    if (proposal.status !== 'pending') throw new Error('That proposal has already been handled')
    const id = requestId()
    this.appendTurn(proposal.conversationId, 'user', 'action', `Approved: ${proposal.summary}`, id)
    return this.applyProposal(proposal, request.range, id)
  }

  reject(input: AssistantRejectRequest): AssistantExchange {
    const request = assistantRejectRequestSchema.parse(input)
    const proposal = this.repository.getAssistantProposal(request.proposalId)
    if (!proposal) throw new Error('That proposal no longer exists')
    if (proposal.status !== 'pending') throw new Error('That proposal has already been handled')
    const id = requestId()
    this.appendTurn(proposal.conversationId, 'user', 'action', `Cancelled: ${proposal.summary}`, id)
    return this.rejectExistingProposal(proposal, request.range, id, request.mode)
  }

  private appendTurn(
    conversationId: string,
    role: ConversationTurnEntity['role'],
    inputKind: ConversationTurnEntity['inputKind'],
    text: string,
    linkedRequestId: string | null
  ): ConversationTurnEntity {
    return this.repository.appendConversationTurn(
      conversationTurnEntitySchema.parse({
        id: turnId(),
        conversationId,
        role,
        inputKind,
        text,
        requestId: linkedRequestId,
        createdAt: new Date().toISOString()
      })
    )
  }

  private rememberClarification(
    conversationId: string,
    id: string,
    sourceText: string,
    ambiguity: CalendarIRDraft['ambiguities'][number]
  ): void {
    const current = this.repository.getAssistantDialogueState(conversationId)
    const now = new Date().toISOString()
    this.repository.saveAssistantDialogueState(conversationId, {
      ...current,
      pendingClarification: {
        requestId: id,
        sourceText: sourceText.slice(0, 50_000),
        code: ambiguity.code,
        message: ambiguity.message,
        options: ambiguity.options,
        createdAt: now
      },
      updatedAt: now
    })
  }

  private answerContextualRequest(
    conversationId: string,
    id: string,
    resolution: Extract<ContextualResolution, { kind: 'resolved' }>,
    range: CalendarSnapshotRequest
  ): AssistantExchange {
    const state = this.repository.getAssistantDialogueState(conversationId)
    const frame = state.queryFrames.find((item) => item.frameId === resolution.frameId)
    if (!frame) {
      return this.respond(conversationId, id, range, {
        kind: 'clarification',
        text: 'Which earlier calendar result do you mean?',
        relatedEventIds: [],
        relatedReminderIds: [],
        receipt: null
      })
    }
    const preferences = this.repository.getPreferences()
    const snapshot = this.calendar.getSnapshot({
      rangeStartUtc: frame.range.rangeStartUtc,
      rangeEndUtc: frame.range.rangeEndUtc
    })
    type MaterializedContextualItem =
      | {
          kind: 'event'
          frameItem: AssistantQueryFrameItem
          occurrence: EventOccurrence
          entity: EventEntity
        }
      | { kind: 'reminder'; frameItem: AssistantQueryFrameItem; reminder: ReminderEntity }
    const selected = resolution.selectedItems.flatMap<MaterializedContextualItem>((item) => {
      if (item.kind === 'event') {
        const matchedOccurrence = snapshot.occurrences.find(
          (candidate) =>
            candidate.eventId === item.id &&
            (item.occurrenceStart === null || candidate.startUtc === item.occurrenceStart)
        )
        const entity = this.repository.getEvent(item.id)
        if (!entity || entity.status !== 'active') return []
        const startUtc = item.occurrenceStart ?? entity.startUtc
        const occurrence: EventOccurrence =
          matchedOccurrence ??
          ({
            occurrenceId: `context:${entity.id}`,
            eventId: entity.id,
            calendarId: entity.calendarId,
            title: entity.title,
            description: entity.description,
            location: entity.location,
            startUtc,
            endUtc: new Date(
              Date.parse(startUtc) + Date.parse(entity.endUtc) - Date.parse(entity.startUtc)
            ).toISOString(),
            timezone: entity.timezone,
            allDay: entity.allDay,
            originalDate: Temporal.Instant.from(startUtc)
              .toZonedDateTimeISO(entity.timezone)
              .toPlainDate()
              .toString(),
            recurring: entity.recurrence !== null
          } satisfies EventOccurrence)
        return [{ kind: 'event' as const, frameItem: item, occurrence, entity }]
      }
      const reminder = this.repository.getReminder(item.id)
      return reminder?.status === 'active'
        ? [{ kind: 'reminder' as const, frameItem: item, reminder }]
        : []
    })
    if (selected.length === 0) {
      return this.respond(conversationId, id, range, {
        kind: 'clarification',
        text: 'Those calendar results are no longer available. Ask for the day again and I’ll refresh them.',
        relatedEventIds: [],
        relatedReminderIds: [],
        receipt: null
      })
    }

    const requestedFields = [...new Set(resolution.fields)]
    const attributeFields = requestedFields.filter(
      (field): field is GroundedAttributeField => field !== 'name' && field !== 'details'
    )
    const groundedItems = selected.map((item) =>
      item.kind === 'event'
        ? groundedEventAnswerItem(item.occurrence, preferences.locale, item.entity.recurrence)
        : groundedReminderAnswerItem(item.reminder, preferences.locale)
    )
    const availableKeys = new Set(selected.map((item) => dialogueFrameItemKey(item.frameItem)))
    const rawStart = resolution.intent === 'continue' ? (frame.continuationCursor ?? 0) : 0
    const startIndex = resolution.selectedItems
      .slice(0, rawStart)
      .filter((item) => availableKeys.has(dialogueFrameItemKey(item))).length
    const mode =
      requestedFields.includes('details') || resolution.intent === 'explain'
        ? ('details' as const)
        : attributeFields.length > 0
          ? ('attributes' as const)
          : resolution.intent === 'summarize' || resolution.intent === 'compare'
            ? ('summary' as const)
            : ('names' as const)
    const answerPage = renderGroundedAnswer({
      items: groundedItems,
      locale: preferences.locale,
      mode,
      fields: attributeFields,
      startIndex,
      staleCount: resolution.selectedItems.length - selected.length,
      emptyText: 'I could not find a matching calendar item.'
    })
    const text = answerPage.text

    const relatedEventIds = [
      ...new Set(selected.filter((item) => item.kind === 'event').map((item) => item.entity.id))
    ]
    const relatedReminderIds = [
      ...new Set(
        selected.filter((item) => item.kind === 'reminder').map((item) => item.reminder.id)
      )
    ]
    const retainedSelectedItems = selected.map((item) => item.frameItem)
    const now = new Date().toISOString()
    this.repository.saveAssistantDialogueState(conversationId, {
      ...state,
      focusedEventIds: relatedEventIds,
      focusedReminderIds: relatedReminderIds,
      lastResultEventIds: relatedEventIds,
      lastResultReminderIds: relatedReminderIds,
      queryFrames: state.queryFrames.map((item) =>
        item.frameId === frame.frameId
          ? {
              ...item,
              selectedItems: retainedSelectedItems,
              requestedFields,
              resultCursor: resolution.resultCursor,
              continuationCursor: answerPage.nextCursor
            }
          : item
      ),
      activeQueryFrameId: frame.frameId,
      activeRange: frame.range,
      pendingClarification: null,
      updatedAt: now
    })
    return this.respond(conversationId, id, range, {
      kind: 'answer',
      text,
      relatedEventIds,
      relatedReminderIds,
      receipt: null
    })
  }

  private recordQueryState(
    conversationId: string,
    command: CalendarIRResolved,
    queryStart: string,
    queryEnd: string,
    eventIds: readonly string[],
    reminderIds: readonly string[],
    orderedItems: readonly AssistantQueryFrameItem[],
    selectedItems: readonly AssistantQueryFrameItem[],
    requestedFields: readonly AssistantRequestedField[],
    resultCursor: number | null,
    continuationCursor: number | null
  ): void {
    if (
      command.operation !== 'calendar.list' &&
      command.operation !== 'calendar.search' &&
      command.operation !== 'calendar.availability' &&
      command.operation !== 'calendar.conflicts'
    ) {
      return
    }
    const current = this.repository.getAssistantDialogueState(conversationId)
    const now = new Date().toISOString()
    const preferences = this.repository.getPreferences()
    const uniqueEventIds = [...new Set(eventIds)].slice(0, 100)
    const uniqueReminderIds = [...new Set(reminderIds)].slice(0, 100)
    const retainedKeys = new Set<string>()
    const retainedItems = orderedItems
      .filter((item) => {
        const key = dialogueFrameItemKey(item)
        if (retainedKeys.has(key)) return false
        retainedKeys.add(key)
        return true
      })
      .slice(0, 200)
    const retainedSelectedKeys = new Set<string>()
    const retainedSelectedItems = selectedItems
      .filter((item) => {
        const key = dialogueFrameItemKey(item)
        if (!retainedKeys.has(key) || retainedSelectedKeys.has(key)) return false
        retainedSelectedKeys.add(key)
        return true
      })
      .slice(0, 200)
    const frameId = `frame:${command.requestId}`
    const frame = {
      frameId,
      operation: command.operation,
      range: {
        rangeStartUtc: queryStart,
        rangeEndUtc: queryEnd,
        timezone: command.fields.timezone ?? preferences.timezone
      },
      orderedItems: retainedItems,
      selectedItems: retainedSelectedItems,
      requestedFields: [...new Set(requestedFields)].slice(0, 10),
      resultCursor:
        resultCursor !== null && resultCursor >= 0 && resultCursor < retainedItems.length
          ? resultCursor
          : null,
      continuationCursor:
        continuationCursor !== null &&
        continuationCursor > 0 &&
        continuationCursor < retainedSelectedItems.length
          ? continuationCursor
          : null,
      createdAt: now
    }
    const queryFrames = [
      ...current.queryFrames.filter((item) => item.frameId !== frameId),
      frame
    ].slice(-12)
    this.repository.saveAssistantDialogueState(conversationId, {
      ...current,
      focusedEventIds: uniqueEventIds,
      focusedReminderIds: uniqueReminderIds,
      lastResultEventIds: uniqueEventIds,
      lastResultReminderIds: uniqueReminderIds,
      lastQuery: {
        requestId: command.requestId,
        operation: command.operation,
        sourceText: commandQuestion(command),
        rangeStartUtc: queryStart,
        rangeEndUtc: queryEnd,
        queryText: command.selection?.query?.value ?? null,
        answeredAt: now
      },
      activeRange: {
        rangeStartUtc: queryStart,
        rangeEndUtc: queryEnd,
        timezone: command.fields.timezone ?? preferences.timezone
      },
      queryFrames,
      activeQueryFrameId: frameId,
      pendingClarification: null,
      updatedAt: now
    })
  }

  private respond(
    conversationId: string,
    id: string,
    range: CalendarSnapshotRequest,
    response: AssistantResponse
  ): AssistantExchange {
    const current = this.repository.getAssistantDialogueState(conversationId)
    const relatedEventIds = [
      ...new Set(response.relatedEventIds.filter((eventId) => this.repository.getEvent(eventId)))
    ].slice(0, 100)
    const relatedReminderIds = [
      ...new Set(
        response.relatedReminderIds.filter((reminderId) => this.repository.getReminder(reminderId))
      )
    ].slice(0, 100)
    const hasRelatedItems = relatedEventIds.length + relatedReminderIds.length > 0
    const now = new Date().toISOString()
    this.repository.saveAssistantDialogueState(conversationId, {
      ...current,
      ...(hasRelatedItems
        ? {
            focusedEventIds: relatedEventIds,
            focusedReminderIds: relatedReminderIds,
            lastResultEventIds: relatedEventIds,
            lastResultReminderIds: relatedReminderIds
          }
        : {}),
      pendingClarification: response.kind === 'clarification' ? current.pendingClarification : null,
      updatedAt: now
    })
    this.appendTurn(conversationId, 'assistant', 'text', response.text, id)
    return assistantExchangeSchema.parse({
      conversation: this.repository.getAssistantConversation(conversationId),
      response: {
        ...response,
        feedbackEligible: this.responseTraces.has(`${conversationId}:${id}`)
      },
      snapshot: this.calendar.getSnapshot(range)
    })
  }

  private groundedReply(
    conversationId: string,
    id: string,
    speechAct: ResponsePlan['speechAct'],
    facts: Parameters<typeof createGroundedReply>[0]['facts'],
    templates: readonly string[]
  ): string {
    const conversation = this.repository.getAssistantConversation(conversationId)
    const recentReplies = conversation.turns
      .filter((turn) => turn.role === 'assistant')
      .slice(-20)
      .map((turn) => turn.text)
    const preferences = this.repository.getPreferences()
    const adaptation = preferences.responseAdaptation
    const reply = createGroundedReply({
      requestId: id,
      speechAct,
      facts,
      templates,
      recentReplies,
      style: preferences.responseStyle,
      templateGenerator: this.speaker,
      templatePreferences: adaptation.enabled
        ? adaptation.entries
            .filter((entry) => entry.speechAct === speechAct)
            .map((entry) => ({
              templateFingerprint: entry.templateFingerprint,
              score: entry.score
            }))
        : []
    })
    const traceKey = `${conversationId}:${id}`
    if (reply.source === 'remindspeak') {
      this.responseTraces.set(traceKey, {
        conversationId,
        speechAct,
        templateFingerprint: reply.templateFingerprint,
        rating: null
      })
    }
    while (this.responseTraces.size > 200) {
      const oldest = this.responseTraces.keys().next().value
      if (oldest === undefined) break
      this.responseTraces.delete(oldest)
    }
    return reply.text
  }

  private payloadFor(command: CalendarIRResolved): AssistantAtomicProposalPayload {
    const timezone = command.fields.timezone ?? this.repository.getPreferences().timezone
    switch (command.operation) {
      case 'event.create': {
        if (!command.fields.startUtc || !command.fields.endUtc || !command.fields.title) {
          throw new Error('The proposed event is missing a title, start, or end time.')
        }
        const start = localParts(command.fields.startUtc, timezone)
        const endInstant = command.fields.allDay
          ? Temporal.Instant.from(command.fields.endUtc).subtract({ nanoseconds: 1 }).toString()
          : command.fields.endUtc
        const end = localParts(endInstant, timezone)
        return {
          kind: 'event-save',
          form: eventFormSchema.parse({
            id: null,
            calendarId: this.repository.listCalendars()[0]?.id ?? null,
            title: command.fields.title,
            description: command.fields.description ?? '',
            location: command.fields.location ?? '',
            startDate: start.date,
            startTime: command.fields.allDay ? null : start.time,
            endDate: end.date,
            endTime: command.fields.allDay ? null : end.time,
            timezone,
            allDay: command.fields.allDay ?? false,
            recurrence: command.recurrence
          })
        }
      }
      case 'event.duplicate': {
        const id = command.selection?.eventIds[0]
        const source = id ? this.repository.getEvent(id) : null
        if (!source) throw new Error('I could not find the event to duplicate.')
        const form = eventToForm(source)
        form.id = null
        form.recurrence = command.recurrence
        if (command.fields.startUtc && command.fields.endUtc) {
          const start = localParts(command.fields.startUtc, timezone)
          const endInstant = command.fields.allDay
            ? Temporal.Instant.from(command.fields.endUtc).subtract({ nanoseconds: 1 }).toString()
            : command.fields.endUtc
          const end = localParts(endInstant, timezone)
          form.startDate = start.date
          form.startTime = command.fields.allDay ? null : start.time
          form.endDate = end.date
          form.endTime = command.fields.allDay ? null : end.time
          form.timezone = timezone
          form.allDay = command.fields.allDay ?? source.allDay
        }
        return { kind: 'event-save', form: eventFormSchema.parse(form) }
      }
      case 'event.update':
      case 'event.move': {
        const id = command.selection?.eventIds[0]
        const event = id ? this.repository.getEvent(id) : null
        if (!event) throw new Error('I could not find the event to update.')
        const form = eventToForm(event)
        if (command.fields.startUtc && command.fields.endUtc) {
          const start = localParts(command.fields.startUtc, timezone)
          const end = localParts(command.fields.endUtc, timezone)
          form.startDate = start.date
          form.startTime = start.time
          form.endDate = end.date
          form.endTime = end.time
          form.timezone = timezone
          form.allDay = command.fields.allDay ?? false
        }
        if (command.fields.title) form.title = command.fields.title
        if (command.fields.description !== null) form.description = command.fields.description
        if (command.fields.location !== null) form.location = command.fields.location
        if (command.recurrence) form.recurrence = command.recurrence
        return { kind: 'event-save', form: eventFormSchema.parse(form) }
      }
      case 'event.delete': {
        const id = command.selection?.eventIds[0]
        if (!id || !this.repository.getEvent(id))
          throw new Error('I could not find the event to delete.')
        return { kind: 'event-delete', id }
      }
      case 'reminder.create': {
        if (!command.fields.dueAtUtc || !command.fields.title) {
          throw new Error('The proposed reminder is missing a title or due time.')
        }
        const due = localParts(command.fields.dueAtUtc, timezone)
        return {
          kind: 'reminder-save',
          form: reminderFormSchema.parse({
            id: null,
            calendarId: this.repository.listCalendars()[0]?.id ?? null,
            title: command.fields.title,
            notes: command.fields.description ?? '',
            dueDate: due.date,
            dueTime: due.time,
            timezone,
            recurrence: command.recurrence
          })
        }
      }
      case 'reminder.update': {
        const id = command.selection?.reminderIds[0]
        const reminder = id ? this.repository.getReminder(id) : null
        if (!reminder) throw new Error('I could not find the reminder to update.')
        const form = reminderToForm(reminder)
        if (command.fields.title) form.title = command.fields.title
        if (command.fields.description !== null) form.notes = command.fields.description
        if (command.fields.dueAtUtc) {
          const due = localParts(command.fields.dueAtUtc, timezone)
          form.dueDate = due.date
          form.dueTime = due.time
          form.timezone = timezone
        }
        if (command.recurrence) form.recurrence = command.recurrence
        return { kind: 'reminder-save', form: reminderFormSchema.parse(form) }
      }
      case 'reminder.complete': {
        const id = command.selection?.reminderIds[0]
        if (!id || !this.repository.getReminder(id)) {
          throw new Error('I could not find the reminder to complete.')
        }
        return { kind: 'reminder-complete', id }
      }
      case 'reminder.delete': {
        const id = command.selection?.reminderIds[0]
        if (!id || !this.repository.getReminder(id)) {
          throw new Error('I could not find the reminder to delete.')
        }
        return { kind: 'reminder-delete', id }
      }
      default:
        throw new Error('That command is not a calendar mutation I can stage.')
    }
  }

  private proposalSummary(payload: AssistantProposalPayload, command: CalendarIRResolved): string {
    switch (payload.kind) {
      case 'event-save': {
        const action = payload.form.id
          ? command.operation === 'event.move'
            ? 'Move'
            : 'Update'
          : command.operation === 'event.duplicate'
            ? 'Duplicate'
            : 'Create'
        const timing = payload.form.allDay
          ? `${payload.form.startDate}${payload.form.endDate === payload.form.startDate ? '' : ` through ${payload.form.endDate}`}`
          : `${payload.form.startDate} at ${payload.form.startTime}–${payload.form.endTime}`
        return `${action} “${payload.form.title}” on ${timing}${recurrenceLabel(payload.form.recurrence)}.`
      }
      case 'event-delete':
        return `Delete “${this.repository.getEvent(payload.id)?.title ?? 'this event'}”.`
      case 'reminder-save': {
        const action = payload.form.id ? 'Update' : 'Create'
        return `${action} reminder “${payload.form.title}” for ${payload.form.dueDate} at ${payload.form.dueTime}${recurrenceLabel(payload.form.recurrence)}.`
      }
      case 'reminder-complete':
        return `Complete “${this.repository.getReminder(payload.id)?.title ?? 'this reminder'}”.`
      case 'reminder-delete':
        return `Delete “${this.repository.getReminder(payload.id)?.title ?? 'this reminder'}”.`
      case 'bulk-delete': {
        const eventLabel = `${payload.eventIds.length} event${payload.eventIds.length === 1 ? '' : 's'}`
        const reminderLabel = `${payload.reminderIds.length} reminder${payload.reminderIds.length === 1 ? '' : 's'}`
        return payload.scope === 'events'
          ? `Delete all ${eventLabel}.`
          : payload.scope === 'reminders'
            ? `Delete all ${reminderLabel}.`
            : `Delete all ${eventLabel} and all ${reminderLabel}.`
      }
      case 'batch':
        return `Apply ${payload.items.length} changes together: ${payload.itemSummaries.join(' ')}`.slice(
          0,
          2_000
        )
    }
  }

  private applyProposal(
    proposal: AssistantProposal,
    range: CalendarSnapshotRequest,
    id: string
  ): AssistantExchange {
    let result: CalendarMutationResult
    const beforeEventIds = new Set(this.repository.listEvents().map((event) => event.id))
    const beforeReminderIds = new Set(
      this.repository.listReminders().map((reminder) => reminder.id)
    )
    try {
      switch (proposal.payload.kind) {
        case 'event-save':
          result = this.calendar.saveEvent(proposal.payload.form, range, {
            actor: 'assistant',
            assistantProposalId: proposal.id,
            operation:
              proposal.operation === 'event.move'
                ? 'event.move'
                : proposal.operation === 'event.duplicate'
                  ? 'event.duplicate'
                  : proposal.payload.form.id
                    ? 'event.update'
                    : 'event.create'
          })
          break
        case 'event-delete':
          result = this.calendar.deleteEvent(proposal.payload.id, range, 'assistant', proposal.id)
          break
        case 'reminder-save':
          result = this.calendar.saveReminder(proposal.payload.form, range, {
            actor: 'assistant',
            assistantProposalId: proposal.id,
            operation: proposal.payload.form.id ? 'reminder.update' : 'reminder.create'
          })
          break
        case 'reminder-complete':
          result = this.calendar.completeReminder(
            proposal.payload.id,
            range,
            'assistant',
            proposal.id
          )
          break
        case 'reminder-delete':
          result = this.calendar.deleteReminder(
            proposal.payload.id,
            range,
            'assistant',
            proposal.id
          )
          break
        case 'bulk-delete': {
          const currentEventIds = this.repository.listEvents().map((event) => event.id)
          const currentReminderIds = this.repository.listReminders().map((reminder) => reminder.id)
          const eventsUnchanged =
            proposal.payload.scope === 'reminders' ||
            sameIdSet(currentEventIds, proposal.payload.eventIds)
          const remindersUnchanged =
            proposal.payload.scope === 'events' ||
            sameIdSet(currentReminderIds, proposal.payload.reminderIds)
          if (!eventsUnchanged || !remindersUnchanged) {
            throw new Error(
              'Your calendar changed after this review was prepared. Ask me to clear it again so the confirmation has an exact, current count.'
            )
          }
          result = this.calendar.deleteEntities(
            proposal.payload.eventIds,
            proposal.payload.reminderIds,
            proposal.summary,
            range,
            'assistant',
            proposal.id
          )
          break
        }
        case 'batch':
          result = this.calendar.applyBatch(proposal.payload.items, proposal.summary, range, {
            actor: 'assistant',
            operation: proposal.operation,
            risk: proposal.risk,
            assistantProposalId: proposal.id
          })
          break
      }
    } catch (error) {
      if (this.repository.getAssistantProposal(proposal.id)?.status === 'pending') {
        this.repository.setAssistantProposalStatus(proposal.id, 'failed')
      }
      const detail =
        error instanceof Error
          ? `I couldn't apply that proposal, so I stopped: ${error.message}`
          : "I couldn't apply that proposal, so I stopped."
      return this.respond(proposal.conversationId, id, range, {
        kind: 'error',
        text: this.groundedReply(
          proposal.conversationId,
          id,
          'error',
          [{ key: 'DETAIL', kind: 'text', value: detail }],
          ['<DETAIL>', 'I kept the failure contained: <DETAIL>', 'I stopped safely. <DETAIL>']
        ),
        relatedEventIds: [],
        relatedReminderIds: [],
        receipt: null
      })
    }
    const speechAct: ResponsePlan['speechAct'] = proposal.operation.endsWith('.delete')
      ? 'deletion-confirmed'
      : proposal.operation === 'reminder.complete'
        ? 'completion-confirmed'
        : proposal.operation.endsWith('.create')
          ? 'creation-confirmed'
          : 'update-confirmed'
    const text = this.groundedReply(
      proposal.conversationId,
      id,
      speechAct,
      [{ key: 'RECEIPT', kind: 'text', value: result.receipt.summary }],
      [
        '<RECEIPT> It’s saved locally, and you can undo it if you change your mind.',
        'Done — <RECEIPT> The change is on this device and remains undoable.',
        'All set. <RECEIPT> I kept an undo receipt for you.'
      ]
    )
    const createdEventIds = result.snapshot.events
      .filter((event) => !beforeEventIds.has(event.id))
      .map((event) => event.id)
    const createdReminderIds = result.snapshot.reminders
      .filter((reminder) => !beforeReminderIds.has(reminder.id))
      .map((reminder) => reminder.id)
    const currentEventIds = new Set(result.snapshot.events.map((event) => event.id))
    const currentReminderIds = new Set(result.snapshot.reminders.map((reminder) => reminder.id))
    const relatedEventIds = createdEventIds.length
      ? createdEventIds
      : (proposal.resolvedCommand.selection?.eventIds ?? []).filter((eventId) =>
          currentEventIds.has(eventId)
        )
    const relatedReminderIds = createdReminderIds.length
      ? createdReminderIds
      : (proposal.resolvedCommand.selection?.reminderIds ?? []).filter((reminderId) =>
          currentReminderIds.has(reminderId)
        )
    return this.respond(proposal.conversationId, id, range, {
      kind: 'receipt',
      text,
      relatedEventIds,
      relatedReminderIds,
      receipt: result.receipt
    })
  }

  private rejectExistingProposal(
    proposal: AssistantProposal,
    range: CalendarSnapshotRequest,
    id: string,
    mode: 'cancel' | 'edit' = 'cancel'
  ): AssistantExchange {
    this.repository.setAssistantProposalStatus(proposal.id, 'rejected')
    const text = this.groundedReply(
      proposal.conversationId,
      id,
      'proposal-rejected',
      [{ key: 'SUMMARY', kind: 'text', value: proposal.summary }],
      mode === 'edit'
        ? [
            'I moved this into the editor without applying it: <SUMMARY>',
            'The original proposal is set aside; you can now edit: <SUMMARY>',
            'Nothing changed yet. I opened the details for: <SUMMARY>'
          ]
        : [
            'Cancelled — I did not apply this proposal: <SUMMARY>',
            'No change made. I set aside the proposal to <SUMMARY>',
            'Consider it dropped. Nothing was saved for: <SUMMARY>'
          ]
    )
    return this.respond(proposal.conversationId, id, range, {
      kind: 'rejected',
      text,
      relatedEventIds: [],
      relatedReminderIds: [],
      receipt: null
    })
  }

  private undo(
    conversationId: string,
    id: string,
    range: CalendarSnapshotRequest
  ): AssistantExchange {
    try {
      const result = this.calendar.undoLastAction(range)
      const text = this.groundedReply(
        conversationId,
        id,
        'undo-confirmed',
        [{ key: 'RECEIPT', kind: 'text', value: result.receipt.summary }],
        [
          '<RECEIPT> Your calendar is back to its previous state.',
          'Done — <RECEIPT> The earlier state is restored.',
          '<RECEIPT> Everything else stayed as it was.'
        ]
      )
      return this.respond(conversationId, id, range, {
        kind: 'receipt',
        text,
        relatedEventIds: [],
        relatedReminderIds: [],
        receipt: result.receipt
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'There is no recent change to undo.'
      return this.respond(conversationId, id, range, {
        kind: 'error',
        text: this.groundedReply(
          conversationId,
          id,
          'error',
          [{ key: 'DETAIL', kind: 'text', value: detail }],
          ['<DETAIL>', 'The undo stopped safely: <DETAIL>', 'I couldn’t undo that: <DETAIL>']
        ),
        relatedEventIds: [],
        relatedReminderIds: [],
        receipt: null
      })
    }
  }

  private answerQuery(
    conversationId: string,
    command: CalendarIRResolved,
    range: CalendarSnapshotRequest,
    followUpDetail: CalendarDetailRequest | null = null
  ): AssistantExchange {
    const preferences = this.repository.getPreferences()
    const id = command.requestId
    const queryStart = command.fields.rangeStartUtc ?? range.rangeStartUtc
    const queryEnd = command.fields.rangeEndUtc ?? range.rangeEndUtc
    const querySnapshot = this.calendar.getSnapshot({
      rangeStartUtc: queryStart,
      rangeEndUtc: queryEnd
    })
    const question = commandQuestion(command)
    const asksForSummary =
      /\b(?:summari[sz]e|summary|recap|overview|run[- ]?down|walk me through|what(?:'s| is) happening)\b/iu.test(
        question
      )
    const asksForDetails =
      followUpDetail === 'details' ||
      /\b(?:details?|more about|tell me about|explain)\b/iu.test(question)
    const asksForLocation =
      followUpDetail === 'location' ||
      /\b(?:where|location|(?:what|which) (?:room|building|place)|how do i get)\b/iu.test(question)
    const asksForStart =
      followUpDetail === 'start' ||
      /\b(?:(?:what|which) time .{0,50}\bstart|when .{0,50}\bstart|start time)\b/iu.test(question)
    const asksForEnd =
      followUpDetail === 'end' ||
      /\b(?:(?:what|which) time .{0,50}\bend|when .{0,50}\bend|end time)\b/iu.test(question)
    const asksForDuration =
      followUpDetail === 'duration' || /\b(?:how long|duration)\b/iu.test(question)
    const asksForDate =
      followUpDetail === 'date' || /\b(?:what|which) (?:day|date)\b/iu.test(question)
    const asksForNotes =
      followUpDetail === 'notes' ||
      /\b(?:what (?:should|do) i (?:bring|prepare|need)|notes?|instructions?|what(?:'s| is) .{0,40} about)\b/iu.test(
        question
      )
    const asksForRecurrence =
      followUpDetail === 'recurrence' ||
      /\b(?:how often|recurrence|repeats?|repeating|which days|what days|days of (?:the )?week)\b/iu.test(
        question
      )
    const asksForTime =
      followUpDetail === 'time' ||
      asksForStart ||
      asksForEnd ||
      asksForDuration ||
      /\b(?:when|what time|which time|start(?:s|ing)?|end(?:s|ing)?)\b/iu.test(question)
    const requestedAttribute: Exclude<CalendarDetailRequest, 'details'> | null =
      followUpDetail && followUpDetail !== 'details'
        ? followUpDetail
        : asksForLocation
          ? 'location'
          : asksForRecurrence
            ? 'recurrence'
            : asksForDuration
              ? 'duration'
              : asksForEnd
                ? 'end'
                : asksForStart
                  ? 'start'
                  : asksForDate
                    ? 'date'
                    : asksForNotes
                      ? 'notes'
                      : asksForTime
                        ? 'time'
                        : null
    const expandedAnswer = asksForSummary || asksForDetails || requestedAttribute !== null
    let text: string
    let relatedEventIds: string[] = []
    let relatedReminderIds: string[] = []
    let orderedResultItems: AssistantQueryFrameItem[] = []
    let selectedResultItems: AssistantQueryFrameItem[] = []
    let resultCursor: number | null = null
    let continuationCursor: number | null = null

    switch (command.operation) {
      case 'calendar.availability': {
        const result = this.calendar.checkAvailability({
          rangeStartUtc: queryStart,
          rangeEndUtc: queryEnd,
          excludeEventId: null
        })
        relatedEventIds = result.conflicts.map((conflict) => conflict.eventId)
        orderedResultItems = result.conflicts
          .slice()
          .sort((left, right) => Date.parse(left.startUtc) - Date.parse(right.startUtc))
          .map((conflict) => ({
            kind: 'event',
            id: conflict.eventId,
            occurrenceStart: conflict.startUtc
          }))
        selectedResultItems = orderedResultItems
        const hasExplicitTime =
          /\b(?:at\s+\d{1,2}|from\s+\d{1,2}|between\s+\d{1,2}|noon|midnight|morning|afternoon|evening|night|\d{1,2}:\d{2}\s*(?:a\.?m\.?|p\.?m\.?)?)\b/iu.test(
            question
          )
        const wholeDay = !hasExplicitTime
        const slot = wholeDay
          ? formatDate(queryStart, preferences.locale, preferences.timezone)
          : `${formatDateTime(queryStart, preferences.locale, preferences.timezone)} to ${formatDateTime(queryEnd, preferences.locale, preferences.timezone, false)}`
        const conflictFacts = result.conflicts
          .sort((left, right) => Date.parse(left.startUtc) - Date.parse(right.startUtc))
          .slice(0, 6)
          .map((conflict) =>
            eventAnswerFact(conflict, preferences.locale, {
              includeDate: false,
              includeDescription: asksForDetails
            })
          )
        const detail = result.free
          ? wholeDay
            ? 'there are no calendar events that day'
            : 'you have no calendar events in that window'
          : wholeDay
            ? `you have ${result.conflicts.length} event${result.conflicts.length === 1 ? '' : 's'}: ${conflictFacts.join('; ')}`
            : `it overlaps ${conflictFacts.join('; ')}`
        text = this.groundedReply(
          conversationId,
          id,
          'availability-answer',
          [
            { key: 'SLOT', kind: 'time', value: slot },
            { key: 'DETAIL', kind: 'text', value: detail }
          ],
          result.free
            ? [
                wholeDay ? 'Yes — <SLOT> is clear; <DETAIL>.' : 'Yes — <SLOT> is open; <DETAIL>.',
                wholeDay
                  ? '<SLOT> is free on your local calendar: <DETAIL>.'
                  : 'You’re free from <SLOT>. I checked the local calendar, and <DETAIL>.',
                '<SLOT> looks clear: <DETAIL>.'
              ]
            : [
                wholeDay
                  ? 'You have plans on <SLOT>: <DETAIL>.'
                  : 'You’re busy from <SLOT>; <DETAIL>.',
                wholeDay
                  ? '<SLOT> is not completely free — <DETAIL>.'
                  : '<SLOT> is not fully open because <DETAIL>.',
                'That window has a collision: <SLOT>, where <DETAIL>.'
              ]
        )
        break
      }
      case 'calendar.list': {
        let occurrences = querySnapshot.occurrences
          .filter((item) => overlaps(item.startUtc, item.endUtc, queryStart, queryEnd))
          .sort((left, right) => Date.parse(left.startUtc) - Date.parse(right.startUtc))
        let reminders = querySnapshot.reminders
          .filter(
            (reminder) =>
              reminder.status === 'active' &&
              Date.parse(reminder.dueAtUtc) >= Date.parse(queryStart) &&
              Date.parse(reminder.dueAtUtc) < Date.parse(queryEnd)
          )
          .sort((left, right) => Date.parse(left.dueAtUtc) - Date.parse(right.dueAtUtc))
        const requestedSelection = calendarListSelection(question)
        if (requestedSelection?.itemKind === 'class') {
          const likelyClasses = occurrences.filter((occurrence) =>
            isLikelyClassOccurrence(occurrence, this.repository.getEvent(occurrence.eventId))
          )
          occurrences = likelyClasses.length > 0 ? likelyClasses : occurrences
          reminders = []
        } else if (requestedSelection?.itemKind === 'event') {
          reminders = []
        } else if (requestedSelection?.itemKind === 'reminder') {
          occurrences = []
        }
        orderedResultItems = [
          ...occurrences.map((occurrence) => ({
            kind: 'event' as const,
            id: occurrence.eventId,
            occurrenceStart: occurrence.startUtc
          })),
          ...reminders.map((reminder) => ({
            kind: 'reminder' as const,
            id: reminder.id,
            occurrenceStart: reminder.dueAtUtc
          }))
        ].sort(
          (left, right) => Date.parse(left.occurrenceStart) - Date.parse(right.occurrenceStart)
        )
        if (requestedSelection) {
          const ordered = [
            ...occurrences.map((occurrence) => ({
              kind: 'event' as const,
              at: occurrence.startUtc,
              occurrence
            })),
            ...reminders.map((reminder) => ({
              kind: 'reminder' as const,
              at: reminder.dueAtUtc,
              reminder
            }))
          ].sort((left, right) => Date.parse(left.at) - Date.parse(right.at))
          const selected =
            requestedSelection.position.kind === 'next'
              ? ordered.find((item) => Date.parse(item.at) >= Date.parse(command.resolvedAt))
              : requestedSelection.position.kind === 'previous'
                ? ordered
                    .filter((item) => Date.parse(item.at) < Date.parse(command.resolvedAt))
                    .at(-1)
                : requestedSelection.position.kind === 'last'
                  ? ordered.at(-1)
                  : ordered[requestedSelection.position.index]
          occurrences = selected?.kind === 'event' ? [selected.occurrence] : []
          reminders = selected?.kind === 'reminder' ? [selected.reminder] : []
        }
        selectedResultItems = [
          ...occurrences.map((occurrence) => ({
            kind: 'event' as const,
            id: occurrence.eventId,
            occurrenceStart: occurrence.startUtc
          })),
          ...reminders.map((reminder) => ({
            kind: 'reminder' as const,
            id: reminder.id,
            occurrenceStart: reminder.dueAtUtc
          }))
        ].sort(
          (left, right) => Date.parse(left.occurrenceStart) - Date.parse(right.occurrenceStart)
        )
        if (selectedResultItems.length === 1) {
          const selectedKey = dialogueFrameItemKey(selectedResultItems[0]!)
          const selectedIndex = orderedResultItems.findIndex(
            (item) => dialogueFrameItemKey(item) === selectedKey
          )
          resultCursor = selectedIndex >= 0 ? selectedIndex : null
        }
        relatedEventIds = [...new Set(occurrences.map((item) => item.eventId))]
        relatedReminderIds = reminders.map((reminder) => reminder.id)
        const nextOnly = requestedSelection?.position.kind === 'next'
        const emptyText =
          requestedSelection?.itemKind === 'class'
            ? nextOnly
              ? 'No classes coming up.'
              : 'No classes scheduled.'
            : requestedSelection?.itemKind === 'reminder'
              ? nextOnly
                ? 'No reminders coming up.'
                : 'No reminders scheduled.'
              : nextOnly
                ? 'Nothing coming up.'
                : 'Nothing scheduled.'
        const groundedItems = [
          ...occurrences.map((occurrence) => ({
            at: occurrence.startUtc,
            item: groundedEventAnswerItem(
              occurrence,
              preferences.locale,
              this.repository.getEvent(occurrence.eventId)?.recurrence ?? null
            )
          })),
          ...reminders.map((reminder) => ({
            at: reminder.dueAtUtc,
            item: groundedReminderAnswerItem(reminder, preferences.locale)
          }))
        ]
          .sort((left, right) => Date.parse(left.at) - Date.parse(right.at))
          .map((entry) => entry.item)
        if (groundedItems.length === 0) {
          text =
            requestedAttribute || expandedAnswer
              ? emptyText
              : this.groundedReply(
                  conversationId,
                  id,
                  'empty-schedule-answer',
                  [],
                  nextOnly
                    ? ['Nothing coming up.', 'There’s nothing coming up.', 'Nothing is coming up.']
                    : requestedSelection?.itemKind === 'class'
                      ? ['No classes scheduled.', 'There are no classes scheduled.']
                      : [
                          'Nothing scheduled.',
                          'There’s nothing scheduled.',
                          'I found nothing scheduled.'
                        ]
                )
          break
        }
        const answerPage = renderGroundedAnswer({
          items: groundedItems,
          locale: preferences.locale,
          mode: requestedAttribute
            ? 'attributes'
            : asksForDetails
              ? 'details'
              : asksForSummary
                ? 'summary'
                : 'names',
          fields: requestedAttribute ? [requestedAttribute] : [],
          emptyText
        })
        text = answerPage.text
        continuationCursor = answerPage.nextCursor
        break
      }
      case 'calendar.search': {
        const query = command.selection?.query?.value.toLocaleLowerCase() ?? ''
        const selectedEventIds = new Set(command.selection?.eventIds ?? [])
        const selectedReminderIds = new Set(command.selection?.reminderIds ?? [])
        const hasFocusedSelection = selectedEventIds.size + selectedReminderIds.size > 0
        const events = this.repository
          .listEvents()
          .filter(
            (event) =>
              event.status === 'active' &&
              (hasFocusedSelection
                ? selectedEventIds.has(event.id)
                : [event.title, event.location, event.description].some((value) =>
                    value.toLocaleLowerCase().includes(query)
                  ) ||
                  typoPhraseSimilarity(query, event.title) >= 0.72 ||
                  typoPhraseSimilarity(query, event.location) >= 0.78)
          )
        const reminders = this.repository
          .listReminders()
          .filter(
            (reminder) =>
              reminder.status === 'active' &&
              (hasFocusedSelection
                ? selectedReminderIds.has(reminder.id)
                : [reminder.title, reminder.notes].some((value) =>
                    value.toLocaleLowerCase().includes(query)
                  ) || typoPhraseSimilarity(query, reminder.title) >= 0.72)
          )
        relatedEventIds = events.map((event) => event.id)
        relatedReminderIds = reminders.map((reminder) => reminder.id)
        orderedResultItems = [
          ...events.map((event) => ({
            kind: 'event' as const,
            id: event.id,
            occurrenceStart: event.startUtc
          })),
          ...reminders.map((reminder) => ({
            kind: 'reminder' as const,
            id: reminder.id,
            occurrenceStart: reminder.dueAtUtc
          }))
        ].sort(
          (left, right) => Date.parse(left.occurrenceStart) - Date.parse(right.occurrenceStart)
        )
        selectedResultItems = orderedResultItems
        const groundedItems = [
          ...events.map((event) => ({
            at: event.startUtc,
            item: groundedEventAnswerItem(
              eventEntityOccurrence(event),
              preferences.locale,
              event.recurrence
            )
          })),
          ...reminders.map((reminder) => ({
            at: reminder.dueAtUtc,
            item: groundedReminderAnswerItem(reminder, preferences.locale)
          }))
        ]
          .sort((left, right) => Date.parse(left.at) - Date.parse(right.at))
          .map((entry) => entry.item)
        const answerPage = renderGroundedAnswer({
          items: groundedItems,
          locale: preferences.locale,
          mode: requestedAttribute
            ? 'attributes'
            : asksForDetails
              ? 'details'
              : asksForSummary
                ? 'summary'
                : 'names',
          fields: requestedAttribute ? [requestedAttribute] : [],
          emptyText: `No active match for “${query}”.`
        })
        text = answerPage.text
        continuationCursor = answerPage.nextCursor
        break
      }
      case 'calendar.conflicts': {
        const occurrences = [...querySnapshot.occurrences].sort(
          (left, right) => Date.parse(left.startUtc) - Date.parse(right.startUtc)
        )
        const pairs: string[] = []
        for (let leftIndex = 0; leftIndex < occurrences.length; leftIndex += 1) {
          const left = occurrences[leftIndex]
          if (!left) continue
          for (let rightIndex = leftIndex + 1; rightIndex < occurrences.length; rightIndex += 1) {
            const right = occurrences[rightIndex]
            if (!right || Date.parse(right.startUtc) >= Date.parse(left.endUtc)) break
            if (
              left.eventId !== right.eventId &&
              overlaps(left.startUtc, left.endUtc, right.startUtc, right.endUtc)
            ) {
              pairs.push(`“${left.title}” overlaps “${right.title}”`)
              relatedEventIds.push(left.eventId, right.eventId)
            }
          }
        }
        relatedEventIds = [...new Set(relatedEventIds)]
        orderedResultItems = occurrences
          .filter((occurrence) => relatedEventIds.includes(occurrence.eventId))
          .map((occurrence) => ({
            kind: 'event',
            id: occurrence.eventId,
            occurrenceStart: occurrence.startUtc
          }))
        selectedResultItems = orderedResultItems
        const summary = pairs.length
          ? `${pairs.length} conflict${pairs.length === 1 ? '' : 's'}: ${pairs.slice(0, 6).join('; ')}`
          : 'no overlapping events'
        text = this.groundedReply(
          conversationId,
          id,
          pairs.length ? 'conflict-warning' : 'schedule-summary',
          [{ key: 'SUMMARY', kind: 'text', value: summary }],
          pairs.length
            ? [
                'I found <SUMMARY>.',
                'A quick conflict check found <SUMMARY>.',
                'There’s some calendar friction: <SUMMARY>.'
              ]
            : [
                'Good news: I found <SUMMARY>.',
                'The schedule is clean — <SUMMARY>.',
                'I checked the window and found <SUMMARY>.'
              ]
        )
        break
      }
      default:
        text = this.groundedReply(
          conversationId,
          id,
          'policy-boundary',
          [
            {
              key: 'DETAIL',
              kind: 'text',
              value: 'I could not answer that calendar question safely.'
            }
          ],
          ['<DETAIL>', 'I could not complete that calendar answer: <DETAIL>']
        )
    }

    if (resultCursor === null && selectedResultItems.length === 1) {
      const selectedKey = dialogueFrameItemKey(selectedResultItems[0]!)
      const selectedIndex = orderedResultItems.findIndex(
        (item) => dialogueFrameItemKey(item) === selectedKey
      )
      resultCursor = selectedIndex >= 0 ? selectedIndex : null
    }

    this.recordQueryState(
      conversationId,
      command,
      queryStart,
      queryEnd,
      relatedEventIds,
      relatedReminderIds,
      orderedResultItems,
      selectedResultItems,
      [requestedAttribute ?? (asksForDetails ? 'details' : 'name')],
      resultCursor,
      continuationCursor
    )
    return this.respond(conversationId, id, range, {
      kind: 'answer',
      text,
      relatedEventIds,
      relatedReminderIds,
      receipt: null
    })
  }
}
