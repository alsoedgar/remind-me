import { describe, expect, it } from 'vitest'
import {
  assessDocumentText,
  decideNativePageOcr,
  documentPdfRenderScale,
  isBetterCalendarGridContent,
  isBetterOcrContent,
  shouldRetryOcrPageSegmentation,
  shouldRetryOcrOrientation
} from './document-extraction-quality'
import { contentFromPositionedWords, type PositionedDocumentWord } from './document-text-layout'

function content(rows: readonly { text: string; x?: number; y: number; confidence?: number }[]) {
  const words: PositionedDocumentWord[] = rows.flatMap((row) =>
    row.text.split(/\s+/u).map((text, index) => ({
      text,
      confidence: row.confidence ?? 1,
      boundingBox: {
        x: (row.x ?? 0.08) + index * 0.07,
        y: row.y,
        width: Math.max(0.02, text.length * 0.009),
        height: 0.02
      }
    }))
  )
  return contentFromPositionedWords(words, 1, 'native-text', 'quality')
}

describe('document extraction quality', () => {
  it('renders letter PDFs at useful OCR resolution within the pixel budget', () => {
    const scale = documentPdfRenderScale(612, 792, 2200, 4_500_000)
    expect(792 * scale).toBeCloseTo(2200)
    expect(612 * 792 * scale * scale).toBeLessThanOrEqual(4_500_000)
    expect(documentPdfRenderScale(4000, 4000, 2200, 4_500_000)).toBeLessThan(1)
  })

  it('retries sparse and empty sideways scans instead of accepting missing text', () => {
    expect(shouldRetryOcrOrientation(content([]))).toBe(true)
    expect(shouldRetryOcrOrientation(content([{ text: 'xy', y: 0.2, confidence: 0.2 }]))).toBe(true)
    expect(shouldRetryOcrPageSegmentation(content([]))).toBe(true)
    expect(
      shouldRetryOcrPageSegmentation(
        content([{ text: 'broken table row', y: 0.2, confidence: 0.4 }])
      )
    ).toBe(true)
  })
  it('requests OCR when a hybrid page only exposes a native footer', () => {
    const footer = content([
      { text: 'Private local evaluation copy raster schedule body', x: 0.04, y: 0.97 }
    ])
    expect(decideNativePageOcr(49, footer)).toMatchObject({
      needsOcr: true,
      reason: 'isolated-native-text'
    })
  })

  it('keeps a useful native schedule on the fast path', () => {
    const schedule = content([
      { text: 'Project kickoff', y: 0.15 },
      { text: 'August 26, 2026', y: 0.22 },
      { text: '9:00 AM - 10:00 AM', y: 0.29 },
      { text: 'Location: Studio A', y: 0.36 }
    ])
    expect(decideNativePageOcr(75, schedule).needsOcr).toBe(false)
  })

  it('retries low-confidence sideways OCR and prefers a readable calendar result', () => {
    const sideways = content([
      { text: 'g 03 fol ge ox', y: 0.2, confidence: 0.34 },
      { text: 'N god yoo', y: 0.3, confidence: 0.34 }
    ])
    const upright = content([
      { text: 'Project kickoff', y: 0.15, confidence: 0.95 },
      { text: 'August 26, 2026', y: 0.22, confidence: 0.95 },
      { text: '9:00 AM - 10:00 AM', y: 0.29, confidence: 0.95 }
    ])
    expect(shouldRetryOcrOrientation(sideways)).toBe(true)
    expect(isBetterOcrContent(upright, sideways)).toBe(true)
    expect(assessDocumentText(upright).calendarSignalCount).toBeGreaterThanOrEqual(2)
  })

  it('requests a layout pass only for calendar-like weekday and day geometry', () => {
    const gridWithoutHeading = content([
      { text: 'SUN', y: 0.1 },
      { text: 'MON', y: 0.14 },
      { text: 'TUE', y: 0.18 },
      { text: '1', y: 0.2 },
      { text: '8', y: 0.3 },
      { text: '14', y: 0.4 },
      { text: '25', y: 0.5 }
    ])
    const gridWithHeading = content([
      { text: 'SEPTEMBER 2026', y: 0.03 },
      { text: 'SUN', y: 0.1 },
      { text: 'MON', y: 0.14 },
      { text: 'TUE', y: 0.18 },
      { text: '1', y: 0.2 },
      { text: '8', y: 0.3 },
      { text: '14', y: 0.4 },
      { text: '25', y: 0.5 }
    ])
    expect(shouldRetryOcrPageSegmentation(gridWithoutHeading)).toBe(true)
    expect(isBetterCalendarGridContent(gridWithHeading, gridWithoutHeading)).toBe(true)
  })
})
