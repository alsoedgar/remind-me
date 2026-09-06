import { normalizeAssistantText, normalizeAssistantWhitespace } from './input-normalizer'
import { parseConversationIntent, type ConversationIntent } from './conversation-intent'
import { parseMemoryIntent, type MemoryIntent } from './memory-intent'

export type AssistantRequestRoute = 'conversation' | 'memory' | 'calendar' | 'broad-chat'

export type AssistantRequestRewriteKind =
  | 'structured-list'
  | 'colloquial-create'
  | 'colloquial-reminder'
  | 'colloquial-target-action'
  | 'colloquial-delete'
  | 'colloquial-move'
  | 'next-query'
  | 'calendar-reflection'

export interface AssistantRequestRewrite {
  kind: AssistantRequestRewriteKind
  before: string
  after: string
}

export interface AssistantRouteDecision {
  route: AssistantRequestRoute
  originalText: string
  normalizedText: string
  conversationIntent: ConversationIntent | null
  memoryIntent: MemoryIntent | null
  rewrites: AssistantRequestRewrite[]
  confidence: number
}

export interface AssistantRouteContext {
  knownTitles?: readonly string[]
}

function withListSeparators(value: string): string {
  return value
    .replace(/\r\n?/gu, '\n')
    .replace(/\n\s*(?=(?:[-*•]|\d{1,2}[.)])\s+)/gu, '; ')
    .replace(/(?:^|;\s*)(?:[-*•]|\d{1,2}[.)])\s+/gu, (match) => (match.startsWith(';') ? '; ' : ''))
}

function canonicalizeStructuredList(value: string): string {
  const match =
    /^(add|create|schedule|book)\s+(?:all\s+)?(?:these|the\s+following)(?:\s+(?:events?|items?|plans?))?\s*:\s*;?\s*(.+)$/iu.exec(
      value
    )
  if (!match?.[1] || !match[2]) return value
  const action = match[1]
  const items = match[2]
    .split(/\s*;\s*/u)
    .map((item) => item.trim())
    .filter(Boolean)
  if (items.length < 2 || items.length > 50) return value
  return items.map((item) => `${action} ${item}`).join('; ')
}

const politePrefix =
  "(?:(?:please\\s+)?(?:(?:can|could|would|will)\\s+you\\s+|i(?:'d| would)\\s+like\\s+(?:you\\s+)?to\\s+)?)"
const clauseBoundary = '(^|(?:;\\s*|\\b(?:and\\s+then|and\\s+also|then|also|plus|and)\\s+))'

function replaceClauseLead(value: string, phrase: string, replacement: string): string {
  return value.replace(
    new RegExp(`${clauseBoundary}(${politePrefix})${phrase}`, 'giu'),
    (_match, boundary: string, courtesy: string) => `${boundary}${courtesy}${replacement}`
  )
}

function canonicalizeColloquialCreate(value: string): string {
  let rewritten = value
  for (const phrase of [
    '(?:pencil|slot)\\s+(?:me\\s+)?in(?:\\s+for)?\\s+',
    'block\\s+off\\s+(?:(?:some|a)\\s+)?(?:time\\s+)?(?:for\\s+)?',
    'set\\s+aside\\s+(?:(?:some|a)\\s+)?time\\s+(?:for\\s+)?',
    'carve\\s+out\\s+(?:(?:some|a)\\s+)?time\\s+(?:for\\s+)?',
    'save\\s+(?:me\\s+)?(?:a\\s+)?spot\\s+for\\s+'
  ]) {
    rewritten = replaceClauseLead(rewritten, phrase, 'add ')
  }
  return rewritten
}

function canonicalizeColloquialReminder(value: string): string {
  let rewritten = value
  for (const phrase of [
    "(?:do\\s+not|don't)\\s+let\\s+me\\s+forget(?:\\s+(?:to|about))?\\s+",
    "(?:do\\s+not|don't)\\s+forget(?:\\s+(?:to|about))?\\s+",
    'i\\s+need\\s+to\\s+remember(?:\\s+(?:to|about))?\\s+',
    "(?:make\\s+sure|be\\s+sure)(?:\\s+that)?\\s+i\\s+(?:(?:do\\s+not|don't)\\s+forget|remember)(?:\\s+(?:to|about))?\\s+",
    'give\\s+me\\s+(?:a\\s+)?reminder(?:\\s+(?:to|for|about))?\\s+'
  ]) {
    rewritten = replaceClauseLead(rewritten, phrase, 'remind me to ')
  }
  return rewritten
}

function escapedTitleSource(value: string): string {
  return value
    .replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    .trim()
    .replace(/\s+/gu, '\\s+')
}

function canonicalizeKnownTargetActions(value: string, knownTitles: readonly string[]): string {
  let rewritten = value
  const titles = [...new Set(knownTitles.map((title) => title.trim()).filter(Boolean))].sort(
    (left, right) => right.length - left.length
  )
  for (const title of titles) {
    const target = escapedTitleSource(title)
    for (const phrase of [
      `take\\s+(?:(?:the|my)\\s+)?${target}\\s+off(?:\\s+(?:my|the)\\s+(?:calendar|schedule))?`,
      `drop\\s+(?:(?:the|my)\\s+)?${target}(?:\\s+from\\s+(?:my|the)\\s+(?:calendar|schedule))?`,
      `call\\s+off\\s+(?:(?:the|my)\\s+)?${target}`,
      `(?:scrap|ditch)\\s+(?:(?:the|my)\\s+)?${target}`
    ]) {
      rewritten = replaceClauseLead(rewritten, phrase, `delete ${title}`)
    }
    for (const phrase of [
      `(?:bump|postpone|push\\s+back|bring\\s+forward)\\s+(?:(?:the|my)\\s+)?${target}\\s+(?:to|until|for)\\s+`
    ]) {
      rewritten = replaceClauseLead(rewritten, phrase, `move ${title} to `)
    }
    for (const phrase of [
      `(?:cross|tick|check)\\s+(?:(?:the|my)\\s+)?${target}\\s+off\\b`,
      `(?:(?:the|my)\\s+)?${target}\\s+(?:is|is\\s+all)\\s+(?:done|finished|complete)\\b`
    ]) {
      rewritten = replaceClauseLead(rewritten, phrase, `complete ${title}`)
    }
    for (const phrase of [
      `make\\s+(?:another|a)\\s+copy\\s+of\\s+(?:(?:the|my)\\s+)?${target}\\s+(?:to|on|for)\\s+`,
      `copy\\s+(?:(?:the|my)\\s+)?${target}\\s+over\\s+(?:to|on|for)\\s+`
    ]) {
      rewritten = replaceClauseLead(rewritten, phrase, `duplicate ${title} to `)
    }
  }
  return rewritten
}

function containsGroundedTarget(value: string, knownTitles: readonly string[]): boolean {
  const normalized = value.toLocaleLowerCase()
  return (
    /\b(?:appointment|calendar|class|course|event|meeting|plan|reminder|schedule|task)\b/iu.test(
      value
    ) ||
    knownTitles.some(
      (title) => title.trim().length > 1 && normalized.includes(title.trim().toLocaleLowerCase())
    )
  )
}

function canonicalizeColloquialDelete(value: string, knownTitles: readonly string[]): string {
  if (!containsGroundedTarget(value, knownTitles)) return value
  return value.replace(new RegExp(`^(${politePrefix})get\\s+rid\\s+of\\s+`, 'iu'), '$1delete ')
}

const dateAnchor =
  '(?:today|tomorrow|tmr|tmrw|tmw|this\\s+(?:morning|afternoon|evening|weekend)|next\\s+(?:week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|monday|tuesday|wednesday|thursday|friday|saturday|sunday|(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\s+\\d{1,2}(?:,?\\s+\\d{4})?|\\d{1,4}[/-]\\d{1,2}(?:[/-]\\d{1,4})?)'

function canonicalizeColloquialMove(value: string, knownTitles: readonly string[]): string {
  if (!containsGroundedTarget(value, knownTitles)) return value
  const reordered = new RegExp(
    `^(${politePrefix})push\\s+(.+?)\\s+(${dateAnchor})\\s+to\\s+(.+?)[.!?]*$`,
    'iu'
  ).exec(value)
  if (reordered?.[1] !== undefined && reordered[2] && reordered[3] && reordered[4]) {
    return `${reordered[1]}move ${reordered[2]} to ${reordered[3]} at ${reordered[4]}`.trim()
  }
  const destination = new RegExp(
    `^(${politePrefix})push\\s+(.+?)\\s+to\\s+((?:${dateAnchor})(?:\\s+at\\s+.+)?|(?:at\\s+)?(?:\\d{1,2}(?::\\d{2})?\\s*(?:a\\.?m\\.?|p\\.?m\\.?)))$`,
    'iu'
  ).exec(value)
  return destination?.[1] !== undefined && destination[2] && destination[3]
    ? `${destination[1]}move ${destination[2]} to ${destination[3]}`.trim()
    : value
}

function canonicalizeNextQuery(value: string): string {
  if (
    /^(?:what(?:'s|s| is)|show(?:\s+me)?|tell(?:\s+me)?)\s+(?:me\s+)?(?:the\s+)?next\s+(?:event|meeting|appointment|plan|item|reminder)[.!?]*$/iu.test(
      value
    )
  ) {
    return 'what is next?'
  }
  return value
}

function canonicalizeCalendarReflection(value: string): string {
  const match =
    /^(?:what|which)\s+(?:should|do)\s+i\s+(?:focus|prioriti[sz]e|prepare)\s+(?:on\s+)?(.+?)(?:\s+based\s+on\s+(?:my|the)\s+(?:calendar|schedule|agenda))?[.!?]*$/iu.exec(
      value
    )
  if (!match?.[1]) return value
  const range = match[1]
    .replace(/\s+based\s+on\s+(?:my|the)\s+(?:calendar|schedule|agenda)$/iu, '')
    .trim()
  if (
    !/\b(?:today|tomorrow|this|next|week|weekend|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/iu.test(
      range
    )
  ) {
    return value
  }
  return `summarize ${range} with details`
}

function applyRewrite(
  value: string,
  kind: AssistantRequestRewriteKind,
  rewrite: (source: string) => string,
  rewrites: AssistantRequestRewrite[]
): string {
  const next = rewrite(value)
  if (next !== value) rewrites.push({ kind, before: value, after: next })
  return next
}

export function hasCalendarRequestSignal(value: string): boolean {
  return /\b(?:add|agenda|appointment|assignments?|availability|available|book|calendar|cancel|change|class|complete|conflict|copy|course|create|deadlines?|delete|duplicate|due|events?|exams?|finals?|find|homework|meeting|midterms?|modify|move|paper|plans?|projects?|quiz(?:zes)?|remind|reminders?|remove|rename|repeat|reschedule|schedule|search|shift|show|tasks?|tests?|today|tomorrow|tmr|tmrw|tmw|update|weekend|worksheet|monday|tuesday|wednesday|thursday|friday|saturday|sunday|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b|\b(?:pencil|slot)\s+(?:me\s+)?in\b|\b(?:block\s+off|set\s+aside|carve\s+out)\b|\b(?:do\s+not|don't)\s+(?:let\s+me\s+)?forget\b|\bi\s+need\s+to\s+remember\b|\b(?:am|will|would|could)\s+i\s+(?:be\s+)?(?:free|busy)\b|\bwhat (?:do|did) i have\b|\bwhat(?:'s|s| is) (?:on|coming up|next|tomorrow|tmr|tmrw|tmw|today|due)\b|^(?:when|where)\s+is\b|\b(?:at|around|before|after|from|between|until|by)\s+\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?\b|\b\d{1,4}[/-]\d{1,2}(?:[/-]\d{1,4})?\b/iu.test(
    value
  )
}

/**
 * Routes complete user turns before semantic planning. Rewrites are deliberately
 * narrow and recorded so a colloquial repair can never become invisible authority.
 */
export function routeAssistantRequest(
  text: string,
  context: AssistantRouteContext = {}
): AssistantRouteDecision {
  const originalText = normalizeAssistantWhitespace(text)
  const rawConversationIntent = parseConversationIntent(originalText)
  const memoryIntent = parseMemoryIntent(originalText)
  const rewrites: AssistantRequestRewrite[] = []
  let normalizedText = normalizeAssistantText(withListSeparators(text))
  normalizedText = applyRewrite(
    normalizedText,
    'structured-list',
    canonicalizeStructuredList,
    rewrites
  )
  normalizedText = applyRewrite(
    normalizedText,
    'colloquial-create',
    canonicalizeColloquialCreate,
    rewrites
  )
  normalizedText = applyRewrite(
    normalizedText,
    'colloquial-reminder',
    canonicalizeColloquialReminder,
    rewrites
  )
  normalizedText = applyRewrite(
    normalizedText,
    'colloquial-target-action',
    (value) => canonicalizeKnownTargetActions(value, context.knownTitles ?? []),
    rewrites
  )
  normalizedText = applyRewrite(
    normalizedText,
    'colloquial-delete',
    (value) => canonicalizeColloquialDelete(value, context.knownTitles ?? []),
    rewrites
  )
  normalizedText = applyRewrite(
    normalizedText,
    'colloquial-move',
    (value) => canonicalizeColloquialMove(value, context.knownTitles ?? []),
    rewrites
  )
  normalizedText = applyRewrite(normalizedText, 'next-query', canonicalizeNextQuery, rewrites)
  normalizedText = applyRewrite(
    normalizedText,
    'calendar-reflection',
    canonicalizeCalendarReflection,
    rewrites
  )
  const conversationIntent = rawConversationIntent ?? parseConversationIntent(normalizedText)
  const route: AssistantRequestRoute = memoryIntent
    ? 'memory'
    : conversationIntent
      ? 'conversation'
      : hasCalendarRequestSignal(normalizedText)
        ? 'calendar'
        : 'broad-chat'
  return {
    route,
    originalText,
    normalizedText,
    conversationIntent,
    memoryIntent,
    rewrites,
    confidence: route === 'broad-chat' ? 0.7 : rewrites.length > 0 ? 0.94 : 0.99
  }
}
