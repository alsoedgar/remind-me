import type {
  DocumentBoundingBox,
  DocumentExtractionMethod,
  DocumentTextBlock,
  DocumentWord
} from '@remind-me/contracts'
import { normalizeBoundingBox, unionBoundingBoxes } from './document-geometry'

export interface PositionedDocumentWord {
  text: string
  boundingBox: DocumentBoundingBox
  confidence: number
}

export interface NativeTextViewport {
  width: number
  height: number
  scale: number
  transform: number[]
}

interface NativeTextItem {
  str: string
  transform: number[]
  width: number
  height: number
}

export interface DocumentTextContent {
  words: DocumentWord[]
  blocks: DocumentTextBlock[]
}

export function cleanDocumentWord(text: string): string {
  return text.replace(/\s+/gu, ' ').trim().slice(0, 200)
}

export function splitDocumentWords(text: string): string[] {
  return text.split(/\s+/gu).map(cleanDocumentWord).filter(Boolean)
}

function joinDocumentWords(words: readonly { text: string }[]): string {
  return words
    .map((word) => word.text)
    .join(' ')
    .replace(/(\d)\s*:\s*(\d)/gu, '$1:$2')
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0)
}

/**
 * Splits one visual text line at table-sized horizontal gaps. Normal word spacing remains one
 * block, while independent columns retain their geometry for PlanScan and deterministic rules.
 */
export function splitPositionedLine<T extends { boundingBox: DocumentBoundingBox }>(
  input: readonly T[]
): T[][] {
  const words = [...input].sort((left, right) => left.boundingBox.x - right.boundingBox.x)
  if (words.length < 2) return words.length === 0 ? [] : [words]
  const typicalHeight = Math.max(0.004, median(words.map((word) => word.boundingBox.height)))
  const gaps = words.slice(1).map((word, index) => {
    const previous = words[index]!
    return Math.max(0, word.boundingBox.x - (previous.boundingBox.x + previous.boundingBox.width))
  })
  const ordinaryGaps = gaps.filter((gap) => gap <= Math.max(0.012, typicalHeight * 1.2))
  const ordinaryGap = median(ordinaryGaps) || Math.min(0.006, typicalHeight * 0.3)
  const columnGap = Math.max(0.014, typicalHeight * 1.5, ordinaryGap * 3)
  const groups: T[][] = [[]]
  for (let index = 0; index < words.length; index += 1) {
    if (index > 0 && (gaps[index - 1] ?? 0) > columnGap) groups.push([])
    groups.at(-1)!.push(words[index]!)
  }
  return groups.filter((group) => group.length > 0)
}

export function contentFromPositionedWords(
  inputWords: readonly PositionedDocumentWord[],
  page: number,
  method: DocumentExtractionMethod,
  idPrefix: string
): DocumentTextContent {
  const sorted = [...inputWords]
    .filter((word) => cleanDocumentWord(word.text))
    .sort(
      (left, right) =>
        left.boundingBox.y - right.boundingBox.y || left.boundingBox.x - right.boundingBox.x
    )
  const lines: PositionedDocumentWord[][] = []
  for (const word of sorted) {
    const centerY = word.boundingBox.y + word.boundingBox.height / 2
    let bestLine: PositionedDocumentWord[] | null = null
    let bestDistance = Number.POSITIVE_INFINITY
    for (const line of lines.slice(-4)) {
      const representative = line[0]
      if (!representative) continue
      const lineCenter = representative.boundingBox.y + representative.boundingBox.height / 2
      const distance = Math.abs(centerY - lineCenter)
      const tolerance = Math.max(word.boundingBox.height, representative.boundingBox.height) * 0.72
      if (distance <= tolerance && distance < bestDistance) {
        bestDistance = distance
        bestLine = line
      }
    }
    if (bestLine) bestLine.push(word)
    else lines.push([word])
  }

  lines.sort((left, right) => {
    const leftBox = left[0]?.boundingBox
    const rightBox = right[0]?.boundingBox
    return (leftBox?.y ?? 0) - (rightBox?.y ?? 0) || (leftBox?.x ?? 0) - (rightBox?.x ?? 0)
  })
  const words: DocumentWord[] = []
  const blocks: DocumentTextBlock[] = []
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]
    if (!line) continue
    const lineId = `${idPrefix}-line:${page}:${lineIndex}`
    const segments = splitPositionedLine(line)
    for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
      const segment = segments[segmentIndex]
      if (!segment) continue
      const lineWords: DocumentWord[] = segment.slice(0, 200).map((word, wordIndex) => ({
        id: `${idPrefix}-word:${page}:${lineIndex}:${segmentIndex}:${wordIndex}`,
        lineId,
        page,
        text: cleanDocumentWord(word.text),
        boundingBox: normalizeBoundingBox(word.boundingBox),
        confidence: Math.max(0, Math.min(1, word.confidence)),
        method
      }))
      if (lineWords.length === 0) continue
      words.push(...lineWords)
      blocks.push({
        id: `${idPrefix}-block:${page}:${lineIndex}:${segmentIndex}`,
        page,
        text: joinDocumentWords(lineWords).slice(0, 2_000),
        boundingBox: unionBoundingBoxes(lineWords.map((word) => word.boundingBox)),
        confidence:
          lineWords.reduce((total, word) => total + word.confidence, 0) / lineWords.length,
        method,
        wordIds: lineWords.map((word) => word.id)
      })
    }
  }
  return { words, blocks }
}

function transformMatrices(left: readonly number[], right: readonly number[]): number[] {
  return [
    (left[0] ?? 0) * (right[0] ?? 0) + (left[2] ?? 0) * (right[1] ?? 0),
    (left[1] ?? 0) * (right[0] ?? 0) + (left[3] ?? 0) * (right[1] ?? 0),
    (left[0] ?? 0) * (right[2] ?? 0) + (left[2] ?? 0) * (right[3] ?? 0),
    (left[1] ?? 0) * (right[2] ?? 0) + (left[3] ?? 0) * (right[3] ?? 0),
    (left[0] ?? 0) * (right[4] ?? 0) + (left[2] ?? 0) * (right[5] ?? 0) + (left[4] ?? 0),
    (left[1] ?? 0) * (right[4] ?? 0) + (left[3] ?? 0) * (right[5] ?? 0) + (left[5] ?? 0)
  ]
}

export function positionedNativeWords(
  items: readonly unknown[],
  viewport: NativeTextViewport
): PositionedDocumentWord[] {
  const positioned: PositionedDocumentWord[] = []
  for (const item of items) {
    if (!item || typeof item !== 'object' || !('str' in item) || !('transform' in item)) {
      continue
    }
    const textItem = item as NativeTextItem
    const tokens = splitDocumentWords(textItem.str)
    if (tokens.length === 0) continue
    const transformed = transformMatrices(viewport.transform, textItem.transform)
    const x = Number(transformed[4] ?? 0)
    const baselineY = Number(transformed[5] ?? 0)
    const fontHeight = Math.max(
      1,
      Math.abs(textItem.height * viewport.scale),
      Math.hypot(Number(transformed[2] ?? 0), Number(transformed[3] ?? 0))
    )
    const width = Math.max(1, Math.abs(textItem.width * viewport.scale))
    const totalCharacters = Math.max(
      1,
      tokens.reduce((total, token) => total + token.length, 0) + tokens.length - 1
    )
    let characterOffset = 0
    for (const token of tokens) {
      const tokenWidth = Math.max(1, width * (token.length / totalCharacters))
      const tokenX = x + width * (characterOffset / totalCharacters)
      positioned.push({
        text: token,
        confidence: 1,
        boundingBox: normalizeBoundingBox({
          x: tokenX / viewport.width,
          y: (baselineY - fontHeight) / viewport.height,
          width: tokenWidth / viewport.width,
          height: fontHeight / viewport.height
        })
      })
      characterOffset += token.length + 1
    }
  }
  return positioned
}
