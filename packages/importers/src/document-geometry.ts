import {
  documentBoundingBoxSchema,
  maximumDocumentBytes,
  maximumDocumentImagePixels,
  type DocumentBoundingBox,
  type DocumentSourceKind
} from '@remind-me/contracts'

export type SupportedDocumentMediaType =
  'application/pdf' | 'image/png' | 'image/jpeg' | 'image/webp'

export interface ImageDimensions {
  width: number
  height: number
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length))
}

function uint16BigEndian(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! << 8) | bytes[offset + 1]!
}

function uint16LittleEndian(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8)
}

function uint24LittleEndian(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16)
}

function uint32BigEndian(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! * 0x1000000 +
    (bytes[offset + 1]! << 16) +
    (bytes[offset + 2]! << 8) +
    bytes[offset + 3]!
  )
}

export function detectDocumentMediaType(bytes: Uint8Array): SupportedDocumentMediaType | null {
  if (bytes.length >= 5 && ascii(bytes, 0, 5) === '%PDF-') return 'application/pdf'
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    ascii(bytes, 1, 3) === 'PNG' &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    return 'image/webp'
  }
  return null
}

function jpegDimensions(bytes: Uint8Array): ImageDimensions | null {
  let offset = 2
  const startOfFrameMarkers = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf
  ])
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1
      continue
    }
    while (bytes[offset] === 0xff) offset += 1
    const marker = bytes[offset]
    offset += 1
    if (marker === undefined || marker === 0xd9 || marker === 0xda) break
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 2 > bytes.length) break
    const segmentLength = uint16BigEndian(bytes, offset)
    if (segmentLength < 2 || offset + segmentLength > bytes.length) break
    if (startOfFrameMarkers.has(marker) && segmentLength >= 7) {
      const height = uint16BigEndian(bytes, offset + 3)
      const width = uint16BigEndian(bytes, offset + 5)
      return width > 0 && height > 0 ? { width, height } : null
    }
    offset += segmentLength
  }
  return null
}

function webpDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 30) return null
  const chunk = ascii(bytes, 12, 4)
  if (chunk === 'VP8X') {
    return {
      width: uint24LittleEndian(bytes, 24) + 1,
      height: uint24LittleEndian(bytes, 27) + 1
    }
  }
  if (chunk === 'VP8L' && bytes[20] === 0x2f && bytes.length >= 25) {
    const width = 1 + (bytes[21]! | ((bytes[22]! & 0x3f) << 8))
    const height = 1 + ((bytes[22]! >> 6) | (bytes[23]! << 2) | ((bytes[24]! & 0x0f) << 10))
    return { width, height }
  }
  if (
    chunk === 'VP8 ' &&
    bytes.length >= 30 &&
    bytes[23] === 0x9d &&
    bytes[24] === 0x01 &&
    bytes[25] === 0x2a
  ) {
    return {
      width: uint16LittleEndian(bytes, 26) & 0x3fff,
      height: uint16LittleEndian(bytes, 28) & 0x3fff
    }
  }
  return null
}

export function readImageDimensions(
  bytes: Uint8Array,
  mediaType: Exclude<SupportedDocumentMediaType, 'application/pdf'>
): ImageDimensions | null {
  if (mediaType === 'image/png') {
    if (bytes.length < 24 || ascii(bytes, 12, 4) !== 'IHDR') return null
    const width = uint32BigEndian(bytes, 16)
    const height = uint32BigEndian(bytes, 20)
    return width > 0 && height > 0 ? { width, height } : null
  }
  if (mediaType === 'image/jpeg') return jpegDimensions(bytes)
  return webpDimensions(bytes)
}

export function validateDocumentBytes(bytes: Uint8Array): {
  kind: DocumentSourceKind
  mediaType: SupportedDocumentMediaType
  dimensions: ImageDimensions | null
} {
  if (bytes.byteLength === 0) throw new Error('The selected file is empty')
  if (bytes.byteLength > maximumDocumentBytes) {
    throw new Error('Images and PDFs must be 25 MB or smaller')
  }
  const mediaType = detectDocumentMediaType(bytes)
  if (!mediaType) throw new Error('Choose a valid PDF, PNG, JPEG, or WebP image')
  if (mediaType === 'application/pdf') return { kind: 'pdf', mediaType, dimensions: null }
  const dimensions = readImageDimensions(bytes, mediaType)
  if (!dimensions) throw new Error('The image header is damaged or unsupported')
  if (dimensions.width * dimensions.height > maximumDocumentImagePixels) {
    throw new Error('Images are limited to 25 megapixels for safe local processing')
  }
  return { kind: 'image', mediaType, dimensions }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

export function normalizeBoundingBox(input: DocumentBoundingBox): DocumentBoundingBox {
  const x = clamp(input.x, 0, 0.999_999)
  const y = clamp(input.y, 0, 0.999_999)
  return documentBoundingBoxSchema.parse({
    x,
    y,
    width: clamp(input.width, 0.000_001, 1 - x),
    height: clamp(input.height, 0.000_001, 1 - y)
  })
}

export function unionBoundingBoxes(boxes: readonly DocumentBoundingBox[]): DocumentBoundingBox {
  if (boxes.length === 0) throw new Error('Cannot join an empty set of bounding boxes')
  const x = Math.min(...boxes.map((box) => box.x))
  const y = Math.min(...boxes.map((box) => box.y))
  const right = Math.max(...boxes.map((box) => box.x + box.width))
  const bottom = Math.max(...boxes.map((box) => box.y + box.height))
  return normalizeBoundingBox({ x, y, width: right - x, height: bottom - y })
}
