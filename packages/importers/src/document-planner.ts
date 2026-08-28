import { Temporal } from '@js-temporal/polyfill'
import {
  createEventDocumentImportIdentity,
  createReminderDocumentImportIdentity,
  documentSourceRowId,
  reconcileDocumentEvent,
  reconcileDocumentReminder,
  resolveCalendarIR
} from '@remind-me/calendar-engine'
import {
  calendarIRDraftSchema,
  documentAnalysisSchema,
  documentFallbackRequestSchema,
  documentFallbackResponseSchema,
  documentImportDraftSchema,
  documentPlanRecordSchema,
  documentRepairSessionSchema,
  eventFormSchema,
  maximumDocumentDrafts,
  maximumDocumentFallbackBlocks,
  maximumDocumentFallbackGroups,
  reminderFormSchema,
  type CalendarIRDraft,
  type DocumentAnalysis,
  type DocumentExtraction,
  type DocumentImportDraft,
  type DocumentFieldConfidence,
  type DocumentFallbackRequest,
  type DocumentFallbackResponse,
  type DocumentPlanRecord,
  type DocumentRepairCandidate,
  type DocumentRepairCitation,
  type DocumentRepairSession,
  type DocumentScheduleMetadata,
  type DocumentSkippedItem,
  type DocumentTextBlock,
  type DocumentWord,
  type EventEntity,
  type ReminderEntity,
  type RecurrenceRule,
  type Weekday
} from '@remind-me/contracts'
import { validateDocumentFallbackResponse } from './document-fallback'
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
  titleBlocks: DocumentTextBlock[]
  locationBlock: DocumentTextBlock | null
  dateText: string
  timeText: string | null
  title: string
  description: string
  location: string
  kind: 'event' | 'reminder'
  allDay: boolean
  inferredTitle: boolean
  plannerSource: 'planscan' | 'rules' | 'qwen-fallback'
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
  skippedItems: SkippedCandidateSeed[]
  regions: ScheduleTableRegion[]
}

interface SyllabusCandidates {
  seeds: CandidateSeed[]
  skipped: number
  unscheduledItems: number
  skippedItems: SkippedCandidateSeed[]
  regions: ScheduleTableRegion[]
}

interface SkippedCandidateSeed {
  page: number
  category: DocumentSkippedItem['category']
  title: string
  reason: string
  blocks: DocumentTextBlock[]
}

interface SyllabusCourseContext {
  courseCode: string
  sectionCode: string | null
  crn: string | null
  creditHours: number | null
  evidenceBlocks: DocumentTextBlock[]
}

interface CalendarGridCandidates {
  seeds: CandidateSeed[]
  skipped: number
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
const maximumAutomaticRepairDisagreements = 3
const scheduleDateToken = `(?:\\d{4}-\\d{2}-\\d{2}|\\d{1,2}[/-]\\d{1,2}[/-]\\d{2,4}|${monthPattern}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?|\\d{1,2}(?:st|nd|rd|th)?\\s+${monthPattern}(?:,?\\s+\\d{4})?)`
const scheduleDateRangePattern = new RegExp(
  `\\b(${scheduleDateToken})\\s*(?:-|–|—|to|through|until)\\s*(${scheduleDateToken})\\b`,
  'iu'
)
const calendarMonthYearPattern = new RegExp(`\\b(${monthPattern})\\s+(\\d{4})\\b`, 'iu')
const weekdayTokenPattern =
  /\b(?:mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b/giu
const syllabusCuePattern = /\b(?:course\s+)?(?:syllabus|outline)\b/iu
const syllabusCourseCodePattern = /\b([A-Z][A-Z&]{1,7})\s*[- ]?\s*(\d{2,4}[A-Z]?)\b/iu
const noFixedMeetingTimePattern =
  /\bARR\b|\bno\s+fixed\s+(?:meeting\s+)?time\b|\b(?:meeting\s+)?time\s+(?:TBA|to\s+be\s+announced)\b/iu

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

function calendarTitleFromSeed(seed: CandidateSeed): string {
  const title = normalizeText(seed.title)
  if (seed.titleBlocks.length === 0 || !seed.titleBlocks.every((block) => block.method === 'ocr')) {
    return title
  }
  // OCR occasionally hallucinates a sentence stop at the right edge of a
  // short heading. Calendar labels are phrase-like, so discard only terminal
  // full-stop/comma/semicolon noise while preserving internal punctuation and
  // meaningful question or exclamation marks.
  return normalizeText(title.replace(/[.,;]+$/u, ''))
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
    /\b(?:room|rm|hall|building|bldg|center|centre|ctr|campus|online|zoom|laboratory|lab|auditorium|library|studio|school|university|college|floor|terminal|gate|hotel|museum|pavilion|clinic|office|suite|theat(?:er|re)|arena|restaurant|cafe|church)\b/iu.test(
      normalized
    )
  const numberedRoom = /\b\d{2,5}[a-z]?\b/iu.test(normalized)
  const streetAddress =
    /^\d{1,6}\s+[\p{L}\p{N}.' -]+\b(?:street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|court|ct|way)\b/iu.test(
      normalized
    )
  const structuredAddress = normalized.split(',').length >= 3
  return locationCue || numberedRoom || streetAddress || structuredAddress ? normalized : null
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
  const skippedItems: SkippedCandidateSeed[] = []
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
          titleBlocks: [title.block],
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
        const rowBlocks = [
          title.block,
          course?.block,
          creditSegment?.block,
          crnSegment?.block,
          anchor.block,
          ...meetingSegments.map((segment) => segment.block)
        ]
          .filter((block): block is DocumentTextBlock => Boolean(block))
          .filter(
            (block, index, blocks) =>
              blocks.findIndex((candidateBlock) => candidateBlock.id === block.id) === index
          )
          .slice(0, 32)
        const sourceText = rowBlocks.map((block) => block.text).join(' ')
        const noFixedTime = noFixedMeetingTimePattern.test(sourceText)
        skippedItems.push({
          page: page.page,
          category: noFixedTime ? 'no-fixed-time' : 'missing-required-fields',
          title: title.text,
          reason: noFixedTime
            ? 'The source marks this row as ARR, asynchronous, online-only, or otherwise without a fixed meeting time.'
            : 'A complete weekday-and-time pattern could not be linked within this schedule row.',
          blocks: rowBlocks
        })
      }
    }
  }
  return { seeds, skipped, unscheduledRows, skippedItems, regions }
}

function syllabusCourseContext(extraction: DocumentExtraction): SyllabusCourseContext | null {
  const blocks = extraction.pages.flatMap((page) => page.blocks)
  const syllabusBlocks = blocks.filter((block) => syllabusCuePattern.test(block.text))
  const excludedSubjects = new Set(['FALL', 'PAGE', 'ROOM', 'SPRING', 'SUMMER', 'WINTER'])

  for (const syllabusBlock of syllabusBlocks) {
    const nearbyBlocks = blocks
      .filter(
        (block) =>
          block.page === syllabusBlock.page &&
          Math.abs(block.boundingBox.y - syllabusBlock.boundingBox.y) <= 0.16
      )
      .sort(
        (left, right) =>
          (left.id === syllabusBlock.id ? -1 : 0) - (right.id === syllabusBlock.id ? -1 : 0) ||
          Math.abs(left.boundingBox.y - syllabusBlock.boundingBox.y) -
            Math.abs(right.boundingBox.y - syllabusBlock.boundingBox.y)
      )
    for (const courseBlock of nearbyBlocks) {
      const match = syllabusCourseCodePattern.exec(normalizeText(courseBlock.text))
      const subject = match?.[1]?.toLocaleUpperCase()
      const number = match?.[2]?.toLocaleUpperCase()
      if (!subject || !number || excludedSubjects.has(subject)) continue
      const metadataText = nearbyBlocks.map((block) => normalizeText(block.text)).join(' ')
      const sectionMatch = /\b(?:section|sec\.?)\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{0,15})\b/iu.exec(
        metadataText
      )
      const crnMatch = /\bCRN\s*[:#-]?\s*(\d{4,9})\b/iu.exec(metadataText)
      const creditMatch = /\b(\d+(?:\.\d+)?)\s+credit(?:\s+hours?)?\b/iu.exec(metadataText)
      const parsedCredits = creditMatch?.[1] ? Number.parseFloat(creditMatch[1]) : null
      const evidenceBlocks = [
        syllabusBlock,
        courseBlock,
        ...nearbyBlocks.filter((block) => /\b(?:section|sec\.?|CRN|credit)\b/iu.test(block.text))
      ].filter(
        (block, index, candidates) =>
          candidates.findIndex((candidate) => candidate.id === block.id) === index
      )
      return {
        courseCode: `${subject} ${number}`,
        sectionCode: sectionMatch?.[1]?.toLocaleUpperCase() ?? null,
        crn: crnMatch?.[1] ?? null,
        creditHours: Number.isFinite(parsedCredits) ? parsedCredits : null,
        evidenceBlocks
      }
    }
  }
  return null
}

function syllabusMeetingTitleBlock(
  blocks: readonly DocumentTextBlock[],
  rangeIndex: number,
  rangeText: string
): { block: DocumentTextBlock; title: string } | null {
  const rangeBlock = blocks[rangeIndex]
  if (!rangeBlock) return null
  const inlineTitle = cleanTitle(rangeBlock.text, rangeText, null)
  if (isUsefulTitle(inlineTitle)) return { block: rangeBlock, title: inlineTitle }
  for (
    let candidateIndex = rangeIndex - 1;
    candidateIndex >= Math.max(0, rangeIndex - 4);
    candidateIndex -= 1
  ) {
    const candidate = blocks[candidateIndex]
    if (!candidate || candidate.page !== rangeBlock.page) break
    if (
      syllabusCuePattern.test(candidate.text) ||
      /\b(?:fall|spring|summer|winter)\s+\d{4}\b/iu.test(candidate.text) ||
      dateMatch(candidate.text) ||
      timeMatch(candidate.text) ||
      weekdayList(candidate.text).length > 0 ||
      locationValue(candidate.text)
    ) {
      continue
    }
    const title = cleanTitle(candidate.text, '', null)
    if (isUsefulTitle(title)) return { block: candidate, title }
  }
  return null
}

function syllabusCandidateSeeds(
  extraction: DocumentExtraction,
  excludedRegions: readonly ScheduleTableRegion[] = []
): SyllabusCandidates {
  const context = syllabusCourseContext(extraction)
  if (!context) return { seeds: [], skipped: 0, unscheduledItems: 0, skippedItems: [], regions: [] }

  const seeds: CandidateSeed[] = []
  const skippedItems: SkippedCandidateSeed[] = []
  const regions: ScheduleTableRegion[] = []
  const blockIsExcluded = (block: DocumentTextBlock): boolean => {
    const centerY = block.boundingBox.y + block.boundingBox.height / 2
    return excludedRegions.some(
      (region) => region.page === block.page && centerY >= region.startY && centerY < region.endY
    )
  }

  for (const page of extraction.pages) {
    const blocks = [...page.blocks].sort(
      (left, right) =>
        left.boundingBox.y - right.boundingBox.y || left.boundingBox.x - right.boundingBox.x
    )
    for (let rangeIndex = 0; rangeIndex < blocks.length; rangeIndex += 1) {
      const rangeBlock = blocks[rangeIndex]
      if (!rangeBlock || blockIsExcluded(rangeBlock)) continue
      const range = scheduleDateRangePattern.exec(normalizeText(rangeBlock.text))
      const startDateText = range?.[1]
      const endDateText = range?.[2]
      if (!range?.[0] || !startDateText || !endDateText) continue
      const title = syllabusMeetingTitleBlock(blocks, rangeIndex, range[0])
      if (!title) continue
      const nearbyBlocks = blocks.slice(rangeIndex + 1, Math.min(blocks.length, rangeIndex + 7))
      const recurrence = nearbyBlocks
        .map((block) => ({ block, weekdays: weekdayList(block.text) }))
        .find((candidate) => candidate.weekdays.length > 0)
      if (!recurrence) continue
      const recurrenceIndex = blocks.findIndex((block) => block.id === recurrence.block.id)
      const time = blocks
        .slice(recurrenceIndex + 1, Math.min(blocks.length, recurrenceIndex + 5))
        .map((block) => ({ block, text: timeMatch(block.text)?.[0] ?? null }))
        .find((candidate) => candidate.text !== null)
      if (!time?.text) continue
      const timeIndex = blocks.findIndex((block) => block.id === time.block.id)
      const location = findLocationBlock(blocks, timeIndex + 1, time.block)
      const schedule: CandidateScheduleMetadata = {
        courseCode: context.courseCode,
        sectionCode: context.sectionCode,
        crn: context.crn,
        creditHours: context.creditHours,
        component: scheduleComponent(title.title, context.creditHours),
        termStartText: startDateText,
        termEndText: endDateText,
        weekdays: recurrence.weekdays,
        verification: 'layout'
      }
      const meetingBlocks = [
        title.block,
        rangeBlock,
        recurrence.block,
        time.block,
        location?.block
      ].filter((block): block is DocumentTextBlock => Boolean(block))
      const sourceBlocks = [...context.evidenceBlocks, ...meetingBlocks].filter(
        (block, index, candidates) =>
          candidates.findIndex((candidate) => candidate.id === block.id) === index
      )
      const meetingTop = Math.min(...meetingBlocks.map((block) => block.boundingBox.y))
      const meetingBottom = Math.max(
        ...meetingBlocks.map((block) => block.boundingBox.y + block.boundingBox.height)
      )
      regions.push({
        page: page.page,
        startY: Math.max(0, meetingTop - 0.006),
        endY: Math.min(1, meetingBottom + 0.006)
      })
      seeds.push({
        page: page.page,
        blocks: sourceBlocks,
        dateBlock: rangeBlock,
        timeBlock: time.block,
        titleBlock: title.block,
        titleBlocks: [title.block],
        locationBlock: location?.block ?? null,
        dateText: startDateText,
        timeText: time.text,
        title: title.title,
        description: scheduleDescription(schedule),
        location: location?.value ?? '',
        kind: 'event',
        allDay: false,
        inferredTitle: false,
        plannerSource: 'rules',
        modelConfidence: null,
        recurrenceBlock: recurrence.block,
        descriptionBlocks: context.evidenceBlocks,
        recurrenceText: `every ${recurrence.weekdays.join(', ')} until ${endDateText}`,
        scheduleRow: true,
        schedule
      })
    }
  }

  const unscheduledAnchors: {
    page: number
    index: number
    y: number
    title: DocumentTextBlock
    blocks: DocumentTextBlock[]
  }[] = []
  const blockIsClaimedMeeting = (block: DocumentTextBlock): boolean => {
    const centerY = block.boundingBox.y + block.boundingBox.height / 2
    return regions.some(
      (region) => region.page === block.page && centerY >= region.startY && centerY < region.endY
    )
  }
  for (const page of extraction.pages) {
    const blocks = [...page.blocks].sort(
      (left, right) =>
        left.boundingBox.y - right.boundingBox.y || left.boundingBox.x - right.boundingBox.x
    )
    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index]
      if (
        !block ||
        blockIsExcluded(block) ||
        blockIsClaimedMeeting(block) ||
        !noFixedMeetingTimePattern.test(block.text)
      )
        continue
      const nearby = blocks.slice(Math.max(0, index - 4), index + 1)
      const dateBlock = nearby.find((candidate) => dateMatch(candidate.text)) ?? null
      const titleBlock = nearby
        .slice(0, -1)
        .reverse()
        .find(
          (candidate) =>
            !syllabusCuePattern.test(candidate.text) &&
            !dateMatch(candidate.text) &&
            !timeMatch(candidate.text) &&
            !locationValue(candidate.text) &&
            isUsefulTitle(candidate.text)
        )
      if (!dateBlock || !titleBlock) continue
      unscheduledAnchors.push({
        page: page.page,
        index,
        y: block.boundingBox.y,
        title: titleBlock,
        blocks: [titleBlock, dateBlock, block].filter(
          (candidate, candidateIndex, candidates) =>
            candidates.findIndex((other) => other.id === candidate.id) === candidateIndex
        )
      })
    }
  }
  const uniqueUnscheduled = unscheduledAnchors.filter((anchor, index, anchors) => {
    const previous = anchors[index - 1]
    const sameItem =
      previous &&
      previous.page === anchor.page &&
      anchor.index - previous.index <= 1 &&
      Math.abs(anchor.y - previous.y) <= 0.06
    return !sameItem
  })
  for (const anchor of uniqueUnscheduled) {
    skippedItems.push({
      page: anchor.page,
      category: 'no-fixed-time',
      title: cleanTitle(anchor.title.text, dateMatch(anchor.title.text)?.[0] ?? '', null),
      reason:
        'The syllabus explicitly gives no fixed meeting time, so no date or time was invented.',
      blocks: anchor.blocks
    })
  }
  const unscheduledItems = uniqueUnscheduled.length

  return { seeds, skipped: unscheduledItems, unscheduledItems, skippedItems, regions }
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

function stackedTitleBlocks(
  blocks: readonly DocumentTextBlock[],
  titleBlock: DocumentTextBlock
): DocumentTextBlock[] {
  const index = blocks.findIndex((block) => block.id === titleBlock.id)
  if (index <= 0) return [titleBlock]
  const result = [titleBlock]
  let lower = titleBlock
  for (
    let candidateIndex = index - 1;
    candidateIndex >= Math.max(0, index - 2);
    candidateIndex -= 1
  ) {
    const candidate = blocks[candidateIndex]
    if (!candidate || candidate.page !== titleBlock.page) break
    if (
      !isUsefulTitle(candidate.text) ||
      dateMatch(candidate.text) ||
      timeMatch(candidate.text) ||
      locationValue(candidate.text)
    ) {
      break
    }
    const gap = lower.boundingBox.y - (candidate.boundingBox.y + candidate.boundingBox.height)
    const typicalHeight = Math.max(lower.boundingBox.height, candidate.boundingBox.height)
    const heightRatio =
      Math.min(lower.boundingBox.height, candidate.boundingBox.height) / typicalHeight
    const leftAlignment = Math.abs(lower.boundingBox.x - candidate.boundingBox.x)
    if (gap < -typicalHeight * 0.45 || gap > typicalHeight * 1.55) break
    if (heightRatio < 0.68 || leftAlignment > 0.08) break
    result.unshift(candidate)
    lower = candidate
  }
  return result
}

function findLocationBlock(
  blocks: readonly DocumentTextBlock[],
  index: number,
  anchor: DocumentTextBlock
): { block: DocumentTextBlock; value: string } | null {
  for (
    let candidateIndex = index;
    candidateIndex <= Math.min(blocks.length - 1, index + 3);
    candidateIndex += 1
  ) {
    const candidate = blocks[candidateIndex]
    if (!candidate) continue
    if (candidate.page !== anchor.page) break
    if (dateMatch(candidate.text) || timeMatch(candidate.text)) break
    const gap = candidate.boundingBox.y - (anchor.boundingBox.y + anchor.boundingBox.height)
    const maximumGap = Math.max(0.1, anchor.boundingBox.height * 5)
    if (gap > maximumGap) break
    if (candidate.boundingBox.y < anchor.boundingBox.y - anchor.boundingBox.height * 0.8) continue
    const value = scheduleLocation(candidate.text)
    if (value) return { block: candidate, value }
  }
  return null
}

function blockCenterX(block: DocumentTextBlock): number {
  return block.boundingBox.x + block.boundingBox.width / 2
}

function monthNumber(text: string): number | null {
  const prefix = text.toLocaleLowerCase().slice(0, 3)
  const months: Record<string, number> = {
    jan: 1,
    feb: 2,
    mar: 3,
    apr: 4,
    may: 5,
    jun: 6,
    jul: 7,
    aug: 8,
    sep: 9,
    oct: 10,
    nov: 11,
    dec: 12
  }
  return months[prefix] ?? null
}

function calendarGridCandidateSeeds(extraction: DocumentExtraction): CalendarGridCandidates {
  const seeds: CandidateSeed[] = []
  const regions: ScheduleTableRegion[] = []
  let skipped = 0
  const weekdayIndexes: Record<string, number> = {
    SUN: 0,
    MON: 1,
    TUE: 2,
    WED: 3,
    THU: 4,
    FRI: 5,
    SAT: 6
  }

  for (const page of extraction.pages) {
    const blocks = [...page.blocks].sort(
      (left, right) =>
        left.boundingBox.y - right.boundingBox.y || left.boundingBox.x - right.boundingBox.x
    )
    const monthHeading = blocks
      .map((block) => ({ block, match: calendarMonthYearPattern.exec(block.text) }))
      .find((candidate) => candidate.match?.[1] && candidate.match?.[2])
    const headingMonth = monthHeading?.match?.[1] ? monthNumber(monthHeading.match[1]) : null
    const headingYear = monthHeading?.match?.[2] ? Number.parseInt(monthHeading.match[2], 10) : null
    if (!monthHeading || !headingMonth || !headingYear) continue

    const weekdayHeaders = blocks
      .map((block) => ({
        block,
        index: weekdayIndexes[normalizeText(block.text).toLocaleUpperCase()]
      }))
      .filter(
        (candidate): candidate is { block: DocumentTextBlock; index: number } =>
          candidate.index !== undefined
      )
    if (weekdayHeaders.length < 2) continue
    const averageIndex =
      weekdayHeaders.reduce((total, header) => total + header.index, 0) / weekdayHeaders.length
    const averageX =
      weekdayHeaders.reduce((total, header) => total + blockCenterX(header.block), 0) /
      weekdayHeaders.length
    const denominator = weekdayHeaders.reduce(
      (total, header) => total + (header.index - averageIndex) ** 2,
      0
    )
    if (denominator <= 0) continue
    const columnStep =
      weekdayHeaders.reduce(
        (total, header) =>
          total + (header.index - averageIndex) * (blockCenterX(header.block) - averageX),
        0
      ) / denominator
    if (columnStep < 0.06 || columnStep > 0.22) continue
    const columnOrigin = averageX - columnStep * averageIndex
    const columnCenters = Array.from({ length: 7 }, (_, index) => columnOrigin + columnStep * index)
    const nearestColumn = (block: DocumentTextBlock): number => {
      const center = blockCenterX(block)
      return columnCenters
        .map((columnCenter, index) => ({ index, distance: Math.abs(center - columnCenter) }))
        .sort((left, right) => left.distance - right.distance)[0]!.index
    }
    const inColumn = (block: DocumentTextBlock, column: number): boolean =>
      Math.abs(blockCenterX(block) - columnCenters[column]!) <= columnStep * 0.44

    const headerBottom = Math.max(
      ...weekdayHeaders.map(
        (header) => header.block.boundingBox.y + header.block.boundingBox.height
      )
    )
    const dayBlocks = blocks.filter(
      (block) =>
        block.boundingBox.y > headerBottom &&
        /^(?:[1-9]|[12]\d|3[01])$/u.test(normalizeText(block.text)) &&
        inColumn(block, nearestColumn(block))
    )
    if (dayBlocks.length < 3) continue
    const dayRows: DocumentTextBlock[][] = []
    for (const block of dayBlocks) {
      const row = dayRows.find(
        (candidate) => Math.abs((candidate[0]?.boundingBox.y ?? 0) - block.boundingBox.y) <= 0.025
      )
      if (row) row.push(block)
      else dayRows.push([block])
    }
    dayRows.sort((left, right) => (left[0]?.boundingBox.y ?? 0) - (right[0]?.boundingBox.y ?? 0))
    const rowGaps = dayRows
      .slice(1)
      .map((row, index) =>
        Math.abs((row[0]?.boundingBox.y ?? 0) - (dayRows[index]?.[0]?.boundingBox.y ?? 0))
      )
      .filter((gap) => gap > 0.04 && gap < 0.3)
      .sort((left, right) => left - right)
    const rowHeight = rowGaps[Math.floor(rowGaps.length / 2)] ?? 0.14
    const rowIndexByBlock = new Map(
      dayRows.flatMap((row, rowIndex) => row.map((block) => [block.id, rowIndex] as const))
    )
    const firstRowDayOne = dayRows[0]?.find((block) => normalizeText(block.text) === '1')
    let nextMonthRow = Number.POSITIVE_INFINITY
    for (let rowIndex = 1; rowIndex < dayRows.length; rowIndex += 1) {
      const previousRowIndex = rowIndex - 1
      const previousDays = dayRows[previousRowIndex]!.filter(
        (block) =>
          !(
            previousRowIndex === 0 &&
            firstRowDayOne &&
            nearestColumn(block) < nearestColumn(firstRowDayOne)
          )
      ).map((block) => Number.parseInt(block.text, 10))
      const currentDays = dayRows[rowIndex]!.map((block) => Number.parseInt(block.text, 10))
      if (
        previousDays.length > 0 &&
        currentDays.length > 0 &&
        Math.max(...previousDays) >= 25 &&
        Math.min(...currentDays) <= 7
      ) {
        nextMonthRow = rowIndex
        break
      }
    }
    const dateForDayBlock = (block: DocumentTextBlock): string | null => {
      const day = Number.parseInt(block.text, 10)
      const rowIndex = rowIndexByBlock.get(block.id) ?? 0
      let base = Temporal.PlainDate.from({ year: headingYear, month: headingMonth, day: 1 })
      if (
        rowIndex === 0 &&
        firstRowDayOne &&
        nearestColumn(block) < nearestColumn(firstRowDayOne) &&
        day >= 20
      ) {
        base = base.subtract({ months: 1 })
      } else if (rowIndex >= nextMonthRow) {
        base = base.add({ months: 1 })
      }
      try {
        return base.with({ day }).toString()
      } catch {
        return null
      }
    }

    const timeBlocks = blocks.filter(
      (block) => block.boundingBox.y > headerBottom && Boolean(timeMatch(block.text))
    )
    for (const timeBlock of timeBlocks) {
      const column = nearestColumn(timeBlock)
      if (!inColumn(timeBlock, column)) continue
      const dayBlock = dayBlocks
        .filter(
          (block) =>
            inColumn(block, column) &&
            block.boundingBox.y < timeBlock.boundingBox.y &&
            timeBlock.boundingBox.y - block.boundingBox.y < rowHeight * 0.9
        )
        .sort((left, right) => right.boundingBox.y - left.boundingBox.y)[0]
      if (!dayBlock) {
        skipped += 1
        continue
      }
      const dateText = dateForDayBlock(dayBlock)
      if (!dateText) {
        skipped += 1
        continue
      }
      const cellBottom = Math.min(1, dayBlock.boundingBox.y + rowHeight * 0.92)
      const previousTime = timeBlocks
        .filter(
          (candidate) =>
            candidate.id !== timeBlock.id &&
            inColumn(candidate, column) &&
            candidate.boundingBox.y > dayBlock.boundingBox.y &&
            candidate.boundingBox.y < timeBlock.boundingBox.y
        )
        .sort((left, right) => right.boundingBox.y - left.boundingBox.y)[0]
      const titleStart = previousTime
        ? previousTime.boundingBox.y + previousTime.boundingBox.height
        : dayBlock.boundingBox.y + dayBlock.boundingBox.height
      const titleBlocks = blocks.filter(
        (block) =>
          inColumn(block, column) &&
          block.boundingBox.y >= titleStart - 0.002 &&
          block.boundingBox.y < timeBlock.boundingBox.y &&
          isUsefulTitle(block.text) &&
          !scheduleLocation(block.text)
      )
      const foundTime = timeMatch(timeBlock.text)?.[0] ?? null
      const title = cleanTitle(
        titleBlocks.map((block) => block.text).join(' '),
        dateText,
        foundTime
      )
      if (!foundTime || titleBlocks.length === 0 || !isUsefulTitle(title)) {
        skipped += 1
        continue
      }
      const nextTime = timeBlocks
        .filter(
          (candidate) =>
            candidate.id !== timeBlock.id &&
            inColumn(candidate, column) &&
            candidate.boundingBox.y > timeBlock.boundingBox.y &&
            candidate.boundingBox.y < cellBottom
        )
        .sort((left, right) => left.boundingBox.y - right.boundingBox.y)[0]
      const location = blocks
        .filter(
          (block) =>
            inColumn(block, column) &&
            block.boundingBox.y > timeBlock.boundingBox.y &&
            block.boundingBox.y < (nextTime?.boundingBox.y ?? cellBottom)
        )
        .map((block) => ({ block, value: scheduleLocation(block.text) }))
        .find((candidate) => candidate.value !== null)
      const sourceBlocks = [dayBlock, ...titleBlocks, timeBlock, location?.block]
        .filter((block): block is DocumentTextBlock => Boolean(block))
        .filter(
          (block, index, candidates) =>
            candidates.findIndex((candidate) => candidate.id === block.id) === index
        )
      const kind = sourceBlocks.some((block) =>
        /\b(?:reminder|remind me|due|deadline|to[- ]?do)\b/iu.test(block.text)
      )
        ? 'reminder'
        : 'event'
      seeds.push({
        page: page.page,
        blocks: sourceBlocks,
        dateBlock: dayBlock,
        timeBlock,
        titleBlock: titleBlocks.at(-1)!,
        titleBlocks,
        locationBlock: location?.block ?? null,
        dateText,
        timeText: foundTime,
        title,
        description: '',
        location: location?.value ?? '',
        kind,
        allDay: false,
        inferredTitle: true,
        plannerSource: 'rules',
        modelConfidence: null,
        recurrenceBlock: null,
        descriptionBlocks: [],
        recurrenceText: null,
        scheduleRow: false,
        schedule: null
      })
    }
    if (timeBlocks.length > 0) {
      regions.push({
        page: page.page,
        startY: Math.max(0, monthHeading.block.boundingBox.y - 0.02),
        endY: Math.min(1, Math.max(...dayBlocks.map((block) => block.boundingBox.y)) + rowHeight)
      })
    }
  }
  return { seeds, skipped, regions }
}

function candidateSeeds(
  extraction: DocumentExtraction,
  excludedRegions: readonly ScheduleTableRegion[] = []
): {
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
      const blockCenterY = block.boundingBox.y + block.boundingBox.height / 2
      if (
        excludedRegions.some(
          (region) =>
            region.page === block.page &&
            blockCenterY >= region.startY &&
            blockCenterY < region.endY
        )
      ) {
        continue
      }
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
      const titleBlocks = isUsefulTitle(inlineTitle)
        ? [block]
        : titleBlock
          ? stackedTitleBlocks(blocks, titleBlock)
          : []
      const title = isUsefulTitle(inlineTitle)
        ? inlineTitle
        : cleanTitle(
            titleBlocks.map((candidate) => candidate.text).join(' '),
            dateContext.text,
            foundTime?.[0] ?? null
          )
      if (!isUsefulTitle(title)) {
        skipped += 1
        continue
      }
      const location = findLocationBlock(blocks, index + 1, block)
      const source = [dateContext.block, ...titleBlocks, block, location?.block]
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
        titleBlock: titleBlocks.at(-1) ?? block,
        titleBlocks,
        locationBlock: location?.block ?? null,
        dateText: dateContext.text,
        timeText: foundTime?.[0] ?? null,
        title,
        description: '',
        location: location?.value ?? '',
        kind,
        allDay,
        inferredTitle: titleBlocks.some((candidate) => candidate.id !== block.id),
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
    const learnedLocationBlock = locationSpan ? blocks.get(locationSpan.blockId) : null
    const recurrenceBlock = recurrenceSpan ? blocks.get(recurrenceSpan.blockId) : null
    const descriptionBlock = descriptionSpan ? blocks.get(descriptionSpan.blockId) : null
    const groupEvidenceBlocks = group.evidenceBlockIds
      .map((id) => blocks.get(id))
      .filter((block): block is DocumentTextBlock => Boolean(block))
    if (!titleSpan || !dateSpan || !titleBlock || !dateBlock || groupEvidenceBlocks.length === 0) {
      skipped += 1
      continue
    }
    const dateText = dateSpan.text
    const timeText = timeSpan?.text ?? null
    // A learned group already names its exact title span. Expanding from that
    // anchor with generic nearby-line heuristics can absorb a print header,
    // footer, or adjacent repeated title that PlanScan deliberately excluded.
    const titleBlocks = [titleBlock]
    const title = cleanTitle(titleBlocks.map((block) => block.text).join(' '), dateText, timeText)
    const locationBlock = learnedLocationBlock ?? null
    const location = locationSpan?.text ?? ''
    const evidenceBlocks = [...groupEvidenceBlocks, ...titleBlocks, locationBlock]
      .filter((block): block is DocumentTextBlock => Boolean(block))
      .filter(
        (block, index, candidates) =>
          candidates.findIndex((candidate) => candidate.id === block.id) === index
      )
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
      titleBlocks,
      locationBlock: locationBlock ?? null,
      dateText,
      timeText,
      title,
      description: descriptionSpan?.text ?? '',
      location,
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

function stableSourceRowId(seed: CandidateSeed): string {
  const canonicalBlocks = [...seed.blocks]
    .sort(
      (left, right) =>
        left.page - right.page ||
        left.boundingBox.y - right.boundingBox.y ||
        left.boundingBox.x - right.boundingBox.x ||
        left.id.localeCompare(right.id)
    )
    .map((block) =>
      [
        block.page,
        block.boundingBox.x.toFixed(4),
        block.boundingBox.y.toFixed(4),
        block.boundingBox.width.toFixed(4),
        block.boundingBox.height.toFixed(4),
        normalizeText(block.text).toLocaleLowerCase()
      ].join('|')
    )
  return documentSourceRowId(canonicalBlocks.join('\n'))
}

interface ResolvedDocumentDate {
  date: string
  origin: DocumentPlanRecord['dateOrigin']
}

interface ResolvedDocumentTime {
  startTime: string | null
  endTime: string | null
  endDate: string | null
  basis: DocumentPlanRecord['timeBasis']
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

function safePlainDate(year: number, month: number, day: number): string | null {
  try {
    return Temporal.PlainDate.from({ year, month, day }, { overflow: 'reject' }).toString()
  } catch {
    return null
  }
}

function normalizedDocumentYear(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  if (value.length !== 2) return parsed
  return parsed >= 70 ? 1900 + parsed : 2000 + parsed
}

function resolveDocumentDate(
  text: string,
  context: DocumentPlanningContext
): ResolvedDocumentDate | null {
  const local = Temporal.PlainDate.from(context.localDate)
  const normalized = normalizeText(text)
    .replace(/(\d)(?:st|nd|rd|th)\b/giu, '$1')
    .replace(/,/gu, '')
    .trim()
  const lower = normalized.toLocaleLowerCase()
  const relativeDays: Record<string, number> = {
    today: 0,
    tomorrow: 1,
    'day after tomorrow': 2
  }
  const relativeOffset = relativeDays[lower]
  if (relativeOffset !== undefined) {
    return { date: local.add({ days: relativeOffset }).toString(), origin: 'relative-source' }
  }

  const weekdayMatch =
    /^(?:(this|next)\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/iu.exec(
      normalized
    )
  if (weekdayMatch?.[2]) {
    const weekday = weekdayMatch[2].toLocaleLowerCase() as Weekday
    const target = weekdayByNumber.indexOf(weekday) + 1
    let offset = (target - local.dayOfWeek + 7) % 7
    if (offset === 0 && weekdayMatch[1]?.toLocaleLowerCase() === 'next') offset = 7
    return { date: local.add({ days: offset }).toString(), origin: 'relative-source' }
  }

  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(normalized)
  if (isoMatch?.[1] && isoMatch[2] && isoMatch[3]) {
    const date = safePlainDate(
      Number.parseInt(isoMatch[1], 10),
      Number.parseInt(isoMatch[2], 10),
      Number.parseInt(isoMatch[3], 10)
    )
    return date ? { date, origin: 'absolute-source' } : null
  }

  const numericMatch = /^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?$/u.exec(normalized)
  if (numericMatch?.[1] && numericMatch[2]) {
    const first = Number.parseInt(numericMatch[1], 10)
    const second = Number.parseInt(numericMatch[2], 10)
    const monthFirst = first > 12 ? false : second > 12 || /^en-(?:US|CA)\b/iu.test(context.locale)
    const year = normalizedDocumentYear(numericMatch[3], local.year)
    const date = safePlainDate(year, monthFirst ? first : second, monthFirst ? second : first)
    return date ? { date, origin: 'absolute-source' } : null
  }

  const monthFirstMatch = /^([\p{L}.]+)\s+(\d{1,2})(?:\s+(\d{4}))?$/iu.exec(normalized)
  if (monthFirstMatch?.[1] && monthFirstMatch[2]) {
    const month = monthNumber(monthFirstMatch[1].replace(/\./gu, ''))
    const date = month
      ? safePlainDate(
          normalizedDocumentYear(monthFirstMatch[3], local.year),
          month,
          Number.parseInt(monthFirstMatch[2], 10)
        )
      : null
    return date ? { date, origin: 'absolute-source' } : null
  }

  const dayFirstMatch = /^(\d{1,2})\s+([\p{L}.]+)(?:\s+(\d{4}))?$/iu.exec(normalized)
  if (dayFirstMatch?.[1] && dayFirstMatch[2]) {
    const month = monthNumber(dayFirstMatch[2].replace(/\./gu, ''))
    const date = month
      ? safePlainDate(
          normalizedDocumentYear(dayFirstMatch[3], local.year),
          month,
          Number.parseInt(dayFirstMatch[1], 10)
        )
      : null
    return date ? { date, origin: 'absolute-source' } : null
  }
  return null
}

interface ClockParts {
  hour: number
  minute: number
  meridiem: 'am' | 'pm' | null
}

function clockParts(text: string): ClockParts | null {
  const normalized = normalizeText(text).replace(/\./gu, '').toLocaleLowerCase()
  if (normalized === 'noon') return { hour: 12, minute: 0, meridiem: 'pm' }
  if (normalized === 'midnight') return { hour: 12, minute: 0, meridiem: 'am' }
  const withMeridiem = /^(\d{1,2})(?::(\d{2}))?\s*([ap])m$/u.exec(normalized)
  if (withMeridiem?.[1]) {
    const hour = Number.parseInt(withMeridiem[1], 10)
    const minute = Number.parseInt(withMeridiem[2] ?? '0', 10)
    if (hour < 1 || hour > 12 || minute > 59) return null
    return { hour, minute, meridiem: withMeridiem[3] === 'p' ? 'pm' : 'am' }
  }
  const twentyFourHour = /^(\d{1,2})(?::(\d{2}))?$/u.exec(normalized)
  if (!twentyFourHour?.[1]) return null
  const hour = Number.parseInt(twentyFourHour[1], 10)
  const minute = Number.parseInt(twentyFourHour[2] ?? '0', 10)
  if (hour > 23 || minute > 59) return null
  return { hour, minute, meridiem: null }
}

function localTimeFromClock(parts: ClockParts, fallback: 'am' | 'pm' | null): string | null {
  const meridiem = parts.meridiem ?? fallback
  let hour = parts.hour
  if (meridiem) {
    if (hour < 1 || hour > 12) return null
    if (meridiem === 'am') hour = hour === 12 ? 0 : hour
    else hour = hour === 12 ? 12 : hour + 12
  }
  if (hour > 23) return null
  return `${hour.toString().padStart(2, '0')}:${parts.minute.toString().padStart(2, '0')}`
}

function sourceAllowsOvernight(seed: CandidateSeed): boolean {
  return /\b(?:overnight|next day|following day|spans midnight)\b/iu.test(
    seed.blocks.map((block) => block.text).join(' ')
  )
}

function resolveDocumentTime(
  seed: CandidateSeed,
  startDate: string,
  printedEndDate: string,
  context: DocumentPlanningContext
): ResolvedDocumentTime | null {
  if (seed.allDay) {
    return {
      startTime: null,
      endTime: null,
      endDate: seed.kind === 'event' ? printedEndDate : null,
      basis: 'all-day'
    }
  }
  if (!seed.timeText) return null
  const normalized = normalizeText(seed.timeText).replace(/^from\s+/iu, '')
  const parts = normalized
    .split(/\s*(?:-|–|—|\bto\b|\buntil\b)\s*/iu)
    .map((part) => part.trim())
    .filter(Boolean)
  if (parts.length === 0 || parts.length > 2) return null
  const startParts = clockParts(parts[0]!)
  const endParts = parts[1] ? clockParts(parts[1]) : null
  if (!startParts || (parts[1] && !endParts)) return null
  const startTime = localTimeFromClock(startParts, endParts?.meridiem ?? null)
  if (!startTime) return null
  if (seed.kind === 'reminder') {
    return { startTime, endTime: null, endDate: null, basis: 'source-instant' }
  }
  if (!endParts) {
    if (printedEndDate !== startDate) return null
    const start = Temporal.PlainTime.from(startTime)
    const end = start.add({ minutes: context.defaultEventDurationMinutes })
    const wraps = Temporal.PlainTime.compare(end, start) <= 0
    return {
      startTime,
      endTime: end.toString({ smallestUnit: 'minute' }),
      endDate: wraps ? Temporal.PlainDate.from(startDate).add({ days: 1 }).toString() : startDate,
      basis: 'default-duration'
    }
  }
  const endTime = localTimeFromClock(endParts, startParts.meridiem)
  if (!endTime) return null
  let endDate = printedEndDate
  if (endDate === startDate && endTime <= startTime) {
    if (!sourceAllowsOvernight(seed)) return null
    endDate = Temporal.PlainDate.from(startDate).add({ days: 1 }).toString()
  }
  return { startTime, endTime, endDate, basis: 'source-range' }
}

function alignDateToWeekdays(date: string, weekdays: readonly Weekday[]): string | null {
  let candidate = Temporal.PlainDate.from(date)
  for (let offset = 0; offset < 7; offset += 1) {
    const weekday = weekdayByNumber[candidate.dayOfWeek - 1]
    if (weekday && weekdays.includes(weekday)) return candidate.toString()
    candidate = candidate.add({ days: 1 })
  }
  return null
}

function documentTimezone(
  seed: CandidateSeed,
  fallback: string
): { timezone: string; origin: DocumentPlanRecord['timezoneOrigin']; evidence: string[] } {
  const abbreviationZones: Record<string, string> = {
    UTC: 'UTC',
    GMT: 'UTC',
    EST: 'America/New_York',
    EDT: 'America/New_York',
    CST: 'America/Chicago',
    CDT: 'America/Chicago',
    MST: 'America/Denver',
    MDT: 'America/Denver',
    PST: 'America/Los_Angeles',
    PDT: 'America/Los_Angeles'
  }
  for (const block of seed.blocks) {
    const iana = /\b[A-Z][A-Za-z_]+\/[A-Z][A-Za-z_]+(?:\/[A-Z][A-Za-z_]+)?\b/u.exec(block.text)?.[0]
    if (iana) {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: iana }).format()
        return { timezone: iana, origin: 'document', evidence: [block.id] }
      } catch {
        // Continue to a known abbreviation or the calendar default.
      }
    }
    const abbreviation = /\b(?:UTC|GMT|EST|EDT|CST|CDT|MST|MDT|PST|PDT)\b/u.exec(
      block.text.toLocaleUpperCase()
    )?.[0]
    if (abbreviation && abbreviationZones[abbreviation]) {
      return {
        timezone: abbreviationZones[abbreviation],
        origin: 'document',
        evidence: [block.id]
      }
    }
  }
  return { timezone: fallback, origin: 'calendar-default', evidence: [] }
}

function hasInterveningBlock(
  blocks: readonly DocumentTextBlock[],
  first: DocumentTextBlock,
  second: DocumentTextBlock,
  claimed: ReadonlySet<string>,
  predicate: (block: DocumentTextBlock) => boolean
): boolean {
  const top = Math.min(
    first.boundingBox.y + first.boundingBox.height / 2,
    second.boundingBox.y + second.boundingBox.height / 2
  )
  const bottom = Math.max(
    first.boundingBox.y + first.boundingBox.height / 2,
    second.boundingBox.y + second.boundingBox.height / 2
  )
  return blocks.some((block) => {
    const center = block.boundingBox.y + block.boundingBox.height / 2
    return !claimed.has(block.id) && center > top && center < bottom && predicate(block)
  })
}

function candidateEvidenceHasOneScope(
  seed: CandidateSeed,
  extraction: DocumentExtraction
): boolean {
  const coreBlocks = [
    ...seed.titleBlocks,
    seed.dateBlock,
    seed.timeBlock,
    seed.recurrenceBlock,
    seed.locationBlock
  ].filter((block): block is DocumentTextBlock => Boolean(block))
  if (coreBlocks.some((block) => block.page !== seed.page)) return false
  const pageBlocks = extraction.pages.find((page) => page.page === seed.page)?.blocks ?? []
  const claimed = new Set(coreBlocks.map((block) => block.id))
  const title = seed.titleBlocks.at(-1) ?? seed.titleBlock
  const time = seed.timeBlock
  if (time) {
    const titleGap = Math.abs(
      title.boundingBox.y +
        title.boundingBox.height / 2 -
        (time.boundingBox.y + time.boundingBox.height / 2)
    )
    if (titleGap > (seed.plannerSource === 'qwen-fallback' ? 0.42 : 0.24)) return false
    if (
      hasInterveningBlock(pageBlocks, title, time, claimed, (block) =>
        Boolean(dateMatch(block.text) || timeMatch(block.text))
      )
    ) {
      return false
    }
    if (
      seed.locationBlock &&
      hasInterveningBlock(pageBlocks, time, seed.locationBlock, claimed, (block) =>
        Boolean(dateMatch(block.text) || timeMatch(block.text))
      )
    ) {
      return false
    }
  }
  if (
    time &&
    hasInterveningBlock(pageBlocks, seed.dateBlock, time, claimed, (block) =>
      Boolean(dateMatch(block.text))
    )
  ) {
    return false
  }
  return true
}

function explicitWeeklyRecurrence(
  seed: CandidateSeed,
  startDate: string,
  rangeEndDate: string,
  context: DocumentPlanningContext
): { recurrence: RecurrenceRule; startDate: string } | null {
  if (!seed.recurrenceText || !seed.recurrenceBlock) return null
  let weekdays = weekdayListFromRecurrenceEvidence(seed.recurrenceText)
  let alignedStart = startDate
  const startWeekday = weekdayByNumber[Temporal.PlainDate.from(startDate).dayOfWeek - 1]
  if (weekdays.length === 0 && startWeekday && /\bweekly\b/iu.test(seed.recurrenceText)) {
    // “Weekly” plus an explicit source date defines its weekday without
    // inventing one: the first printed occurrence is the recurrence anchor.
    weekdays = [startWeekday]
  }
  if (weekdays.length === 0) return null
  if (!startWeekday || !weekdays.includes(startWeekday)) {
    if (rangeEndDate === startDate) return null
    alignedStart = alignDateToWeekdays(startDate, weekdays) ?? ''
    if (!alignedStart || alignedStart > rangeEndDate) return null
  }
  const untilPattern = new RegExp(`\\buntil\\s+(${scheduleDateToken})\\b`, 'iu')
  const untilText = untilPattern.exec(seed.recurrenceText)?.[1]
  const explicitUntil = untilText ? resolveDocumentDate(untilText, context)?.date : null
  const end = explicitUntil
    ? { kind: 'until' as const, date: explicitUntil }
    : rangeEndDate > startDate
      ? { kind: 'until' as const, date: rangeEndDate }
      : { kind: 'never' as const }
  return {
    startDate: alignedStart,
    recurrence: { frequency: 'weekly', interval: 1, byWeekday: weekdays, byMonthDay: [], end }
  }
}

function weekdayListFromRecurrenceEvidence(text: string): Weekday[] {
  const candidates = [
    text,
    text.split(/\b(?:until|through)\b/iu)[0] ?? text,
    text
      .replace(scheduleDateRangePattern, ' ')
      .replace(
        /^\s*(?:(?:meeting\s+)?days?|meets?|class(?:\s+meets?)?|occurs?|repeats?|weekly(?:\s+on)?|on)\s*[:\-–—]?\s*/iu,
        ''
      )
  ]
  for (const candidate of candidates) {
    const weekdays = weekdayList(candidate.trim())
    if (weekdays.length > 0) return weekdays
  }
  return []
}

function compileDocumentPlanRecord(
  seed: CandidateSeed,
  extraction: DocumentExtraction,
  context: DocumentPlanningContext
): DocumentPlanRecord | null {
  if (!candidateEvidenceHasOneScope(seed, extraction)) return null
  const sourceBlockIds = blockIds(seed.blocks)
  const sourceDateRange = scheduleDateRangePattern.exec(normalizeText(seed.dateBlock.text))
  const printedStart = resolveDocumentDate(
    seed.schedule?.termStartText ?? sourceDateRange?.[1] ?? seed.dateText,
    context
  )
  const printedEnd = resolveDocumentDate(
    seed.schedule?.termEndText ?? sourceDateRange?.[2] ?? seed.dateText,
    context
  )
  if (!printedStart || !printedEnd) return null

  let startDate = printedStart.date
  let rangeEndDate = seed.kind === 'event' ? printedEnd.date : printedStart.date
  let recurrence: RecurrenceRule | null = null
  let schedule: DocumentScheduleMetadata | null = null
  if (seed.schedule) {
    const seedDate = resolveDocumentDate(seed.dateText, context)
    if (!seedDate || seedDate.date !== printedStart.date) return null
    startDate = alignDateToWeekdays(printedStart.date, seed.schedule.weekdays) ?? ''
    if (!startDate || startDate > printedEnd.date) return null
    rangeEndDate = startDate
    recurrence = {
      frequency: 'weekly',
      interval: 1,
      byWeekday: seed.schedule.weekdays,
      byMonthDay: [],
      end: { kind: 'until', date: printedEnd.date }
    }
    schedule = {
      courseCode: seed.schedule.courseCode,
      sectionCode: seed.schedule.sectionCode,
      crn: seed.schedule.crn,
      creditHours: seed.schedule.creditHours,
      component: seed.schedule.component,
      termStartDate: printedStart.date,
      termEndDate: printedEnd.date,
      weekdays: seed.schedule.weekdays,
      verification: seed.schedule.verification
    }
  } else if (seed.recurrenceText || seed.recurrenceBlock) {
    const explicit = explicitWeeklyRecurrence(seed, startDate, rangeEndDate, context)
    if (!explicit) return null
    startDate = explicit.startDate
    recurrence = explicit.recurrence
  }

  const resolvedTime = resolveDocumentTime(seed, startDate, rangeEndDate, context)
  if (!resolvedTime) return null
  const timezone = documentTimezone(seed, context.timezone)
  const titleEvidence = blockIds(seed.titleBlocks)
  const dateEvidence = [seed.dateBlock.id]
  const timeEvidence = seed.timeBlock ? [seed.timeBlock.id] : []
  const locationEvidence = seed.locationBlock ? [seed.locationBlock.id] : []
  const recurrenceEvidence = seed.recurrenceBlock ? [seed.recurrenceBlock.id] : []
  const courseEvidence = schedule
    ? blockIds(seed.descriptionBlocks.length > 0 ? seed.descriptionBlocks : [seed.titleBlock])
    : []
  const descriptionEvidence = seed.description
    ? seed.descriptionBlocks.length > 0
      ? blockIds(seed.descriptionBlocks)
      : courseEvidence
    : []
  const parsed = documentPlanRecordSchema.safeParse({
    version: '0.1',
    kind: seed.kind,
    page: seed.page,
    title: calendarTitleFromSeed(seed),
    description: seed.description,
    allDay: seed.allDay,
    startDate,
    endDate: resolvedTime.endDate,
    startTime: resolvedTime.startTime,
    endTime: resolvedTime.endTime,
    timeBasis: resolvedTime.basis,
    timezone: timezone.timezone,
    timezoneOrigin: timezone.origin,
    location: seed.location,
    recurrence,
    schedule,
    dateOrigin: printedStart.origin,
    sourceBlockIds,
    evidence: {
      title: titleEvidence,
      date: dateEvidence,
      time: timeEvidence,
      timezone: timezone.evidence,
      location: locationEvidence,
      recurrence: recurrenceEvidence,
      course: courseEvidence,
      description: descriptionEvidence
    }
  })
  return parsed.success ? parsed.data : null
}

function buildDraft(
  seed: CandidateSeed,
  extraction: DocumentExtraction,
  context: DocumentPlanningContext,
  index: number,
  semanticRecord: DocumentPlanRecord
): DocumentImportDraft | null {
  const requestId = `request:document:${extraction.source.sha256.slice(0, 12)}:${seed.page}:${index}`
  const expectedOperation = semanticRecord.kind === 'event' ? 'event.create' : 'reminder.create'
  const titleEvidence = semanticRecord.evidence.title
  const whenEvidence = [
    ...new Set([
      ...semanticRecord.evidence.date,
      ...semanticRecord.evidence.time,
      ...semanticRecord.evidence.timezone,
      ...semanticRecord.evidence.recurrence
    ])
  ]
  const locationEvidence = semanticRecord.evidence.location
  const descriptionEvidence = semanticRecord.evidence.description
  const sourceIdentity = {
    sourceSha256: extraction.source.sha256,
    sourceRowId: stableSourceRowId(seed)
  }
  const sourceConfidence =
    seed.blocks.reduce((total, block) => total + block.confidence, 0) / seed.blocks.length
  const blocksById = new Map(seed.blocks.map((block) => [block.id, block] as const))
  const confidenceFor = (ids: readonly string[]): number | null => {
    const values = ids
      .map((id) => blocksById.get(id)?.confidence)
      .filter((value): value is number => value !== undefined)
    if (values.length === 0) return null
    const evidenceConfidence = values.reduce((total, value) => total + value, 0) / values.length
    return Math.max(
      0,
      Math.min(
        1,
        evidenceConfidence,
        seed.plannerSource === 'planscan' || seed.plannerSource === 'qwen-fallback'
          ? (seed.modelConfidence ?? 1)
          : 1
      )
    )
  }
  const fieldConfidence: DocumentFieldConfidence = {
    title: confidenceFor(titleEvidence) ?? sourceConfidence,
    when: confidenceFor(whenEvidence) ?? sourceConfidence,
    location: confidenceFor(locationEvidence),
    description: confidenceFor(descriptionEvidence)
  }
  const proposal = calendarIRDraftSchema.parse({
    version: '0.1',
    requestId,
    operation: expectedOperation,
    selection: null,
    fields: {
      title: {
        value: semanticRecord.title,
        sourceSpan: null,
        evidenceIds: titleEvidence
      },
      description: semanticRecord.description
        ? {
            value: semanticRecord.description,
            sourceSpan: null,
            evidenceIds: descriptionEvidence
          }
        : null,
      location: semanticRecord.location
        ? {
            value: semanticRecord.location,
            sourceSpan: null,
            evidenceIds: locationEvidence
          }
        : null,
      when: {
        value: {
          start: {
            date: { kind: 'absolute', date: semanticRecord.startDate },
            time: semanticRecord.startTime
          },
          end:
            semanticRecord.kind === 'event' && semanticRecord.endDate
              ? {
                  date: { kind: 'absolute', date: semanticRecord.endDate },
                  time: semanticRecord.endTime
                }
              : null,
          allDay: semanticRecord.allDay,
          timezone: semanticRecord.timezone
        },
        sourceSpan: null,
        evidenceIds: whenEvidence
      },
      reminderOffsetMinutes: null,
      status: null
    },
    recurrence: semanticRecord.recurrence,
    scope: 'single',
    references: [],
    ambiguities: [],
    risk: 'medium',
    confidence: Math.min(
      0.93,
      sourceConfidence,
      seed.scheduleRow ? 1 : (seed.modelConfidence ?? 1)
    ),
    evidence: evidenceFromBlocks(seed.blocks, extraction)
  })
  const zonedNow = Temporal.Instant.from(context.nowUtc).toZonedDateTimeISO(semanticRecord.timezone)
  const resolved = resolveCalendarIR(proposal, {
    nowUtc: context.nowUtc,
    localDate: context.localDate,
    timezone: semanticRecord.timezone,
    utcOffsetMinutes: Math.round(zonedNow.offsetNanoseconds / 60_000_000_000),
    defaultCalendarId: context.defaultCalendarId,
    defaultEventDurationMinutes: context.defaultEventDurationMinutes
  })
  const warnings: string[] = []
  if (seed.blocks.some((block) => block.method === 'ocr') && sourceConfidence < 0.82) {
    warnings.push('OCR confidence is modest; compare this item with the highlighted source.')
  }
  if (seed.inferredTitle) warnings.push('The title was paired with a nearby date and time.')
  if (seed.scheduleRow && semanticRecord.schedule?.verification !== 'layout-and-planscan') {
    warnings.push(
      'The layout reader reconstructed this repeating schedule pattern without a PlanScan match; compare it with the highlighted source.'
    )
  }
  if (seed.plannerSource === 'planscan') {
    warnings.push(
      'PlanScan linked these fields from their position on the page; verify the highlights.'
    )
  }
  if (seed.plannerSource === 'qwen-fallback') {
    warnings.push(
      'The optional local model grouped exact extracted fields that the built-in document reader did not connect. Compare every highlight before adding it.'
    )
  }
  if (semanticRecord.kind === 'event' && semanticRecord.timeBasis === 'default-duration') {
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
    semanticRecord,
    schedule: semanticRecord.schedule,
    fieldEvidence: {
      title: titleEvidence,
      when: whenEvidence,
      location: locationEvidence,
      description: descriptionEvidence
    },
    fieldConfidence,
    warnings
  }

  if (semanticRecord.kind === 'event') {
    if (!resolved.fields.startUtc || !resolved.fields.endUtc || !resolved.fields.title) return null
    const timezone = resolved.fields.timezone ?? semanticRecord.timezone
    const start = localParts(resolved.fields.startUtc, timezone)
    const endInstant = resolved.fields.allDay
      ? Temporal.Instant.from(resolved.fields.endUtc).subtract({ nanoseconds: 1 }).toString()
      : resolved.fields.endUtc
    const end = localParts(endInstant, timezone)
    if (
      timezone !== semanticRecord.timezone ||
      start.date !== semanticRecord.startDate ||
      end.date !== semanticRecord.endDate ||
      (!semanticRecord.allDay &&
        (start.time !== semanticRecord.startTime || end.time !== semanticRecord.endTime)) ||
      recurrenceFingerprint(resolved.recurrence) !==
        recurrenceFingerprint(semanticRecord.recurrence)
    ) {
      return null
    }
    const form = eventFormSchema.parse({
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
    const importIdentity = createEventDocumentImportIdentity(
      sourceIdentity,
      form,
      semanticRecord.schedule
    )
    const reconciliation = reconcileDocumentEvent(
      importIdentity,
      form,
      context.events,
      context.reminders
    )
    if (reconciliation.state === 'same-source') {
      warnings.push('This exact source row was imported before and is left unselected.')
    } else if (reconciliation.state === 'likely-duplicate') {
      warnings.push('A likely calendar match is shown below; select this item only if it is new.')
    }
    return documentImportDraftSchema.parse({
      ...common,
      attention:
        reconciliation.state === 'same-source' || reconciliation.state === 'likely-duplicate'
          ? 'check-evidence'
          : common.attention,
      importIdentity,
      reconciliation,
      kind: 'event',
      form
    })
  }

  if (!resolved.fields.dueAtUtc || !resolved.fields.title) return null
  const timezone = resolved.fields.timezone ?? semanticRecord.timezone
  const due = localParts(resolved.fields.dueAtUtc, timezone)
  if (
    timezone !== semanticRecord.timezone ||
    due.date !== semanticRecord.startDate ||
    due.time !== semanticRecord.startTime ||
    recurrenceFingerprint(resolved.recurrence) !== recurrenceFingerprint(semanticRecord.recurrence)
  ) {
    return null
  }
  const form = reminderFormSchema.parse({
    id: null,
    calendarId: context.defaultCalendarId,
    title: resolved.fields.title,
    notes: resolved.fields.description ?? '',
    dueDate: due.date,
    dueTime: due.time,
    timezone,
    recurrence: resolved.recurrence
  })
  const importIdentity = createReminderDocumentImportIdentity(sourceIdentity, form)
  const reconciliation = reconcileDocumentReminder(
    importIdentity,
    form,
    context.reminders,
    context.events
  )
  if (reconciliation.state === 'same-source') {
    warnings.push('This exact source row was imported before and is left unselected.')
  } else if (reconciliation.state === 'likely-duplicate') {
    warnings.push('A likely calendar match is shown below; select this item only if it is new.')
  }
  return documentImportDraftSchema.parse({
    ...common,
    attention:
      reconciliation.state === 'same-source' || reconciliation.state === 'likely-duplicate'
        ? 'check-evidence'
        : common.attention,
    importIdentity,
    reconciliation,
    kind: 'reminder',
    form
  })
}

function recurrenceFingerprint(recurrence: DocumentImportDraft['form']['recurrence']): string {
  if (!recurrence) return 'once'
  return JSON.stringify({
    ...recurrence,
    byWeekday: [...recurrence.byWeekday].sort(),
    byMonthDay: [...recurrence.byMonthDay].sort((left, right) => left - right)
  })
}

function repairAnchor(seed: CandidateSeed): string {
  return `${seed.page}:${seed.dateBlock.id}:${seed.timeBlock?.id ?? 'all-day'}`
}

function repairRecordFingerprint(record: DocumentPlanRecord): string {
  return JSON.stringify({
    kind: record.kind,
    title: normalizeText(record.title).toLocaleLowerCase(),
    description: normalizeText(record.description).toLocaleLowerCase(),
    startDate: record.startDate,
    endDate: record.endDate,
    startTime: record.startTime,
    endTime: record.endTime,
    timezone: record.timezone,
    location: normalizeText(record.location).toLocaleLowerCase(),
    recurrence: recurrenceFingerprint(record.recurrence)
  })
}

function repairCitations(
  record: DocumentPlanRecord,
  extraction: DocumentExtraction
): DocumentRepairCitation[] {
  const blocks = new Map(
    extraction.pages.flatMap((page) => page.blocks.map((block) => [block.id, block] as const))
  )
  const fields: Array<[DocumentRepairCitation['role'], readonly string[]]> = [
    ['title', record.evidence.title],
    ['date', record.evidence.date],
    ['time', record.evidence.time],
    ['location', record.evidence.location],
    ['description', record.evidence.description],
    ['recurrence', record.evidence.recurrence]
  ]
  const citations: DocumentRepairCitation[] = []
  for (const [role, ids] of fields) {
    for (const id of ids) {
      const block = blocks.get(id)
      if (
        !block ||
        citations.some((citation) => citation.blockId === block.id && citation.role === role)
      ) {
        continue
      }
      citations.push({
        blockId: block.id,
        page: block.page,
        role,
        text: block.text,
        start: 0,
        end: block.text.length
      })
    }
  }
  return citations.slice(0, 24)
}

function repairCandidate(
  id: string,
  origin: DocumentRepairCandidate['origin'],
  draft: DocumentImportDraft,
  extraction: DocumentExtraction
): DocumentRepairCandidate {
  const record = draft.semanticRecord
  const when =
    record.kind === 'event'
      ? `${record.startDate}${record.startTime ? ` ${record.startTime}` : ' all day'}${record.endDate && record.endDate !== record.startDate ? ` through ${record.endDate}` : ''}${record.endTime ? ` to ${record.endTime}` : ''}`
      : `${record.startDate}${record.startTime ? ` ${record.startTime}` : ''}`
  return {
    id,
    origin,
    draftId: draft.id,
    kind: draft.kind,
    title: record.title,
    when,
    location: record.location,
    recurrence: record.recurrence ? recurrenceFingerprint(record.recurrence) : '',
    citations: repairCitations(record, extraction)
  }
}

export function planDocumentExtraction(
  extractionInput: DocumentExtraction,
  context: DocumentPlanningContext
): DocumentAnalysis {
  const extraction = documentAnalysisSchema.shape.extraction.parse(extractionInput)
  const scheduleCandidates = scheduleTableCandidateSeeds(extraction)
  const syllabusCandidates = syllabusCandidateSeeds(extraction, scheduleCandidates.regions)
  const calendarGridCandidates = calendarGridCandidateSeeds(extraction)
  const modelCandidates = planScanCandidateSeeds(extraction)
  const scheduleSeeds = corroborateScheduleSeeds(scheduleCandidates.seeds, extraction)
  const syllabusSeeds = corroborateScheduleSeeds(syllabusCandidates.seeds, extraction)
  const structuredRegions = [
    ...scheduleCandidates.regions,
    ...syllabusCandidates.regions,
    ...calendarGridCandidates.regions
  ]
  const ruleCandidates = candidateSeeds(extraction, structuredRegions)
  const outsideStructuredRegions = (seed: CandidateSeed): boolean =>
    !structuredRegions.some((region) => regionContains(seed, region))
  const usableModelSeeds = modelCandidates.seeds.filter(outsideStructuredRegions)
  const usableRuleSeeds = ruleCandidates.seeds.filter(outsideStructuredRegions)
  const semanticRecords = new Map<CandidateSeed, DocumentPlanRecord | null>()
  const semanticRecordForSeed = (seed: CandidateSeed): DocumentPlanRecord | null => {
    if (semanticRecords.has(seed)) return semanticRecords.get(seed) ?? null
    let record: DocumentPlanRecord | null = null
    try {
      record = compileDocumentPlanRecord(seed, extraction, context)
    } catch {
      // The semantic gate fails closed; a malformed candidate cannot claim nearby evidence.
    }
    semanticRecords.set(seed, record)
    return record
  }
  const semanticallyValidModelSeeds = usableModelSeeds.filter((seed) =>
    Boolean(semanticRecordForSeed(seed))
  )
  const parserDisagreementPairs = semanticallyValidModelSeeds.flatMap((modelSeed) => {
    const modelRecord = semanticRecordForSeed(modelSeed)
    if (!modelRecord) return []
    const ruleSeed = usableRuleSeeds.find((candidate) => {
      if (repairAnchor(candidate) !== repairAnchor(modelSeed)) return false
      const ruleRecord = semanticRecordForSeed(candidate)
      return Boolean(
        ruleRecord && repairRecordFingerprint(ruleRecord) !== repairRecordFingerprint(modelRecord)
      )
    })
    return ruleSeed ? [{ modelSeed, ruleSeed }] : []
  })
  const repairPairs = parserDisagreementPairs.slice(0, maximumAutomaticRepairDisagreements)
  const semanticRejectedModelCount = usableModelSeeds.length - semanticallyValidModelSeeds.length
  const repairModelSeeds = new Set(parserDisagreementPairs.map((pair) => pair.modelSeed))
  const activeUnstructuredSeeds = [
    ...semanticallyValidModelSeeds.filter((seed) => !repairModelSeeds.has(seed)),
    ...parserDisagreementPairs.map((pair) => pair.ruleSeed)
  ]
  const activeClaimedAnchors = new Set(
    activeUnstructuredSeeds.flatMap((seed) =>
      [seed.dateBlock.id, seed.timeBlock?.id].filter((id): id is string => Boolean(id))
    )
  )
  const supplementalRuleSeeds = usableRuleSeeds.filter(
    (seed) =>
      !activeClaimedAnchors.has(seed.dateBlock.id) &&
      (!seed.timeBlock || !activeClaimedAnchors.has(seed.timeBlock.id))
  )
  const seeds = [
    ...scheduleSeeds,
    ...syllabusSeeds,
    ...calendarGridCandidates.seeds,
    ...activeUnstructuredSeeds,
    ...supplementalRuleSeeds
  ]
  const drafts: DocumentImportDraft[] = []
  const draftBySeed = new Map<CandidateSeed, DocumentImportDraft>()
  const seenSourceRows = new Set<string>()
  let duplicateCandidateCount = 0
  let existingCalendarDuplicateCount = 0
  let likelyDuplicateCount = 0
  let protectedDistinctCount = 0
  let skipped =
    scheduleCandidates.skipped +
    syllabusCandidates.skipped +
    calendarGridCandidates.skipped +
    modelCandidates.skipped +
    ruleCandidates.skipped +
    semanticRejectedModelCount
  for (let index = 0; index < seeds.length; index += 1) {
    const seed = seeds[index]
    if (!seed) continue
    const semanticRecord = semanticRecordForSeed(seed)
    if (!semanticRecord) {
      skipped += 1
      continue
    }
    let draft: DocumentImportDraft | null = null
    try {
      draft = buildDraft(seed, extraction, context, index, semanticRecord)
    } catch {
      // One malformed candidate must not prevent review of the remaining source evidence.
    }
    if (!draft) {
      skipped += 1
      continue
    }
    const sourceRowKey = `${draft.importIdentity.sourceSha256}:${draft.importIdentity.sourceRowId}`
    if (seenSourceRows.has(sourceRowKey)) {
      duplicateCandidateCount += 1
      continue
    }
    seenSourceRows.add(sourceRowKey)
    if (draft.reconciliation.state === 'same-source') existingCalendarDuplicateCount += 1
    if (draft.reconciliation.state === 'likely-duplicate') likelyDuplicateCount += 1
    if (draft.reconciliation.state === 'protected-distinct') protectedDistinctCount += 1
    if (drafts.length >= maximumDocumentDrafts) {
      skipped += 1
      continue
    }
    drafts.push(draft)
    draftBySeed.set(seed, draft)
  }
  const repairDisagreements: DocumentRepairSession['request']['disagreements'] = []
  const repairAlternatives: DocumentRepairSession['alternatives'] = []
  for (const [pairIndex, pair] of repairPairs.entries()) {
    const activeDraft = draftBySeed.get(pair.ruleSeed)
    const modelRecord = semanticRecordForSeed(pair.modelSeed)
    if (!activeDraft || !modelRecord) continue
    const alternateDraft = buildDraft(
      pair.modelSeed,
      extraction,
      context,
      maximumDocumentDrafts + pairIndex * 4 + 1,
      modelRecord
    )
    if (!alternateDraft) continue
    const prefix = `repair:${extraction.source.sha256.slice(0, 12)}:${pair.modelSeed.page}:${pairIndex}`
    const modelCandidate = repairCandidate(
      `${prefix}:planscan`,
      'planscan',
      alternateDraft,
      extraction
    )
    const ruleCandidate = repairCandidate(`${prefix}:rules`, 'rules', activeDraft, extraction)
    repairDisagreements.push({
      id: `${prefix}:disagreement`,
      reason: 'parser-disagreement',
      activeCandidateId: ruleCandidate.id,
      candidates: [modelCandidate, ruleCandidate]
    })
    repairAlternatives.push(
      { candidateId: modelCandidate.id, draft: alternateDraft },
      { candidateId: ruleCandidate.id, draft: activeDraft }
    )
  }
  const repairSessionCandidate: DocumentRepairSession | null =
    repairDisagreements.length > 0
      ? {
          request: {
            schemaVersion: 1,
            selectionId: context.selectionId,
            sourceSha256: extraction.source.sha256,
            reason: 'parser-disagreement',
            disagreements: repairDisagreements
          },
          alternatives: repairAlternatives
        }
      : null
  const parsedRepairSession = documentRepairSessionSchema.safeParse(repairSessionCandidate)
  const repairSession: DocumentRepairSession | null = parsedRepairSession.success
    ? parsedRepairSession.data
    : null
  const skippedItems = [...scheduleCandidates.skippedItems, ...syllabusCandidates.skippedItems]
    .filter(
      (item, index, items) =>
        items.findIndex(
          (candidate) =>
            candidate.page === item.page &&
            candidate.blocks.some((block) => item.blocks.some((other) => other.id === block.id)) &&
            normalizeText(candidate.title).toLocaleLowerCase() ===
              normalizeText(item.title).toLocaleLowerCase()
        ) === index
    )
    .slice(0, maximumDocumentDrafts * 2)
    .map((item, index): DocumentSkippedItem => {
      const evidenceIds = item.blocks
        .map((block) => block.id)
        .filter((id, evidenceIndex, ids) => ids.indexOf(id) === evidenceIndex)
        .slice(0, 32)
      const confidence =
        item.blocks.reduce((total, block) => total + block.confidence, 0) / item.blocks.length
      return {
        id: `skipped:${extraction.source.sha256.slice(0, 12)}:${item.page}:${index}`,
        page: item.page,
        category: item.category,
        title: item.title,
        reason: item.reason,
        sourceText: item.blocks.map((block) => block.text).join('\n'),
        evidenceIds,
        confidence
      }
    })
  const plannerWarnings = [...extraction.warnings]
  if (repairSession) {
    plannerWarnings.push(
      `${repairSession.request.disagreements.length} parser disagreement${repairSession.request.disagreements.length === 1 ? ' is' : 's are'} eligible for optional local source-quoted repair. The fallback can select only an existing validated candidate and cannot save calendar data.`
    )
  }
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
  if (syllabusCandidates.seeds.length > 0) {
    plannerWarnings.push(
      `Syllabus context reconstructed ${syllabusCandidates.seeds.length} term-bounded meeting pattern${syllabusCandidates.seeds.length === 1 ? '' : 's'} with course identity, component, weekday set, and source-backed location.`
    )
  }
  if (syllabusCandidates.unscheduledItems > 0) {
    plannerWarnings.push(
      `${syllabusCandidates.unscheduledItems} syllabus item${syllabusCandidates.unscheduledItems === 1 ? '' : 's'} had no fixed meeting time, so no invented calendar event was proposed.`
    )
  }
  if (calendarGridCandidates.seeds.length > 0) {
    plannerWarnings.push(
      `Calendar layout rules linked ${calendarGridCandidates.seeds.length} plan${calendarGridCandidates.seeds.length === 1 ? '' : 's'} to their month cells, dates, and times.`
    )
  }
  if (extraction.planScan) {
    plannerWarnings.push(
      semanticallyValidModelSeeds.length > 0
        ? `PlanScan linked ${semanticallyValidModelSeeds.length} additional evidence-backed plan${semanticallyValidModelSeeds.length === 1 ? '' : 's'}; deterministic rules checked the same source as fallback.`
        : verifiedScheduleCount > 0 && scheduleCandidates.seeds.length > 0
          ? `PlanScan independently cross-checked ${verifiedScheduleCount} of ${scheduleCandidates.seeds.length} table meeting pattern${scheduleCandidates.seeds.length === 1 ? '' : 's'}; exact row geometry still controls section identity, weekdays, times, and term bounds.`
          : 'PlanScan withheld uncertain groups; deterministic layout rules supplied any reviewable proposals.'
    )
  }
  if (semanticRejectedModelCount > 0) {
    plannerWarnings.push(
      `The semantic safety gate withheld ${semanticRejectedModelCount} learned plan${semanticRejectedModelCount === 1 ? '' : 's'} with inconsistent dates, times, recurrence, or row evidence; deterministic fallback remained eligible.`
    )
  }
  if (duplicateCandidateCount > 0) {
    plannerWarnings.push(
      `${duplicateCandidateCount} repeated extraction candidate${duplicateCandidateCount === 1 ? ' was' : 's were'} merged only after resolving to the same stable source row.`
    )
  }
  if (existingCalendarDuplicateCount > 0) {
    plannerWarnings.push(
      `${existingCalendarDuplicateCount} source row${existingCalendarDuplicateCount === 1 ? ' was' : 's were'} imported before; ${existingCalendarDuplicateCount === 1 ? 'it remains' : 'they remain'} visible but unselected.`
    )
  }
  if (likelyDuplicateCount > 0) {
    plannerWarnings.push(
      `${likelyDuplicateCount} likely calendar duplicate${likelyDuplicateCount === 1 ? ' is' : 's are'} visible and unselected for review instead of being merged automatically.`
    )
  }
  if (protectedDistinctCount > 0) {
    plannerWarnings.push(
      `${protectedDistinctCount} similar class item${protectedDistinctCount === 1 ? ' has' : 's have'} a different CRN, section, or component and remains selected as a distinct series.`
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
    repairSession,
    skippedItems,
    skippedCandidateCount: skipped,
    duplicateCandidateCount,
    existingCalendarDuplicateCount,
    likelyDuplicateCount,
    protectedDistinctCount,
    plannerWarnings
  })
}

function fallbackWindowAnchor(block: DocumentTextBlock): boolean {
  return Boolean(
    dateMatch(block.text) || timeMatch(block.text) || /\ball[- ]day\b/iu.test(block.text)
  )
}

function sameBoundingBox(
  left: DocumentTextBlock['boundingBox'],
  right: DocumentTextBlock['boundingBox']
): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  )
}

export function buildDocumentFallbackRequests(
  analysisValue: DocumentAnalysis
): DocumentFallbackRequest[] {
  const analysis = documentAnalysisSchema.parse(analysisValue)
  const claimed = new Set(analysis.drafts.flatMap((draft) => draft.semanticRecord.sourceBlockIds))
  const noFixedTimeEvidence = new Set(
    analysis.skippedItems
      .filter((item) => item.category === 'no-fixed-time')
      .flatMap((item) => item.evidenceIds)
  )
  const requests: DocumentFallbackRequest[] = []
  const seenWindows = new Set<string>()

  for (const page of analysis.extraction.pages) {
    const blocks = [...page.blocks]
      .filter((block) => !isPageChrome(block) && !noFixedTimeEvidence.has(block.id))
      .sort(
        (left, right) =>
          left.boundingBox.y - right.boundingBox.y ||
          left.boundingBox.x - right.boundingBox.x ||
          left.id.localeCompare(right.id)
      )
    const anchorIndexes = blocks
      .map((block, index) => ({ block, index }))
      .filter(({ block }) => !claimed.has(block.id) && fallbackWindowAnchor(block))
      .map(({ index }) => index)
    let anchorCursor = 0
    while (anchorCursor < anchorIndexes.length && requests.length < maximumDocumentFallbackGroups) {
      const firstAnchor = anchorIndexes[anchorCursor]!
      let lastAnchor = firstAnchor
      anchorCursor += 1
      while (
        anchorCursor < anchorIndexes.length &&
        anchorIndexes[anchorCursor]! - firstAnchor <= 12
      ) {
        lastAnchor = anchorIndexes[anchorCursor]!
        anchorCursor += 1
      }
      const anchorSpan = lastAnchor - firstAnchor + 1
      const availablePadding = Math.max(0, maximumDocumentFallbackBlocks - anchorSpan)
      let start = Math.max(0, firstAnchor - Math.floor(availablePadding / 2))
      let end = Math.min(blocks.length, lastAnchor + 1 + Math.ceil(availablePadding / 2))
      if (end - start < maximumDocumentFallbackBlocks) {
        start = Math.max(0, end - maximumDocumentFallbackBlocks)
        end = Math.min(blocks.length, start + maximumDocumentFallbackBlocks)
      }
      const windowBlocks = blocks.slice(start, end)
      const hasDate = windowBlocks.some((block) => Boolean(dateMatch(block.text)))
      const hasTimeOrAllDay = windowBlocks.some(
        (block) => Boolean(timeMatch(block.text)) || /\ball[- ]day\b/iu.test(block.text)
      )
      const hasPlausibleTitle = windowBlocks.some(
        (block) =>
          !dateMatch(block.text) &&
          !timeMatch(block.text) &&
          /[\p{L}]{2,}/u.test(block.text) &&
          isUsefulTitle(cleanTitle(block.text, '', null))
      )
      if (!hasDate || !hasTimeOrAllDay || !hasPlausibleTitle) continue
      const fingerprint = windowBlocks.map((block) => block.id).join('|')
      if (!fingerprint || seenWindows.has(fingerprint)) continue
      seenWindows.add(fingerprint)
      const candidate = documentFallbackRequestSchema.safeParse({
        schemaVersion: 1,
        requestId: `fallback:${analysis.extraction.source.sha256.slice(0, 12)}:${page.page}:${requests.length}`,
        selectionId: analysis.selectionId,
        sourceSha256: analysis.extraction.source.sha256,
        reason: 'coverage-gap',
        page: page.page,
        blocks: windowBlocks.map((block) => ({
          id: block.id,
          page: block.page,
          text: block.text.slice(0, 360).trim(),
          boundingBox: block.boundingBox,
          confidence: block.confidence,
          method: block.method,
          claimed: claimed.has(block.id)
        }))
      })
      if (candidate.success) requests.push(candidate.data)
    }
  }
  return requests
}

function fallbackSemanticFingerprint(record: DocumentPlanRecord): string {
  return JSON.stringify({
    kind: record.kind,
    title: normalizeText(record.title).toLocaleLowerCase(),
    startDate: record.startDate,
    endDate: record.endDate,
    startTime: record.startTime,
    endTime: record.endTime,
    timezone: record.timezone,
    location: normalizeText(record.location).toLocaleLowerCase(),
    recurrence: recurrenceFingerprint(record.recurrence)
  })
}

function fallbackScheduleMetadata(
  title: string,
  dateText: string,
  recurrenceText: string | null,
  selectedText: string
): CandidateScheduleMetadata | null {
  if (!recurrenceText) return null
  const range = scheduleDateRangePattern.exec(normalizeText(dateText))
  const course = /\b([A-Z][A-Z&]{1,7})\s*[- ]?\s*(\d{2,4}[A-Z]?)\b/iu.exec(title)
  const weekdays = weekdayListFromRecurrenceEvidence(recurrenceText)
  if (!range?.[1] || !range[2] || !course?.[1] || !course[2] || weekdays.length === 0) {
    return null
  }
  const section = /\b(?:section|sec)\s*[:#-]?\s*([A-Z0-9-]{1,20})\b/iu.exec(selectedText)?.[1]
  const crn = /\bCRN\s*[:#-]?\s*(\d{3,12})\b/iu.exec(selectedText)?.[1]
  return {
    courseCode: `${course[1].toLocaleUpperCase()} ${course[2].toLocaleUpperCase()}`,
    sectionCode: section ?? null,
    crn: crn ?? null,
    creditHours: null,
    component: scheduleComponent(title, null),
    termStartText: range[1],
    termEndText: range[2],
    weekdays,
    verification: 'fallback-grouping'
  }
}

export function applyDocumentFallbackResponse(
  analysisValue: DocumentAnalysis,
  requestValue: DocumentFallbackRequest,
  responseValue: DocumentFallbackResponse,
  context: DocumentPlanningContext
): DocumentAnalysis {
  const analysis = documentAnalysisSchema.parse(analysisValue)
  const requestResult = documentFallbackRequestSchema.safeParse(requestValue)
  const responseResult = documentFallbackResponseSchema.safeParse(responseValue)
  if (!requestResult.success || !responseResult.success) return analysis
  const request = requestResult.data
  const response = responseResult.data
  if (
    request.selectionId !== analysis.selectionId ||
    request.sourceSha256 !== analysis.extraction.source.sha256 ||
    response.requestId !== request.requestId ||
    response.page !== request.page ||
    response.hasMutationAuthority !== false
  ) {
    return analysis
  }
  const sourcePage = analysis.extraction.pages.find((page) => page.page === request.page)
  if (!sourcePage) return analysis
  const sourceBlocks = new Map(sourcePage.blocks.map((block) => [block.id, block] as const))
  if (
    request.blocks.some((projection) => {
      const source = sourceBlocks.get(projection.id)
      return (
        !source ||
        projection.page !== source.page ||
        projection.text !== source.text.slice(0, 360).trim() ||
        projection.confidence !== source.confidence ||
        projection.method !== source.method ||
        !sameBoundingBox(projection.boundingBox, source.boundingBox)
      )
    })
  ) {
    return analysis
  }
  const validated = validateDocumentFallbackResponse(request, { groups: response.groups })
  if (!validated) return analysis

  const currentClaimed = new Set(
    analysis.drafts.flatMap((draft) => draft.semanticRecord.sourceBlockIds)
  )
  const existingRows = new Set(
    analysis.drafts.map(
      (draft) => `${draft.importIdentity.sourceSha256}:${draft.importIdentity.sourceRowId}`
    )
  )
  const semanticFingerprints = new Set(
    analysis.drafts.map((draft) => fallbackSemanticFingerprint(draft.semanticRecord))
  )
  const additions: DocumentImportDraft[] = []
  let duplicateCount = 0
  let existingCalendarDuplicateCount = 0
  let likelyDuplicateCount = 0
  let protectedDistinctCount = 0

  for (const [groupIndex, group] of validated.groups.entries()) {
    if (analysis.drafts.length + additions.length >= maximumDocumentDrafts) break
    const titleBlocks = group.titleBlockIds
      .map((id) => sourceBlocks.get(id))
      .filter((block): block is DocumentTextBlock => Boolean(block))
      .sort(
        (left, right) =>
          left.boundingBox.y - right.boundingBox.y || left.boundingBox.x - right.boundingBox.x
      )
    const dateBlock = sourceBlocks.get(group.dateBlockId)
    const timeBlock = group.timeBlockId ? sourceBlocks.get(group.timeBlockId) : null
    const locationBlock = group.locationBlockId ? sourceBlocks.get(group.locationBlockId) : null
    const recurrenceBlock = group.recurrenceBlockId
      ? sourceBlocks.get(group.recurrenceBlockId)
      : null
    const descriptionBlocks = group.descriptionBlockIds
      .map((id) => sourceBlocks.get(id))
      .filter((block): block is DocumentTextBlock => Boolean(block))
    if (!dateBlock || titleBlocks.length !== group.titleBlockIds.length) continue
    if (currentClaimed.has(dateBlock.id) && (!timeBlock || currentClaimed.has(timeBlock.id))) {
      duplicateCount += 1
      continue
    }
    const foundDate = dateMatch(dateBlock.text)?.[0]
    const foundTime = timeBlock ? timeMatch(timeBlock.text)?.[0] : null
    const selectedBlocks = [
      ...titleBlocks,
      dateBlock,
      timeBlock,
      locationBlock,
      recurrenceBlock,
      ...descriptionBlocks
    ]
      .filter((block): block is DocumentTextBlock => Boolean(block))
      .filter(
        (block, index, blocks) =>
          blocks.findIndex((candidate) => candidate.id === block.id) === index
      )
    const allDay = selectedBlocks.some((block) => /\ball[- ]day\b/iu.test(block.text))
    if (!foundDate || (!foundTime && !allDay)) continue
    const title = cleanTitle(
      titleBlocks.map((block) => block.text).join(' '),
      foundDate,
      foundTime ?? null
    )
    if (!isUsefulTitle(title)) continue
    const selectedText = selectedBlocks.map((block) => block.text).join(' ')
    const kind = /\b(?:reminder|remind me|due|deadline|to[- ]?do)\b/iu.test(selectedText)
      ? 'reminder'
      : 'event'
    if (kind === 'reminder' && !foundTime) continue
    const rawLocation = locationBlock ? normalizeText(locationBlock.text) : ''
    const location = locationBlock
      ? (locationValue(rawLocation) ?? scheduleLocation(rawLocation) ?? rawLocation)
      : ''
    const schedule = fallbackScheduleMetadata(
      title,
      dateBlock.text,
      recurrenceBlock?.text ?? null,
      selectedText
    )
    const sourceDescription = normalizeText(descriptionBlocks.map((block) => block.text).join(' '))
    const seed: CandidateSeed = {
      page: request.page,
      blocks: selectedBlocks,
      dateBlock,
      timeBlock: timeBlock ?? null,
      titleBlock: titleBlocks.at(-1)!,
      titleBlocks,
      locationBlock: locationBlock ?? null,
      dateText: foundDate,
      timeText: foundTime ?? null,
      title,
      description: schedule
        ? [scheduleDescription(schedule), sourceDescription].filter(Boolean).join(' · ')
        : sourceDescription,
      location,
      kind,
      allDay,
      inferredTitle: true,
      plannerSource: 'qwen-fallback',
      modelConfidence: Math.min(
        0.74,
        selectedBlocks.reduce((total, block) => total + block.confidence, 0) / selectedBlocks.length
      ),
      recurrenceBlock: recurrenceBlock ?? null,
      descriptionBlocks,
      recurrenceText: recurrenceBlock?.text ?? null,
      scheduleRow: false,
      schedule
    }
    const semanticRecord = compileDocumentPlanRecord(seed, analysis.extraction, context)
    if (!semanticRecord) continue
    const semanticFingerprint = fallbackSemanticFingerprint(semanticRecord)
    if (semanticFingerprints.has(semanticFingerprint)) {
      duplicateCount += 1
      continue
    }
    const draft = buildDraft(
      seed,
      analysis.extraction,
      context,
      analysis.drafts.length + additions.length + groupIndex + 1,
      semanticRecord
    )
    if (!draft) continue
    const sourceRowKey = `${draft.importIdentity.sourceSha256}:${draft.importIdentity.sourceRowId}`
    if (existingRows.has(sourceRowKey)) {
      duplicateCount += 1
      continue
    }
    existingRows.add(sourceRowKey)
    semanticFingerprints.add(semanticFingerprint)
    semanticRecord.sourceBlockIds.forEach((id) => currentClaimed.add(id))
    if (draft.reconciliation.state === 'same-source') existingCalendarDuplicateCount += 1
    if (draft.reconciliation.state === 'likely-duplicate') likelyDuplicateCount += 1
    if (draft.reconciliation.state === 'protected-distinct') protectedDistinctCount += 1
    additions.push(draft)
  }

  if (additions.length === 0) return analysis
  const recoveredEvidence = new Set(
    additions.flatMap((draft) => draft.semanticRecord.sourceBlockIds)
  )
  const emptyPlanWarning =
    'Text was extracted, but no complete date-and-time plans were found. Try a clearer schedule or add the details by typing.'
  return documentAnalysisSchema.parse({
    ...analysis,
    drafts: [...analysis.drafts, ...additions],
    skippedItems: analysis.skippedItems.filter(
      (item) =>
        item.category === 'no-fixed-time' ||
        !item.evidenceIds.some((id) => recoveredEvidence.has(id))
    ),
    duplicateCandidateCount: analysis.duplicateCandidateCount + duplicateCount,
    existingCalendarDuplicateCount:
      analysis.existingCalendarDuplicateCount + existingCalendarDuplicateCount,
    likelyDuplicateCount: analysis.likelyDuplicateCount + likelyDuplicateCount,
    protectedDistinctCount: analysis.protectedDistinctCount + protectedDistinctCount,
    plannerWarnings: [
      ...analysis.plannerWarnings.filter((warning) => warning !== emptyPlanWarning),
      `The installed optional local model recovered ${additions.length} source-backed plan${additions.length === 1 ? '' : 's'} by grouping exact extracted fields. Dates, times, recurrence, and duplicates were still checked by deterministic code, and nothing is saved until you confirm.`
    ].slice(0, 50)
  })
}
