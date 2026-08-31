import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { createWorker, OEM, PSM, type Worker as OcrWorker } from 'tesseract.js'
import {
  documentExtractionSchema,
  type DocumentExtraction,
  type DocumentImportDraft,
  type DocumentPage
} from '@remind-me/contracts'
import {
  contentFromPositionedWords,
  decideNativePageOcr,
  isBetterCalendarGridContent,
  isBetterOcrContent,
  isStrongOcrOrientation,
  normalizeBoundingBox,
  planDocumentExtraction,
  PlanScanRuntime,
  positionedNativeWords,
  shouldRetryOcrPageSegmentation,
  shouldRetryOcrOrientation,
  validateDocumentBytes,
  type DocumentTextContent,
  type PositionedDocumentWord
} from '@remind-me/importers/document'
import {
  countTaxonomy,
  documentEvalCorpusRecordSchema,
  documentEvalManifestSchema,
  formatDocumentEvaluationMarkdown,
  scoreDocumentEvaluation,
  type DocumentEvalCorpusRecord,
  type DocumentEvalManifest,
  type DocumentEvalObservation,
  type DocumentEvalObservedItem
} from '../../../scripts/document-evaluation'

const execFileAsync = promisify(execFile)
const workspace = resolve(import.meta.dirname, '../../..')
const corpusPath = resolve(workspace, 'evals/documents/v0.1/corpus.jsonl')
const manifestPath = resolve(workspace, 'evals/documents/v0.1/manifest.json')
const reportDirectory = resolve(workspace, 'evals/documents/reports')
const reportJsonPath = resolve(reportDirectory, 'document-baseline.latest.json')
const reportMarkdownPath = resolve(reportDirectory, 'document-baseline.latest.md')
const observationsPath = resolve(reportDirectory, 'observations.latest.jsonl')
const modelRoot = resolve(workspace, 'models/planscan')
const ocrLanguagePath = resolve(workspace, 'apps/desktop/.generated-public/ocr/lang')
const documentAssetRoot = resolve(workspace, 'apps/desktop/.generated-public/document')
const fixtureRoot = resolve(workspace, 'fixtures/documents')
const maximumOcrDimension = 2_200
const fixedNowUtc = '2026-08-24T15:00:00.000Z'
const fixedLocalDate = '2026-08-24'

function directoryUrl(path: string): string {
  return pathToFileURL(`${resolve(path)}${sep}`).href
}

const pdfDocumentOptions = {
  cMapUrl: directoryUrl(resolve(documentAssetRoot, 'cmaps')),
  cMapPacked: true,
  standardFontDataUrl: directoryUrl(resolve(documentAssetRoot, 'standard_fonts')),
  wasmUrl: directoryUrl(resolve(documentAssetRoot, 'wasm')),
  useSystemFonts: true
} as const

interface Options {
  check: boolean
  freeze: boolean
  noWrite: boolean
  fixtureId: string | null
}

interface OcrContext {
  worker: OcrWorker
  temporaryDirectory: string
}

interface RecognizedImage {
  content: DocumentTextContent
  width: number
  height: number
  rotation: 0 | 90 | 180 | 270
}

function options(): Options {
  const fixture = process.argv.find((argument) => argument.startsWith('--case='))
  return {
    check: process.argv.includes('--check'),
    freeze: process.argv.includes('--freeze'),
    noWrite: process.argv.includes('--no-write'),
    fixtureId: fixture?.slice('--case='.length) || null
  }
}

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function loadCorpus(): Promise<{ raw: string; records: DocumentEvalCorpusRecord[] }> {
  const raw = await readFile(corpusPath, 'utf8')
  const records = raw
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return documentEvalCorpusRecordSchema.parse(JSON.parse(line))
      } catch (error) {
        throw new Error(`Invalid document corpus row ${index + 1}: ${String(error)}`, {
          cause: error
        })
      }
    })
  const ids = records.map((record) => record.id)
  if (new Set(ids).size !== ids.length)
    throw new Error('Document corpus fixture IDs must be unique')
  const paths = records.map((record) => record.fixture)
  if (new Set(paths).size !== paths.length)
    throw new Error('Document corpus fixture paths must be unique')
  return { raw, records }
}

function fixturePath(record: DocumentEvalCorpusRecord): string {
  const path = resolve(workspace, record.fixture)
  const expectedPrefix = `${fixtureRoot}${sep}`.toLocaleLowerCase()
  if (!path.toLocaleLowerCase().startsWith(expectedPrefix)) {
    throw new Error(`Fixture escaped the document fixture root: ${record.fixture}`)
  }
  return path
}

async function inspectPageCount(
  record: DocumentEvalCorpusRecord,
  bytes: Uint8Array
): Promise<number> {
  if (record.sourceKind === 'image') return 1
  const loadingTask = getDocument({ data: Uint8Array.from(bytes), ...pdfDocumentOptions })
  try {
    const pdf = await loadingTask.promise
    return pdf.numPages
  } finally {
    await loadingTask.destroy().catch(() => undefined)
  }
}

async function createManifest(
  rawCorpus: string,
  records: readonly DocumentEvalCorpusRecord[]
): Promise<DocumentEvalManifest> {
  const fixtureDigests: Record<string, string> = {}
  for (const record of records) {
    const path = fixturePath(record)
    const bytes = await readFile(path)
    const validation = validateDocumentBytes(bytes)
    if (validation.kind !== record.sourceKind || validation.mediaType !== record.mediaType) {
      throw new Error(
        `${record.id} is ${validation.kind}/${validation.mediaType}, expected ${record.sourceKind}/${record.mediaType}`
      )
    }
    const pageCount = await inspectPageCount(record, bytes)
    if (pageCount !== record.pageCount) {
      throw new Error(`${record.id} has ${pageCount} page(s), expected ${record.pageCount}`)
    }
    fixtureDigests[record.fixture] = sha256(bytes)
  }
  return documentEvalManifestSchema.parse({
    schemaVersion: 1,
    suiteVersion: '0.1.0',
    corpusPath: 'evals/documents/v0.1/corpus.jsonl',
    corpusSha256: sha256(rawCorpus),
    records: records.length,
    sourceGroups: new Set(records.map((record) => record.sourceGroupId)).size,
    expectedItems: records.reduce((total, record) => total + record.expectedItems.length, 0),
    expectedSkips: records.reduce((total, record) => total + record.expectedSkips.length, 0),
    humanBlindRecords: records.filter((record) => record.independentHumanBlind).length,
    trainingExcluded: true,
    frozen: true,
    fixtureDigests: Object.fromEntries(
      Object.entries(fixtureDigests).sort(([left], [right]) => left.localeCompare(right))
    ),
    taxonomy: countTaxonomy(records)
  })
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

async function verifyOrFreezeCorpus(freeze: boolean): Promise<DocumentEvalCorpusRecord[]> {
  const { raw, records } = await loadCorpus()
  const actual = await createManifest(raw, records)
  if (freeze) {
    await mkdir(dirname(manifestPath), { recursive: true })
    await writeFile(manifestPath, `${JSON.stringify(actual, null, 2)}\n`, 'utf8')
  } else {
    const expected = documentEvalManifestSchema.parse(
      JSON.parse(await readFile(manifestPath, 'utf8'))
    )
    if (stableJson(actual) !== stableJson(expected)) {
      throw new Error(
        'Document evaluation corpus or fixture digests changed; review and freeze it again'
      )
    }
  }
  return records
}

function cleanWord(text: string): string {
  return text.replace(/\s+/gu, ' ').trim().slice(0, 200)
}

function contentFromOcr(
  blocks: Awaited<ReturnType<OcrWorker['recognize']>>['data']['blocks'],
  page: number,
  width: number,
  height: number
): DocumentTextContent {
  const words: PositionedDocumentWord[] = []
  for (const block of blocks ?? []) {
    for (const paragraph of block.paragraphs) {
      for (const line of paragraph.lines) {
        for (const word of line.words) {
          const text = cleanWord(word.text)
          if (!text) continue
          words.push({
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
  return contentFromPositionedWords(words, page, 'ocr', 'eval-ocr')
}

async function recognizeImageOnce(
  path: string,
  page: number,
  width: number,
  height: number,
  worker: OcrWorker,
  segmentation: PSM
): Promise<DocumentTextContent> {
  await worker.setParameters({ tessedit_pageseg_mode: segmentation })
  const result = await worker.recognize(path, { rotateAuto: false }, { text: true, blocks: true })
  return contentFromOcr(result.data.blocks, page, width, height)
}

async function recognizeImageLayout(
  path: string,
  page: number,
  width: number,
  height: number,
  worker: OcrWorker
): Promise<DocumentTextContent> {
  let content = await recognizeImageOnce(path, page, width, height, worker, PSM.SINGLE_BLOCK)
  if (shouldRetryOcrPageSegmentation(content)) {
    const layout = await recognizeImageOnce(path, page, width, height, worker, PSM.AUTO)
    if (isBetterCalendarGridContent(layout, content)) content = layout
  }
  return content
}

async function rotatedImage(
  inputPath: string,
  page: number,
  rotation: 90 | 180 | 270,
  temporaryDirectory: string
): Promise<{ path: string; width: number; height: number }> {
  const image = await loadImage(inputPath)
  const swapsDimensions = rotation === 90 || rotation === 270
  const canvas = createCanvas(
    swapsDimensions ? image.height : image.width,
    swapsDimensions ? image.width : image.height
  )
  const context = canvas.getContext('2d')
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
  context.drawImage(image, 0, 0)
  const outputPath = join(temporaryDirectory, `ocr-page-${page}-rotate-${rotation}.png`)
  await writeFile(outputPath, canvas.toBuffer('image/png'))
  return { path: outputPath, width: canvas.width, height: canvas.height }
}

async function recognizeImage(
  path: string,
  page: number,
  width: number,
  height: number,
  ocr: OcrContext
): Promise<RecognizedImage> {
  const initial: RecognizedImage = {
    content: await recognizeImageLayout(path, page, width, height, ocr.worker),
    width,
    height,
    rotation: 0
  }
  if (!shouldRetryOcrOrientation(initial.content)) return initial

  let best = initial
  for (const rotation of [90, 270, 180] as const) {
    const rotated = await rotatedImage(path, page, rotation, ocr.temporaryDirectory)
    const candidate: RecognizedImage = {
      content: await recognizeImageLayout(
        rotated.path,
        page,
        rotated.width,
        rotated.height,
        ocr.worker
      ),
      width: rotated.width,
      height: rotated.height,
      rotation
    }
    if (isBetterOcrContent(candidate.content, best.content)) best = candidate
    if (best.rotation !== 0 && isStrongOcrOrientation(best.content)) break
  }
  return best
}

async function renderPdfPage(
  inputPath: string,
  page: number,
  temporaryDirectory: string
): Promise<string> {
  const prefix = join(temporaryDirectory, `page-${page}`)
  try {
    await execFileAsync('pdftoppm', [
      '-f',
      String(page),
      '-l',
      String(page),
      '-singlefile',
      '-png',
      '-scale-to',
      String(maximumOcrDimension),
      inputPath,
      prefix
    ])
  } catch (error) {
    throw new Error(
      `Raster PDF evaluation requires Poppler's pdftoppm. ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    )
  }
  return `${prefix}.png`
}

async function extractPdf(
  path: string,
  bytes: Uint8Array,
  ocr: OcrContext
): Promise<{ pages: DocumentPage[]; warnings: string[] }> {
  const loadingTask = getDocument({
    data: Uint8Array.from(bytes),
    stopAtErrors: true,
    ...pdfDocumentOptions
  })
  const pdf = await loadingTask.promise
  const pages: DocumentPage[] = []
  const warnings: string[] = []
  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber)
      const viewport = page.getViewport({ scale: 1 })
      const text = await page.getTextContent({ disableNormalization: false })
      const nativeCharacters = text.items.reduce(
        (total, item) =>
          total + (item && typeof item === 'object' && 'str' in item ? item.str.trim().length : 0),
        0
      )
      const native = contentFromPositionedWords(
        positionedNativeWords(text.items, viewport),
        pageNumber,
        'native-text',
        'eval-native'
      )
      let content = native
      let extraction: DocumentPage['extraction'] = 'native-text'
      const ocrDecision = decideNativePageOcr(nativeCharacters, native)
      let additionalRotation: 0 | 90 | 180 | 270 = 0
      let pageWidth = viewport.width
      let pageHeight = viewport.height
      if (ocrDecision.needsOcr) {
        const renderedPath = await renderPdfPage(path, pageNumber, ocr.temporaryDirectory)
        const renderedBytes = await readFile(renderedPath)
        const dimensions = validateDocumentBytes(renderedBytes).dimensions
        if (!dimensions) throw new Error(`Could not read rendered page ${pageNumber} dimensions`)
        const raster = await recognizeImage(
          renderedPath,
          pageNumber,
          dimensions.width,
          dimensions.height,
          ocr
        )
        content = raster.content
        extraction = 'ocr'
        additionalRotation = raster.rotation
        if (additionalRotation === 90 || additionalRotation === 270) {
          pageWidth = viewport.height
          pageHeight = viewport.width
        }
        const reason =
          ocrDecision.reason === 'isolated-native-text'
            ? 'isolated embedded text'
            : ocrDecision.reason === 'weak-positioned-text'
              ? 'unreliable embedded text positioning'
              : 'sparse embedded text'
        warnings.push(`Page ${pageNumber} used local OCR because of ${reason}.`)
        if (additionalRotation !== 0) {
          warnings.push(
            `OCR rotated page ${pageNumber} by ${additionalRotation} degrees to recover readable text.`
          )
        }
      }
      pages.push({
        page: pageNumber,
        width: pageWidth,
        height: pageHeight,
        rotation: (page.rotate + additionalRotation) % 360,
        extraction,
        nativeCharacterCount: nativeCharacters,
        thumbnailDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
        ...content
      })
      page.cleanup()
    }
  } finally {
    await loadingTask.destroy()
  }
  return { pages, warnings }
}

async function extractImage(
  path: string,
  bytes: Uint8Array,
  ocr: OcrContext
): Promise<{ pages: DocumentPage[]; warnings: string[] }> {
  const dimensions = validateDocumentBytes(bytes).dimensions
  if (!dimensions) throw new Error('Image fixture dimensions are unavailable')
  const recognized = await recognizeImage(path, 1, dimensions.width, dimensions.height, ocr)
  return {
    pages: [
      {
        page: 1,
        width: recognized.width,
        height: recognized.height,
        rotation: recognized.rotation,
        extraction: 'ocr',
        nativeCharacterCount: 0,
        thumbnailDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
        ...recognized.content
      }
    ],
    warnings: [
      'The direct image used the bundled offline English OCR model.',
      ...(recognized.rotation === 0
        ? []
        : [`OCR rotated the image by ${recognized.rotation} degrees to recover readable text.`])
    ]
  }
}

function observedDraft(draft: DocumentImportDraft): DocumentEvalObservedItem {
  const schedule = draft.schedule
    ? {
        courseCode: draft.schedule.courseCode,
        sectionCode: draft.schedule.sectionCode,
        crn: draft.schedule.crn,
        component: draft.schedule.component
      }
    : null
  if (draft.kind === 'event') {
    return {
      id: draft.id,
      page: draft.page,
      kind: 'event',
      title: draft.form.title,
      startDate: draft.form.startDate,
      endDate: draft.form.endDate,
      startTime: draft.form.startTime,
      endTime: draft.form.endTime,
      timezone: draft.form.timezone,
      allDay: draft.form.allDay,
      location: draft.form.location || null,
      recurrence: draft.form.recurrence,
      schedule,
      confidence: draft.confidence,
      attention: draft.attention,
      evidence: {
        title: draft.fieldEvidence.title.length > 0,
        when: draft.fieldEvidence.when.length > 0,
        location: draft.fieldEvidence.location.length > 0,
        description: draft.fieldEvidence.description.length > 0
      }
    }
  }
  return {
    id: draft.id,
    page: draft.page,
    kind: 'reminder',
    title: draft.form.title,
    startDate: draft.form.dueDate ?? '',
    endDate: null,
    startTime: draft.form.dueTime ?? '',
    endTime: null,
    timezone: draft.form.timezone,
    allDay: false,
    location: null,
    recurrence: draft.form.recurrence,
    schedule,
    confidence: draft.confidence,
    attention: draft.attention,
    evidence: {
      title: draft.fieldEvidence.title.length > 0,
      when: draft.fieldEvidence.when.length > 0,
      location: draft.fieldEvidence.location.length > 0,
      description: draft.fieldEvidence.description.length > 0
    }
  }
}

async function observeFixture(
  record: DocumentEvalCorpusRecord,
  runtime: PlanScanRuntime,
  ocr: OcrContext
): Promise<DocumentEvalObservation> {
  const startedAt = performance.now()
  const path = fixturePath(record)
  const bytes = await readFile(path)
  const sourceSha256 = sha256(bytes)
  try {
    const extracted =
      record.sourceKind === 'pdf'
        ? await extractPdf(path, bytes, ocr)
        : await extractImage(path, bytes, ocr)
    const extraction: DocumentExtraction = documentExtractionSchema.parse({
      source: {
        id: `document:eval:${record.id}`,
        kind: record.sourceKind,
        displayName: basename(path),
        mediaType: record.mediaType,
        byteLength: bytes.byteLength,
        sha256: sourceSha256
      },
      pages: extracted.pages,
      planScan: runtime.analyze(extracted.pages),
      warnings: extracted.warnings,
      processingDurationMs: Math.round(performance.now() - startedAt)
    })
    const analysis = planDocumentExtraction(extraction, {
      selectionId: extraction.source.id,
      nowUtc: fixedNowUtc,
      localDate: fixedLocalDate,
      timezone: record.timezone,
      locale: record.locale,
      defaultCalendarId: 'calendar:evaluation',
      defaultEventDurationMinutes: 60,
      events: [],
      reminders: []
    })
    return {
      fixtureId: record.id,
      sourceSha256,
      status: 'success',
      error: null,
      pages: extraction.pages.length,
      extractionMethods: extraction.pages.map((page) => page.extraction),
      processingDurationMs: Math.round(performance.now() - startedAt),
      items: analysis.drafts.map(observedDraft),
      skippedCandidateCount: analysis.skippedCandidateCount,
      duplicateCandidateCount: analysis.duplicateCandidateCount,
      existingCalendarDuplicateCount: analysis.existingCalendarDuplicateCount,
      warnings: analysis.plannerWarnings
    }
  } catch (error) {
    return {
      fixtureId: record.id,
      sourceSha256,
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
      pages: 0,
      extractionMethods: [],
      processingDurationMs: Math.round(performance.now() - startedAt),
      items: [],
      skippedCandidateCount: 0,
      duplicateCandidateCount: 0,
      existingCalendarDuplicateCount: 0,
      warnings: []
    }
  }
}

async function loadRuntime(): Promise<PlanScanRuntime> {
  const [configuration, weights] = await Promise.all([
    readFile(resolve(modelRoot, 'planscan-v0.1-int8.json'), 'utf8'),
    readFile(resolve(modelRoot, 'planscan-v0.1-int8.bin.gz'))
  ])
  return PlanScanRuntime.create(JSON.parse(configuration), weights)
}

async function main(): Promise<void> {
  const input = options()
  if (input.check && input.freeze) throw new Error('Choose either --check or --freeze')
  const records = await verifyOrFreezeCorpus(input.freeze)
  if (input.check || input.freeze) {
    const verb = input.freeze ? 'Froze' : 'Verified'
    console.log(
      `${verb} ${records.length} document fixtures across ${new Set(records.map((record) => record.sourceGroupId)).size} source groups with ${records.reduce((total, record) => total + record.expectedItems.length, 0)} expected proposals.`
    )
    return
  }

  const selected = input.fixtureId
    ? records.filter((record) => record.id === input.fixtureId)
    : records
  if (selected.length === 0) throw new Error(`Unknown document evaluation case: ${input.fixtureId}`)
  await readFile(resolve(ocrLanguagePath, 'eng.traineddata.gz'))
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'remind-me-document-eval-'))
  const runtime = await loadRuntime()
  const worker = await createWorker('eng', OEM.LSTM_ONLY, {
    langPath: ocrLanguagePath,
    cacheMethod: 'none',
    gzip: true,
    logger: () => undefined
  })
  await worker.setParameters({
    tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
    preserve_interword_spaces: '1'
  })
  const observations: DocumentEvalObservation[] = []
  try {
    for (const [index, record] of selected.entries()) {
      console.log(`[${index + 1}/${selected.length}] ${record.id}`)
      observations.push(await observeFixture(record, runtime, { worker, temporaryDirectory }))
    }
  } finally {
    await worker.terminate().catch(() => undefined)
    const resolvedTemporary = resolve(temporaryDirectory)
    const resolvedSystemTemporary = `${resolve(tmpdir())}${sep}`.toLocaleLowerCase()
    if (resolvedTemporary.toLocaleLowerCase().startsWith(resolvedSystemTemporary)) {
      await rm(resolvedTemporary, { recursive: true, force: true })
    }
  }
  const scoredRecords = input.fixtureId ? selected : records
  const report = scoreDocumentEvaluation(scoredRecords, observations)
  if (!input.noWrite) {
    await mkdir(reportDirectory, { recursive: true })
    await Promise.all([
      writeFile(reportJsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8'),
      writeFile(reportMarkdownPath, formatDocumentEvaluationMarkdown(report), 'utf8'),
      writeFile(
        observationsPath,
        `${observations.map((observation) => JSON.stringify(observation)).join('\n')}\n`,
        'utf8'
      )
    ])
  }
  console.log(
    `Scored ${report.coverage.scoredDocuments}/${report.coverage.corpusDocuments} documents: cardinality ${report.overall.precision?.toFixed(3) ?? 'n/a'} precision / ${report.overall.recall?.toFixed(3) ?? 'n/a'} recall, exact-item ${report.overall.exactRecall?.toFixed(3) ?? 'n/a'} recall, perfect ${report.overall.perfectDocuments}/${report.overall.documents}.`
  )
  if (report.coverage.erroredDocuments > 0) process.exitCode = 1
}

await main()
