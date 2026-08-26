import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { documentExtractionSchema, type DocumentPage } from '@remind-me/contracts'
import {
  contentFromPositionedWords,
  planDocumentExtraction,
  PlanScanRuntime,
  positionedNativeWords
} from '@remind-me/importers/document'

const inputPath = process.argv[2] ? resolve(process.argv[2]) : null
const showBlocks = process.argv.includes('--blocks')
const showGroups = process.argv.includes('--groups')
if (!inputPath) throw new Error('Usage: pnpm document:inspect <path-to-native-pdf>')
const bytes = await readFile(inputPath)
const loadingTask = getDocument({ data: Uint8Array.from(bytes) })
const pdf = await loadingTask.promise
const pages: DocumentPage[] = []
try {
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber)
    const viewport = page.getViewport({ scale: 1 })
    const textContent = await page.getTextContent({ disableNormalization: false })
    const content = contentFromPositionedWords(
      positionedNativeWords(textContent.items, viewport),
      pageNumber,
      'native-text',
      'inspect'
    )
    pages.push({
      page: pageNumber,
      width: viewport.width,
      height: viewport.height,
      rotation: page.rotate,
      extraction: 'native-text',
      nativeCharacterCount: textContent.items.reduce(
        (total, item) =>
          total + (item && typeof item === 'object' && 'str' in item ? item.str.trim().length : 0),
        0
      ),
      thumbnailDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
      ...content
    })
    page.cleanup()
  }
} finally {
  await loadingTask.destroy()
}

const modelRoot = resolve(process.cwd(), 'models', 'planscan')
const [configuration, compressedWeights] = await Promise.all([
  readFile(resolve(modelRoot, 'planscan-v0.1-int8.json'), 'utf8'),
  readFile(resolve(modelRoot, 'planscan-v0.1-int8.bin.gz'))
])
const planScan = await PlanScanRuntime.create(JSON.parse(configuration), compressedWeights)
const extraction = documentExtractionSchema.parse({
  source: {
    id: `document:inspect:${createHash('sha256').update(bytes).digest('hex').slice(0, 20)}`,
    kind: 'pdf',
    displayName: basename(inputPath),
    mediaType: 'application/pdf',
    byteLength: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex')
  },
  pages,
  planScan: planScan.analyze(pages),
  warnings: [],
  processingDurationMs: 0
})
const currentDate = new Date().toISOString().slice(0, 10)
const analysis = planDocumentExtraction(extraction, {
  selectionId: extraction.source.id,
  nowUtc: new Date().toISOString(),
  localDate: currentDate,
  timezone: 'America/Chicago',
  locale: 'en-US',
  defaultCalendarId: 'calendar:inspect',
  defaultEventDurationMinutes: 60,
  events: [],
  reminders: []
})

console.log(
  JSON.stringify(
    {
      source: extraction.source.displayName,
      pages: pages.length,
      words: pages.reduce((total, page) => total + page.words.length, 0),
      blocks: pages.reduce((total, page) => total + page.blocks.length, 0),
      blockDetails: showBlocks
        ? pages.flatMap((page) =>
            page.blocks.map((block) => ({
              id: block.id,
              text: block.text,
              box: block.boundingBox
            }))
          )
        : undefined,
      planScanGroups: extraction.planScan?.groups.length ?? 0,
      planScanGroupDetails: showGroups ? extraction.planScan?.groups : undefined,
      drafts: analysis.drafts.map((draft) => ({
        kind: draft.kind,
        form: draft.form,
        schedule: draft.schedule,
        proposedWhen: draft.proposal.fields.when?.value ?? null,
        confidence: draft.confidence,
        warnings: draft.warnings
      })),
      skippedCandidateCount: analysis.skippedCandidateCount,
      duplicateCandidateCount: analysis.duplicateCandidateCount,
      existingCalendarDuplicateCount: analysis.existingCalendarDuplicateCount,
      plannerWarnings: analysis.plannerWarnings
    },
    null,
    2
  )
)
