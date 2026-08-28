const globalVocabulary = [
  'and',
  'today',
  'tomorrow',
  'yesterday',
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
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
  'next',
  'first',
  'second',
  'third',
  'fourth',
  'fifth',
  'last',
  'earliest',
  'latest',
  'class',
  'classes',
  'course',
  'courses',
  'lecture',
  'discussion',
  'room',
  'building',
  'calendar',
  'schedule',
  'scheduled',
  'agenda',
  'event',
  'events',
  'reminder',
  'reminders',
  'appointment',
  'appointments',
  'available',
  'availability',
  'conflict',
  'conflicts',
  'details',
  'evening',
  'morning',
  'afternoon',
  'night',
  'location',
  'past',
  'repeat',
  'upcoming',
  'weekly',
  'entire',
  'everything'
] as const

const leadingVocabulary = [
  'can',
  'could',
  'would',
  'add',
  'create',
  'schedule',
  'scheduled',
  'book',
  'remind',
  'remember',
  'move',
  'reschedule',
  'shift',
  'rename',
  'duplicate',
  'copy',
  'clone',
  'delete',
  'remove',
  'cancel',
  'mark',
  'complete',
  'finish',
  'change',
  'modify',
  'update',
  'clear',
  'reset',
  'wipe',
  'erase',
  'purge',
  'undo',
  'confirm',
  'yes',
  'what',
  'whats',
  'where',
  'when',
  'show',
  'list',
  'find',
  'search',
  'hello',
  'help',
  'you',
  'the',
  'have',
  'anything',
  'does',
  'through'
] as const

const actionWords = new Set([
  'add',
  'create',
  'schedule',
  'book',
  'remind',
  'remember',
  'move',
  'reschedule',
  'shift',
  'rename',
  'duplicate',
  'copy',
  'clone',
  'delete',
  'remove',
  'cancel',
  'mark',
  'complete',
  'finish',
  'change',
  'modify',
  'update',
  'clear',
  'reset',
  'wipe',
  'erase',
  'purge',
  'undo',
  'confirm'
])

const exactRepairs: Readonly<Record<string, string>> = {
  ad: 'add',
  adn: 'and',
  anythng: 'anything',
  calandar: 'calendar',
  calednaar: 'calendar',
  calednar: 'calendar',
  calender: 'calendar',
  calss: 'class',
  cancle: 'cancel',
  cna: 'can',
  chnage: 'change',
  cler: 'clear',
  craete: 'create',
  creat: 'create',
  claas: 'class',
  delte: 'delete',
  delet: 'delete',
  detials: 'details',
  dose: 'does',
  duplciate: 'duplicate',
  enxt: 'next',
  entier: 'entire',
  evnt: 'event',
  eveent: 'event',
  evrything: 'everything',
  firday: 'friday',
  fisrt: 'first',
  frist: 'first',
  helo: 'hello',
  hav: 'have',
  loaction: 'location',
  modfy: 'modify',
  modnay: 'monday',
  mvoe: 'move',
  nxt: 'next',
  remidner: 'reminder',
  remid: 'remind',
  remnder: 'reminder',
  remvoe: 'remove',
  romm: 'room',
  satruday: 'saturday',
  schedue: 'schedule',
  scheduel: 'schedule',
  secnd: 'second',
  shedule: 'schedule',
  shwo: 'show',
  sudnay: 'sunday',
  teh: 'the',
  thrusday: 'thursday',
  tmorow: 'tomorrow',
  tommorow: 'tomorrow',
  tomorow: 'tomorrow',
  udpate: 'update',
  thru: 'through',
  waht: 'what',
  wahts: 'whats',
  wednsday: 'wednesday',
  wensday: 'wednesday',
  wehn: 'when',
  wher: 'where',
  whts: 'whats',
  yess: 'yes',
  yuo: 'you'
}

const exactOnlyVocabulary = new Set(['class', 'classes'])

const compactPhraseRepairs: Readonly<Record<string, string>> = {
  add: 'add',
  am: 'am',
  appointment: 'appointment',
  availability: 'availability',
  calendar: 'calendar',
  cancel: 'cancel',
  complete: 'complete',
  confirm: 'confirm',
  create: 'create',
  delete: 'delete',
  duplicate: 'duplicate',
  everything: 'everything',
  move: 'move',
  no: 'no',
  remind: 'remind',
  reminder: 'reminder',
  remember: 'remember',
  rename: 'rename',
  remove: 'remove',
  reschedule: 'reschedule',
  saturday: 'saturday',
  schedule: 'schedule',
  september: 'september',
  thenext: 'the next',
  thursday: 'thursday',
  today: 'today',
  tomorrow: 'tomorrow',
  update: 'update',
  undo: 'undo',
  wednesday: 'wednesday',
  whats: 'whats',
  yes: 'yes',
  yesterday: 'yesterday',
  pm: 'pm'
}

export function normalizeAssistantWhitespace(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[‘’]/gu, "'")
    .trim()
    .replace(/\s+/gu, ' ')
    .replace(/\s+([,.;!?])/gu, '$1')
}

function damerauLevenshtein(left: string, right: string): number {
  const rows = left.length + 1
  const columns = right.length + 1
  const matrix = Array.from({ length: rows }, () => Array<number>(columns).fill(0))
  for (let row = 0; row < rows; row += 1) matrix[row]![0] = row
  for (let column = 0; column < columns; column += 1) matrix[0]![column] = column

  for (let row = 1; row < rows; row += 1) {
    for (let column = 1; column < columns; column += 1) {
      const substitution = left[row - 1] === right[column - 1] ? 0 : 1
      matrix[row]![column] = Math.min(
        matrix[row - 1]![column]! + 1,
        matrix[row]![column - 1]! + 1,
        matrix[row - 1]![column - 1]! + substitution
      )
      if (
        row > 1 &&
        column > 1 &&
        left[row - 1] === right[column - 2] &&
        left[row - 2] === right[column - 1]
      ) {
        matrix[row]![column] = Math.min(
          matrix[row]![column]!,
          matrix[row - 2]![column - 2]! + substitution
        )
      }
    }
  }
  return matrix[left.length]![right.length]!
}

export function typoTokenSimilarity(left: string, right: string): number {
  const normalizedLeft = left.normalize('NFKC').toLocaleLowerCase()
  const normalizedRight = right.normalize('NFKC').toLocaleLowerCase()
  if (!normalizedLeft || !normalizedRight) return 0
  if (normalizedLeft === normalizedRight) return 1
  const longest = Math.max(normalizedLeft.length, normalizedRight.length)
  const distance = damerauLevenshtein(normalizedLeft, normalizedRight)
  const allowedDistance = longest >= 7 ? 2 : longest >= 4 ? 1 : 0
  return distance <= allowedDistance ? 1 - distance / longest : 0
}

export function typoPhraseSimilarity(left: string, right: string): number {
  const tokens = (value: string): string[] =>
    value
      .normalize('NFKC')
      .toLocaleLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/u)
      .filter(Boolean)
  const leftTokens = [...new Set(tokens(left))]
  const rightTokens = [...new Set(tokens(right))]
  if (leftTokens.length === 0 || rightTokens.length === 0) return 0
  const coverage = (source: readonly string[], candidates: readonly string[]): number =>
    source.reduce(
      (total, token) =>
        total + Math.max(...candidates.map((candidate) => typoTokenSimilarity(token, candidate))),
      0
    ) / source.length
  return (coverage(leftTokens, rightTokens) + coverage(rightTokens, leftTokens)) / 2
}

type WordSpan = { value: string; start: number; end: number }

function wordSpans(value: string): WordSpan[] {
  return [...value.matchAll(/[\p{L}\p{N}]+/gu)].flatMap((match) =>
    match.index === undefined
      ? []
      : [{ value: match[0], start: match.index, end: match.index + match[0].length }]
  )
}

const targetedMutationWords = new Set([
  'move',
  'reschedule',
  'shift',
  'rename',
  'duplicate',
  'copy',
  'clone',
  'delete',
  'remove',
  'cancel',
  'mark',
  'complete',
  'finish',
  'change',
  'modify',
  'update'
])

/** Canonicalizes only high-confidence references to titles already on device. */
export function repairKnownMutationTargets(text: string, knownTitles: readonly string[]): string {
  const sourceWords = wordSpans(text)
  const canonicalActionIndex = sourceWords.findIndex((word) =>
    actionWords.has(word.value.toLocaleLowerCase())
  )
  const colloquialAction =
    /\b(?:take|drop|call\s+off|scrap|ditch|bump|postpone|push\s+back|bring\s+forward|cross|tick|check|make\s+(?:a|another)\s+copy)\b/iu.exec(
      text
    )
  const colloquialActionIndex =
    colloquialAction?.index === undefined
      ? -1
      : sourceWords.findIndex((word) => word.start >= (colloquialAction.index ?? 0))
  const actionIndex = canonicalActionIndex >= 0 ? canonicalActionIndex : colloquialActionIndex
  const firstAction =
    actionIndex >= 0 ? sourceWords[actionIndex]?.value.toLocaleLowerCase() : undefined
  if (
    !firstAction ||
    (!targetedMutationWords.has(firstAction) && colloquialActionIndex !== actionIndex)
  ) {
    return text
  }

  const candidates: Array<{
    title: string
    start: number
    end: number
    score: number
  }> = []
  for (const title of [...new Set(knownTitles.map((value) => value.trim()).filter(Boolean))]) {
    const titleWords = wordSpans(title)
    if (titleWords.length === 0 || titleWords.length > sourceWords.length) continue
    for (
      let startIndex = actionIndex + 1;
      startIndex <= sourceWords.length - titleWords.length;
      startIndex += 1
    ) {
      const window = sourceWords.slice(startIndex, startIndex + titleWords.length)
      if (window.length !== titleWords.length) continue
      const tokenScores = window.map((word, index) =>
        typoTokenSimilarity(word.value, titleWords[index]?.value ?? '')
      )
      const minimum = Math.min(...tokenScores)
      const score = tokenScores.reduce((total, value) => total + value, 0) / tokenScores.length
      const singleWordAllowed = titleWords.length > 1 || (titleWords[0]?.value.length ?? 0) >= 4
      if (singleWordAllowed && minimum >= 0.72 && score >= 0.8) {
        const first = window[0]
        const last = window.at(-1)
        if (first && last) candidates.push({ title, start: first.start, end: last.end, score })
      }
    }
  }

  const accepted: typeof candidates = []
  for (const candidate of candidates.sort(
    (left, right) =>
      right.score - left.score ||
      right.end - right.start - (left.end - left.start) ||
      left.start - right.start
  )) {
    if (accepted.some((item) => candidate.start < item.end && candidate.end > item.start)) continue
    accepted.push(candidate)
  }
  let repaired = text
  for (const candidate of accepted.sort((left, right) => right.start - left.start)) {
    repaired = `${repaired.slice(0, candidate.start)}${candidate.title}${repaired.slice(candidate.end)}`
  }
  return repaired
}

function bestVocabularyRepair(token: string, vocabulary: readonly string[]): string | null {
  const normalized = token.toLocaleLowerCase()
  if (vocabulary.includes(normalized)) return normalized
  const exact = exactRepairs[normalized]
  if (exact && vocabulary.includes(exact)) return exact
  if (normalized.length < 5) return null
  let best: { word: string; score: number } | null = null
  let tied = false
  for (const word of vocabulary) {
    if (exactOnlyVocabulary.has(word)) continue
    const score = typoTokenSimilarity(normalized, word)
    if (score < 0.72) continue
    if (!best || score > best.score) {
      best = { word, score }
      tied = false
    } else if (score === best.score && word !== best.word) {
      tied = true
    }
  }
  return best && !tied ? best.word : null
}

function repairSplitWords(text: string): string {
  let repaired = text
  for (let pass = 0; pass < 24; pass += 1) {
    const words = wordSpans(repaired)
    let replacement: { start: number; end: number; value: string } | null = null
    for (let index = 0; index < words.length - 1; index += 1) {
      const left = words[index]
      const right = words[index + 1]
      if (!left || !right || !/^\s+$/u.test(repaired.slice(left.end, right.start))) continue
      const value = compactPhraseRepairs[`${left.value}${right.value}`.toLocaleLowerCase()]
      if (value) {
        replacement = { start: left.start, end: right.end, value }
        break
      }
    }
    if (!replacement) break
    repaired = `${repaired.slice(0, replacement.start)}${replacement.value}${repaired.slice(replacement.end)}`
  }
  return repaired
}

/**
 * Repairs only assistant vocabulary. Once a write verb is found, free-form
 * title and note words are left untouched; temporal words remain repairable.
 */
export function normalizeAssistantText(text: string): string {
  const source = repairSplitWords(normalizeAssistantWhitespace(text))
  let wordIndex = 0
  let sawAction = false
  return source.replace(/\b[\p{L}]+\b/gu, (token) => {
    const normalized = token.toLocaleLowerCase()
    const preservedCommand = leadingVocabulary.some((word) => word === normalized)
      ? normalized
      : null
    const exactActionRepair = exactRepairs[normalized]
    const repairedAction =
      exactActionRepair && actionWords.has(exactActionRepair) ? exactActionRepair : null
    const globalRepair = bestVocabularyRepair(normalized, globalVocabulary)
    const leadingRepair =
      !sawAction && wordIndex < 8 ? bestVocabularyRepair(normalized, leadingVocabulary) : null
    const replacement = preservedCommand ?? repairedAction ?? leadingRepair ?? globalRepair ?? token
    if (actionWords.has(replacement.toLocaleLowerCase())) sawAction = true
    wordIndex += 1
    return replacement
  })
}
