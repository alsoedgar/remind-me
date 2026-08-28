import type {
  AssistantDialogueState,
  AssistantQueryFrame,
  AssistantQueryFrameItem,
  AssistantRequestedField
} from '@remind-me/contracts'
import { normalizeAssistantText, typoPhraseSimilarity } from './input-normalizer'

export type ContextualIntent =
  'list' | 'summarize' | 'compare' | 'explain' | 'modify' | 'delete' | 'continue'

export type ContextualScope = 'one' | 'selected' | 'all'
export type ContextualItemCategory = 'event' | 'reminder' | 'class' | 'lab' | 'lecture'

export interface ContextualItemDescriptor {
  item: AssistantQueryFrameItem
  title: string
  categories: readonly ContextualItemCategory[]
}

export interface ContextualResolverInput {
  text: string
  state: AssistantDialogueState
  items: readonly ContextualItemDescriptor[]
}

export interface ResolvedContextualRequest {
  kind: 'resolved'
  frameId: string
  intent: ContextualIntent
  fields: AssistantRequestedField[]
  scope: ContextualScope
  selectedItems: AssistantQueryFrameItem[]
  resultCursor: number | null
}

export interface ContextualClarification {
  kind: 'clarification'
  frameId: string
  message: string
  options: string[]
}

export type ContextualResolution = ResolvedContextualRequest | ContextualClarification

function itemKey(item: AssistantQueryFrameItem): string {
  return `${item.kind}:${item.id}:${item.occurrenceStart ?? ''}`
}

function activeFrame(state: AssistantDialogueState, text: string): AssistantQueryFrame | null {
  const frames = state.queryFrames
  if (frames.length === 0) return null
  const activeIndex = frames.findIndex((frame) => frame.frameId === state.activeQueryFrameId)
  const resolvedActiveIndex = activeIndex >= 0 ? activeIndex : frames.length - 1
  if (
    /\b(?:earlier|previous|prior)\s+(?:list|results?|schedule|items?|answer)\b|\bgo back\b/iu.test(
      text
    )
  ) {
    return frames[Math.max(0, resolvedActiveIndex - 1)] ?? null
  }
  return frames[resolvedActiveIndex] ?? null
}

function requestedFields(text: string): AssistantRequestedField[] {
  const fields: AssistantRequestedField[] = []
  const add = (field: AssistantRequestedField): void => {
    if (!fields.includes(field)) fields.push(field)
  }
  if (/\b(?:where|locations?|rooms?|buildings?|places?)\b/iu.test(text)) add('location')
  if (/\b(?:how long|how much time|durations?|lengths?)\b/iu.test(text)) add('duration')
  if (/\b(?:end|ends|ending|finish|finishes)\s*(?:times?)?\b|\bend times?\b/iu.test(text)) {
    add('end')
  }
  if (/\b(?:start|starts|starting|begin|begins)\s*(?:times?)?\b|\bstart times?\b/iu.test(text)) {
    add('start')
  }
  if (
    /\b(?:recurrence|repeats?|repeating|recurs?|how often|which days|what days|which weekdays|what weekdays|days of (?:the )?week|happen every week)\b/iu.test(
      text
    )
  ) {
    add('recurrence')
  }
  if (
    /\b(?:notes?|instructions?|descriptions?|written down|prepare|bring|need for)\b/iu.test(text)
  ) {
    add('notes')
  }
  if (/\b(?:what|which)\s+(?:day|date)\b|\bdates?\b/iu.test(text)) add('date')
  const asksTime =
    /^(?:at\s+)?(?:what|which)\s+times?\??$/iu.test(text) ||
    /\b(?:what|which)\s+times?\b/iu.test(text) ||
    /\btimes\b/iu.test(text) ||
    /\b(?:their|these|those|the)\s+times?\b|\btimes?\s+(?:are|were|for|of)\b|\bwhen\s+(?:are|were|is|was|does|did)\b/iu.test(
      text
    )
  if (asksTime && !fields.includes('start') && !fields.includes('end')) add('time')
  if (
    /\b(?:details?|more about|tell me more|show me more|expand|explain|what(?:'s| is) .+ about)\b|^more(?: please)?[.!?]*$/iu.test(
      text
    )
  ) {
    add('details')
  }
  if (/\b(?:names?|called|which (?:ones?|items?|classes?|events?))\b/iu.test(text)) add('name')
  return fields
}

function requestedIntent(text: string): ContextualIntent {
  if (/\b(?:delete|remove|cancel|erase|drop|get rid of)\b/iu.test(text)) return 'delete'
  if (/\b(?:change|modify|move|reschedule|rename|update|edit|shift)\b/iu.test(text)) {
    return 'modify'
  }
  if (/\b(?:compare|difference|versus|vs\.?)\b/iu.test(text)) return 'compare'
  if (
    /^(?:continue|keep going|next page|show (?:me )?(?:the )?(?:next|more) (?:results?|items?)|(?:what|how) about (?:the )?(?:others?|rest|remaining)|(?:anything|what) else (?:from|in) (?:that|the) (?:list|results?))[.!?]*$/iu.test(
      text
    )
  ) {
    return 'continue'
  }
  if (/\b(?:explain|why|tell me more|more about|details?)\b/iu.test(text)) return 'explain'
  if (
    /\b(?:summari[sz]e|summary|recap|overview|short version|run[- ]?down|sum (?:it|that|all)|briefly walk)\b/iu.test(
      text
    )
  ) {
    return 'summarize'
  }
  return 'list'
}

const ordinalPattern = /\b(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|last|final)\b/giu

function ordinalIndex(token: string, length: number): number {
  if (/^(?:last|final)$/iu.test(token)) return length - 1
  return (
    {
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
    }[token.toLocaleLowerCase()] ?? -1
  )
}

function descriptorMap(
  descriptors: readonly ContextualItemDescriptor[]
): Map<string, ContextualItemDescriptor> {
  return new Map(descriptors.map((descriptor) => [itemKey(descriptor.item), descriptor]))
}

function titleSelection(
  text: string,
  ordered: readonly AssistantQueryFrameItem[],
  descriptors: ReadonlyMap<string, ContextualItemDescriptor>
): AssistantQueryFrameItem[] {
  const normalizedText = text.toLocaleLowerCase()
  const exact = ordered.filter((item) => {
    const title = descriptors.get(itemKey(item))?.title.trim().toLocaleLowerCase() ?? ''
    const baseTitle = title.replace(/\s+\d+$/u, '').trim()
    return (
      (title.length >= 2 && normalizedText.includes(title)) ||
      (baseTitle.length >= 3 && baseTitle !== title && normalizedText.includes(baseTitle))
    )
  })
  if (exact.length > 0) return exact

  const candidate = text
    .replace(
      /\b(?:what|which|when|where|time|times|date|day|location|room|building|duration|notes?|details?|is|are|was|were|does|do|did|the|my|for|of|about|please|tell|show|me|more)\b/giu,
      ' '
    )
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  if (candidate.length < 3) return []
  const scored = ordered.flatMap((item) => {
    const title = descriptors.get(itemKey(item))?.title ?? ''
    const score = typoPhraseSimilarity(candidate, title)
    return score >= 0.78 ? [{ item, score }] : []
  })
  const best = Math.max(0, ...scored.map((entry) => entry.score))
  return scored.filter((entry) => entry.score >= best - 0.02).map((entry) => entry.item)
}

function hasNewTemporalAnchor(text: string): boolean {
  return /\b(?:today|tomorrow|yesterday|tonight|this|next|last)\s+(?:morning|afternoon|evening|night|week|weekend|month|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|\b(?:today|tomorrow|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/iu.test(
    text
  )
}

function contextualSignal(
  text: string,
  fields: readonly AssistantRequestedField[],
  intent: ContextualIntent,
  titleMatches: readonly AssistantQueryFrameItem[]
): boolean {
  if (titleMatches.length > 0) return true
  if (
    /\b(?:it|that|this|they|them|these|those|both|all|every|each|ones?|results?|whole set|just found)\b/iu.test(
      text
    )
  ) {
    return true
  }
  if (
    /\b(?:first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|last|final)\b/iu.test(text) &&
    !hasNewTemporalAnchor(text)
  ) {
    return true
  }
  if (/^(?:at\s+)?(?:what|which)\s+times?\??$/iu.test(text)) return true
  if (
    /^(?:locations?|rooms?|dates?|notes?|durations?|recurrence|repeat pattern|times?)[.!?]*$/iu.test(
      text
    )
  ) {
    return true
  }
  if (/^(?:where|when|how long|details?|more|tell me more|what days)\b/iu.test(text)) return true
  if (
    /^(?:continue|keep going|next page|show (?:me )?(?:the )?(?:next|more) (?:results?|items?)|(?:what|how) about (?:the )?(?:others?|rest|remaining)|(?:anything|what) else (?:from|in) (?:that|the) (?:list|results?))/iu.test(
      text
    )
  ) {
    return true
  }
  if (
    intent !== 'list' &&
    /\b(?:schedule|items?|events?|classes?|courses?|labs?|lectures?|reminders?|results?)\b/iu.test(
      text
    )
  ) {
    return true
  }
  if (/\b(?:numbers?|items?)\s+(?:one|two|three|four|five|\d)\b/iu.test(text)) return true
  if (
    intent === 'summarize' &&
    /\b(?:summary|summari[sz]e|recap|short version|sum|briefly|my day)\b/iu.test(text)
  ) {
    return true
  }
  if (
    fields.length > 0 &&
    !hasNewTemporalAnchor(text) &&
    /^(?:and\b|what\b|which\b|show\b|tell\b|anything\b|give\b)/iu.test(text)
  ) {
    return true
  }
  return fields.length > 0 && /\b(?:their|these|those|all|each)\b/iu.test(text)
}

function categorySelection(
  text: string,
  ordered: readonly AssistantQueryFrameItem[],
  descriptors: ReadonlyMap<string, ContextualItemDescriptor>
): AssistantQueryFrameItem[] | null {
  let category: ContextualItemCategory | null = null
  if (/\b(?:reminders?|tasks?)\b/iu.test(text)) category = 'reminder'
  else if (/\b(?:labs?|laborator(?:y|ies)|practicums?)\b/iu.test(text)) category = 'lab'
  else if (/\b(?:lectures?)\b/iu.test(text)) category = 'lecture'
  else if (
    /\b(?:classes?|courses?|discussions?|seminars?|recitations?|tutorials?)\b/iu.test(text)
  ) {
    category = 'class'
  } else if (/\b(?:events?|meetings?|appointments?)\b/iu.test(text)) category = 'event'
  if (!category) return null
  return ordered.filter((item) => descriptors.get(itemKey(item))?.categories.includes(category))
}

/**
 * Resolves short follow-ups against immutable, ordered query results. It never
 * invents calendar facts and returns null when a message should take a fresh route.
 */
export function resolveContextualRequest(
  input: ContextualResolverInput
): ContextualResolution | null {
  const text = normalizeAssistantText(input.text)
    .replace(/^wht\b/iu, 'what')
    .replace(/^wat\b/iu, 'what')
    .replace(/^were\s+r\b/iu, 'where are')
    .replace(/\bthere times\b/iu, 'their times')
    .replace(/\blocatons\b/iu, 'locations')
    .replace(/\bsumarize\b/iu, 'summarize')
    .replace(/\bem\b/iu, 'them')
  // Existing deterministic mutation parsing owns time-of-day and location subsets.
  // They require richer live facts than the portable frame contract carries.
  if (
    /\b(?:morning|afternoon|evening|night)\s+(?:ones?|items?|events?|classes?|reminders?)\b|\b(?:ones?|items?|events?|classes?)\s+(?:in|at)\s+.+/iu.test(
      text
    )
  ) {
    return null
  }
  const frame = activeFrame(input.state, text)
  if (!frame) return null
  const descriptors = descriptorMap(input.items)
  const fields = requestedFields(text)
  const intent = requestedIntent(text)
  const titleMatches = titleSelection(text, frame.orderedItems, descriptors)
  if (!contextualSignal(text, fields, intent, titleMatches)) return null

  const durationVerbLastIndex =
    fields.includes('duration') && /^(?:how long|how much time)\b/iu.test(text)
      ? text.search(/\blast[.!?]*$/iu)
      : -1
  const ordinalTokens = [...text.matchAll(ordinalPattern)]
    .filter((match) => match.index !== durationVerbLastIndex)
    .map((match) => match[1] ?? '')
  let indices = ordinalTokens.map((token) => ordinalIndex(token, frame.orderedItems.length))
  const numberWordIndex = (token: string): number =>
    ({
      one: 0,
      '1': 0,
      two: 1,
      '2': 1,
      three: 2,
      '3': 2,
      four: 3,
      '4': 3,
      five: 4,
      '5': 4
    })[token.toLocaleLowerCase()] ?? -1
  const numberedSelection =
    /\b(?:numbers?|items?)\s+((?:(?:one|two|three|four|five|[1-5])(?:\s*(?:,|and|&|n)\s*)?)+)\b/iu.exec(
      text
    )
  const numberedTokens = numberedSelection?.[1]?.match(/\b(?:one|two|three|four|five|[1-5])\b/giu)
  const singularNumber = /\bnumber\s+(one|two|three|four|five|[1-5])\b/iu.exec(text)?.[1]
  if (numberedTokens?.length) indices = numberedTokens.map(numberWordIndex)
  else if (singularNumber) indices = [numberWordIndex(singularNumber)]
  else if (/\b(?:the\s+)?first\s+two\b/iu.test(text)) indices = [0, 1]
  const hasOrdinal = indices.length > 0 && !hasNewTemporalAnchor(text)
  const asksNext = /\bnext\s+(?:one|item|event|class|reminder|result)\b/iu.test(text)
  const categoryItems = categorySelection(text, frame.orderedItems, descriptors)
  const singularPronoun = /\b(?:it|that one|this one)\b/iu.test(text)
  const pluralReference = /\b(?:they|them|these|those|both|all|each)\b/iu.test(text)
  const explicitAll =
    /\b(?:all|every one|everything)(?:\s+(?:of\s+)?(?:them|these|those|the results?|the items?))?\b/iu.test(
      text
    )
  const explicitOthers = /\b(?:others?|the rest|remaining ones?|remaining items?)\b/iu.test(text)

  let selected: AssistantQueryFrameItem[]
  let resultCursor: number | null = frame.resultCursor
  if (hasOrdinal) {
    if (indices.some((index) => index < 0 || index >= frame.orderedItems.length)) {
      return {
        kind: 'clarification',
        frameId: frame.frameId,
        message: `That list has ${frame.orderedItems.length} item${frame.orderedItems.length === 1 ? '' : 's'}, so that position is not available.`,
        options: frame.orderedItems.slice(0, 5).map((item, index) => {
          const title = descriptors.get(itemKey(item))?.title ?? 'Untitled item'
          return `${index + 1}. ${title}`
        })
      }
    }
    const uniqueIndices = [...new Set(indices)]
    selected = uniqueIndices.flatMap((index) => frame.orderedItems[index] ?? [])
    resultCursor = uniqueIndices.length === 1 ? (uniqueIndices[0] ?? null) : null
  } else if (asksNext) {
    const index = frame.resultCursor === null ? 0 : frame.resultCursor + 1
    const next = frame.orderedItems[index]
    if (!next) {
      return {
        kind: 'clarification',
        frameId: frame.frameId,
        message: 'There is not another item in that result list.',
        options: []
      }
    }
    selected = [next]
    resultCursor = index
  } else if (titleMatches.length > 0) {
    selected = titleMatches
    const index = frame.orderedItems.findIndex((item) => itemKey(item) === itemKey(selected[0]!))
    resultCursor = selected.length === 1 && index >= 0 ? index : null
  } else if (categoryItems !== null) {
    selected = categoryItems
    resultCursor = selected.length === 1 ? frame.orderedItems.indexOf(selected[0]!) : null
  } else if (intent === 'continue' && frame.continuationCursor !== null) {
    selected = frame.selectedItems.length > 0 ? [...frame.selectedItems] : [...frame.orderedItems]
  } else if (explicitOthers) {
    const priorKeys = new Set(frame.selectedItems.map(itemKey))
    selected = frame.orderedItems.filter((item) => !priorKeys.has(itemKey(item)))
    resultCursor = null
  } else if (intent === 'continue') {
    return {
      kind: 'clarification',
      frameId: frame.frameId,
      message: 'That result is already fully shown.',
      options: []
    }
  } else if (explicitAll) {
    selected = [...frame.orderedItems]
    resultCursor = null
  } else if (singularPronoun) {
    const priorSelection = frame.selectedItems.length > 0 ? frame.selectedItems : frame.orderedItems
    if (priorSelection.length !== 1) {
      return {
        kind: 'clarification',
        frameId: frame.frameId,
        message: 'Which item do you mean?',
        options: priorSelection.slice(0, 5).map((item, index) => {
          const title = descriptors.get(itemKey(item))?.title ?? 'Untitled item'
          return `${index + 1}. ${title}`
        })
      }
    }
    selected = [...priorSelection]
  } else if (pluralReference) {
    selected = frame.selectedItems.length > 0 ? [...frame.selectedItems] : [...frame.orderedItems]
  } else {
    selected = frame.selectedItems.length > 0 ? [...frame.selectedItems] : [...frame.orderedItems]
  }

  if (selected.length === 0) {
    return {
      kind: 'clarification',
      frameId: frame.frameId,
      message: explicitOthers
        ? 'There are no other items in that result.'
        : 'I could not find a matching item in those results.',
      options: []
    }
  }
  const scope: ContextualScope =
    selected.length === 1
      ? 'one'
      : selected.length === frame.orderedItems.length
        ? 'all'
        : 'selected'
  const resolvedFields: AssistantRequestedField[] =
    fields.length > 0
      ? fields
      : intent === 'explain'
        ? ['details']
        : intent === 'continue' && frame.requestedFields.length > 0
          ? [...frame.requestedFields]
          : ['name']
  return {
    kind: 'resolved',
    frameId: frame.frameId,
    intent,
    fields: resolvedFields,
    scope,
    selectedItems: selected,
    resultCursor
  }
}
