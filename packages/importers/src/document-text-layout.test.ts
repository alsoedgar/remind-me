import { describe, expect, it } from 'vitest'
import { contentFromPositionedWords, type PositionedDocumentWord } from './document-text-layout'

function word(text: string, x: number, width: number): PositionedDocumentWord {
  return {
    text,
    confidence: 1,
    boundingBox: { x, y: 0.2, width, height: 0.012 }
  }
}

describe('document text layout', () => {
  it('keeps ordinary phrases together while preserving schedule table columns', () => {
    const content = contentFromPositionedWords(
      [
        word('Data', 0.05, 0.03),
        word('Structures', 0.084, 0.07),
        word('CS', 0.26, 0.02),
        word('251', 0.285, 0.03),
        word('AL3', 0.32, 0.028),
        word('4.0', 0.4, 0.024),
        word('42499', 0.49, 0.04),
        word('08/24/2026', 0.56, 0.075),
        word('-', 0.64, 0.008),
        word('12/04/2026', 0.653, 0.075)
      ],
      1,
      'native-text',
      'table'
    )

    expect(content.blocks.map((block) => block.text)).toEqual([
      'Data Structures',
      'CS 251 AL3',
      '4.0',
      '42499',
      '08/24/2026 - 12/04/2026'
    ])
    expect(new Set(content.words.map((item) => item.lineId))).toHaveLength(1)
  })
})
