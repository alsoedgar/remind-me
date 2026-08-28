import type { DocumentTextContent } from './document-text-layout'

export interface DocumentTextQuality {
  characterCount: number
  wordCount: number
  blockCount: number
  averageConfidence: number
  readableWordRatio: number
  calendarSignalCount: number
  horizontalCoverage: number
  verticalCoverage: number
  score: number
}

export type NativeOcrReason = 'sparse-native-text' | 'weak-positioned-text' | 'isolated-native-text'

export interface NativeOcrDecision {
  needsOcr: boolean
  reason: NativeOcrReason | null
  quality: DocumentTextQuality
}

const monthOrWeekdayPattern =
  /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b/giu
const numericDatePattern = /\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?)\b/gu
const clockPattern =
  /\b(?:[01]?\d|2[0-3]):[0-5]\d(?:\s*[ap]\.?m\.?)?|\b(?:0?[1-9]|1[0-2])\s*[ap]\.?m\.?\b|\b(?:noon|midnight)\b/giu

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function normalizedText(content: DocumentTextContent): string {
  return content.blocks
    .map((block) => block.text)
    .join(' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

function matchCount(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length
}

export function assessDocumentText(content: DocumentTextContent): DocumentTextQuality {
  const text = normalizedText(content)
  const readableWords = content.words.filter((word) => /[\p{L}\p{N}]{2}/u.test(word.text)).length
  const averageConfidence =
    content.words.length === 0
      ? 0
      : content.words.reduce((total, word) => total + word.confidence, 0) / content.words.length
  const left = content.words.length
    ? Math.min(...content.words.map((word) => word.boundingBox.x))
    : 0
  const top = content.words.length
    ? Math.min(...content.words.map((word) => word.boundingBox.y))
    : 0
  const right = content.words.length
    ? Math.max(...content.words.map((word) => word.boundingBox.x + word.boundingBox.width))
    : 0
  const bottom = content.words.length
    ? Math.max(...content.words.map((word) => word.boundingBox.y + word.boundingBox.height))
    : 0
  const calendarSignalCount =
    matchCount(text, monthOrWeekdayPattern) +
    matchCount(text, numericDatePattern) +
    matchCount(text, clockPattern)
  const readableWordRatio = content.words.length === 0 ? 0 : readableWords / content.words.length
  const score = clamp(
    averageConfidence * 0.55 +
      readableWordRatio * 0.15 +
      Math.min(1, content.words.length / 24) * 0.1 +
      Math.min(1, calendarSignalCount / 3) * 0.2
  )

  return {
    characterCount: text.replace(/\s/gu, '').length,
    wordCount: content.words.length,
    blockCount: content.blocks.length,
    averageConfidence,
    readableWordRatio,
    calendarSignalCount,
    horizontalCoverage: clamp(right - left),
    verticalCoverage: clamp(bottom - top),
    score
  }
}

/**
 * Embedded PDF text is useful only when it represents the page, not merely a URL, footer, or
 * accessibility label. This keeps native PDFs fast while allowing OCR for hybrid raster pages.
 */
export function decideNativePageOcr(
  nativeCharacterCount: number,
  content: DocumentTextContent
): NativeOcrDecision {
  const quality = assessDocumentText(content)
  if (nativeCharacterCount < 24 || quality.wordCount < 4) {
    return { needsOcr: true, reason: 'sparse-native-text', quality }
  }
  if (quality.characterCount < nativeCharacterCount * 0.48) {
    return { needsOcr: true, reason: 'weak-positioned-text', quality }
  }
  const isolated =
    quality.blockCount <= 2 &&
    quality.characterCount < 180 &&
    quality.calendarSignalCount === 0 &&
    (quality.verticalCoverage < 0.1 || quality.horizontalCoverage < 0.3)
  if (isolated) return { needsOcr: true, reason: 'isolated-native-text', quality }
  return { needsOcr: false, reason: null, quality }
}

export function shouldRetryOcrOrientation(content: DocumentTextContent): boolean {
  const quality = assessDocumentText(content)
  return (
    quality.wordCount >= 6 &&
    (quality.averageConfidence < 0.62 ||
      (quality.score < 0.58 && quality.calendarSignalCount === 0))
  )
}

export function isStrongOcrOrientation(content: DocumentTextContent): boolean {
  const quality = assessDocumentText(content)
  return (
    quality.averageConfidence >= 0.78 &&
    quality.readableWordRatio >= 0.68 &&
    quality.calendarSignalCount >= 2
  )
}

export function isBetterOcrContent(
  candidate: DocumentTextContent,
  current: DocumentTextContent
): boolean {
  const next = assessDocumentText(candidate)
  const existing = assessDocumentText(current)
  return next.score >= existing.score + 0.08
}

function calendarGridSignals(content: DocumentTextContent): {
  weekdayHeaders: number
  dayNumbers: number
  monthHeadings: number
} {
  const weekdayHeaders = content.blocks.filter((block) =>
    /^(?:SUN|MON|TUE|WED|THU|FRI|SAT)$/iu.test(block.text.trim())
  ).length
  const dayNumbers = content.blocks.filter((block) =>
    /^(?:[1-9]|[12]\d|3[01])$/u.test(block.text.trim())
  ).length
  const monthHeadings = content.blocks.filter((block) =>
    /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{4}\b/iu.test(
      block.text
    )
  ).length
  return { weekdayHeaders, dayNumbers, monthHeadings }
}

export function shouldRetryOcrPageSegmentation(content: DocumentTextContent): boolean {
  const signals = calendarGridSignals(content)
  return signals.weekdayHeaders >= 3 && signals.dayNumbers >= 4
}

export function isBetterCalendarGridContent(
  candidate: DocumentTextContent,
  current: DocumentTextContent
): boolean {
  const next = calendarGridSignals(candidate)
  const existing = calendarGridSignals(current)
  const gridScore = (signals: ReturnType<typeof calendarGridSignals>): number =>
    signals.monthHeadings * 12 +
    signals.weekdayHeaders * 1.5 +
    Math.min(31, signals.dayNumbers) * 0.2
  return gridScore(next) > gridScore(existing) + 0.5
}
