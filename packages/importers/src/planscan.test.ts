import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { documentPageSchema, planScanAnalysisSchema, type DocumentPage } from '@remind-me/contracts'
import { contentFromPositionedWords, type PositionedDocumentWord } from './document-text-layout'
import { PlanScanRuntime } from './planscan'

const modelRoot = fileURLToPath(new URL('../../../models/planscan/', import.meta.url))
const fixturePath = fileURLToPath(
  new URL('../../../fixtures/planscan/heldout.v0.1.jsonl', import.meta.url)
)

let runtime: PlanScanRuntime
let pages: Array<{ page: DocumentPage; gold: { groups: unknown[] } }>

beforeAll(async () => {
  const [configuration, compressed, fixtures] = await Promise.all([
    readFile(`${modelRoot}planscan-v0.1-int8.json`, 'utf8'),
    readFile(`${modelRoot}planscan-v0.1-int8.bin.gz`),
    readFile(fixturePath, 'utf8')
  ])
  runtime = await PlanScanRuntime.create(JSON.parse(configuration), compressed)
  pages = fixtures
    .trim()
    .split('\n')
    .slice(0, 8)
    .map((line) => JSON.parse(line) as { page: DocumentPage; gold: { groups: unknown[] } })
})

describe('PlanScan browser-safe runtime', () => {
  it('loads a bounded, scratch-trained INT8 spatial graph model', () => {
    expect(runtime.info).toMatchObject({
      available: true,
      parameterCount: 5_242_880,
      mode: 'evidence-gated-spatial-graph',
      teacherUsed: false,
      networkRequired: false
    })
    expect(runtime.info.modelBytes).toBeLessThan(64 * 1024)
    expect(runtime.info.workingSetBytes).toBe(5_242_880)
  })

  it('projects predictions to exact source spans and evidence-backed groups', () => {
    for (const fixture of pages) {
      const page = documentPageSchema.parse(fixture.page)
      const analysis = planScanAnalysisSchema.parse(runtime.analyze([page]))
      expect(analysis.blockPredictions).toHaveLength(page.blocks.length)
      expect(analysis.groups).toHaveLength(fixture.gold.groups.length)
      const blocks = new Map(page.blocks.map((block) => [block.id, block]))
      for (const span of analysis.spans) {
        const source = blocks.get(span.blockId)
        expect(source?.text.slice(span.start, span.end)).toBe(span.text)
        expect(span.wordIds.every((id) => source?.wordIds.includes(id))).toBe(true)
      }
      expect(analysis.groups.every((group) => group.evidenceBlockIds.length >= 3)).toBe(true)
    }
  })

  it('produces deterministic predictions for the same positioned page', () => {
    const page = documentPageSchema.parse(pages[0]?.page)
    const first = runtime.analyze([page])
    const second = runtime.analyze([page])

    expect({ ...first, processingDurationMs: 0 }).toEqual({
      ...second,
      processingDurationMs: 0
    })
  })

  it('does not borrow a time from the next aligned table row after an ARR class', () => {
    const words: PositionedDocumentWord[] = []
    const add = (text: string, x: number, y: number): void => {
      let cursor = x
      for (const token of text.split(/\s+/u)) {
        const width = Math.max(0.008, token.length * 0.0052)
        words.push({
          text: token,
          confidence: 1,
          boundingBox: { x: cursor, y, width, height: 0.012 }
        })
        cursor += width + 0.004
      }
    }
    add('Title', 0.05, 0.08)
    add('Course Details', 0.26, 0.08)
    add('Meeting Times', 0.58, 0.08)
    add('Jazz History', 0.05, 0.12)
    add('MUS 114 0', 0.26, 0.12)
    add('08/24/2026 - 12/04/2026', 0.58, 0.12)
    add('Chicago Online Section ARR', 0.58, 0.14)
    add('Data Structures', 0.05, 0.2)
    add('CS 251 AL3', 0.26, 0.2)
    add('08/24/2026 - 12/04/2026', 0.58, 0.2)
    add('Monday Wednesday Friday', 0.58, 0.22)
    add('02:00 PM - 02:50 PM', 0.58, 0.24)
    add('Research Center 1426', 0.58, 0.26)
    const content = contentFromPositionedWords(words, 1, 'native-text', 'planscan-row-guard')
    const page = documentPageSchema.parse({
      page: 1,
      width: 612,
      height: 792,
      rotation: 0,
      extraction: 'native-text',
      nativeCharacterCount: 240,
      thumbnailDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
      ...content
    })
    const analysis = runtime.analyze([page])
    const spans = new Map(analysis.spans.map((span) => [span.id, span]))
    const titledGroups = analysis.groups.map((group) => ({
      title: spans.get(group.titleSpanId)?.text,
      time: group.timeSpanId ? spans.get(group.timeSpanId)?.text : null
    }))

    expect(titledGroups).toContainEqual({
      title: 'Data Structures',
      time: '02:00 PM - 02:50 PM'
    })
    expect(titledGroups).not.toContainEqual({
      title: 'Jazz History',
      time: '02:00 PM - 02:50 PM'
    })
  })
})
