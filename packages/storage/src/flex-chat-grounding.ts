import {
  flexModelChatResponseSchema,
  type FlexModelCalendarFactField,
  type FlexModelCalendarFactPacket,
  type FlexModelChatResponse
} from '@remind-me/contracts'

export type FlexChatGroundingFailure = 'fact-rejected' | 'write-claim-rejected'

export interface GroundedFlexChatResponse {
  kind: FlexModelChatResponse['kind']
  text: string
  relatedEventIds: string[]
  relatedReminderIds: string[]
}

export type FlexChatGroundingResult =
  { ok: true; response: GroundedFlexChatResponse } | { ok: false; reason: FlexChatGroundingFailure }

const placeholderPattern = /\{\{(F(?:[1-9]|1[0-9]|2[0-4]))\.([a-z]+)\}\}/gu

const emptyFactPacket: FlexModelCalendarFactPacket = {
  schemaVersion: 1,
  range: null,
  facts: [],
  truncated: false
}

function normalizedComparable(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[‘’]/gu, "'")
    .replace(/\s+/gu, ' ')
    .trim()
    .toLocaleLowerCase()
}

function claimsCalendarWrite(value: string): boolean {
  const normalized = value.normalize('NFKC').replace(/[‘’]/gu, "'").trim()
  return (
    /\b(?:i|we)(?:'ve| have)?\s+(?:just\s+)?(?:added|booked|cancelled|canceled|changed|completed|copied|created|deleted|duplicated|marked|moved|removed|renamed|rescheduled|saved|scheduled|set|shifted|updated)\b/iu.test(
      normalized
    ) ||
    /^(?:done|all set|taken care of)[.!—, ]/iu.test(normalized) ||
    /\b(?:i|we)\s+(?:took care of|handled)\s+(?:it|that|those|them)\b/iu.test(normalized) ||
    /\b(?:your|the|that|this)\s+(?:event|meeting|appointment|reminder|calendar item)\b.{0,48}\b(?:has been|was|is now)\s+(?:added|booked|cancelled|canceled|changed|completed|created|deleted|moved|removed|renamed|rescheduled|saved|scheduled|set|updated)\b/iu.test(
      normalized
    )
  )
}

function requestRequiresCalendarFacts(sourceText: string): boolean {
  const normalized = sourceText.normalize('NFKC').trim()
  if (
    /\b(?:what can you do|how can you help|capabilit(?:y|ies)|why|advice|recommend|suggest)\b/iu.test(
      normalized
    )
  ) {
    return false
  }
  return /\b(?:what|when|where|which|first|last|next|time|room|location|date|duration|notes?|details?|today|tomorrow|yesterday|calendar|schedule|agenda|class|course|event|meeting|appointment|reminder|free|busy)\b/iu.test(
    normalized
  )
}

function factualValues(packet: FlexModelCalendarFactPacket): string[] {
  const values = new Set<string>()
  for (const fact of packet.facts) {
    for (const value of Object.values(fact.fields)) {
      if (typeof value !== 'string') continue
      const normalized = normalizedComparable(value)
      if (normalized.length >= 4) values.add(normalized)
    }
  }
  return [...values].sort((left, right) => right.length - left.length)
}

function containsUnverifiedCalendarLiteral(value: string): boolean {
  const normalized = value.normalize('NFKC').replace(/[‘’]/gu, "'").trim()
  return (
    /\d/gu.test(normalized) ||
    /\b(?:a\.?m\.?|p\.?m\.?|noon|midnight|today|tomorrow|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december)\b/iu.test(
      normalized
    ) ||
    /\b(?:cancelled|canceled|completed|overdue|pending|scheduled|rescheduled|daily|weekly|monthly|yearly|every weekday)\b/iu.test(
      normalized
    ) ||
    /\b(?:overlaps?|conflicts?|before|after|earlier|later|same time|minutes?|hours?)\b/iu.test(
      normalized
    ) ||
    /\b(?:at|in|inside)\s+(?:room|building|hall|library|office|campus|home|[A-Z][\p{L}'-]+(?:\s+[A-Z][\p{L}'-]+)*)\b/u.test(
      normalized
    ) ||
    /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:events?|classes?|courses?|meetings?|appointments?|reminders?|items?)\b/iu.test(
      normalized
    )
  )
}

function requestedFieldGroups(sourceText: string): FlexModelCalendarFactField[][] {
  const groups: FlexModelCalendarFactField[][] = []
  if (/\b(?:time|times|start|when)\b/iu.test(sourceText)) groups.push(['time', 'start'])
  if (/\b(?:end|finish)\b/iu.test(sourceText)) groups.push(['end'])
  if (/\b(?:where|room|location|locations|rooms)\b/iu.test(sourceText)) groups.push(['location'])
  if (/\b(?:date|day)\b/iu.test(sourceText)) groups.push(['date'])
  if (/\b(?:duration|how long)\b/iu.test(sourceText)) groups.push(['duration'])
  if (/\b(?:notes?|instructions?)\b/iu.test(sourceText)) groups.push(['notes'])
  if (/\b(?:details?|summari[sz]e|summary|recap)\b/iu.test(sourceText)) groups.push(['details'])
  if (/\b(?:repeat|recurrence|how often|which days)\b/iu.test(sourceText))
    groups.push(['recurrence'])
  return groups
}

function preservesFactAssociations(text: string, sourceText: string): boolean {
  const fieldsByRef = new Map<string, Set<FlexModelCalendarFactField>>()
  for (const match of text.matchAll(/\{\{(F(?:[1-9]|1[0-9]|2[0-4]))\.([a-z]+)\}\}/gu)) {
    const ref = match[1]
    const field = match[2] as FlexModelCalendarFactField
    if (!ref) continue
    const fields = fieldsByRef.get(ref) ?? new Set<FlexModelCalendarFactField>()
    fields.add(field)
    fieldsByRef.set(ref, fields)
  }
  const titleRefs = new Set(
    [...fieldsByRef].filter(([, fields]) => fields.has('title')).map(([ref]) => ref)
  )
  for (const group of requestedFieldGroups(sourceText)) {
    const valueRefs = new Set(
      [...fieldsByRef]
        .filter(([, fields]) => group.some((field) => fields.has(field)))
        .map(([ref]) => ref)
    )
    if (valueRefs.size === 0) return false
    if (titleRefs.size === 0) continue
    if ([...valueRefs].some((ref) => !titleRefs.has(ref))) return false
    if ([...titleRefs].some((ref) => !valueRefs.has(ref))) return false
  }
  return true
}

export function groundFlexChatResponse(
  input: unknown,
  packet: FlexModelCalendarFactPacket,
  sourceText: string
): FlexChatGroundingResult {
  const parsed = flexModelChatResponseSchema.safeParse(input)
  if (!parsed.success) return { ok: false, reason: 'fact-rejected' }
  const response = parsed.data
  if (response.writeClaim || claimsCalendarWrite(response.text)) {
    return { ok: false, reason: 'write-claim-rejected' }
  }

  const packetByRef = new Map(packet.facts.map((fact) => [fact.ref, fact]))
  const declared = new Map<string, Set<FlexModelCalendarFactField>>()
  for (const reference of response.factRefs) {
    const fact = packetByRef.get(reference.ref)
    if (!fact || fact.factId !== reference.factId || declared.has(reference.ref)) {
      return { ok: false, reason: 'fact-rejected' }
    }
    const fields = new Set(reference.fields)
    for (const field of fields) {
      if (fact.fields[field] === null || fact.fields[field] === undefined) {
        return { ok: false, reason: 'fact-rejected' }
      }
    }
    declared.set(reference.ref, fields)
  }

  const used = new Set<string>()
  let invalidPlaceholder = false
  const rendered = response.text.replace(
    placeholderPattern,
    (_placeholder, ref: string, fieldValue: string) => {
      const field = fieldValue as FlexModelCalendarFactField
      const fact = packetByRef.get(ref)
      const declaredFields = declared.get(ref)
      const value = fact?.fields[field]
      if (!fact || !declaredFields?.has(field) || typeof value !== 'string') {
        invalidPlaceholder = true
        return ''
      }
      used.add(`${ref}.${field}`)
      return value
    }
  )
  if (invalidPlaceholder || /\{\{|\}\}/u.test(rendered)) {
    return { ok: false, reason: 'fact-rejected' }
  }

  for (const [ref, fields] of declared) {
    for (const field of fields) {
      if (!used.has(`${ref}.${field}`)) return { ok: false, reason: 'fact-rejected' }
    }
  }

  const proseOnly = normalizedComparable(response.text.replace(placeholderPattern, ' '))
  if (factualValues(packet).some((value) => proseOnly.includes(value))) {
    return { ok: false, reason: 'fact-rejected' }
  }
  if (
    response.kind === 'answer' &&
    response.factRefs.length > 0 &&
    containsUnverifiedCalendarLiteral(response.text.replace(placeholderPattern, ' '))
  ) {
    return { ok: false, reason: 'fact-rejected' }
  }
  if (
    response.kind === 'answer' &&
    response.factRefs.length > 0 &&
    !preservesFactAssociations(response.text, sourceText)
  ) {
    return { ok: false, reason: 'fact-rejected' }
  }
  if (
    response.kind === 'answer' &&
    packet.facts.length > 0 &&
    response.factRefs.length === 0 &&
    requestRequiresCalendarFacts(sourceText)
  ) {
    return { ok: false, reason: 'fact-rejected' }
  }
  if (claimsCalendarWrite(rendered)) {
    return { ok: false, reason: 'write-claim-rejected' }
  }

  const relatedEventIds = new Set<string>()
  const relatedReminderIds = new Set<string>()
  for (const reference of response.factRefs) {
    const fact = packetByRef.get(reference.ref)
    if (!fact?.entityId) continue
    if (fact.kind === 'event') relatedEventIds.add(fact.entityId)
    if (fact.kind === 'reminder') relatedReminderIds.add(fact.entityId)
  }

  return {
    ok: true,
    response: {
      kind: response.kind,
      text: rendered.trim(),
      relatedEventIds: [...relatedEventIds],
      relatedReminderIds: [...relatedReminderIds]
    }
  }
}

/**
 * Return only a stable, non-writing prefix for progressive broad-chat display.
 * Two unfinished words stay hidden so a harmless-looking prefix cannot grow
 * into a false "I added/moved/deleted…" claim after it has reached the UI.
 * Calendar-factual replies use the complete envelope boundary instead.
 */
export function safeGeneralChatStreamPrefix(text: string, sourceText: string): string | null {
  const normalized = text.normalize('NFKC').trim()
  if (!normalized) return null
  const completeSentence = /[.!?]["')\]]?$/u.test(normalized)
  let stableText = normalized
  if (!completeSentence) {
    const words = [...normalized.matchAll(/\S+/gu)]
    if (words.length <= 2) return null
    const hiddenWord = words.at(-2)
    if (hiddenWord?.index === undefined) return null
    stableText = normalized.slice(0, hiddenWord.index).trimEnd()
  }
  if (!stableText) return null
  const grounded = groundFlexChatResponse(
    {
      kind: 'answer',
      text: stableText,
      factRefs: [],
      writeClaim: false
    },
    emptyFactPacket,
    sourceText
  )
  return grounded.ok ? grounded.response.text : null
}
