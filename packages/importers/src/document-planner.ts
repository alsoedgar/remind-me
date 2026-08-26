import { Temporal } from '@js-temporal/polyfill'
import { parseCalendarText } from '@remind-me/assistant-core'
import { resolveCalendarIR } from '@remind-me/calendar-engine'
import {
  calendarIRDraftSchema,
  documentAnalysisSchema,
  documentImportDraftSchema,
  eventFormSchema,
  maximumDocumentDrafts,
  reminderFormSchema,
  type CalendarIRDraft,
  type DocumentAnalysis,
  type DocumentExtraction,
  type DocumentImportDraft,
  type DocumentScheduleMetadata,
  type DocumentTextBlock,
  type DocumentWord,
  type EventEntity,
  type ReminderEntity,
  type Weekday
} from '@remind-me/contracts'
import { splitPositionedLine } from './document-text-layout'

export interface DocumentPlanningContext {
  selectionId: string
  nowUtc: string
  localDate: string
  timezone: string
  locale: string
  defaultCalendarId: string
  defaultEventDurationMinutes: number
  events: readonly EventEntity[]
  reminders: readonly ReminderEntity[]
}

interface CandidateScheduleMetadata {
  courseCode: string
  sectionCode: string | null
  crn: string | null
  creditHours: number | null
  component: DocumentScheduleMetadata['component']
  termStartText: string
  termEndText: string
  weekdays: Weekday[]
  verification: DocumentScheduleMetadata['verification']
}

interface CandidateSeed {
  page: number
  blocks: DocumentTextBlock[]
  dateBlock: DocumentTextBlock
  timeBlock: DocumentTextBlock | null
  titleBlock: DocumentTextBlock
  locationBlock: DocumentTextBlock | null
  dateText: string
  timeText: string | null
  title: string
  description: string
  location: string
  kind: 'event' | 'reminder'
  allDay: boolean
  inferredTitle: boolean
  plannerSource: 'planscan' | 'rules'
  modelConfidence: number | null
  recurrenceBlock: DocumentTextBlock | null
  descriptionBlocks: DocumentTextBlock[]
  recurrenceText: string | null
  scheduleRow: boolean
  schedule: CandidateScheduleMetadata | null
}

interface ScheduleTableRegion {
  page: number
  startY: number
  endY: number
}

interface ScheduleTableCandidates {
  seeds: CandidateSeed[]
  skipped: number
  unscheduledRows: number
  regions: ScheduleTableRegion[]
}

const monthPattern =
  '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)'
const weekdayPattern = '(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)'
const datePatterns = [
  new RegExp(`\\b${monthPattern}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?\\b`, 'iu'),
  new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${monthPattern}(?:,?\\s+\\d{4})?\\b`, 'iu'),
  /\b\d{4}-\d{2}-\d{2}\b/u,
  /\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/u,
  new RegExp(`\\b(?:(?:this|next)\\s+)?${weekdayPattern}\\b`, 'iu'),
  /\b(?:today|tomorrow|day after tomorrow)\b/iu
] as const

const clockWithMinutes = '(?:[01]?\\d|2[0-3]):[0-5]\\d(?:\\s*[ap]\\.?m\\.?)?'
const clockWithMeridiem = '(?:0?[1-9]|1[0-2])(?::[0-5]\\d)?\\s*[ap]\\.?m\\.?'
const clockToken = `(?:${clockWithMinutes}|${clockWithMeridiem}|noon|midnight)`
const bareHourRange = `(?:0?[1-9]|1[0-2])\\s*(?:-|–|—|to|until)\\s*${clockWithMeridiem}`
const timePattern = new RegExp(
  `\\b(?:from\\s+)?(?:${bareHourRange}|${clockToken}(?:\\s*(?:-|–|—|to|until)\\s*${clockToken})?)\\b`,
  'iu'
)
const scheduleDateToken = `(?:\\d{4}-\\d{2}-\\d{2}|\\d{1,2}[/-]\\d{1,2}[/-]\\d{2,4}|${monthPattern}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?|\\d{1,2}(?:st|nd|rd|th)?\\s+${monthPattern}(?:,?\\s+\\d{4})?)`
const scheduleDateRangePattern = new RegExp(
  `\\b(${scheduleDateToken})\\s*(?:-|–|—|to|through|until)\\s*(${scheduleDateToken})\\b`,
  'iu'
)
const weekdayTokenPattern =
  /\b(?:mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b/giu

const genericHeadings = new Set([
  'agenda',
  'calendar',
  'dates',
  'events',
  'important dates',
  'plan',
  'schedule',
  'timeline'
])

function firstMatch(text: string, patterns: readonly RegExp[]): RegExpMatchArray | null {
  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (match) return match
  }
  return null
}

function dateMatch(text: string): RegExpMatchArray | null {
  return firstMatch(text, datePatterns)
}

function timeMatch(text: string): RegExpMatchArray | null {
  return text.match(timePattern)
}

function normalizeText(text: string): string {
  return text
    .replace(/(\d)\s*:\s*(\d)/gu, '$1:$2')
    .replace(/\s+/gu, ' ')
    .trim()
}

function isPageChrome(block: DocumentTextBlock): boolean {
  const inMargin = block.boundingBox.y < 0.06 || block.boundingBox.y > 0.94
  if (!inMargin) return false
  return (
    /^\d{1,2}[/-]\d{1,2}[/-]\d{2,4},?\s+\d{1,2}:\d{2}\s*[ap]m$/iu.test(normalizeText(block.text)) ||
    /^https?:\/\//iu.test(block.text) ||
    /^\d+\s*\/\s*\d+$/u.test(block.text)
  )
}

function cleanTitle(text: string, dateText: string, timeText: string | null): string {
  let title = text
  if (dateText) title = title.replace(dateText, ' ')
  if (timeText) title = title.replace(timeText, ' ')
  return normalizeText(
    title
      .replace(
        /^(?:please\s+)?(?:reminder|remind me|due|deadline|event|meeting|appointment)\s*[:\-–—]?\s*/iu,
        ''
      )
      .replace(/^(?:on|at|from|until|to)\b/iu, '')
      .replace(/\b(?:on|at|from|until)\s*$/iu, '')
      .replace(/^[\s|•·*#:_\-–—]+|[\s|•·*#:_\-–—]+$/gu, '')
  )
}

function isUsefulTitle(text: string): boolean {
  const normalized = normalizeText(text).toLocaleLowerCase()
  return (
    normalized.length >= 2 &&
    normalized.length <= 180 &&
    /[\p{L}\p{N}]/u.test(normalized) &&
    !genericHeadings.has(normalized) &&
    !dateMatch(normalized) &&
    !timeMatch(normalized)
  )
}

function locationValue(text: string): string | null {
  const labelled = /^(?:location|where|room|venue)\s*[:\-–—]\s*(.+)$/iu.exec(text)
  if (labelled?.[1]) return normalizeText(labelled[1])
  const atLocation = /^@\s*(.+)$/u.exec(text)
  return atLocation?.[1] ? normalizeText(atLocation[1]) : null
}

function weekdayList(text: string): Weekday[] {
  const matches = [...text.matchAll(weekdayTokenPattern)]
  if (matches.length > 0) {
    const residue = text
      .replace(weekdayTokenPattern, ' ')
      .replace(/\b(?:and|every|each)\b/giu, ' ')
      .replace(/[,&/+|·•\-–—\s]/gu, '')
    if (/[\p{L}\p{N}]/u.test(residue)) return []
    const weekdays = matches.map((match): Weekday => {
      const value = match[0].toLocaleLowerCase()
      if (value.startsWith('mon')) return 'monday'
      if (value.startsWith('tue')) return 'tuesday'
      if (value.startsWith('wed')) return 'wednesday'
      if (value.startsWith('thu')) return 'thursday'
      if (value.startsWith('fri')) return 'friday'
      if (value.startsWith('sat')) return 'saturday'
      return 'sunday'
    })
    return [...new Set(weekdays)]
  }

  const abbreviatedText = text
    .replace(/\b(?:and|every|each|on)\b/giu, '')
    .trim()
    .toLocaleUpperCase()
  const separatedTokens = abbreviatedText.split(/[,&/+|·•.\-–—\s]+/gu).filter(Boolean)
  const separatedCodes: Partial<Record<string, Weekday>> = {
    M: 'monday',
    MO: 'monday',
    T: 'tuesday',
    TU: 'tuesday',
    W: 'wednesday',
    WE: 'wednesday',
    R: 'thursday',
    TH: 'thursday',
    F: 'friday',
    FR: 'friday',
    S: 'saturday',
    SA: 'saturday',
    U: 'sunday',
    SU: 'sunday'
  }
  if (separatedTokens.length > 1 && separatedTokens.every((token) => separatedCodes[token])) {
    return [...new Set(separatedTokens.map((token) => separatedCodes[token]!))]
  }
  const compact = abbreviatedText.replace(/[,&/+|·•.\-–—\s]/gu, '').toLocaleUpperCase()
  if (!compact || !/^(?:M|T|W|R|F|S|U|MO|TU|WE|TH|FR|SA|SU)+$/u.test(compact)) return []
  const weekdays: Weekday[] = []
  let cursor = 0
  while (cursor < compact.length) {
    const pair = compact.slice(cursor, cursor + 2)
    if (pair === 'MO') weekdays.push('monday')
    else if (pair === 'TU') weekdays.push('tuesday')
    else if (pair === 'WE') weekdays.push('wednesday')
    else if (pair === 'TH') weekdays.push('thursday')
    else if (pair === 'FR') weekdays.push('friday')
    else if (pair === 'SA') weekdays.push('saturday')
    else if (pair === 'SU') weekdays.push('sunday')
    else {
      const token = compact[cursor]
      if (token === 'M') weekdays.push('monday')
      else if (token === 'T') weekdays.push('tuesday')
      else if (token === 'W') weekdays.push('wednesday')
      else if (token === 'R') weekdays.push('thursday')
      else if (token === 'F') weekdays.push('friday')
      else if (token === 'S') weekdays.push('saturday')
      else if (token === 'U') weekdays.push('sunday')
      else return []
      cursor += 1
      continue
    }
    cursor += 2
  }
  return [...new Set(weekdays)]
}

function scheduleLocation(text: string): string | null {
  const labelled = locationValue(text)
  if (labelled) return labelled
  const normalized = normalizeText(text)
  if (
    dateMatch(normalized) ||
    timeMatch(normalized) ||
    weekdayList(normalized).length > 0 ||
    normalized.length < 2 ||
    normalized.length > 220
  ) {
    return null
  }
  const locationCue =
    /\b(?:room|rm|hall|building|bldg|center|centre|ctr|campus|online|zoom|laboratory|lab|auditorium|library|studio|school|university|college|floor)\b/iu.test(
      normalized
    )
  const numberedRoom = /\b\d{2,5}[a-z]?\b/iu.test(normalized)
  const structuredAddress = normalized.split(',').length >= 3
  return locationCue || numberedRoom || structuredAddress ? normalized : null
}

interface PositionedSegment {
  lineId: string
  words: DocumentWord[]
  text: string
  x: number
  y: number
  width: number
  height: number
  block: DocumentTextBlock
}

function bestSourceBlock(
  blocks: readonly DocumentTextBlock[],
  words: readonly DocumentWord[]
): DocumentTextBlock | null {
  const ids = new Set(words.map((word) => word.id))
  return (
    blocks
      .map((block) => ({
        block,
        overlap: block.wordIds.filter((id) => ids.has(id)).length
      }))
      .filter((candidate) => candidate.overlap > 0)
      .sort(
        (left, right) =>
          right.overlap - left.overlap ||
          left.block.boundingBox.width - right.block.boundingBox.width
      )[0]?.block ?? null
  )
}

function positionedSegments(
  words: readonly DocumentWord[],
  blocks: readonly DocumentTextBlock[]
): PositionedSegment[] {
  const byLine = new Map<string, DocumentWord[]>()
  for (const word of words) {
    const line = byLine.get(word.lineId) ?? []
    line.push(word)
    byLine.set(word.lineId, line)
  }
  const segments: PositionedSegment[] = []
  for (const [lineId, lineWords] of byLine) {
    for (const segmentWords of splitPositionedLine(lineWords)) {
      const block = bestSourceBlock(blocks, segmentWords)
      if (!block) continue
      const left = Math.min(...segmentWords.map((word) => word.boundingBox.x))
      const top = Math.min(...segmentWords.map((word) => word.boundingBox.y))
      const right = Math.max(
        ...segmentWords.map((word) => word.boundingBox.x + word.boundingBox.width)
      )
      const bottom = Math.max(
        ...segmentWords.map((word) => word.boundingBox.y + word.boundingBox.height)
      )
      segments.push({
        lineId,
        words: segmentWords,
        text: normalizeText(segmentWords.map((word) => word.text).join(' ')),
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
        block
      })
    }
  }
  return segments.sort((left, right) => left.y - right.y || left.x - right.x)
}

function sameVisualLine(left: PositionedSegment, right: PositionedSegment): boolean {
  if (left.lineId === right.lineId) return true
  const leftCenter = left.y + left.height / 2
  const rightCenter = right.y + right.height / 2
  return Math.abs(leftCenter - rightCenter) <= Math.max(left.height, right.height) * 0.72
}

function tableTitleSegment(
  anchor: PositionedSegment,
  segments: readonly PositionedSegment[]
): PositionedSegment | null {
  return (
    segments
      .filter(
        (candidate) =>
          candidate.x + candidate.width < anchor.x - 0.004 &&
          sameVisualLine(candidate, anchor) &&
          isUsefulTitle(candidate.text) &&
          !/^(?:title|course details?|credit hours?|crn|meeting times?)$/iu.test(candidate.text)
      )
      .sort((left, right) => left.x - right.x)[0] ?? null
  )
}

function tableCourseSegment(
  title: PositionedSegment,
  anchor: PositionedSegment,
  segments: readonly PositionedSegment[]
): PositionedSegment | null {
  return (
    segments
      .filter(
        (candidate) =>
          candidate.x > title.x + title.width + 0.004 &&
          candidate.x + candidate.width < anchor.x - 0.004 &&
          sameVisualLine(candidate, anchor) &&
          /\b[A-Z][A-Z&]{1,7}\s*[- ]?\s*\d{2,4}\b/u.test(candidate.text)
      )
      .sort((left, right) => left.x - right.x)[0] ?? null
  )
}

function tableNumericSegments(
  course: PositionedSegment | null,
  anchor: PositionedSegment,
  segments: readonly PositionedSegment[]
): PositionedSegment[] {
  if (!course) return []
  return segments
    .filter(
      (candidate) =>
        candidate.x > course.x + course.width + 0.004 &&
        candidate.x + candidate.width < anchor.x - 0.004 &&
        sameVisualLine(candidate, anchor) &&
        /^\d+(?:\.\d+)?$/u.test(candidate.text)
    )
    .sort((left, right) => left.x - right.x)
}

function courseIdentity(courseText: string): { courseCode: string; sectionCode: string | null } {
  const normalized = normalizeText(courseText)
  const match = /^([A-Z][A-Z&]{1,7})\s*[- ]?\s*(\d{2,4}[A-Z]?)\s*(.*)$/u.exec(normalized)
  if (!match?.[1] || !match[2]) return { courseCode: normalized, sectionCode: null }
  return {
    courseCode: `${match[1]} ${match[2]}`,
    sectionCode: match[3]?.trim() || null
  }
}

function scheduleComponent(
  text: string,
  creditHours: number | null
): DocumentScheduleMetadata['component'] {
  const normalized = normalizeText(text).toLocaleLowerCase()
  if (/\blab(?:oratory)?[- ]discussion\b/u.test(normalized)) return 'laboratory-discussion'
  if (/\blecture[- ]discussion\b/u.test(normalized)) return 'lecture-discussion'
  if (/\blab(?:oratory)?\b/u.test(normalized)) return 'laboratory'
  if (/\blecture\b/u.test(normalized)) return 'lecture'
  if (/\bdiscussion\b/u.test(normalized)) return 'discussion'
  if (/\bseminar\b/u.test(normalized)) return 'seminar'
  if (/\bstudio\b/u.test(normalized)) return 'studio'
  if (/\bclinic(?:al)?\b/u.test(normalized)) return 'clinical'
  if (creditHours === 0) return 'linked-section'
  if (creditHours !== null && creditHours > 0) return 'primary-section'
  if (/\bpracticum\b/u.test(normalized)) return 'practicum'
  return 'class-meeting'
}

function scheduleDescription(schedule: CandidateScheduleMetadata): string {
  const componentLabels: Record<DocumentScheduleMetadata['component'], string> = {
    lecture: 'Lecture',
    'lecture-discussion': 'Lecture-discussion',
    laboratory: 'Laboratory',
    'laboratory-discussion': 'Laboratory-discussion',
    discussion: 'Discussion',
    seminar: 'Seminar',
    studio: 'Studio',
    clinical: 'Clinical',
    practicum: 'Practicum',
    'primary-section': 'Primary section',
    'linked-section': 'Linked section',
    'class-meeting': 'Class meeting'
  }
  return [
    `Course: ${schedule.courseCode}`,
    schedule.sectionCode ? `Section: ${schedule.sectionCode}` : null,
    schedule.crn ? `CRN: ${schedule.crn}` : null,
    componentLabels[schedule.component],
    schedule.creditHours === null
      ? null
      : `${schedule.creditHours.toLocaleString('en-US', { maximumFractionDigits: 2 })} credit hour${schedule.creditHours === 1 ? '' : 's'}`
  ]
    .filter((part): part is string => Boolean(part))
    .join(' · ')
}

function regionContains(seed: CandidateSeed, region: ScheduleTableRegion): boolean {
  return seed.blocks.some((block) => {
    const centerY = block.boundingBox.y + block.boundingBox.height / 2
    return block.page === region.page && centerY >= region.startY && centerY < region.endY
  })
}

function scheduleTableCandidateSeeds(extraction: DocumentExtraction): ScheduleTableCandidates {
  const seeds: CandidateSeed[] = []
  const regions: ScheduleTableRegion[] = []
  let skipped = 0
  let unscheduledRows = 0
  for (const page of extraction.pages) {
    const segments = positionedSegments(page.words, page.blocks)
    const rangeAnchors = segments
      .map((segment) => ({ segment, range: scheduleDateRangePattern.exec(segment.text) }))
      .filter((candidate): candidate is { segment: PositionedSegment; range: RegExpExecArray } =>
        Boolean(candidate.range?.[1] && candidate.range?.[2])
      )
    if (rangeAnchors.length === 0) continue
    const hasTableHeading = page.blocks.some((block) =>
      /\b(?:meeting times?|course details?|class schedule)\b/iu.test(block.text)
    )
    const alignedAnchors = rangeAnchors.filter(
      (anchor) =>
        hasTableHeading ||
        rangeAnchors.filter((candidate) => Math.abs(candidate.segment.x - anchor.segment.x) <= 0.08)
          .length >= 2
    )
    if (alignedAnchors.length === 0) continue
    const rowGaps = alignedAnchors
      .slice(1)
      .map((anchor, index) => anchor.segment.y - alignedAnchors[index]!.segment.y)
      .filter((gap) => gap > 0.015 && gap < 0.3)
      .sort((left, right) => left - right)
    const typicalRowHeight = rowGaps[Math.floor(rowGaps.length / 2)] ?? 0.09

    for (let anchorIndex = 0; anchorIndex < alignedAnchors.length; anchorIndex += 1) {
      const candidate = alignedAnchors[anchorIndex]!
      const { segment: anchor, range } = candidate
      const startDateText = range[1]
      const endDateText = range[2]
      if (!startDateText || !endDateText) continue
      const title = tableTitleSegment(anchor, segments)
      if (!title) {
        skipped += 1
        continue
      }
      const course = tableCourseSegment(title, anchor, segments)
      const numericSegments = tableNumericSegments(course, anchor, segments)
      const creditSegment = numericSegments.find((segment) => segment.text.includes('.')) ?? null
      const crnSegment =
        numericSegments.find(
          (segment) => segment !== creditSegment && /^\d{4,9}$/u.test(segment.text)
        ) ?? null
      const creditHours = creditSegment ? Number.parseFloat(creditSegment.text) : null
      const identity = courseIdentity(course?.text ?? title.text)
      const nextAnchor = alignedAnchors[anchorIndex + 1]?.segment
      const rowEnd = Math.min(1, nextAnchor?.y ?? anchor.y + typicalRowHeight)
      regions.push({
        page: page.page,
        startY: Math.max(0, anchor.y - Math.max(0.006, anchor.height)),
        endY: rowEnd
      })
      const meetingSegments = segments.filter(
        (segment) =>
          segment.y > anchor.y + anchor.height * 0.55 &&
          segment.y < rowEnd - 0.001 &&
          segment.x >= anchor.x - 0.035
      )
      const timeSegments = meetingSegments.filter((segment) => {
        const match = timeMatch(segment.text)?.[0]
        return Boolean(match && /(?:-|–|—|\bto\b|\buntil\b)/iu.test(match))
      })
      let rowSeedCount = 0
      for (let timeIndex = 0; timeIndex < timeSegments.length; timeIndex += 1) {
        const time = timeSegments[timeIndex]!
        const previousTimeY = timeSegments[timeIndex - 1]?.y ?? anchor.y
        const weekdays = meetingSegments
          .filter((segment) => segment.y > previousTimeY && segment.y < time.y)
          .map((segment) => ({ segment, weekdays: weekdayList(segment.text) }))
          .filter((item) => item.weekdays.length > 0)
          .sort((left, right) => right.segment.y - left.segment.y)[0]
        if (!weekdays) {
          skipped += 1
          continue
        }
        const nextPatternY = timeSegments[timeIndex + 1]?.y ?? rowEnd
        const location = meetingSegments
          .filter((segment) => segment.y > time.y && segment.y < nextPatternY)
          .map((segment) => ({ segment, value: scheduleLocation(segment.text) }))
          .find((item) => item.value !== null)
        const schedule: CandidateScheduleMetadata = {
          ...identity,
          crn: crnSegment?.text ?? null,
          creditHours: Number.isFinite(creditHours) ? creditHours : null,
          component: scheduleComponent(
            `${title.text} ${course?.text ?? ''}`,
            Number.isFinite(creditHours) ? creditHours : null
          ),
          termStartText: startDateText,
          termEndText: endDateText,
          weekdays: weekdays.weekdays,
          verification: 'layout'
        }
        const sourceBlocks = [
          title.block,
          course?.block,
          creditSegment?.block,
          crnSegment?.block,
          anchor.block,
          weekdays.segment.block,
          time.block,
          location?.segment.block
        ]
          .filter((block): block is DocumentTextBlock => Boolean(block))
          .filter(
            (block, index, blocks) =>
              blocks.findIndex((candidateBlock) => candidateBlock.id === block.id) === index
          )
        seeds.push({
          page: page.page,
          blocks: sourceBlocks,
          dateBlock: anchor.block,
          timeBlock: time.block,
          titleBlock: title.block,
          locationBlock: location?.segment.block ?? null,
          dateText: startDateText,
          timeText: timeMatch(time.text)?.[0] ?? time.text,
          title: title.text,
          description: scheduleDescription(schedule),
          location: location?.value ?? '',
          kind: 'event',
          allDay: false,
          inferredTitle: false,
          plannerSource: 'rules',
          modelConfidence: null,
          recurrenceBlock: weekdays.segment.block,
          descriptionBlocks: [course?.block, creditSegment?.block, crnSegment?.block].filter(
            (block): block is DocumentTextBlock => Boolean(block)
          ),
          recurrenceText: `every ${weekdays.weekdays.join(', ')} until ${endDateText}`,
          scheduleRow: true,
          schedule
        })
        rowSeedCount += 1
      }
      if (rowSeedCount === 0) {
        unscheduledRows += 1
        skipped += 1
      }
    }
  }
  return { seeds, skipped, unscheduledRows, regions }
}

function nearestTitleBlock(
  blocks: readonly DocumentTextBlock[],
  index: number,
  dateBlock: DocumentTextBlock,
  timeBlock: DocumentTextBlock
): DocumentTextBlock | null {
  const sameLineTitle = cleanTitle(
    timeBlock.text,
    dateMatch(timeBlock.text)?.[0] ?? '',
    timeMatch(timeBlock.text)?.[0] ?? null
  )
  if (isUsefulTitle(sameLineTitle)) return timeBlock
  for (
    let candidateIndex = index - 1;
    candidateIndex >= Math.max(0, index - 3);
    candidateIndex -= 1
  ) {
    const candidate = blocks[candidateIndex]
    if (!candidate || candidate.id === dateBlock.id) continue
    if (isUsefulTitle(candidate.text)) return candidate
  }
  for (
    let candidateIndex = index + 1;
    candidateIndex <= Math.min(blocks.length - 1, index + 2);
    candidateIndex += 1
  ) {
    const candidate = blocks[candidateIndex]
    if (
      !candidate ||
      dateMatch(candidate.text) ||
      timeMatch(candidate.text) ||
      locationValue(candidate.text)
    )
      continue
    if (isUsefulTitle(candidate.text)) return candidate
  }
  return null
}

function findLocationBlock(
  blocks: readonly DocumentTextBlock[],
  index: number
): { block: DocumentTextBlock; value: string } | null {
  for (
    let candidateIndex = index;
    candidateIndex <= Math.min(blocks.length - 1, index + 2);
    candidateIndex += 1
  ) {
    const candidate = blocks[candidateIndex]
    if (!candidate) continue
    const value = locationValue(candidate.text)
    if (value) return { block: candidate, value }
  }
  return null
}

function candidateSeeds(extraction: DocumentExtraction): {
  seeds: CandidateSeed[]
  skipped: number
} {
  const seeds: CandidateSeed[] = []
  let skipped = 0
  for (const page of extraction.pages) {
    const blocks = [...page.blocks].sort(
      (left, right) =>
        left.boundingBox.y - right.boundingBox.y || left.boundingBox.x - right.boundingBox.x
    )
    let activeDate: { block: DocumentTextBlock; index: number; text: string } | null = null
    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index]
      if (!block) continue
      if (isPageChrome(block)) continue
      const foundDate = dateMatch(block.text)
      if (foundDate?.[0]) activeDate = { block, index, text: foundDate[0] }
      const foundTime = timeMatch(block.text)
      const allDay = /\ball[- ]day\b/iu.test(block.text)
      if (!foundTime?.[0] && !allDay) continue
      const dateContext = foundDate?.[0]
        ? { block, index, text: foundDate[0] }
        : activeDate && index - activeDate.index <= 10
          ? activeDate
          : null
      if (!dateContext) {
        skipped += 1
        continue
      }
      const titleBlock = nearestTitleBlock(blocks, index, dateContext.block, block)
      const inlineTitle = cleanTitle(block.text, dateContext.text, foundTime?.[0] ?? null)
      const title = isUsefulTitle(inlineTitle)
        ? inlineTitle
        : titleBlock
          ? cleanTitle(titleBlock.text, dateContext.text, foundTime?.[0] ?? null)
          : ''
      if (!isUsefulTitle(title)) {
        skipped += 1
        continue
      }
      const location = findLocationBlock(blocks, index + 1)
      const source = [dateContext.block, titleBlock, block, location?.block]
        .filter((candidate): candidate is DocumentTextBlock => Boolean(candidate))
        .filter(
          (candidate, candidateIndex, candidates) =>
            candidates.findIndex((other) => other.id === candidate.id) === candidateIndex
        )
      const kind = source.some((candidate) =>
        /\b(?:reminder|remind me|due|deadline|to[- ]?do)\b/iu.test(candidate.text)
      )
        ? 'reminder'
        : 'event'
      if (kind === 'reminder' && !foundTime?.[0]) {
        skipped += 1
        continue
      }
      seeds.push({
        page: page.page,
        blocks: source,
        dateBlock: dateContext.block,
        timeBlock: foundTime ? block : null,
        titleBlock: titleBlock ?? block,
        locationBlock: location?.block ?? null,
        dateText: dateContext.text,
        timeText: foundTime?.[0] ?? null,
        title,
        description: '',
        location: location?.value ?? '',
        kind,
        allDay,
        inferredTitle: titleBlock !== null && titleBlock.id !== block.id,
        plannerSource: 'rules',
        modelConfidence: null,
        recurrenceBlock: null,
        descriptionBlocks: [],
        recurrenceText: null,
        scheduleRow: false,
        schedule: null
      })
    }
  }
  return { seeds, skipped }
}

function planScanCandidateSeeds(extraction: DocumentExtraction): {
  seeds: CandidateSeed[]
  skipped: number
} {
  const analysis = extraction.planScan
  if (!analysis) return { seeds: [], skipped: 0 }
  const blocks = new Map(
    extraction.pages.flatMap((page) => page.blocks.map((block) => [block.id, block] as const))
  )
  const spans = new Map(analysis.spans.map((span) => [span.id, span] as const))
  const seeds: CandidateSeed[] = []
  let skipped = 0
  for (const group of analysis.groups) {
    const titleSpan = spans.get(group.titleSpanId)
    const dateSpan = spans.get(group.dateSpanId)
    const timeSpan = group.timeSpanId ? spans.get(group.timeSpanId) : null
    const locationSpan = group.locationSpanId ? spans.get(group.locationSpanId) : null
    const recurrenceSpan = group.recurrenceSpanId ? spans.get(group.recurrenceSpanId) : null
    const descriptionSpan = group.descriptionSpanIds[0]
      ? spans.get(group.descriptionSpanIds[0])
      : null
    const titleBlock = titleSpan ? blocks.get(titleSpan.blockId) : null
    const dateBlock = dateSpan ? blocks.get(dateSpan.blockId) : null
    const timeBlock = timeSpan ? blocks.get(timeSpan.blockId) : null
    const locationBlock = locationSpan ? blocks.get(locationSpan.blockId) : null
    const recurrenceBlock = recurrenceSpan ? blocks.get(recurrenceSpan.blockId) : null
    const descriptionBlock = descriptionSpan ? blocks.get(descriptionSpan.blockId) : null
    const evidenceBlocks = group.evidenceBlockIds
      .map((id) => blocks.get(id))
      .filter((block): block is DocumentTextBlock => Boolean(block))
    if (!titleSpan || !dateSpan || !titleBlock || !dateBlock || evidenceBlocks.length === 0) {
      skipped += 1
      continue
    }
    const dateText = dateSpan.text
    const timeText = timeSpan?.text ?? null
    const title = cleanTitle(titleSpan.text, dateText, timeText)
    const allDay = evidenceBlocks.some((block) => /\ball[- ]day\b/iu.test(block.text))
    if (!dateMatch(dateText) || (!timeText && !allDay) || !isUsefulTitle(title)) {
      skipped += 1
      continue
    }
    seeds.push({
      page: group.page,
      blocks: evidenceBlocks,
      dateBlock,
      timeBlock: timeBlock ?? null,
      titleBlock,
      locationBlock: locationBlock ?? null,
      dateText,
      timeText,
      title,
      description: descriptionSpan?.text ?? '',
      location: locationSpan?.text ?? '',
      kind: group.kind,
      allDay,
      inferredTitle: titleBlock.id !== dateBlock.id && titleBlock.id !== timeBlock?.id,
      plannerSource: 'planscan',
      modelConfidence: group.confidence,
      recurrenceBlock: recurrenceBlock ?? null,
      descriptionBlocks: descriptionBlock ? [descriptionBlock] : [],
      recurrenceText: recurrenceSpan?.text ?? null,
      scheduleRow: false,
      schedule: null
    })
  }
  return { seeds, skipped }
}

function corroborateScheduleSeeds(
  seeds: readonly CandidateSeed[],
  extraction: DocumentExtraction
): CandidateSeed[] {
  const groups = extraction.planScan?.groups ?? []
  return seeds.map((seed) => {
    if (!seed.schedule) return seed
    const requiredIds = [
      seed.titleBlock.id,
      seed.dateBlock.id,
      seed.timeBlock?.id,
      seed.recurrenceBlock?.id
    ].filter((id): id is string => Boolean(id))
    const corroboratingGroup = groups.find((group) => {
      if (group.page !== seed.page) return false
      const evidence = new Set(group.evidenceBlockIds)
      return requiredIds.filter((id) => evidence.has(id)).length >= Math.min(3, requiredIds.length)
    })
    if (!corroboratingGroup) return seed
    return {
      ...seed,
      modelConfidence: corroboratingGroup.confidence,
      schedule: { ...seed.schedule, verification: 'layout-and-planscan' }
    }
  })
}

function localParts(instant: string, timezone: string): { date: string; time: string } {
  const zoned = Temporal.Instant.from(instant).toZonedDateTimeISO(timezone)
  return {
    date: zoned.toPlainDate().toString(),
    time: zoned.toPlainTime().toString({ smallestUnit: 'minute' })
  }
}

function evidenceFromBlocks(
  blocks: readonly DocumentTextBlock[],
  extraction: DocumentExtraction
): CalendarIRDraft['evidence'] {
  return blocks.slice(0, 20).map((block) => ({
    id: block.id,
    sourceKind: extraction.source.kind,
    sourceId: extraction.source.id,
    page: block.page,
    boundingBox: block.boundingBox,
    text: block.text,
    sourceSpan: null
  }))
}

function blockIds(blocks: readonly DocumentTextBlock[]): string[] {
  return [...new Set(blocks.map((block) => block.id))]
}

function parserRecurrenceClause(text: string | null): string {
  if (!text) return ''
  const normalized = normalizeText(text)
  if (!normalized) return ''
  const weekdays = weekdayList(normalized)
  const recurrenceText =
    weekdays.length > 0 && !/\b(?:every|each|weekly|weekdays?)\b/iu.test(normalized)
      ? `every ${normalized}`
      : normalized
  return ` ${recurrenceText}`
}

function alignScheduleRecurrenceStart(
  draft: CalendarIRDraft,
  rangeStartDate: string
): CalendarIRDraft {
  const when = draft.fields.when?.value
  const recurrence = draft.recurrence
  if (recurrence?.frequency !== 'weekly' || recurrence.byWeekday.length === 0 || !when) {
    return draft
  }
  const weekdayByNumber: readonly Weekday[] = [
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
    'saturday',
    'sunday'
  ]
  const original = Temporal.PlainDate.from(rangeStartDate)
  let aligned = original
  for (let offset = 0; offset < 7; offset += 1) {
    const weekday = weekdayByNumber[aligned.dayOfWeek - 1]
    if (weekday && recurrence.byWeekday.includes(weekday)) break
    aligned = aligned.add({ days: 1 })
  }
  const alignedAnchor = { kind: 'absolute' as const, date: aligned.toString() }
  const endNeedsAlignment =
    when.end !== null &&
    (when.end.date.kind !== 'absolute' || when.end.date.date !== aligned.toString())
  if (aligned.equals(original) && !endNeedsAlignment) return draft
  return {
    ...draft,
    fields: {
      ...draft.fields,
      when: draft.fields.when
        ? {
            ...draft.fields.when,
            value: {
              ...when,
              start: { ...when.start, date: alignedAnchor },
              end: when.end ? { ...when.end, date: alignedAnchor } : null
            }
          }
        : null
    }
  }
}

function buildDraft(
  seed: CandidateSeed,
  extraction: DocumentExtraction,
  context: DocumentPlanningContext,
  index: number
): DocumentImportDraft | null {
  const requestId = `request:document:${extraction.source.sha256.slice(0, 12)}:${seed.page}:${index}`
  const rawParserTimeText =
    seed.kind === 'reminder' && seed.timeText
      ? (seed.timeText.split(/\s*(?:-|–|—|\bto\b|\buntil\b)\s*/iu)[0] ?? seed.timeText)
      : seed.timeText
  const parserTimeText =
    rawParserTimeText?.toLocaleLowerCase() === 'noon'
      ? '12:00 PM'
      : rawParserTimeText?.toLocaleLowerCase() === 'midnight'
        ? '12:00 AM'
        : rawParserTimeText
  const parserTitle = seed.plannerSource === 'planscan' ? 'Imported plan' : seed.title
  const timeClause = parserTimeText
    ? /(?:-|–|—|\bto\b|\buntil\b)/iu.test(parserTimeText)
      ? ` from ${parserTimeText}`
      : ` at ${parserTimeText}`
    : ''
  const parserText =
    seed.kind === 'reminder'
      ? `Remind me to ${parserTitle} on ${seed.dateText}${timeClause}${parserRecurrenceClause(seed.recurrenceText)}`
      : `Schedule ${parserTitle}${seed.allDay ? ' all day' : ''} on ${seed.dateText}${timeClause}${parserRecurrenceClause(seed.recurrenceText)}`
  let parsed = parseCalendarText({
    requestId,
    text: parserText,
    previousUserText: null,
    nowUtc: context.nowUtc,
    localDate: context.localDate,
    timezone: context.timezone,
    locale: context.locale,
    events: context.events,
    reminders: context.reminders
  }).draft
  let schedule: DocumentScheduleMetadata | null = null
  if (seed.schedule) {
    const probeDate = (dateText: string, suffix: string) =>
      parseCalendarText({
        requestId: `${requestId}:${suffix}`,
        text: `Schedule Imported plan on ${dateText} at 12:00 PM`,
        previousUserText: null,
        nowUtc: context.nowUtc,
        localDate: context.localDate,
        timezone: context.timezone,
        locale: context.locale,
        events: context.events,
        reminders: context.reminders
      }).draft.fields.when?.value.start.date
    const scheduleStartProbe = probeDate(seed.schedule.termStartText, 'term-start')
    const scheduleEndProbe = probeDate(seed.schedule.termEndText, 'term-end')
    if (scheduleStartProbe?.kind !== 'absolute' || scheduleEndProbe?.kind !== 'absolute')
      return null
    parsed = alignScheduleRecurrenceStart(parsed, scheduleStartProbe.date)
    const parsedWeekdays = parsed.recurrence?.byWeekday ?? []
    if (
      parsed.recurrence?.frequency !== 'weekly' ||
      parsedWeekdays.length !== seed.schedule.weekdays.length ||
      seed.schedule.weekdays.some((weekday) => !parsedWeekdays.includes(weekday)) ||
      parsed.recurrence.end.kind !== 'until' ||
      parsed.recurrence.end.date !== scheduleEndProbe.date
    ) {
      return null
    }
    schedule = {
      courseCode: seed.schedule.courseCode,
      sectionCode: seed.schedule.sectionCode,
      crn: seed.schedule.crn,
      creditHours: seed.schedule.creditHours,
      component: seed.schedule.component,
      termStartDate: scheduleStartProbe.date,
      termEndDate: scheduleEndProbe.date,
      weekdays: seed.schedule.weekdays,
      verification: seed.schedule.verification
    }
  } else if (seed.scheduleRow) {
    const scheduleDateProbe = parseCalendarText({
      requestId: `${requestId}:date`,
      text: `Schedule Imported plan on ${seed.dateText} at 12:00 PM`,
      previousUserText: null,
      nowUtc: context.nowUtc,
      localDate: context.localDate,
      timezone: context.timezone,
      locale: context.locale,
      events: context.events,
      reminders: context.reminders
    }).draft.fields.when?.value.start.date
    if (scheduleDateProbe?.kind === 'absolute') {
      parsed = alignScheduleRecurrenceStart(parsed, scheduleDateProbe.date)
    }
  }
  const expectedOperation = seed.kind === 'event' ? 'event.create' : 'reminder.create'
  if (parsed.operation !== expectedOperation || parsed.ambiguities.length > 0) return null

  const titleEvidence = blockIds([seed.titleBlock])
  const whenEvidence = blockIds(
    [seed.dateBlock, seed.timeBlock, seed.recurrenceBlock].filter(
      (block): block is DocumentTextBlock => block !== null
    )
  )
  const locationEvidence = seed.locationBlock ? [seed.locationBlock.id] : []
  const descriptionEvidence = blockIds(seed.descriptionBlocks)
  const proposal = calendarIRDraftSchema.parse({
    ...parsed,
    confidence: Math.min(
      parsed.confidence,
      seed.blocks.reduce((total, block) => total + block.confidence, 0) / seed.blocks.length,
      seed.scheduleRow ? 1 : (seed.modelConfidence ?? 1)
    ),
    evidence: evidenceFromBlocks(seed.blocks, extraction),
    fields: {
      ...parsed.fields,
      title: parsed.fields.title
        ? {
            ...parsed.fields.title,
            value: seed.title,
            sourceSpan: null,
            evidenceIds: titleEvidence
          }
        : null,
      description: seed.description
        ? {
            value: seed.description,
            sourceSpan: null,
            evidenceIds: descriptionEvidence
          }
        : parsed.fields.description,
      when: parsed.fields.when
        ? { ...parsed.fields.when, sourceSpan: null, evidenceIds: whenEvidence }
        : null,
      location: seed.location
        ? { value: seed.location, sourceSpan: null, evidenceIds: locationEvidence }
        : null
    }
  })
  const zonedNow = Temporal.Instant.from(context.nowUtc).toZonedDateTimeISO(context.timezone)
  const resolved = resolveCalendarIR(proposal, {
    nowUtc: context.nowUtc,
    localDate: context.localDate,
    timezone: context.timezone,
    utcOffsetMinutes: Math.round(zonedNow.offsetNanoseconds / 60_000_000_000),
    defaultCalendarId: context.defaultCalendarId,
    defaultEventDurationMinutes: context.defaultEventDurationMinutes
  })
  const warnings: string[] = []
  const extractionConfidence =
    seed.blocks.reduce((total, block) => total + block.confidence, 0) / seed.blocks.length
  if (seed.blocks.some((block) => block.method === 'ocr') && extractionConfidence < 0.82) {
    warnings.push('OCR confidence is modest; compare this item with the highlighted source.')
  }
  if (seed.inferredTitle) warnings.push('The title was paired with a nearby date and time.')
  if (seed.scheduleRow && schedule?.verification !== 'layout-and-planscan') {
    warnings.push(
      'The layout reader reconstructed this repeating row without a PlanScan match; compare it with the highlighted source.'
    )
  }
  if (seed.plannerSource === 'planscan') {
    warnings.push(
      'PlanScan linked these fields from their position on the page; verify the highlights.'
    )
  }
  if (
    seed.kind === 'event' &&
    seed.timeText &&
    !/(?:-|–|—|\bto\b|\buntil\b)/iu.test(seed.timeText)
  ) {
    warnings.push(
      `No end time was printed; ${context.defaultEventDurationMinutes} minutes is assumed.`
    )
  }
  const confidence = Math.max(0, Math.min(1, proposal.confidence - warnings.length * 0.04))
  const common = {
    id: `draft:${extraction.source.sha256.slice(0, 12)}:${seed.page}:${index}`,
    page: seed.page,
    confidence,
    attention:
      confidence >= 0.78 && warnings.length === 0
        ? ('ready' as const)
        : ('check-evidence' as const),
    sourceText: seed.blocks.map((block) => block.text).join('\n'),
    proposal,
    resolved,
    schedule,
    fieldEvidence: {
      title: titleEvidence,
      when: whenEvidence,
      location: locationEvidence,
      description: descriptionEvidence
    },
    warnings
  }

  if (seed.kind === 'event') {
    if (!resolved.fields.startUtc || !resolved.fields.endUtc || !resolved.fields.title) return null
    const timezone = resolved.fields.timezone ?? context.timezone
    const start = localParts(resolved.fields.startUtc, timezone)
    const endInstant = resolved.fields.allDay
      ? Temporal.Instant.from(resolved.fields.endUtc).subtract({ nanoseconds: 1 }).toString()
      : resolved.fields.endUtc
    const end = localParts(endInstant, timezone)
    return documentImportDraftSchema.parse({
      ...common,
      kind: 'event',
      form: eventFormSchema.parse({
        id: null,
        calendarId: context.defaultCalendarId,
        title: resolved.fields.title,
        description: resolved.fields.description ?? '',
        location: resolved.fields.location ?? '',
        startDate: start.date,
        startTime: resolved.fields.allDay ? null : start.time,
        endDate: end.date,
        endTime: resolved.fields.allDay ? null : end.time,
        timezone,
        allDay: resolved.fields.allDay ?? false,
        recurrence: resolved.recurrence
      })
    })
  }

  if (!resolved.fields.dueAtUtc || !resolved.fields.title) return null
  const timezone = resolved.fields.timezone ?? context.timezone
  const due = localParts(resolved.fields.dueAtUtc, timezone)
  return documentImportDraftSchema.parse({
    ...common,
    kind: 'reminder',
    form: reminderFormSchema.parse({
      id: null,
      calendarId: context.defaultCalendarId,
      title: resolved.fields.title,
      notes: resolved.fields.description ?? '',
      dueDate: due.date,
      dueTime: due.time,
      timezone,
      recurrence: resolved.recurrence
    })
  })
}

function normalizedFingerprintText(value: string): string {
  return normalizeText(value).toLocaleLowerCase()
}

function recurrenceFingerprint(recurrence: DocumentImportDraft['form']['recurrence']): string {
  if (!recurrence) return 'once'
  return JSON.stringify({
    ...recurrence,
    byWeekday: [...recurrence.byWeekday].sort(),
    byMonthDay: [...recurrence.byMonthDay].sort((left, right) => left - right)
  })
}

function eventFormKey(form: Extract<DocumentImportDraft, { kind: 'event' }>['form']): string {
  return [
    'event',
    normalizedFingerprintText(form.title),
    normalizedFingerprintText(form.description),
    normalizedFingerprintText(form.location),
    form.startDate,
    form.startTime ?? 'all-day',
    form.endDate,
    form.endTime ?? 'all-day',
    form.timezone,
    recurrenceFingerprint(form.recurrence)
  ].join('|')
}

function existingEventKey(event: EventEntity): string {
  const start = localParts(event.startUtc, event.timezone)
  const endInstant = event.allDay
    ? Temporal.Instant.from(event.endUtc).subtract({ nanoseconds: 1 }).toString()
    : event.endUtc
  const end = localParts(endInstant, event.timezone)
  return eventFormKey({
    id: null,
    calendarId: event.calendarId,
    title: event.title,
    description: event.description,
    location: event.location,
    startDate: start.date,
    startTime: event.allDay ? null : start.time,
    endDate: end.date,
    endTime: event.allDay ? null : end.time,
    timezone: event.timezone,
    allDay: event.allDay,
    recurrence: event.recurrence
  })
}

function reminderFormKey(form: Extract<DocumentImportDraft, { kind: 'reminder' }>['form']): string {
  return [
    'reminder',
    normalizedFingerprintText(form.title),
    normalizedFingerprintText(form.notes),
    form.dueDate,
    form.dueTime,
    form.timezone,
    recurrenceFingerprint(form.recurrence)
  ].join('|')
}

function existingReminderKey(reminder: ReminderEntity): string {
  const due = localParts(reminder.dueAtUtc, reminder.timezone)
  return reminderFormKey({
    id: null,
    calendarId: reminder.calendarId,
    title: reminder.title,
    notes: reminder.notes,
    dueDate: due.date,
    dueTime: due.time,
    timezone: reminder.timezone,
    recurrence: reminder.recurrence
  })
}

function draftKey(draft: DocumentImportDraft): string {
  if (draft.kind === 'event') {
    return eventFormKey(draft.form)
  }
  return reminderFormKey(draft.form)
}

export function planDocumentExtraction(
  extractionInput: DocumentExtraction,
  context: DocumentPlanningContext
): DocumentAnalysis {
  const extraction = documentAnalysisSchema.shape.extraction.parse(extractionInput)
  const scheduleCandidates = scheduleTableCandidateSeeds(extraction)
  const modelCandidates = planScanCandidateSeeds(extraction)
  const scheduleSeeds = corroborateScheduleSeeds(scheduleCandidates.seeds, extraction)
  const ruleCandidates = candidateSeeds(extraction)
  const outsideScheduleRows = (seed: CandidateSeed): boolean =>
    !scheduleCandidates.regions.some((region) => regionContains(seed, region))
  const usableModelSeeds = modelCandidates.seeds.filter(outsideScheduleRows)
  const usableRuleSeeds = ruleCandidates.seeds.filter(outsideScheduleRows)
  const modelClaimedAnchors = new Set(
    usableModelSeeds.flatMap((seed) =>
      [seed.dateBlock.id, seed.timeBlock?.id].filter((id): id is string => Boolean(id))
    )
  )
  const supplementalRuleSeeds = usableRuleSeeds.filter(
    (seed) =>
      !modelClaimedAnchors.has(seed.dateBlock.id) &&
      (!seed.timeBlock || !modelClaimedAnchors.has(seed.timeBlock.id))
  )
  const seeds = [...scheduleSeeds, ...usableModelSeeds, ...supplementalRuleSeeds]
  const drafts: DocumentImportDraft[] = []
  const seen = new Set<string>()
  const existingEventKeys = new Set(
    context.events.filter((event) => event.status === 'active').map(existingEventKey)
  )
  const existingReminderKeys = new Set(
    context.reminders.filter((reminder) => reminder.status === 'active').map(existingReminderKey)
  )
  let duplicateCandidateCount = 0
  let existingCalendarDuplicateCount = 0
  let skipped = scheduleCandidates.skipped + modelCandidates.skipped + ruleCandidates.skipped
  for (let index = 0; index < seeds.length; index += 1) {
    const seed = seeds[index]
    if (!seed) continue
    let draft: DocumentImportDraft | null = null
    try {
      draft = buildDraft(seed, extraction, context, index)
    } catch {
      // One malformed candidate must not prevent review of the remaining source evidence.
    }
    if (!draft) {
      skipped += 1
      continue
    }
    const key = draftKey(draft)
    if (seen.has(key)) {
      duplicateCandidateCount += 1
      continue
    }
    seen.add(key)
    const alreadyExists =
      draft.kind === 'event' ? existingEventKeys.has(key) : existingReminderKeys.has(key)
    if (alreadyExists) {
      existingCalendarDuplicateCount += 1
      continue
    }
    if (drafts.length >= maximumDocumentDrafts) {
      skipped += 1
      continue
    }
    drafts.push(draft)
  }
  const plannerWarnings = [...extraction.warnings]
  const verifiedScheduleCount = scheduleSeeds.filter(
    (seed) => seed.schedule?.verification === 'layout-and-planscan'
  ).length
  if (scheduleCandidates.seeds.length > 0) {
    plannerWarnings.push(
      `Layout rules reconstructed ${scheduleCandidates.seeds.length} repeating meeting pattern${scheduleCandidates.seeds.length === 1 ? '' : 's'} from aligned schedule rows, including their weekday sets and term end dates.`
    )
  }
  if (scheduleCandidates.unscheduledRows > 0) {
    plannerWarnings.push(
      `${scheduleCandidates.unscheduledRows} schedule row${scheduleCandidates.unscheduledRows === 1 ? '' : 's'} had no fixed weekday-and-time pattern (for example ARR or asynchronous sections), so no invented calendar event was proposed.`
    )
  }
  if (extraction.planScan) {
    plannerWarnings.push(
      usableModelSeeds.length > 0
        ? `PlanScan linked ${usableModelSeeds.length} additional evidence-backed plan${usableModelSeeds.length === 1 ? '' : 's'}; deterministic rules checked the same source as fallback.`
        : verifiedScheduleCount > 0 && scheduleCandidates.seeds.length > 0
          ? `PlanScan independently cross-checked ${verifiedScheduleCount} of ${scheduleCandidates.seeds.length} table meeting pattern${scheduleCandidates.seeds.length === 1 ? '' : 's'}; exact row geometry still controls section identity, weekdays, times, and term bounds.`
          : 'PlanScan withheld uncertain groups; deterministic layout rules supplied any reviewable proposals.'
    )
  }
  if (duplicateCandidateCount > 0) {
    plannerWarnings.push(
      `${duplicateCandidateCount} repeated source candidate${duplicateCandidateCount === 1 ? ' was' : 's were'} merged by exact section, time, weekday, and location identity.`
    )
  }
  if (existingCalendarDuplicateCount > 0) {
    plannerWarnings.push(
      `${existingCalendarDuplicateCount} exact duplicate${existingCalendarDuplicateCount === 1 ? ' already exists' : 's already exist'} in this calendar and ${existingCalendarDuplicateCount === 1 ? 'was' : 'were'} left out.`
    )
  }
  if (drafts.length === 0) {
    plannerWarnings.push(
      'Text was extracted, but no complete date-and-time plans were found. Try a clearer schedule or add the details by typing.'
    )
  }
  if (seeds.length > maximumDocumentDrafts) {
    plannerWarnings.push(`Only the first ${maximumDocumentDrafts} reviewable plans are shown.`)
  }
  return documentAnalysisSchema.parse({
    selectionId: context.selectionId,
    extraction,
    drafts,
    skippedCandidateCount: skipped,
    duplicateCandidateCount,
    existingCalendarDuplicateCount,
    plannerWarnings
  })
}
