import { randomUUID } from 'node:crypto'
import { Temporal } from '@js-temporal/polyfill'
import {
  assistantPlanForCapability,
  assistantPlanFromCalendarDrafts,
  createGroundedReply,
  getActionDisposition,
  normalizeAssistantText,
  parseBulkClearIntent,
  parseScopedBulkClearRequest,
  planCalendarTextHybrid,
  parseScheduleReplicationRequest,
  repairKnownMutationTargets,
  routeAssistantRequest,
  splitCalendarRequests,
  typoPhraseSimilarity,
  type ConversationIntent,
  type BulkClearIntent,
  type MemoryIntent,
  type ScheduleReplicationIntent,
  type SemanticPlannerPrediction
} from '@remind-me/assistant-core'
import { dryRunCalendarCommand, resolveCalendarIR } from '@remind-me/calendar-engine'
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
  type FlexModelAction,
  type FlexModelPlan,
  type FlexModelPlanContext,
  type ReminderEntity,
  type ReminderForm,
  type ResponsePlan
} from '@remind-me/contracts'
import { PersistentCalendarService } from './calendar-service'
import type { SqliteCalendarRepository } from './sqlite-repository'

const defaultConversationId = 'conversation:local'

export interface FlexibleCalendarPlanner {
  plan(text: string, context: FlexModelPlanContext): Promise<FlexModelPlan | null>
  chat?(input: FlexModelChatRequest): Promise<string | null>
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

function exactExcerpt(source: string, excerpt: string): { text: string; start: number } | null {
  const start = source.toLocaleLowerCase().indexOf(excerpt.toLocaleLowerCase())
  if (start < 0) return null
  return { text: source.slice(start, start + excerpt.length), start }
}

function groundedActionSource(
  source: string,
  action: FlexModelAction
): { text: string; start: number } | null {
  const exact = exactExcerpt(source, action.sourceText)
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
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12
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
  const monthFirst = new RegExp(`\\b(${monthNames})\\s+(${daySource})(?:,?\\s+(\\d{4}))?\\b`, 'giu')
  const dayFirst = new RegExp(
    `\\b(?:the\\s+)?(${daySource})(?:\\s+day\\s+of|\\s+of)\\s+(${monthNames})(?:,?\\s+(\\d{4}))?\\b`,
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
  }
  return dates
}

function sourceClockCandidates(source: string): Set<string> {
  const clocks = new Set<string>()
  const add = (hour: number, minute: number): void => {
    if (hour >= 1 && hour <= 12 && minute >= 0 && minute <= 59) {
      clocks.add(`${hour}:${String(minute).padStart(2, '0')}`)
    }
  }
  for (const match of source.matchAll(/\b(\d{1,2})(?::(\d{2}))?\s*(?:a\.?m\.?|p\.?m\.?)\b/giu)) {
    add(Number(match[1]), Number(match[2] ?? 0))
  }
  if (/\bnoon\b/iu.test(source)) add(12, 0)
  if (/\bmidnight\b/iu.test(source)) add(12, 0)
  for (const match of source.matchAll(
    /\b(half|quarter)\s+(past|after|to)\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/giu
  )) {
    const rawHour = match[3]?.toLocaleLowerCase() ?? ''
    const hour = /^\d+$/u.test(rawHour) ? Number(rawHour) : (clockNumberByName[rawHour] ?? 0)
    const direction = match[2]?.toLocaleLowerCase()
    const quarter = match[1]?.toLocaleLowerCase() === 'quarter'
    add(
      direction === 'to' ? (hour === 1 ? 12 : hour - 1) : hour,
      direction === 'to' ? 45 : quarter ? 15 : 30
    )
  }
  return clocks
}

function canonicalClockCandidates(source: string): Set<string> {
  const clocks = new Set<string>()
  for (const match of source.matchAll(/\b(1[0-2]|[1-9]):([0-5]\d)\s+(?:AM|PM)\b/giu)) {
    clocks.add(`${Number(match[1])}:${match[2]}`)
  }
  return clocks
}

function canUseTemporalTranslation(
  fullSource: string,
  copiedWhen: { text: string; start: number } | null,
  suppliedWhen: string | null | undefined,
  normalizedWhen: string,
  context: FlexModelPlanContext | undefined
): boolean {
  if (!suppliedWhen) return false
  if (copiedWhen) return true
  const normalizedDates = normalizedWhen.match(/\b\d{4}-\d{2}-\d{2}\b/gu) ?? []
  const availableDates = sourceDateCandidates(fullSource, context)
  if (normalizedDates.some((date) => !availableDates.has(date))) return false
  const normalizedClocks = canonicalClockCandidates(normalizedWhen)
  const availableClocks = sourceClockCandidates(fullSource)
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
    return /\b(?:note|notes|description|details?|with)\s*(?::|-)?\s*$/iu.test(prefix)
  }
  if (kind === 'LOCATION') {
    return (
      /\b(?:in|inside|location|room)\s+(?:the\s+)?$/iu.test(prefix) ||
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
  for (const action of plan.actions) {
    if (!flexibleAssistedOperations.has(action.operation)) return null
    const segment = groundedActionSource(source, action)
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
    const normalizedWhen =
      normalizedWhenCandidate &&
      canUseTemporalTranslation(
        source,
        whenExcerpt,
        action.whenText,
        normalizedWhenCandidate,
        context
      )
        ? normalizedWhenCandidate
        : null
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
    /\b(?:add|book|cancel|change|complete|copy|create|delete|duplicate|mark|modify|move|postpone|push|remind|remove|rename|repeat|reschedule|save|schedule|set|shift|update)\b/iu.test(
      value
    ) ||
    /\bmake\s+(?:(?:an?|the|my)\s+)?(?:appointment|calendar item|event|plan|reminder|room\s+for)\b/iu.test(
      value
    )
  )
}

function claimsCalendarMutation(value: string): boolean {
  return /\b(?:i(?:'ve| have)?|we(?:'ve| have)?)[ ]+(?:added|booked|cancelled|canceled|changed|completed|copied|created|deleted|duplicated|marked|moved|removed|renamed|rescheduled|saved|scheduled|set|shifted|updated)\b|\b(?:event|meeting|appointment|reminder|calendar item)\b.{0,60}\b(?:has been|is|was)\s+(?:added|booked|cancelled|canceled|changed|completed|created|deleted|moved|removed|renamed|rescheduled|saved|scheduled|set|updated)\b|^(?:done|all set)[.!—, ]/iu.test(
    value.trim()
  )
}

function isRejectedFlexibleChatTurn(value: string): boolean {
  return /could not finish that response with the local language model|could not map that request safely yet/iu.test(
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

function isCalendarDetailFollowUp(value: string): boolean {
  return /^(?:more|more please|details?|show (?:me )?(?:more|details?)|tell me more|go (?:deeper|on)|expand(?: on that)?|what about the (?:times?|locations?|details?))[.!]*$/iu.test(
    value.trim()
  )
}

function focusedItemTitles(
  state: AssistantDialogueState,
  events: readonly EventEntity[],
  reminders: readonly ReminderEntity[]
): string[] {
  const focusedEvents = new Set(state.focusedEventIds)
  const focusedReminders = new Set(state.focusedReminderIds)
  return [
    ...events
      .filter((event) => event.status === 'active' && focusedEvents.has(event.id))
      .map((event) => event.title),
    ...reminders
      .filter((reminder) => reminder.status === 'active' && focusedReminders.has(reminder.id))
      .map((reminder) => reminder.title)
  ]
}

function expandPluralDialogueReference(
  value: string,
  state: AssistantDialogueState,
  events: readonly EventEntity[],
  reminders: readonly ReminderEntity[]
): string {
  if (!looksLikeCalendarMutation(value)) return value
  const reference = /\b(?:all\s+of\s+them|both|them|these|those|these\s+ones|those\s+ones)\b/iu
  if (!reference.test(value)) return value
  const titles = focusedItemTitles(state, events, reminders)
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

function mergeClarificationAnswer(
  clarification: AssistantPendingClarification,
  answer: string
): string {
  const source = clarification.sourceText.trim().replace(/[.!?]+$/gu, '')
  const option = selectedClarificationOption(answer, clarification.options)
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

function asksForSingleNextItem(value: string): boolean {
  const normalized = value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[‘’]/gu, "'")
    .replace(/[.!?]+$/gu, '')
    .trim()
  return /^(?:what(?:'s|s| is) (?:my )?next(?: (?:event|meeting|appointment|plan|item|reminder))?|what(?:'s|s| is) coming up next|which (?:event|meeting|appointment|plan|item|reminder) is next|show (?:me )?(?:my )?next (?:event|meeting|appointment|plan|item|reminder))$/u.test(
    normalized
  )
}

function compactNameAnswer(titles: readonly string[], locale: string, emptyText: string): string {
  const unique = [...new Set(titles.map((title) => clippedDetail(title, 120)).filter(Boolean))]
  if (unique.length === 0) return emptyText
  const maximumVisible = 8
  const visible = unique.slice(0, maximumVisible)
  if (unique.length > maximumVisible) visible.push(`${unique.length - maximumVisible} more`)
  return `${new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(visible)}.`
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

export class PersistentAssistantService {
  private readonly calendar: PersistentCalendarService
  private readonly plannerInfo: RemindCoreInfo
  private readonly speakerInfo: RemindSpeakInfo
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
    private readonly flexiblePlanner: FlexibleCalendarPlanner | null = null
  ) {
    this.calendar = new PersistentCalendarService(repository)
    this.plannerInfo = plannerInfo ?? planner?.info ?? unavailableRemindCoreInfo('Rules-only mode')
    this.speakerInfo =
      speakerInfo ?? speaker?.info ?? unavailableRemindSpeakInfo('Template response mode')
  }

  getPlannerInfo(): RemindCoreInfo {
    return this.plannerInfo
  }

  getSpeakerInfo(): RemindSpeakInfo {
    return this.speakerInfo
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

  async send(input: AssistantSendRequest): Promise<AssistantExchange> {
    const request = assistantSendRequestSchema.parse(input)
    const conversation = this.getConversation(request.conversationId)
    const id = requestId()
    const earlierTurns = conversation.turns
    this.appendTurn(conversation.id, 'user', 'text', request.text, id)

    let requestRoute = routeAssistantRequest(request.text)
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
    const normalizedInput = requestRoute.normalizedText
    const previousUser = [...earlierTurns].reverse().find((turn) => turn.role === 'user')
    const normalizedPreviousUser = previousUser ? normalizeAssistantText(previousUser.text) : null

    if (/^(?:undo|undo that|take that back|revert that)[.!]*$/iu.test(normalizedInput)) {
      return this.undo(conversation.id, id, request.range)
    }

    const activeProposal = conversation.activeProposal
    if (
      activeProposal &&
      /^(?:yes|confirm|do it|save it|looks good)[.!]*$/iu.test(normalizedInput)
    ) {
      return this.applyProposal(activeProposal, request.range, id)
    }
    if (activeProposal && /^(?:no|cancel|never mind|reject it)[.!]*$/iu.test(normalizedInput)) {
      return this.rejectExistingProposal(activeProposal, request.range, id)
    }

    const memoryIntent = requestRoute.memoryIntent
    if (memoryIntent) {
      return this.answerMemory(conversation.id, id, memoryIntent, request.range)
    }

    const conversationIntent = requestRoute.conversationIntent
    if (conversationIntent) {
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

    let attemptedBroadChat = false
    const currentEvents = prefetchedEvents ?? this.repository.listEvents()
    const currentReminders = prefetchedReminders ?? this.repository.listReminders()
    const pendingClarification = conversation.dialogueState.pendingClarification
    const clarificationContinuation =
      pendingClarification !== null &&
      isClarificationContinuation(normalizedInput, pendingClarification)
    if (pendingClarification && !clarificationContinuation) {
      const clearedAt = new Date().toISOString()
      this.repository.saveAssistantDialogueState(conversation.id, {
        ...conversation.dialogueState,
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
    const detailFollowUp = isCalendarDetailFollowUp(normalizedInput) && previousReadText !== null
    const interpretedText = detailFollowUp ? previousReadText : contextualInput
    const referenceExpandedText = expandPluralDialogueReference(
      interpretedText,
      conversation.dialogueState,
      currentEvents,
      currentReminders
    )
    const knownTitles = [
      ...currentEvents.map((event) => event.title),
      ...currentReminders.map((reminder) => reminder.title)
    ]
    const routedText = repairKnownMutationTargets(referenceExpandedText, knownTitles)
    const normalizedRequest = routedText.toLocaleLowerCase()
    const mentionsKnownItem = knownTitles.some(
      (title) => title.trim().length >= 2 && normalizedRequest.includes(title.toLocaleLowerCase())
    )
    const routedAsCalendar =
      requestRoute.route === 'calendar' ||
      looksLikeCalendarRequest(routedText) ||
      mentionsKnownItem ||
      (requestRoute.route === 'broad-chat' &&
        nativeAssistantPrediction?.route === 'calendar' &&
        nativeAssistantPrediction.eligibleForRoutingAssistance &&
        nativeAssistantPrediction.capabilities.every((capability) =>
          capability.startsWith('calendar.')
        ))
    if (!routedAsCalendar) {
      attemptedBroadChat = true
      const conversational = await this.flexibleChatAnswer(
        conversation.id,
        id,
        normalizedInput,
        earlierTurns,
        request.range
      )
      if (conversational) return conversational
    }

    const preferences = this.repository.getPreferences()
    const now = new Date().toISOString()
    const zonedNow = Temporal.Instant.from(now).toZonedDateTimeISO(preferences.timezone)
    const flexiblePlanContext: FlexModelPlanContext = {
      currentLocalDateTime: zonedNow.toPlainDateTime().toString({ smallestUnit: 'minute' }),
      timezone: preferences.timezone,
      locale: preferences.locale,
      dialogueContext: this.dialogueContextForPlanner(conversation.id)
    }
    const lastAssistant = [...earlierTurns].reverse().find((turn) => turn.role === 'assistant')
    const contextualFollowUp = /^(?:and\b|what about\b|how about\b)/iu.test(normalizedInput)
    const parserContext = {
      requestId: id,
      text: routedText,
      previousUserText:
        !detailFollowUp &&
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
      focusedEventIds: conversation.dialogueState.focusedEventIds,
      focusedReminderIds: conversation.dialogueState.focusedReminderIds
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
        request.text,
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
        request.text,
        requestParts,
        request.range,
        now,
        zonedNow.toPlainDate().toString()
      )
    }
    let semanticPrediction: RemindCorePrediction | null
    try {
      semanticPrediction = this.planner?.predict(routedText) ?? null
    } catch {
      semanticPrediction = null
    }
    let parseResult = planCalendarTextHybrid(parserContext, semanticPrediction)
    let disposition = getActionDisposition(parseResult.draft)
    let usedFlexibleFallback = false

    if (
      (disposition === 'clarify' ||
        disposition === 'reject' ||
        parseResult.matchedPattern === 'event-create-inferred') &&
      this.flexiblePlanner &&
      !attemptedBroadChat
    ) {
      let flexiblePlan: FlexModelPlan | null
      try {
        flexiblePlan = await this.flexiblePlanner.plan(routedText, flexiblePlanContext)
      } catch {
        flexiblePlan = null
      }
      const grounded = flexiblePlan
        ? groundFlexiblePlan(routedText, flexiblePlan, flexiblePlanContext)
        : null
      if (grounded && grounded.length > 1) {
        return this.stageBatchRequest(
          conversation.id,
          id,
          request.text,
          grounded.map((action) => action.parserText),
          request.range,
          now,
          zonedNow.toPlainDate().toString(),
          grounded.map((action) => action.prediction)
        )
      }
      const action = grounded?.[0]
      if (action) {
        usedFlexibleFallback = true
        parseResult = planCalendarTextHybrid(
          { ...parserContext, text: action.parserText, previousUserText: null },
          action.prediction
        )
        disposition = getActionDisposition(parseResult.draft)
      }
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
      if (unsupported && !attemptedBroadChat) {
        const conversational = await this.flexibleChatAnswer(
          conversation.id,
          id,
          request.text,
          earlierTurns,
          request.range
        )
        if (conversational) return conversational
      }
      const detail = unsupported
        ? this.flexiblePlanner
          ? 'I could not finish that response with the local language model. I’m still here: if it concerns your calendar, include the event or reminder and any date or time you know; for live information, I need a connected source to verify it.'
          : 'The original RemindCore and RemindSpeak models could not answer that open-ended request on their own. Install or enable the optional broad language pack in Settings for general conversation; the native calendar and reminder intelligence still works without it.'
        : 'I did not make a change because that request did not pass the local safety checks.'
      const text = this.groundedReply(
        conversation.id,
        id,
        unsupported ? 'unsupported' : 'error',
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
        kind: unsupported ? 'unsupported' : 'rejected',
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
      sourceText: request.text,
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

  private calendarContextForChat(): string {
    const preferences = this.repository.getPreferences()
    const now = Date.now()
    const events = this.repository
      .listEvents()
      .filter((event) => event.status === 'active')
      .sort((left, right) => {
        const leftDistance = Math.abs(Date.parse(left.startUtc) - now)
        const rightDistance = Math.abs(Date.parse(right.startUtc) - now)
        return leftDistance - rightDistance
      })
      .slice(0, 48)
      .sort((left, right) => Date.parse(left.startUtc) - Date.parse(right.startUtc))
      .map((event) => ({
        type: 'event',
        id: event.id,
        title: event.title,
        start: formatDateTime(event.startUtc, preferences.locale, event.timezone),
        end: formatDateTime(event.endUtc, preferences.locale, event.timezone),
        timezone: event.timezone,
        allDay: event.allDay,
        location: event.location.trim() || null,
        details: event.description.trim() ? clippedDetail(event.description, 240) : null,
        recurrence: event.recurrence
      }))
    const reminders = this.repository
      .listReminders()
      .filter((reminder) => reminder.status !== 'cancelled')
      .sort(
        (left, right) =>
          Math.abs(Date.parse(left.dueAtUtc) - now) - Math.abs(Date.parse(right.dueAtUtc) - now)
      )
      .slice(0, 32)
      .sort((left, right) => Date.parse(left.dueAtUtc) - Date.parse(right.dueAtUtc))
      .map((reminder) => ({
        type: 'reminder',
        id: reminder.id,
        title: reminder.title,
        due: formatDateTime(reminder.dueAtUtc, preferences.locale, reminder.timezone),
        timezone: reminder.timezone,
        status: reminder.status,
        notes: reminder.notes.trim() ? clippedDetail(reminder.notes, 240) : null,
        recurrence: reminder.recurrence
      }))
    const payload = { events, reminders, truncated: false }
    let context = JSON.stringify(payload)
    while (context.length > 8_000 && (payload.events.length || payload.reminders.length)) {
      payload.truncated = true
      if (payload.events.length >= payload.reminders.length) payload.events.pop()
      else payload.reminders.pop()
      context = JSON.stringify(payload)
    }
    return context
  }

  private dialogueContextForPlanner(conversationId: string): string {
    const state = this.repository.getAssistantDialogueState(conversationId)
    const focusedEvents = new Set(state.focusedEventIds)
    const focusedReminders = new Set(state.focusedReminderIds)
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
        : null
    }
    return JSON.stringify(payload).slice(0, 6_000)
  }

  private contextualCalendarDataForChat(conversationId: string): string {
    const dialogue = this.dialogueContextForPlanner(conversationId)
    const calendar = this.calendarContextForChat()
    return `DIALOGUE_FOCUS=${dialogue}\nCALENDAR=${calendar}`.slice(0, 8_000)
  }

  private async flexibleChatAnswer(
    conversationId: string,
    id: string,
    sourceText: string,
    earlierTurns: readonly ConversationTurnEntity[],
    range: CalendarSnapshotRequest
  ): Promise<AssistantExchange | null> {
    if (!this.flexiblePlanner?.chat) return null
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
      if (!text) continue
      turns.unshift({ role: turn.role, text })
      turnBudget -= text.length
    }
    let text: string | null
    try {
      text = await this.flexiblePlanner.chat({
        text: sourceText,
        turns,
        calendarContext: looksLikeCalendarRequest(sourceText)
          ? this.contextualCalendarDataForChat(conversationId)
          : '',
        currentLocalDateTime: now.toString({ smallestUnit: 'minute' }),
        timezone: preferences.timezone,
        profile,
        style: preferences.responseStyle
      })
    } catch {
      text = null
    }
    if (!text?.trim()) return null
    if (looksLikeCalendarMutation(sourceText) && claimsCalendarMutation(text)) return null
    return this.respond(conversationId, id, range, {
      kind: 'answer',
      text: text.trim(),
      relatedEventIds: [],
      relatedReminderIds: [],
      receipt: null
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
    semanticPredictions: readonly SemanticPlannerPrediction[] | null = null
  ): Promise<AssistantExchange> {
    const preferences = this.repository.getPreferences()
    const zonedNow = Temporal.Instant.from(now).toZonedDateTimeISO(preferences.timezone)
    const dialogueState = this.repository.getAssistantDialogueState(conversationId)
    const flexiblePlanContext: FlexModelPlanContext = {
      currentLocalDateTime: zonedNow.toPlainDateTime().toString({ smallestUnit: 'minute' }),
      timezone: preferences.timezone,
      locale: preferences.locale,
      dialogueContext: this.dialogueContextForPlanner(conversationId)
    }
    const events = this.repository.listEvents()
    const reminders = this.repository.listReminders()
    const calendars = this.repository.listCalendars()
    const resolvedCommands: CalendarIRResolved[] = []
    const plannedDrafts: CalendarIRDraft[] = []
    const items: AssistantAtomicProposalPayload[] = []
    const itemSummaries: string[] = []
    let usedFlexibleFallback = Boolean(semanticPredictions?.length)

    for (let index = 0; index < requestParts.length; index += 1) {
      const part = requestParts[index]
      if (!part) continue
      let prediction: SemanticPlannerPrediction | null = semanticPredictions?.[index] ?? null
      if (!prediction) {
        try {
          prediction = this.planner?.predict(part) ?? null
        } catch {
          prediction = null
        }
      }
      let parsed = planCalendarTextHybrid(
        {
          requestId: `${id}:${index + 1}`,
          text: part,
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
      let disposition = getActionDisposition(parsed.draft)
      if (
        (disposition === 'clarify' ||
          disposition === 'reject' ||
          parsed.matchedPattern === 'event-create-inferred') &&
        this.flexiblePlanner
      ) {
        let flexiblePlan: FlexModelPlan | null
        try {
          flexiblePlan = await this.flexiblePlanner.plan(part, flexiblePlanContext)
        } catch {
          flexiblePlan = null
        }
        const grounded = flexiblePlan
          ? groundFlexiblePlan(part, flexiblePlan, flexiblePlanContext)
          : null
        const action = grounded?.length === 1 ? grounded[0] : null
        if (action) {
          usedFlexibleFallback = true
          parsed = planCalendarTextHybrid(
            {
              requestId: `${id}:${index + 1}`,
              text: action.parserText,
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
            action.prediction
          )
          disposition = getActionDisposition(parsed.draft)
        }
      }
      if (disposition === 'clarify' || disposition === 'reject' || disposition === 'answer') {
        const detail =
          parsed.draft.ambiguities[0]?.message ??
          (disposition === 'answer'
            ? 'Questions and calendar changes need separate messages.'
            : `I could not safely understand item ${index + 1}: “${part}”.`)
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
    usedFlexibleFallback = false
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
    const reply = multiple
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

  private recordQueryState(
    conversationId: string,
    command: CalendarIRResolved,
    queryStart: string,
    queryEnd: string,
    eventIds: readonly string[],
    reminderIds: readonly string[]
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
    forceDetails = false
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
    const asksForDetails =
      forceDetails ||
      /\b(?:summari[sz]e|details?|more about|walk me through|tell me about|what(?:'s| is) happening|explain)\b/iu.test(
        question
      )
    const asksForLocation =
      /\b(?:where|location|which (?:room|building|place)|how do i get)\b/iu.test(question)
    const asksForTime =
      /\b(?:when|what time|which time|start(?:s|ing)?|end(?:s|ing)?|duration|how long)\b/iu.test(
        question
      )
    const expandedAnswer = asksForDetails || asksForLocation || asksForTime
    let text: string
    let relatedEventIds: string[] = []
    let relatedReminderIds: string[] = []

    switch (command.operation) {
      case 'calendar.availability': {
        const result = this.calendar.checkAvailability({
          rangeStartUtc: queryStart,
          rangeEndUtc: queryEnd,
          excludeEventId: null
        })
        relatedEventIds = result.conflicts.map((conflict) => conflict.eventId)
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
        const nextOnly = asksForSingleNextItem(question)
        if (nextOnly) {
          const next = [
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
          ]
            .filter((item) => Date.parse(item.at) >= Date.parse(command.resolvedAt))
            .sort((left, right) => Date.parse(left.at) - Date.parse(right.at))[0]
          occurrences = next?.kind === 'event' ? [next.occurrence] : []
          reminders = next?.kind === 'reminder' ? [next.reminder] : []
        }
        relatedEventIds = [...new Set(occurrences.map((item) => item.eventId))]
        relatedReminderIds = reminders.map((reminder) => reminder.id)
        if (!expandedAnswer) {
          const orderedNames = [
            ...occurrences.map((occurrence) => ({
              at: occurrence.startUtc,
              title: occurrence.title
            })),
            ...reminders.map((reminder) => ({ at: reminder.dueAtUtc, title: reminder.title }))
          ]
            .sort((left, right) => Date.parse(left.at) - Date.parse(right.at))
            .map((item) => item.title)
          text = orderedNames.length
            ? compactNameAnswer(orderedNames, preferences.locale, 'Nothing scheduled.')
            : this.groundedReply(
                conversationId,
                id,
                'empty-schedule-answer',
                [],
                nextOnly
                  ? ['Nothing coming up.', 'There’s nothing coming up.', 'Nothing is coming up.']
                  : [
                      'Nothing scheduled.',
                      'There’s nothing scheduled.',
                      'I found nothing scheduled.'
                    ]
              )
          break
        }
        const includeDate =
          new Set(occurrences.map((item) => item.originalDate)).size > 1 ||
          Date.parse(queryEnd) - Date.parse(queryStart) > 26 * 60 * 60 * 1_000
        const eventItems = occurrences.map((item) =>
          eventAnswerFact(item, preferences.locale, {
            includeDate,
            includeDescription: asksForDetails
          })
        )
        const reminderItems = reminders.map(
          (reminder) =>
            `${formatDateTime(reminder.dueAtUtc, preferences.locale, reminder.timezone, includeDate)} — reminder: “${reminder.title}”${
              asksForDetails && reminder.notes.trim() ? ` — ${clippedDetail(reminder.notes)}` : ''
            }`
        )
        const items = [...eventItems, ...reminderItems].slice(0, 8)
        const totalItems = occurrences.length + reminders.length
        const daySpan =
          occurrences.length > 1 && !includeDate
            ? ` Your scheduled day runs from ${formatTime(occurrences[0]?.startUtc ?? queryStart, preferences.locale, preferences.timezone)} to ${formatTime(occurrences.at(-1)?.endUtc ?? queryEnd, preferences.locale, preferences.timezone)}.`
            : ''
        const summary =
          items.length === 0
            ? `nothing scheduled for ${formatDate(queryStart, preferences.locale, preferences.timezone)}`
            : `${totalItems} item${totalItems === 1 ? '' : 's'}: ${items.join('; ')}${
                totalItems > items.length ? `; plus ${totalItems - items.length} more` : ''
              }.${daySpan}`
        text = this.groundedReply(
          conversationId,
          id,
          nextOnly ? 'next-item-answer' : 'schedule-summary',
          [{ key: 'SUMMARY', kind: 'text', value: summary }],
          [
            'Here’s the shape of it: <SUMMARY>.',
            'Your local calendar shows <SUMMARY>.',
            'I checked the schedule and found <SUMMARY>.'
          ]
        )
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
        if (!expandedAnswer) {
          text = compactNameAnswer(
            [...events.map((event) => event.title), ...reminders.map((reminder) => reminder.title)],
            preferences.locale,
            `No active match for “${query}”.`
          )
          break
        }
        const matches = [
          ...events.map((event) =>
            asksForLocation && !asksForDetails && !asksForTime
              ? `“${event.title}” — ${event.location.trim() || 'no location saved'}`
              : asksForTime && !asksForDetails && !asksForLocation
                ? `“${event.title}” — ${formatDateTime(event.startUtc, preferences.locale, event.timezone)}`
                : `“${event.title}” on ${formatDateTime(event.startUtc, preferences.locale, event.timezone)}${
                    event.location.trim() ? ` at ${event.location.trim()}` : ''
                  }${
                    (asksForDetails || asksForLocation) && event.description.trim()
                      ? ` — ${clippedDetail(event.description)}`
                      : ''
                  }`
          ),
          ...reminders.map((reminder) =>
            asksForLocation && !asksForDetails && !asksForTime
              ? `reminder “${reminder.title}” — reminders do not have locations`
              : `reminder “${reminder.title}” at ${formatDateTime(reminder.dueAtUtc, preferences.locale, reminder.timezone)}${
                  asksForDetails && reminder.notes.trim()
                    ? ` — ${clippedDetail(reminder.notes)}`
                    : ''
                }`
          )
        ]
        const summary = matches.length
          ? matches.slice(0, 6).join('; ')
          : `no active match for “${query}”`
        text = this.groundedReply(
          conversationId,
          id,
          'item-details-answer',
          [{ key: 'SUMMARY', kind: 'text', value: summary }],
          [
            'I found <SUMMARY>.',
            'The closest local result is <SUMMARY>.',
            'Your calendar has <SUMMARY>.'
          ]
        )
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
          'unsupported',
          [
            {
              key: 'DETAIL',
              kind: 'text',
              value: 'I could not answer that calendar question safely.'
            }
          ],
          ['<DETAIL>', 'I stopped at the safe boundary: <DETAIL>', 'For this one, <DETAIL>']
        )
    }

    this.recordQueryState(
      conversationId,
      command,
      queryStart,
      queryEnd,
      relatedEventIds,
      relatedReminderIds
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
