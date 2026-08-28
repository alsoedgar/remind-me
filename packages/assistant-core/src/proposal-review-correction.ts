import { normalizeAssistantText, typoPhraseSimilarity } from './input-normalizer'

const ordinalWords: Readonly<Record<string, number>> = {
  first: 0,
  second: 1,
  third: 2,
  fourth: 3,
  fifth: 4,
  sixth: 5,
  seventh: 6,
  eighth: 7,
  ninth: 8,
  tenth: 9
}

const ordinalTokenSource =
  '(?:first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|sixth|6th|seventh|7th|eighth|8th|ninth|9th|tenth|10th|last|final|#\\d{1,2}|item\\s+\\d{1,2}|\\d{1,2}(?:st|nd|rd|th))'
const ordinalSelectorSource = `(?:the\\s+)?${ordinalTokenSource}(?:\\s+(?:one|item|event|meeting|class|reminder|task))?`
const ordinalListSelectorSource = `${ordinalSelectorSource}(?:(?:\\s*,\\s*|\\s+(?:and|&)\\s+)${ordinalSelectorSource})*`
const reviewNounSource = '(?:review|proposal|preview|batch|list)'

export type ProposalReviewCorrection =
  | { kind: 'keep'; indexes: number[] }
  | { kind: 'remove'; indexes: number[] }
  | { kind: 'edit'; indexes: number[]; instruction: string; verb: string }
  | { kind: 'clarify'; message: string }

export type ProposalReviewSelection = { indexes: number[] } | { error: string } | null

function selectionError(count: number, requested: number): string {
  return `That position is outside this ${count}-item review (you asked for item ${requested + 1}). Nothing in the current review changed.`
}

function ordinalIndex(token: string, count: number): number | null {
  const normalized = token
    .toLocaleLowerCase()
    .replace(/^item\s+/u, '')
    .replace(/^#/u, '')
  if (normalized === 'last' || normalized === 'final') return count - 1
  if (ordinalWords[normalized] !== undefined) return ordinalWords[normalized] ?? null
  const numeric = /^(\d{1,2})(?:st|nd|rd|th)?$/u.exec(normalized)?.[1]
  return numeric ? Number.parseInt(numeric, 10) - 1 : null
}

function cleanSelector(value: string): string {
  return value
    .replace(/[.!?]+$/gu, '')
    .replace(
      new RegExp(
        `\\s+(?:from|in|of)\\s+(?:(?:that|the|this|my|current)\\s+)?${reviewNounSource}$`,
        'iu'
      ),
      ''
    )
    .trim()
}

function labelKey(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[“”"']/gu, '')
    .replace(/^(?:the\s+)?/u, '')
    .replace(/\s+(?:one|item|event|meeting|class|reminder|task)$/u, '')
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim()
}

function escapedLabel(value: string): string {
  return value
    .replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    .trim()
    .replace(/\s+/gu, '\\s+')
}

export function selectProposalReviewItems(
  selector: string,
  labels: readonly string[]
): ProposalReviewSelection {
  const cleaned = cleanSelector(selector)
  const count = labels.length
  if (!cleaned || count === 0) return null
  if (/^(?:it|that|this|that one|this one|the item|the event|the reminder)$/iu.test(cleaned)) {
    return count === 1
      ? { indexes: [0] }
      : {
          error: `There are ${count} items in this review. Choose one by name or position.`
        }
  }
  if (/^(?:all|all of them|every item|everything)$/iu.test(cleaned)) {
    return { indexes: labels.map((_label, index) => index) }
  }
  if (/^(?:both|both of them)$/iu.test(cleaned)) {
    return count === 2
      ? { indexes: [0, 1] }
      : { error: `“Both” is ambiguous because this review has ${count} items.` }
  }

  const matches = [
    ...cleaned.matchAll(
      /(?:#\d{1,2}|\b(?:first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|sixth|6th|seventh|7th|eighth|8th|ninth|9th|tenth|10th|last|final|item\s+\d{1,2}|\d{1,2}(?:st|nd|rd|th))\b)/giu
    )
  ]
  if (matches.length > 0) {
    const remainder = matches
      .reduceRight((value, match) => {
        const start = match.index ?? 0
        return `${value.slice(0, start)} ${value.slice(start + match[0].length)}`
      }, cleaned)
      .replace(
        /\b(?:the|one|ones|item|items|event|events|meeting|meetings|class|classes|reminder|reminders|task|tasks|and)\b/giu,
        ' '
      )
      .replace(/[,&+]/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim()
    if (!remainder) {
      const indexes: number[] = []
      for (const match of matches) {
        const index = ordinalIndex(match[0], count)
        if (index === null) return null
        if (index < 0 || index >= count) return { error: selectionError(count, index) }
        if (!indexes.includes(index)) indexes.push(index)
      }
      return indexes.length > 0 ? { indexes } : null
    }
  }

  const key = labelKey(cleaned)
  if (!key) return null
  const ranked = labels
    .map((label, index) => ({ index, score: typoPhraseSimilarity(key, labelKey(label)) }))
    .filter((candidate) => candidate.score >= 0.78)
    .sort((left, right) => right.score - left.score)
  const best = ranked[0]
  if (!best) return null
  const tied = ranked.filter((candidate) => best.score - candidate.score <= 0.04)
  if (tied.length > 1) {
    return {
      error: `More than one reviewed item matches “${cleaned}”. Choose it by position, such as “the second one.”`
    }
  }
  return { indexes: [best.index] }
}

function withoutPrelude(value: string): { text: string; corrective: boolean } {
  const normalized = normalizeAssistantText(value)
  const match =
    /^(?:(?:actually|wait|sorry|instead|correction|on second thought|one change)(?:\s*[,—:-]\s*|\s+))+/iu.exec(
      normalized
    )
  return {
    text: (match ? normalized.slice(match[0].length) : normalized).trim(),
    corrective: Boolean(match)
  }
}

function selectionOrClarification(
  selector: string,
  labels: readonly string[],
  explicitReviewLanguage: boolean
): Exclude<ProposalReviewSelection, null> | { ignored: true } {
  const selection = selectProposalReviewItems(selector, labels)
  if (selection) return selection
  return explicitReviewLanguage
    ? {
        error:
          'Which reviewed item do you mean? Use its name or position, such as “the second one.”'
      }
    : { ignored: true }
}

/**
 * Recognizes edits to the current, unsaved review. It deliberately requires review language,
 * a corrective prelude, or a position/name that is grounded in the visible proposal.
 */
export function parseProposalReviewCorrection(
  value: string,
  labels: readonly string[]
): ProposalReviewCorrection | null {
  if (labels.length === 0) return null
  const { text, corrective } = withoutPrelude(value)
  const explicitlyNamesReview = new RegExp(`\\b${reviewNounSource}\\b`, 'iu').test(text)

  const keepMatch = /^(?:please\s+)?(?:keep|use)\s+only\s+(.+?)[.!?]*$/iu.exec(text)
  if (keepMatch?.[1]) {
    const selection = selectionOrClarification(keepMatch[1], labels, true)
    if ('ignored' in selection) return null
    return 'error' in selection
      ? { kind: 'clarify', message: selection.error }
      : { kind: 'keep', indexes: selection.indexes }
  }

  const removeMatch = /^(?:please\s+)?(?:remove|drop|exclude|take\s+out)\s+(.+?)[.!?]*$/iu.exec(
    text
  )
  if (removeMatch?.[1]) {
    const selector = cleanSelector(removeMatch[1])
    const ordinalGrounded = new RegExp(
      `^(?:${ordinalListSelectorSource}|all(?:\\s+of\\s+them)?|both(?:\\s+of\\s+them)?)$`,
      'iu'
    ).test(selector)
    const selection = selectionOrClarification(
      removeMatch[1],
      labels,
      corrective || explicitlyNamesReview || ordinalGrounded
    )
    if ('ignored' in selection) return null
    return 'error' in selection
      ? { kind: 'clarify', message: selection.error }
      : { kind: 'remove', indexes: selection.indexes }
  }

  const verbSource = '(make|move|change|set|update|reschedule|rename)'
  const ordinalWithConnector = new RegExp(
    `^(?:please\\s+)?${verbSource}\\s+(${ordinalListSelectorSource})\\s+(?:to|for)\\s+(.+?)[.!?]*$`,
    'iu'
  ).exec(text)
  const ordinalWithoutConnector = new RegExp(
    `^(?:please\\s+)?(make|change|set|update)\\s+(${ordinalListSelectorSource})\\s+(.+?)[.!?]*$`,
    'iu'
  ).exec(text)
  const ordinalShould = new RegExp(
    `^(${ordinalListSelectorSource})\\s+(?:should|needs?\\s+to|is\\s+supposed\\s+to)\\s+(?:be\\s+)?(.+?)[.!?]*$`,
    'iu'
  ).exec(text)
  const singularWithoutConnector =
    labels.length === 1
      ? /^(?:please\s+)?(make|change|set|update)\s+(it|that|this|that one|this one|the item|the event|the reminder)\s+(.+?)[.!?]*$/iu.exec(
          text
        )
      : null
  if (ordinalWithConnector?.[1] && ordinalWithConnector[2] && ordinalWithConnector[3]) {
    const selection = selectProposalReviewItems(ordinalWithConnector[2], labels)
    if (!selection || 'error' in selection) {
      return {
        kind: 'clarify',
        message:
          selection && 'error' in selection
            ? selection.error
            : 'Which reviewed item should I change?'
      }
    }
    return {
      kind: 'edit',
      indexes: selection.indexes,
      instruction: ordinalWithConnector[3].trim(),
      verb: ordinalWithConnector[1].toLocaleLowerCase()
    }
  }
  if (ordinalWithoutConnector?.[1] && ordinalWithoutConnector[2] && ordinalWithoutConnector[3]) {
    const selection = selectProposalReviewItems(ordinalWithoutConnector[2], labels)
    if (!selection || 'error' in selection) {
      return {
        kind: 'clarify',
        message:
          selection && 'error' in selection
            ? selection.error
            : 'Which reviewed item should I change?'
      }
    }
    return {
      kind: 'edit',
      indexes: selection.indexes,
      instruction: ordinalWithoutConnector[3].trim(),
      verb: ordinalWithoutConnector[1].toLocaleLowerCase()
    }
  }
  if (ordinalShould?.[1] && ordinalShould[2]) {
    const selection = selectProposalReviewItems(ordinalShould[1], labels)
    if (!selection || 'error' in selection) {
      return {
        kind: 'clarify',
        message:
          selection && 'error' in selection
            ? selection.error
            : 'Which reviewed item should I change?'
      }
    }
    return {
      kind: 'edit',
      indexes: selection.indexes,
      instruction: ordinalShould[2].trim(),
      verb: 'change'
    }
  }
  if (singularWithoutConnector?.[1] && singularWithoutConnector[2] && singularWithoutConnector[3]) {
    return {
      kind: 'edit',
      indexes: [0],
      instruction: singularWithoutConnector[3].replace(/^(?:to|for)\s+/iu, '').trim(),
      verb: singularWithoutConnector[1].toLocaleLowerCase()
    }
  }

  const groundedNamedEdit = [...new Set(labels)]
    .sort((left, right) => right.length - left.length)
    .map((label) => {
      const match = new RegExp(
        `^(?:please\\s+)?(make|move|change|set|update|reschedule|rename)\\s+(?:the\\s+)?[“"']?${escapedLabel(label)}[”"']?\\s+(?:to|for)\\s+(.+?)[.!?]*$`,
        'iu'
      ).exec(text)
      return match?.[1] && match[2] ? { label, verb: match[1], instruction: match[2] } : null
    })
    .find((match): match is { label: string; verb: string; instruction: string } => Boolean(match))
  if (groundedNamedEdit) {
    const selection = selectProposalReviewItems(groundedNamedEdit.label, labels)
    if (!selection || 'error' in selection) {
      return {
        kind: 'clarify',
        message:
          selection && 'error' in selection
            ? selection.error
            : 'Which reviewed item should I change?'
      }
    }
    return {
      kind: 'edit',
      indexes: selection.indexes,
      instruction: groundedNamedEdit.instruction.trim(),
      verb: groundedNamedEdit.verb.toLocaleLowerCase()
    }
  }

  const namedEdit =
    /^(?:please\s+)?(make|move|change|set|update|reschedule|rename)\s+(.+?)\s+(?:to|for)\s+(.+?)[.!?]*$/iu.exec(
      text
    )
  if (namedEdit?.[1] && namedEdit[2] && namedEdit[3]) {
    const selection = selectProposalReviewItems(namedEdit[2], labels)
    if (!selection) {
      return corrective || explicitlyNamesReview
        ? {
            kind: 'clarify',
            message:
              'Which reviewed item should I change? Use its name or visible position. The current review is untouched.'
          }
        : null
    }
    if ('error' in selection) return { kind: 'clarify', message: selection.error }
    return {
      kind: 'edit',
      indexes: selection.indexes,
      instruction: namedEdit[3].trim(),
      verb: namedEdit[1].toLocaleLowerCase()
    }
  }

  return null
}
