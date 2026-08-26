import { describe, expect, it } from 'vitest'
import {
  detectDocumentMediaType,
  readImageDimensions,
  unionBoundingBoxes,
  validateDocumentBytes
} from './document-geometry'

function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  bytes.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8)
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

describe('document byte validation', () => {
  it('sniffs PDF and image content instead of trusting filenames', () => {
    expect(detectDocumentMediaType(new TextEncoder().encode('%PDF-1.7\n'))).toBe('application/pdf')
    const png = pngHeader(1_200, 900)
    expect(detectDocumentMediaType(png)).toBe('image/png')
    expect(readImageDimensions(png, 'image/png')).toEqual({ width: 1_200, height: 900 })
    expect(validateDocumentBytes(png)).toEqual({
      kind: 'image',
      mediaType: 'image/png',
      dimensions: { width: 1_200, height: 900 }
    })
  })

  it('rejects unknown, empty, and decompression-risk image dimensions', () => {
    expect(() => validateDocumentBytes(new Uint8Array())).toThrow(/empty/iu)
    expect(() => validateDocumentBytes(new TextEncoder().encode('not an image'))).toThrow(
      /valid PDF/iu
    )
    expect(() => validateDocumentBytes(pngHeader(6_000, 6_000))).toThrow(/25 megapixels/iu)
  })

  it('unions normalized evidence rectangles without crossing page bounds', () => {
    expect(
      unionBoundingBoxes([
        { x: 0.1, y: 0.2, width: 0.2, height: 0.1 },
        { x: 0.25, y: 0.25, width: 0.3, height: 0.15 }
      ])
    ).toEqual({ x: 0.1, y: 0.2, width: 0.45000000000000007, height: 0.2 })
  })
})
