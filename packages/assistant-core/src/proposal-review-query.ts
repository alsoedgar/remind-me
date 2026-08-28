import { normalizeAssistantText, typoPhraseSimilarity } from './input-normalizer'
import {
  selectProposalReviewItems,
  type ProposalReviewSelection
} from './proposal-review-correction'

export type ProposalReviewAttribute =
  'details' | 'title' | 'kind' | 'action' | 'date' | 'time' | 'location' | 'notes' | 'recurrence'

export type ProposalReviewQuery =
  | { kind: 'overview'; mode: 'names' | 'actions' | 'details' }
  | { kind: 'count' }
  | { kind: 'detail'; indexes: number[]; attribute: ProposalReviewAttribute }
  | { kind: 'conflicts'; indexes: number[] | null }
  | { kind: 'clarify'; message: string }

const reviewNounPattern =
  /\b(?:(?:the|this|that|current|pending|your|my)\s+(?:review|proposal|preview|changes?)|changes?\s+to\s+approve)\b/iu
const mutationLeadPattern =
  /^(?:actually[, ]+)?(?:(?:can|could|would|will)\s+you\s+|please\s+)?(?:add|book|bump|cancel|change|clear|complete|copy|create|cross|delete|duplicate|edit|make|mark|move|push|remove|rename|reschedule|save|schedule|set|shift|update)\b/iu
const ordinalPattern =
  /(?:#\d{1,2}|\b(?:first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|sixth|6th|seventh|7th|eighth|8th|ninth|9th|tenth|10th|last|final|item\s+\d{1,2}|\d{1,2}(?:st|nd|rd|th))\b)/giu

function normalizedKey(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[“”"']/gu, '')
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim()
}

function selectionFromQuestion(text: string, labels: readonly string[]): ProposalReviewSelection {
  const ordinals = [...text.matchAll(ordinalPattern)].map((match) => match[0])
  if (ordinals.length > 0) {
    return selectProposalReviewItems(ordinals.join(' and '), labels)
  }
  const textKey = ` ${normalizedKey(text)} `
  const matchingLabels = [...new Set(labels)]
    .sort((left, right) => right.length - left.length)
    .filter((label) => {
      const key = normalizedKey(label)
      return key.length > 0 && textKey.includes(` ${key} `)
    })
  if (matchingLabels[0]) return selectProposalReviewItems(matchingLabels[0], labels)
  const words = normalizedKey(text).split(/\s+/u).filter(Boolean)
  const fuzzyLabels = [...new Set(labels)]
    .map((label) => {
      const key = normalizedKey(label)
      const size = key.split(/\s+/u).filter(Boolean).length
      let score = 0
      for (const windowSize of [size - 1, size, size + 1]) {
        if (windowSize < 1 || windowSize > words.length) continue
        for (let index = 0; index + windowSize <= words.length; index += 1) {
          score = Math.max(
            score,
            typoPhraseSimilarity(words.slice(index, index + windowSize).join(' '), key)
          )
        }
      }
      return { label, score }
    })
    .filter((candidate) => candidate.score >= 0.82)
    .sort((left, right) => right.score - left.score)
  const fuzzyBest = fuzzyLabels[0]
  if (
    fuzzyBest &&
    (fuzzyLabels[1] === undefined || fuzzyBest.score - fuzzyLabels[1].score > 0.04)
  ) {
    return selectProposalReviewItems(fuzzyBest.label, labels)
  }
  if (/\b(?:all|each|every|both|them|these|those|the items?|the changes?)\b/iu.test(text)) {
    return { indexes: labels.map((_label, index) => index) }
  }
  if (/\b(?:it|this one|that one|the item|the event|the reminder)\b/iu.test(text)) {
    return selectProposalReviewItems('it', labels)
  }
  return null
}

function requestedAttribute(text: string): ProposalReviewAttribute | null {
  if (/\b(?:where|location|room|building|place)\b/iu.test(text)) return 'location'
  if (/\b(?:repeat|recurrence|recurring|how often|which days?|what days?)\b/iu.test(text)) {
    return 'recurrence'
  }
  if (/\b(?:notes?|description|instructions?|about|bring|prepare)\b/iu.test(text)) return 'notes'
  if (/\b(?:what (?:type|kind)|event or reminder|reminder or event)\b/iu.test(text)) return 'kind'
  if (
    /\b(?:what (?:will|would) happen|what (?:are|were) you doing|which action|what action)\b/iu.test(
      text
    )
  ) {
    return 'action'
  }
  if (/\b(?:what(?:'s| is) (?:its |the )?name|what is it called|title|called)\b/iu.test(text)) {
    return 'title'
  }
  if (/\b(?:what|which) (?:date|day)\b|\bwhat day is\b/iu.test(text)) return 'date'
  if (/\b(?:when|what time|which time|start time|end time|how long|duration)\b/iu.test(text)) {
    return 'time'
  }
  if (/\b(?:details?|tell me more|explain|what is|what(?:'s| is) the)\b/iu.test(text)) {
    return 'details'
  }
  return null
}

/** Parses read-only questions about the current unsaved proposal. */
export function parseProposalReviewQuery(
  value: string,
  labels: readonly string[]
): ProposalReviewQuery | null {
  const text = normalizeAssistantText(value)
  if (mutationLeadPattern.test(text)) return null
  const explicitlyNamesReview = reviewNounPattern.test(text)

  if (
    /\b(?:conflict|overlap|double[- ]book|clash|collide)\b/iu.test(text) &&
    (explicitlyNamesReview ||
      /\b(?:this|that|these|those|it|them|one|ones|item|items|change|changes)\b/iu.test(text))
  ) {
    const selection = selectionFromQuestion(text, labels)
    if (selection && 'error' in selection) return { kind: 'clarify', message: selection.error }
    return { kind: 'conflicts', indexes: selection?.indexes ?? null }
  }

  if (
    /\bhow many\b/iu.test(text) &&
    (explicitlyNamesReview || /\b(?:items?|changes?|things?)\b/iu.test(text))
  ) {
    return { kind: 'count' }
  }

  const selection = selectionFromQuestion(text, labels)
  const attribute = requestedAttribute(text)
  const questionLead =
    /^(?:can you |could you |please )?(?:what|what's|when|where|which|how|does|do|has|have|is|are|will|would|tell|show|explain)\b/iu.test(
      text
    )
  if (attribute && questionLead && (selection || explicitlyNamesReview)) {
    if (selection && 'error' in selection) return { kind: 'clarify', message: selection.error }
    if (selection) return { kind: 'detail', indexes: selection.indexes, attribute }
    if (labels.length === 1) return { kind: 'detail', indexes: [0], attribute }
    if (/\b(?:all|each|every|items|changes|their|these|those|them)\b/iu.test(text)) {
      return { kind: 'detail', indexes: labels.map((_label, index) => index), attribute }
    }
    return {
      kind: 'clarify',
      message: `Which reviewed item do you mean? This review has ${labels.length} items.`
    }
  }

  if (
    explicitlyNamesReview ||
    /\bwhat (?:are|were) you (?:adding|changing|deleting|saving|doing)\b/iu.test(text) ||
    /\bwhat (?:will|would) (?:this|that) do\b/iu.test(text) ||
    /\b(?:show|list|summarize|summarise|review) (?:me )?(?:the )?(?:pending )?changes\b/iu.test(
      text
    ) ||
    /\bwhat did you understand\b/iu.test(text)
  ) {
    const mode =
      /\b(?:what (?:will|would).+do|what (?:are|were) you doing|summari[sz]e|details?|explain)\b/iu.test(
        text
      )
        ? 'actions'
        : /\b(?:with details|full review|everything)\b/iu.test(text)
          ? 'details'
          : 'names'
    return { kind: 'overview', mode }
  }

  return null
}
