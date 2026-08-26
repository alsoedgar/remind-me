const politePrefix =
  "(?:please\\s+)?(?:(?:can|could|would|will)\\s+you\\s+|i(?:'d| would)\\s+like\\s+(?:you\\s+)?to\\s+)?"
const explicitAction = new RegExp(
  `^${politePrefix}(?:add|create|schedule|book|put|block|make|remind\\s+me|remember\\s+to|set\\s+(?:a\\s+)?reminder|move|reschedule|shift|rename|duplicate|copy|clone|delete|remove|cancel|mark|complete|finish|check\\s+off|change|modify|update)\\b`,
  'iu'
)

const datedClause =
  /\b(?:today|tomorrow|tmr|tmrw|tmw|monday|tuesday|wednesday|thursday|friday|saturday|sunday|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|\d{1,2}[/-]\d{1,2})\b/iu
const timedClause = /\b(?:at|from|noon|midnight|\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?))\b/iu

type KnownTitleMention = {
  title: string
  start: number
  end: number
}

function isTitleBoundary(value: string | undefined): boolean {
  return value === undefined || !/[\p{L}\p{N}]/u.test(value)
}

function knownTitleMentions(text: string, knownTitles: readonly string[]): KnownTitleMention[] {
  const normalizedText = text.toLocaleLowerCase()
  const titles = [...new Set(knownTitles.map((title) => title.trim()).filter(Boolean))].sort(
    (left, right) => right.length - left.length
  )
  const mentions: KnownTitleMention[] = []

  for (const title of titles) {
    const normalizedTitle = title.toLocaleLowerCase()
    let cursor = 0
    while (cursor < normalizedText.length) {
      const start = normalizedText.indexOf(normalizedTitle, cursor)
      if (start < 0) break
      const end = start + normalizedTitle.length
      cursor = end
      if (
        !isTitleBoundary(text[start - 1]) ||
        !isTitleBoundary(text[end]) ||
        mentions.some((mention) => start < mention.end && end > mention.start)
      ) {
        continue
      }
      mentions.push({ title, start, end })
    }
  }

  return mentions.sort((left, right) => left.start - right.start)
}

function mutationVerb(
  value: string
): 'delete' | 'complete' | 'move' | 'duplicate' | 'rename' | 'change' | null {
  const normalized = value.toLocaleLowerCase().replace(/\s+/gu, ' ').trim()
  if (/^(?:delete|remove|cancel)$/u.test(normalized)) return 'delete'
  if (/^(?:mark|complete|finish|check off)$/u.test(normalized)) return 'complete'
  if (/^(?:move|reschedule|shift)$/u.test(normalized)) return 'move'
  if (/^(?:duplicate|copy|clone)$/u.test(normalized)) return 'duplicate'
  if (normalized === 'rename') return 'rename'
  if (/^(?:make|set|change|modify|update)$/u.test(normalized)) return 'change'
  return null
}

function validMutationTail(
  verb: Exclude<ReturnType<typeof mutationVerb>, null>,
  tail: string
): boolean {
  switch (verb) {
    case 'move':
      return /^\s+(?:to|for)\b/iu.test(tail)
    case 'duplicate':
      return /^\s+(?:to|on|for)\b/iu.test(tail)
    case 'rename':
      return /^\s+to\b/iu.test(tail)
    case 'change':
      return /^\s+(?:to\s+)?(?:repeat|recur)\b/iu.test(tail)
    default:
      return false
  }
}

/**
 * Expands exact, already-known targets into independently validated commands.
 * Matching known titles first keeps ordinary titles containing “and” intact and
 * prevents a loose list split from widening a destructive request.
 */
function splitKnownTargetMutation(text: string, knownTitles: readonly string[]): string[] {
  if (knownTitles.length < 2) return [text]
  const match = new RegExp(
    `^${politePrefix}(delete|remove|cancel|move|reschedule|shift|duplicate|copy|clone|mark|complete|finish|check\\s+off|rename|make|set|change|modify|update)\\s+(.+)$`,
    'iu'
  ).exec(text.trim().replace(/[.?!]+$/u, ''))
  const verb = match?.[1] ? mutationVerb(match[1]) : null
  const body = match?.[2]
  if (!verb || !body) return [text]

  const mentions = knownTitleMentions(body, knownTitles)
  if (mentions.length < 2 || mentions.length > 50) return [text]

  if (verb === 'delete') {
    const series = /\b(?:(?:the\s+)?(?:whole|entire)\s+series|all\s+occurrences)\b/iu.test(body)
      ? ' the entire series'
      : ''
    return mentions.map((mention) => `Delete ${mention.title}${series}`)
  }
  if (verb === 'complete') {
    return mentions.map((mention) => `Complete ${mention.title}`)
  }

  const clauses = body
    .split(/\s*,\s*(?:and\s+)?|\s+(?:and|plus)\s+/iu)
    .map((clause) => clause.trim())
    .filter(Boolean)
  const perTarget = mentions.map((mention) => {
    const clause = clauses.find((candidate) =>
      knownTitleMentions(candidate, [mention.title]).some(
        (candidateMention) => candidateMention.title === mention.title
      )
    )
    if (!clause) return null
    const clauseMention = knownTitleMentions(clause, [mention.title])[0]
    if (!clauseMention) return null
    const tail = clause.slice(clauseMention.end)
    return validMutationTail(verb, tail) ? `${match[1]} ${mention.title}${tail}` : null
  })
  if (perTarget.every((part): part is string => Boolean(part))) return perTarget

  const lastMention = mentions.at(-1)
  if (!lastMention) return [text]
  const sharedTail = body.slice(lastMention.end)
  if (!validMutationTail(verb, sharedTail)) return [text]
  return mentions.map((mention) => `${match[1]} ${mention.title}${sharedTail}`)
}

function inheritedPrefix(first: string): string | null {
  const event = new RegExp(
    `^${politePrefix}(add|create|schedule|book|put|block|make)\\s+`,
    'iu'
  ).exec(first)
  if (event?.[1]) return `${event[1]} `
  if (/^(?:please\s+)?(?:remind\s+me|remember\s+to|set\s+(?:a\s+)?reminder)\b/iu.test(first)) {
    return 'Remind me to '
  }
  return null
}

function inheritedDate(first: string): string | null {
  return datedClause.exec(first)?.[0] ?? null
}

function splitCoordinatedTimedList(text: string): string[] {
  let parts = text
    .split(/\s*,\s*(?:and\s+)?/iu)
    .map((part) => part.trim())
    .filter(Boolean)
  if (parts.length === 1) {
    parts = text
      .split(/\s+(?:and|plus)\s+(?=.{1,160}\b(?:at|from|between)\s+(?:\d{1,2}|noon|midnight))/iu)
      .map((part) => part.trim())
      .filter(Boolean)
  }
  if (parts.length < 2 || parts.length > 8) return [text]
  const first = parts[0] ?? ''
  const prefix = inheritedPrefix(first)
  const sharedDate = inheritedDate(first)
  if (!prefix || !sharedDate || !timedClause.test(first)) return [text]
  if (!parts.slice(1).every((part) => timedClause.test(part))) return [text]
  return parts.map((part, index) => {
    const withAction = index === 0 || explicitAction.test(part) ? part : `${prefix}${part}`
    return index === 0 || datedClause.test(part) ? withAction : `${withAction} ${sharedDate}`
  })
}

function splitImplicitCommaList(text: string): string[] {
  const parts = text
    .split(/\s*,\s*(?:and\s+)?/iu)
    .map((part) => part.trim())
    .filter(Boolean)
  if (parts.length < 2 || parts.length > 8) return [text]
  const prefix = inheritedPrefix(parts[0] ?? '')
  if (!prefix) return [text]
  if (!parts.every((part) => datedClause.test(part) && timedClause.test(part))) return [text]
  return parts.map((part, index) =>
    index === 0 || explicitAction.test(part) ? part : `${prefix}${part}`
  )
}

export function splitCalendarRequests(text: string, knownTitles: readonly string[] = []): string[] {
  const normalized = text
    .trim()
    .replace(/(?:^|\n)\s*(?:[-*•]|\d{1,2}[.)])\s+/gu, (match) =>
      match.startsWith('\n') ? '\n' : ''
    )
  let parts = normalized
    .split(/\s*(?:\n+|;+)\s*/u)
    .flatMap((part) =>
      part.split(
        /\s+(?:(?:and\s+)?then|also|and)\s+(?=(?:please\s+)?(?:add|create|schedule|book|put|block|make|remind|remember|set|move|reschedule|shift|rename|duplicate|copy|clone|delete|remove|cancel|mark|complete|finish|check|change|modify|update)\b)/iu
      )
    )
    .map((part) => part.trim().replace(/[.?!]+$/u, ''))
    .filter(Boolean)

  if (parts.length === 1 && parts[0]) {
    parts = splitImplicitCommaList(parts[0])
    if (parts.length === 1 && parts[0]) parts = splitCoordinatedTimedList(parts[0])
    if (parts.length === 1 && parts[0]) parts = splitKnownTargetMutation(parts[0], knownTitles)
  }
  if (parts.length < 2 || parts.length > 50) return [text.trim()]

  const prefix = inheritedPrefix(parts[0] ?? '')
  if (prefix) {
    parts = parts.map((part, index) =>
      index === 0 || explicitAction.test(part) ? part : `${prefix}${part}`
    )
  }
  return parts
}
