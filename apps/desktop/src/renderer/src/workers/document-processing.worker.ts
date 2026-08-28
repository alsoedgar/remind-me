/// <reference lib="webworker" />

import { createWorker, OEM, PSM, type LoggerMessage, type Worker as OcrWorker } from 'tesseract.js'
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs'
import {
  documentExtractionSchema,
  documentSelectionSchema,
  maximumDocumentCharacters,
  maximumDocumentImagePixels,
  maximumDocumentPages,
  maximumDocumentReviewImageCharacters,
  maximumDocumentWords,
  type DocumentExtraction,
  type DocumentPage,
  type DocumentProgressEvent,
  type DocumentSelection
} from '@remind-me/contracts'
import {
  cleanDocumentWord as cleanWord,
  contentFromPositionedWords,
  decideNativePageOcr,
  isBetterCalendarGridContent,
  isBetterOcrContent,
  isStrongOcrOrientation,
  normalizeBoundingBox,
  PlanScanRuntime,
  positionedNativeWords,
  shouldRetryOcrPageSegmentation,
  shouldRetryOcrOrientation,
  splitDocumentWords as splitWords,
  type DocumentTextContent,
  type PositionedDocumentWord,
  validateDocumentBytes
} from '@remind-me/importers/document'

interface AnalyzeMessage {
  type: 'analyze'
  selection: DocumentSelection
}

interface ProgressMessage {
  type: 'progress'
  progress: DocumentProgressEvent
}

interface ResultMessage {
  type: 'result'
  extraction: DocumentExtraction
}

interface ErrorMessage {
  type: 'error'
  message: string
}

type OutboundMessage = ProgressMessage | ResultMessage | ErrorMessage

interface OcrProgressContext {
  page: number
  totalPages: number
}

interface OcrCanvasResult {
  canvas: OffscreenCanvas
  content: DocumentTextContent
  rotation: 0 | 90 | 180 | 270
}

interface PdfCanvasAndContext {
  canvas: OffscreenCanvas | null
  context: OffscreenCanvasRenderingContext2D | null
}

class OffscreenPdfCanvasFactory {
  create(width: number, height: number): PdfCanvasAndContext {
    if (width <= 0 || height <= 0) throw new Error('Invalid PDF canvas size')
    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('Could not create a PDF canvas')
    return { canvas, context }
  }

  reset(target: PdfCanvasAndContext, width: number, height: number): void {
    if (!target.canvas) throw new Error('PDF canvas is unavailable')
    if (width <= 0 || height <= 0) throw new Error('Invalid PDF canvas size')
    target.canvas.width = width
    target.canvas.height = height
  }

  destroy(target: PdfCanvasAndContext): void {
    if (target.canvas) target.canvas.width = target.canvas.height = 0
    target.canvas = null
    target.context = null
  }
}

const thumbnailMaximumDimension = 440
const reviewMaximumDimension = 2_200
const ocrMaximumDimension = 2_200
const ocrMaximumPixels = 4_500_000
const workerScope = self as unknown as DedicatedWorkerGlobalScope

let ocrWorker: OcrWorker | null = null
let ocrProgressContext: OcrProgressContext | null = null
let planScanRuntime: PlanScanRuntime | null = null

function assetUrl(path: string): string {
  return new URL(path.replace(/^\//u, ''), new URL('/', workerScope.location.href)).toString()
}

GlobalWorkerOptions.workerSrc = assetUrl('/document/pdf.worker.min.mjs')

function post(message: OutboundMessage): void {
  workerScope.postMessage(message)
}

function progress(
  stage: DocumentProgressEvent['stage'],
  value: number,
  message: string,
  currentPage: number | null,
  totalPages: number | null
): void {
  post({
    type: 'progress',
    progress: {
      stage,
      progress: Math.max(0, Math.min(1, value)),
      message,
      currentPage,
      totalPages
    }
  })
}

function canvasScale(width: number, height: number, maximumDimension: number): number {
  const dimensionScale = Math.min(1, maximumDimension / Math.max(width, height))
  const pixelScale = Math.min(1, Math.sqrt(ocrMaximumPixels / (width * height)))
  return Math.min(dimensionScale, pixelScale)
}

async function canvasDataUrl(canvas: OffscreenCanvas, quality = 0.76): Promise<string> {
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality })
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return `data:image/jpeg;base64,${btoa(binary)}`
}

async function reviewImageDataUrl(canvas: OffscreenCanvas): Promise<string> {
  for (const quality of [0.88, 0.74, 0.6, 0.48]) {
    const dataUrl = await canvasDataUrl(canvas, quality)
    if (dataUrl.length <= maximumDocumentReviewImageCharacters) return dataUrl
  }
  throw new Error('This page is too visually dense for the private high-resolution review view.')
}

function thumbnailFromCanvas(source: OffscreenCanvas): OffscreenCanvas {
  const scale = Math.min(1, thumbnailMaximumDimension / Math.max(source.width, source.height))
  const thumbnail = new OffscreenCanvas(
    Math.max(1, Math.round(source.width * scale)),
    Math.max(1, Math.round(source.height * scale))
  )
  const context = thumbnail.getContext('2d')
  if (!context) throw new Error('Could not create a thumbnail canvas')
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, thumbnail.width, thumbnail.height)
  context.drawImage(source, 0, 0, thumbnail.width, thumbnail.height)
  return thumbnail
}

function ocrContent(
  blocks: Awaited<ReturnType<OcrWorker['recognize']>>['data']['blocks'],
  fallbackText: string,
  fallbackConfidence: number,
  page: number,
  width: number,
  height: number
): DocumentTextContent {
  const positioned: PositionedDocumentWord[] = []
  for (const block of blocks ?? []) {
    for (const paragraph of block.paragraphs) {
      for (const line of paragraph.lines) {
        for (const word of line.words) {
          const text = cleanWord(word.text)
          if (!text) continue
          positioned.push({
            text,
            confidence: word.confidence / 100,
            boundingBox: normalizeBoundingBox({
              x: word.bbox.x0 / width,
              y: word.bbox.y0 / height,
              width: (word.bbox.x1 - word.bbox.x0) / width,
              height: (word.bbox.y1 - word.bbox.y0) / height
            })
          })
        }
      }
    }
  }
  if (positioned.length === 0) {
    const lines = fallbackText
      .split(/\r?\n/gu)
      .map(normalizeFallbackLine)
      .filter(Boolean)
      .slice(0, 120)
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex]!
      const tokens = splitWords(line)
      for (let wordIndex = 0; wordIndex < tokens.length; wordIndex += 1) {
        positioned.push({
          text: tokens[wordIndex]!,
          confidence: fallbackConfidence / 100,
          boundingBox: normalizeBoundingBox({
            x: 0.06 + (wordIndex / Math.max(1, tokens.length)) * 0.86,
            y: 0.04 + (lineIndex / Math.max(1, lines.length)) * 0.9,
            width: Math.max(0.015, 0.82 / Math.max(1, tokens.length)),
            height: Math.max(0.008, 0.75 / Math.max(1, lines.length))
          })
        })
      }
    }
  }
  return contentFromPositionedWords(positioned, page, 'ocr', 'ocr')
}

function normalizeFallbackLine(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}

async function ensureOcrWorker(): Promise<OcrWorker> {
  if (ocrWorker) return ocrWorker
  const logger = (message: LoggerMessage): void => {
    const context = ocrProgressContext
    if (!context) return
    const recognizing = message.status === 'recognizing text'
    const base = (context.page - 1) / context.totalPages
    const pageShare = 1 / context.totalPages
    progress(
      recognizing ? 'recognizing' : 'loading-ocr',
      0.12 + (base + pageShare * Math.max(0, Math.min(1, message.progress))) * 0.78,
      recognizing
        ? `Reading page ${context.page} locally…`
        : 'Loading the bundled English OCR model…',
      context.page,
      context.totalPages
    )
  }
  ocrWorker = await createWorker('eng', OEM.LSTM_ONLY, {
    workerPath: assetUrl('/ocr/worker.min.js'),
    corePath: assetUrl('/ocr/core'),
    langPath: assetUrl('/ocr/lang'),
    workerBlobURL: false,
    cacheMethod: 'none',
    gzip: true,
    logger
  })
  await ocrWorker.setParameters({
    tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
    preserve_interword_spaces: '1'
  })
  return ocrWorker
}

async function ensurePlanScanRuntime(): Promise<PlanScanRuntime> {
  if (planScanRuntime) return planScanRuntime
  const [configurationResponse, weightsResponse] = await Promise.all([
    fetch(assetUrl('/planscan/planscan-v0.1-int8.json')),
    fetch(assetUrl('/planscan/planscan-v0.1-int8.bin.gz'))
  ])
  if (!configurationResponse.ok || !weightsResponse.ok) {
    throw new Error('The bundled PlanScan artifacts are unavailable')
  }
  const [configuration, weights] = await Promise.all([
    configurationResponse.json(),
    weightsResponse.arrayBuffer()
  ])
  planScanRuntime = await PlanScanRuntime.create(configuration, new Uint8Array(weights))
  return planScanRuntime
}

async function recognizeCanvasOnce(
  canvas: OffscreenCanvas,
  page: number,
  totalPages: number,
  segmentation: PSM
): Promise<DocumentTextContent> {
  ocrProgressContext = { page, totalPages }
  const worker = await ensureOcrWorker()
  await worker.setParameters({ tessedit_pageseg_mode: segmentation })
  const result = await worker.recognize(canvas, { rotateAuto: false }, { text: true, blocks: true })
  return ocrContent(
    result.data.blocks,
    result.data.text,
    result.data.confidence,
    page,
    canvas.width,
    canvas.height
  )
}

async function recognizeCanvasLayout(
  canvas: OffscreenCanvas,
  page: number,
  totalPages: number
): Promise<DocumentTextContent> {
  let content = await recognizeCanvasOnce(canvas, page, totalPages, PSM.SINGLE_BLOCK)
  if (shouldRetryOcrPageSegmentation(content)) {
    const layout = await recognizeCanvasOnce(canvas, page, totalPages, PSM.AUTO)
    if (isBetterCalendarGridContent(layout, content)) content = layout
  }
  return content
}

function rotatedCanvas(source: OffscreenCanvas, rotation: 90 | 180 | 270): OffscreenCanvas {
  const swapsDimensions = rotation === 90 || rotation === 270
  const canvas = new OffscreenCanvas(
    swapsDimensions ? source.height : source.width,
    swapsDimensions ? source.width : source.height
  )
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('Could not create an OCR rotation canvas')
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  if (rotation === 90) {
    context.translate(canvas.width, 0)
    context.rotate(Math.PI / 2)
  } else if (rotation === 180) {
    context.translate(canvas.width, canvas.height)
    context.rotate(Math.PI)
  } else {
    context.translate(0, canvas.height)
    context.rotate(-Math.PI / 2)
  }
  context.drawImage(source, 0, 0)
  return canvas
}

async function recognizeCanvas(
  canvas: OffscreenCanvas,
  page: number,
  totalPages: number
): Promise<OcrCanvasResult> {
  const initial: OcrCanvasResult = {
    canvas,
    content: await recognizeCanvasLayout(canvas, page, totalPages),
    rotation: 0
  }
  if (!shouldRetryOcrOrientation(initial.content)) return initial

  let best = initial
  const created: OffscreenCanvas[] = []
  for (const rotation of [90, 270, 180] as const) {
    const candidateCanvas = rotatedCanvas(canvas, rotation)
    created.push(candidateCanvas)
    const candidate: OcrCanvasResult = {
      canvas: candidateCanvas,
      content: await recognizeCanvasLayout(candidateCanvas, page, totalPages),
      rotation
    }
    if (isBetterOcrContent(candidate.content, best.content)) best = candidate
    if (best.rotation !== 0 && isStrongOcrOrientation(best.content)) break
  }
  for (const candidateCanvas of created) {
    if (candidateCanvas !== best.canvas) candidateCanvas.width = candidateCanvas.height = 0
  }
  return best
}

async function renderPdfPage(
  page: Awaited<ReturnType<Awaited<ReturnType<typeof getDocument>['promise']>['getPage']>>,
  maximumDimension: number
): Promise<OffscreenCanvas> {
  const baseViewport = page.getViewport({ scale: 1 })
  const scale = canvasScale(baseViewport.width, baseViewport.height, maximumDimension)
  const viewport = page.getViewport({ scale })
  const canvas = new OffscreenCanvas(
    Math.max(1, Math.ceil(viewport.width)),
    Math.max(1, Math.ceil(viewport.height))
  )
  await page.render({
    canvas: canvas as unknown as HTMLCanvasElement,
    viewport,
    background: '#ffffff'
  }).promise
  return canvas
}

function assertContentLimits(pages: readonly DocumentPage[]): void {
  const wordCount = pages.reduce((total, page) => total + page.words.length, 0)
  if (wordCount > maximumDocumentWords) {
    throw new Error(
      'This document contains too many words; import a smaller section (12,000 words maximum).'
    )
  }
  const characterCount = pages.reduce(
    (total, page) =>
      total + page.blocks.reduce((pageTotal, block) => pageTotal + block.text.length, 0),
    0
  )
  if (characterCount > maximumDocumentCharacters) {
    throw new Error('This document contains too much text; import a smaller section.')
  }
}

async function extractPdf(selection: DocumentSelection): Promise<{
  pages: DocumentPage[]
  warnings: string[]
}> {
  const loadingTask = getDocument({
    data: new Uint8Array(selection.bytes),
    CanvasFactory: OffscreenPdfCanvasFactory,
    cMapUrl: assetUrl('/document/cmaps/'),
    cMapPacked: true,
    disableFontFace: true,
    standardFontDataUrl: assetUrl('/document/standard_fonts/'),
    wasmUrl: assetUrl('/document/wasm/'),
    useWorkerFetch: true,
    useSystemFonts: true,
    maxImageSize: maximumDocumentImagePixels,
    stopAtErrors: true
  })
  const document = await loadingTask.promise
  if (document.numPages > maximumDocumentPages) {
    await loadingTask.destroy()
    throw new Error(`PDFs are limited to ${maximumDocumentPages} pages for safe local processing.`)
  }
  const pages: DocumentPage[] = []
  const warnings: string[] = []
  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      progress(
        'extracting-native',
        0.05 + ((pageNumber - 1) / document.numPages) * 0.18,
        `Checking page ${pageNumber} for embedded text…`,
        pageNumber,
        document.numPages
      )
      const page = await document.getPage(pageNumber)
      const viewport = page.getViewport({ scale: 1 })
      const textContent = await page.getTextContent({ disableNormalization: false })
      const nativeCharacters = textContent.items.reduce(
        (total, item) =>
          total + (item && typeof item === 'object' && 'str' in item ? item.str.trim().length : 0),
        0
      )
      const native = contentFromPositionedWords(
        positionedNativeWords(textContent.items, viewport),
        pageNumber,
        'native-text',
        'native'
      )
      progress(
        'rendering',
        0.2 + ((pageNumber - 1) / document.numPages) * 0.2,
        `Rendering a private preview of page ${pageNumber}…`,
        pageNumber,
        document.numPages
      )
      const ocrDecision = decideNativePageOcr(nativeCharacters, native)
      const needsOcr = ocrDecision.needsOcr
      const rendered = await renderPdfPage(
        page,
        needsOcr ? ocrMaximumDimension : reviewMaximumDimension
      )
      let combined = native
      let displayCanvas = rendered
      let additionalRotation: 0 | 90 | 180 | 270 = 0
      let extraction: DocumentPage['extraction'] = 'native-text'
      if (needsOcr) {
        const ocr = await recognizeCanvas(rendered, pageNumber, document.numPages)
        if (ocr.content.words.length > 0) {
          combined = ocr.content
          displayCanvas = ocr.canvas
          additionalRotation = ocr.rotation
          extraction = 'ocr'
        }
        const reason =
          ocrDecision.reason === 'isolated-native-text'
            ? 'its embedded text covered only an isolated part of the page'
            : ocrDecision.reason === 'weak-positioned-text'
              ? 'its embedded text could not be positioned reliably'
              : 'its embedded text was sparse'
        warnings.push(`Page ${pageNumber} used the bundled OCR model because ${reason}.`)
        if (additionalRotation !== 0) {
          warnings.push(
            `OCR rotated page ${pageNumber} by ${additionalRotation} degrees to recover readable text.`
          )
        }
      }
      if (combined.words.length > 5_000 || combined.blocks.length > 1_000) {
        throw new Error(`Page ${pageNumber} contains too much text to review safely.`)
      }
      const thumbnail =
        Math.max(displayCanvas.width, displayCanvas.height) > thumbnailMaximumDimension
          ? thumbnailFromCanvas(displayCanvas)
          : displayCanvas
      const swapsDimensions = additionalRotation === 90 || additionalRotation === 270
      pages.push({
        page: pageNumber,
        width: swapsDimensions ? viewport.height : viewport.width,
        height: swapsDimensions ? viewport.width : viewport.height,
        rotation: (page.rotate + additionalRotation) % 360,
        extraction,
        nativeCharacterCount: nativeCharacters,
        thumbnailDataUrl: await canvasDataUrl(thumbnail),
        reviewImageDataUrl: await reviewImageDataUrl(displayCanvas),
        words: combined.words,
        blocks: combined.blocks
      })
      assertContentLimits(pages)
      page.cleanup()
    }
  } finally {
    await loadingTask.destroy()
  }
  return { pages, warnings }
}

async function extractImage(selection: DocumentSelection): Promise<{
  pages: DocumentPage[]
  warnings: string[]
}> {
  const bytes = new Uint8Array(selection.bytes)
  const validation = validateDocumentBytes(bytes)
  if (validation.kind !== 'image' || !validation.dimensions) {
    throw new Error('The selected file is not a supported image')
  }
  progress('rendering', 0.12, 'Preparing a private image preview…', 1, 1)
  const bitmap = await createImageBitmap(new Blob([bytes], { type: validation.mediaType }))
  try {
    const scale = canvasScale(bitmap.width, bitmap.height, ocrMaximumDimension)
    const canvas = new OffscreenCanvas(
      Math.max(1, Math.round(bitmap.width * scale)),
      Math.max(1, Math.round(bitmap.height * scale))
    )
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Could not create an image canvas')
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const ocr = await recognizeCanvas(canvas, 1, 1)
    const thumbnail = thumbnailFromCanvas(ocr.canvas)
    const swapsDimensions = ocr.rotation === 90 || ocr.rotation === 270
    const page: DocumentPage = {
      page: 1,
      width: swapsDimensions ? validation.dimensions.height : validation.dimensions.width,
      height: swapsDimensions ? validation.dimensions.width : validation.dimensions.height,
      rotation: ocr.rotation,
      extraction: 'ocr',
      nativeCharacterCount: 0,
      thumbnailDataUrl: await canvasDataUrl(thumbnail),
      reviewImageDataUrl: await reviewImageDataUrl(ocr.canvas),
      words: ocr.content.words,
      blocks: ocr.content.blocks
    }
    assertContentLimits([page])
    return {
      pages: [page],
      warnings: [
        'Images have no embedded text, so the bundled English OCR model read the pixels.',
        ...(ocr.rotation === 0
          ? []
          : [`OCR rotated the image by ${ocr.rotation} degrees to recover readable text.`])
      ]
    }
  } finally {
    bitmap.close()
  }
}

function friendlyError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Local document processing failed'
  if (/password/iu.test(message))
    return 'Password-protected PDFs are not supported. Unlock a copy and try again.'
  if (/invalid pdf|bad xref|missing pdf/iu.test(message)) {
    return 'This PDF appears damaged or incomplete. Export a fresh copy and try again.'
  }
  if (/image.*decode|could not.*image|invalidstateerror/iu.test(message)) {
    return 'This image could not be decoded. Export it as PNG or JPEG and try again.'
  }
  return message.slice(0, 1_000)
}

async function analyze(input: AnalyzeMessage): Promise<void> {
  const startedAt = performance.now()
  progress('validating', 0.02, 'Validating the file on this device…', null, null)
  const selection = documentSelectionSchema.parse(input.selection)
  validateDocumentBytes(new Uint8Array(selection.bytes))
  const extracted =
    selection.source.kind === 'pdf' ? await extractPdf(selection) : await extractImage(selection)
  progress(
    'planning',
    0.93,
    'Linking dates, titles, and times with the local PlanScan model…',
    null,
    extracted.pages.length
  )
  let planScan = null
  try {
    planScan = (await ensurePlanScanRuntime()).analyze(extracted.pages)
    extracted.warnings.push(...planScan.warnings)
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'PlanScan could not load'
    extracted.warnings.push(
      `The learned document model was unavailable, so review uses the deterministic layout rules. ${reason}`
    )
  }
  progress('complete', 1, 'Evidence and text are ready for review.', null, extracted.pages.length)
  post({
    type: 'result',
    extraction: documentExtractionSchema.parse({
      source: selection.source,
      pages: extracted.pages,
      planScan,
      warnings: extracted.warnings,
      processingDurationMs: Math.round(performance.now() - startedAt)
    })
  })
}

workerScope.onmessage = (event: MessageEvent<unknown>) => {
  const input = event.data
  if (!input || typeof input !== 'object' || !('type' in input) || input.type !== 'analyze') {
    post({ type: 'error', message: 'The document worker received an invalid request.' })
    return
  }
  void analyze(input as AnalyzeMessage)
    .catch((error: unknown) => post({ type: 'error', message: friendlyError(error) }))
    .finally(async () => {
      ocrProgressContext = null
      if (ocrWorker) await ocrWorker.terminate().catch(() => undefined)
      ocrWorker = null
    })
}

export {}
