import { Temporal } from '@js-temporal/polyfill'
import {
  calendarIRDraftSchema,
  type CalendarIRDraft,
  type EventEntity,
  type RecurrenceRule,
  type ReminderEntity,
  type TemporalAnchor,
  type TemporalWindow,
  type Weekday
} from '@remind-me/contracts'
import { typoPhraseSimilarity } from './input-normalizer'

export interface DeterministicParserContext {
  requestId: string
  text: string
  previousUserText: string | null
  nowUtc: string
  localDate: string
  timezone: string
  locale: string
  events: readonly EventEntity[]
  reminders: readonly ReminderEntity[]
  focusedEventIds?: readonly string[]
  focusedReminderIds?: readonly string[]
  semanticHint?: SemanticParserHint
}

export interface SemanticParserHint {
  operation:
    | 'event.create'
    | 'event.duplicate'
    | 'event.update'
    | 'event.move'
    | 'event.delete'
    | 'reminder.create'
    | 'reminder.update'
    | 'reminder.complete'
    | 'reminder.delete'
    | 'calendar.list'
    | 'calendar.search'
    | 'calendar.availability'
    | 'calendar.conflicts'
  confidence: number
  titleSpan: { start: number; end: number } | null
  targetSpan: { start: number; end: number } | null
  descriptionSpan: { start: number; end: number } | null
  locationSpan: { start: number; end: number } | null
}

export interface DeterministicParseResult {
  draft: CalendarIRDraft
  sourceText: string
  matchedPattern: string
}

interface DateMatch {
  anchor: TemporalAnchor
  start: number
  end: number
  text: string
}

interface TimeMatch {
  startTime: string
  endTime: string | null
  start: number
  end: number
  text: string
  ambiguous: boolean
  period: 'morning' | 'afternoon' | 'evening' | 'night' | null
}

interface TargetMatch {
  eventIds: string[]
  reminderIds: string[]
  ambiguity: CalendarIRDraft['ambiguities'][number] | null
}

const weekdays: readonly Weekday[] = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday'
]

const monthNumbers: Readonly<Record<string, number>> = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sep: 9,
  sept: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12
}

const politeRequestPrefix =
  "(?:please\\s+)?(?:(?:can|could|would|will)\\s+you\\s+|i(?:'d| would)\\s+like\\s+(?:you\\s+)?to\\s+)?"
const reminderRequestPattern = new RegExp(
  `^${politeRequestPrefix}(?:remind\\s+me(?:\\s+(?:to|about))?|remember\\s+to|(?:set|add|create)\\s+(?:a\\s+)?reminder(?:\\s+(?:to|for|about))?)\\b`,
  'iu'
)
const remindMeRequestPattern = new RegExp(`^${politeRequestPrefix}remind\\s+me\\b`, 'iu')
const reminderPrefixPattern = new RegExp(
  `^\\s*${politeRequestPrefix}(?:remind\\s+me(?:\\s+(?:to|about))?|remember\\s+to|(?:set|add|create)\\s+(?:a\\s+)?reminder(?:\\s+(?:to|for|about))?)\\s*`,
  'iu'
)

const stopWords = new Set([
  'a',
  'an',
  'and',
  'as',
  'at',
  'event',
  'for',
  'in',
  'me',
  'my',
  'of',
  'on',
  'please',
  'reminder',
  'the',
  'to'
])

function sourceSpan(start: number, end: number): { start: number; end: number } | null {
  return end > start ? { start, end } : null
}

function evidence(context: DeterministicParserContext, text: string): CalendarIRDraft['evidence'] {
  return [
    {
      id: `evidence:${context.requestId.replace(/[^a-zA-Z0-9._:-]/g, '-')}`,
      sourceKind: 'text',
      sourceId: null,
      page: null,
      boundingBox: null,
      text,
      sourceSpan: sourceSpan(0, text.length)
    }
  ]
}

function emptyFields(): CalendarIRDraft['fields'] {
  return {
    title: null,
    description: null,
    location: null,
    when: null,
    reminderOffsetMinutes: null,
    status: null
  }
}

function sourcedText(
  value: string,
  source: string,
  evidenceId: string
): NonNullable<CalendarIRDraft['fields']['title']> {
  const trimmed = value
    .trim()
    .replace(/[,.!?]+$/u, '')
    .trim()
  const index = source.toLocaleLowerCase().indexOf(trimmed.toLocaleLowerCase())
  return {
    value: trimmed,
    sourceSpan: sourceSpan(index, index + trimmed.length),
    evidenceIds: [evidenceId]
  }
}

function hintedText(
  source: string,
  span: { start: number; end: number } | null,
  evidenceId: string
): NonNullable<CalendarIRDraft['fields']['title']> | null {
  if (!span || span.start < 0 || span.end > source.length || span.end <= span.start) return null
  const value = source.slice(span.start, span.end).trim()
  if (!value) return null
  const start = source.indexOf(value, span.start)
  return {
    value,
    sourceSpan: sourceSpan(start, start + value.length),
    evidenceIds: [evidenceId]
  }
}

function sourcedWindow(
  value: TemporalWindow,
  start: number,
  end: number,
  evidenceId: string
): NonNullable<CalendarIRDraft['fields']['when']> {
  return { value, sourceSpan: sourceSpan(start, end), evidenceIds: [evidenceId] }
}

function baseDraft(
  context: DeterministicParserContext,
  sourceText: string,
  operation: CalendarIRDraft['operation'],
  risk: CalendarIRDraft['risk'],
  confidence: number
): CalendarIRDraft {
  return {
    version: '0.1',
    requestId: context.requestId,
    operation,
    selection: null,
    fields: emptyFields(),
    recurrence: null,
    scope: 'single',
    references: [],
    ambiguities: [],
    risk,
    confidence,
    evidence: evidence(context, sourceText)
  }
}

function prefersPastDate(text: string): boolean {
  return /\b(?:ago|before|did|earlier|had|last|past|previous|was|were|yesterday)\b/iu.test(text)
}

function parseDateMatch(text: string, localDate: string): DateMatch | null {
  const relativePatterns: ReadonlyArray<[RegExp, number]> = [
    [/\bday before yesterday\b/iu, -2],
    [/\bday after tomorrow\b/iu, 2],
    [/\byesterday\b/iu, -1],
    [/\b(?:tomorrow|tmr|tmrw|tmw)\b/iu, 1],
    [/\btoday\b/iu, 0]
  ]
  for (const [pattern, offset] of relativePatterns) {
    const match = pattern.exec(text)
    if (match?.index !== undefined) {
      return {
        anchor: { kind: 'relative-day', offset },
        start: match.index,
        end: match.index + match[0].length,
        text: match[0]
      }
    }
  }

  const weekdayMatch = new RegExp(
    `\\b(?:(last|next|this)\\s+)?(${weekdays.join('|')})\\b`,
    'iu'
  ).exec(text)
  if (weekdayMatch?.index !== undefined && weekdayMatch[2]) {
    const relation = weekdayMatch[1]?.toLocaleLowerCase()
    if (relation === 'last') {
      const current = Temporal.PlainDate.from(localDate)
      const targetDay = weekdays.indexOf(weekdayMatch[2].toLocaleLowerCase() as Weekday) + 1
      let offset = targetDay - current.dayOfWeek
      if (offset >= 0) offset -= 7
      return {
        anchor: { kind: 'absolute', date: current.add({ days: offset }).toString() },
        start: weekdayMatch.index,
        end: weekdayMatch.index + weekdayMatch[0].length,
        text: weekdayMatch[0]
      }
    }
    return {
      anchor: {
        kind: 'weekday',
        weekday: weekdayMatch[2].toLocaleLowerCase() as Weekday,
        relation: relation === 'next' ? 'next' : 'this'
      },
      start: weekdayMatch.index,
      end: weekdayMatch.index + weekdayMatch[0].length,
      text: weekdayMatch[0]
    }
  }

  const isoMatch = /\b(\d{4}-\d{2}-\d{2})\b/u.exec(text)
  if (isoMatch?.index !== undefined && isoMatch[1]) {
    try {
      const date = Temporal.PlainDate.from(isoMatch[1]).toString()
      return {
        anchor: { kind: 'absolute', date },
        start: isoMatch.index,
        end: isoMatch.index + isoMatch[0].length,
        text: isoMatch[0]
      }
    } catch {
      return null
    }
  }

  const numericMatch = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/u.exec(text)
  if (numericMatch?.index !== undefined && numericMatch[1] && numericMatch[2]) {
    const current = Temporal.PlainDate.from(localDate)
    const rawYear = numericMatch[3] ? Number(numericMatch[3]) : current.year
    const year = rawYear < 100 ? 2000 + rawYear : rawYear
    try {
      let date = Temporal.PlainDate.from({
        year,
        month: Number(numericMatch[1]),
        day: Number(numericMatch[2])
      })
      if (
        !numericMatch[3] &&
        !prefersPastDate(text) &&
        Temporal.PlainDate.compare(date, current) < 0
      ) {
        date = date.add({ years: 1 })
      }
      return {
        anchor: { kind: 'absolute', date: date.toString() },
        start: numericMatch.index,
        end: numericMatch.index + numericMatch[0].length,
        text: numericMatch[0]
      }
    } catch {
      return null
    }
  }

  const monthMatch = new RegExp(
    `\\b(${Object.keys(monthNumbers).join('|')})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`,
    'iu'
  ).exec(text)
  if (monthMatch?.index !== undefined && monthMatch[1] && monthMatch[2]) {
    const current = Temporal.PlainDate.from(localDate)
    const month = monthNumbers[monthMatch[1].toLocaleLowerCase()]
    if (!month) return null
    try {
      let date = Temporal.PlainDate.from({
        year: monthMatch[3] ? Number(monthMatch[3]) : current.year,
        month,
        day: Number(monthMatch[2])
      })
      if (
        !monthMatch[3] &&
        !prefersPastDate(text) &&
        Temporal.PlainDate.compare(date, current) < 0
      ) {
        date = date.add({ years: 1 })
      }
      return {
        anchor: { kind: 'absolute', date: date.toString() },
        start: monthMatch.index,
        end: monthMatch.index + monthMatch[0].length,
        text: monthMatch[0]
      }
    } catch {
      return null
    }
  }
  return null
}

function parseEndDateMatch(
  text: string,
  localDate: string,
  startDate: DateMatch | null
): DateMatch | null {
  if (!startDate) return null
  const tail = text.slice(startDate.end)
  const connector = /^\s*(?:through|until|to|[-–—])\s*/iu.exec(tail)
  if (!connector) return null
  const offset = startDate.end + connector[0].length
  const remaining = text.slice(offset)
  const parsed = parseDateMatch(remaining, localDate)
  if (parsed) {
    let anchor = parsed.anchor
    if (
      startDate.anchor.kind === 'absolute' &&
      anchor.kind === 'absolute' &&
      Temporal.PlainDate.compare(anchor.date, startDate.anchor.date) < 0 &&
      !/\b\d{4}\b/u.test(parsed.text)
    ) {
      const startYear = Temporal.PlainDate.from(startDate.anchor.date).year
      const inherited = Temporal.PlainDate.from(anchor.date).with({ year: startYear })
      anchor = { kind: 'absolute', date: inherited.toString() }
    }
    return {
      ...parsed,
      anchor,
      start: offset + parsed.start,
      end: offset + parsed.end
    }
  }
  if (startDate.anchor.kind !== 'absolute') return null
  const shortDay = /^(\d{1,2})(?:st|nd|rd|th)?\b/u.exec(remaining)
  if (!shortDay?.[1]) return null
  try {
    const start = Temporal.PlainDate.from(startDate.anchor.date)
    const end = start.with({ day: Number(shortDay[1]) })
    return {
      anchor: { kind: 'absolute', date: end.toString() },
      start: offset,
      end: offset + shortDay[0].length,
      text: shortDay[0]
    }
  } catch {
    return null
  }
}

interface ParsedClock {
  time: string
  explicitMeridiem: boolean
  ambiguous: boolean
}

function parseClock(raw: string): ParsedClock | null {
  const normalized = raw.trim().toLocaleLowerCase().replace(/\./gu, '').replace(/\s+/gu, '')
  if (normalized === 'noon') return { time: '12:00', explicitMeridiem: true, ambiguous: false }
  if (normalized === 'midnight') return { time: '00:00', explicitMeridiem: true, ambiguous: false }
  const match = /^(\d{1,2})(?::(\d{1,2}))?(am|pm)?$/u.exec(normalized)
  if (!match?.[1]) return null
  let hour = Number(match[1])
  const minute = Number(match[2] ?? '0')
  const meridiem = match[3]
  if (minute > 59 || hour > 23 || (meridiem && (hour < 1 || hour > 12))) return null
  if (meridiem === 'am' && hour === 12) hour = 0
  if (meridiem === 'pm' && hour !== 12) hour += 12
  const ambiguous = !meridiem && hour >= 1 && hour <= 12
  return {
    time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    explicitMeridiem: Boolean(meridiem),
    ambiguous
  }
}

function inferRangeClocks(
  leftRaw: string,
  rightRaw: string
): { left: ParsedClock; right: ParsedClock; ambiguous: boolean } | null {
  let left = parseClock(leftRaw)
  let right = parseClock(rightRaw)
  if (!left || !right) return null
  const meridiem = (value: string): 'am' | 'pm' | null =>
    /p\.?m\.?/iu.test(value) ? 'pm' : /a\.?m\.?/iu.test(value) ? 'am' : null
  const leftMeridiem = meridiem(leftRaw)
  const rightMeridiem = meridiem(rightRaw)
  if (!left.explicitMeridiem && rightMeridiem) {
    const inferred = parseClock(`${leftRaw}${rightMeridiem}`)
    if (inferred) left = inferred
  }
  if (!right.explicitMeridiem && leftMeridiem) {
    const inferred = parseClock(`${rightRaw}${leftMeridiem}`)
    if (inferred) right = inferred
  }
  return { left, right, ambiguous: left.ambiguous || right.ambiguous }
}

function parseTimeMatch(text: string): TimeMatch | null {
  const malformedRangePattern =
    /(?<![\d/])(?:from\s+|between\s+)?(\d{1,2}):(\d{1,2})\s*[-–—]\s*(\d{2})\s*(a\.?m\.?|p\.?m\.?)?\b/iu
  const malformedRange = malformedRangePattern.exec(text)
  if (
    malformedRange?.index !== undefined &&
    malformedRange[1] &&
    malformedRange[2] &&
    malformedRange[3]
  ) {
    const rightRaw =
      malformedRange[2] +
      ':' +
      malformedRange[3] +
      (malformedRange[4] ? ' ' + malformedRange[4] : '')
    const clocks = inferRangeClocks(malformedRange[1], rightRaw)
    if (clocks) {
      return {
        startTime: clocks.left.time,
        endTime: clocks.right.time,
        start: malformedRange.index,
        end: malformedRange.index + malformedRange[0].length,
        text: malformedRange[0],
        ambiguous: clocks.ambiguous,
        period: null
      }
    }
  }

  const clockToken = '(?:\\d{1,2}(?::\\d{1,2})?\\s*(?:a\\.?m\\.?|p\\.?m\\.?)?|noon|midnight)'
  const rangePattern = new RegExp(
    `(?<![\\d/-])(from\\s+|between\\s+)?(${clockToken})\\s*(?:to|until|and|[-–—])\\s*(${clockToken})(?![\\d/-])`,
    'iu'
  )
  const rangeMatch = rangePattern.exec(text)
  if (rangeMatch?.index !== undefined && rangeMatch[2] && rangeMatch[3]) {
    const hasRangeCue =
      Boolean(rangeMatch[1]) || /:|a\.?m\.?|p\.?m\.?|noon|midnight/iu.test(rangeMatch[0])
    const clocks = hasRangeCue ? inferRangeClocks(rangeMatch[2], rangeMatch[3]) : null
    if (clocks) {
      return {
        startTime: clocks.left.time,
        endTime: clocks.right.time,
        start: rangeMatch.index,
        end: rangeMatch.index + rangeMatch[0].length,
        text: rangeMatch[0],
        ambiguous: clocks.ambiguous,
        period: null
      }
    }
  }

  const periodPattern = /\b(morning|afternoon|evening|tonight|night)\b/iu
  const periodMatch = periodPattern.exec(text)
  if (periodMatch?.index !== undefined && periodMatch[1]) {
    const period = periodMatch[1].toLocaleLowerCase()
    const times: Record<string, [string, string]> = {
      morning: ['09:00', '12:00'],
      afternoon: ['12:00', '17:00'],
      evening: ['17:00', '21:00'],
      tonight: ['19:00', '22:00'],
      night: ['19:00', '22:00']
    }
    const value = times[period]
    if (value) {
      return {
        startTime: value[0],
        endTime: value[1],
        start: periodMatch.index,
        end: periodMatch.index + periodMatch[0].length,
        text: periodMatch[0],
        ambiguous: false,
        period: period === 'tonight' ? 'night' : (period as TimeMatch['period'])
      }
    }
  }

  const pointPattern =
    /(?:\bat\s+|@\s*)(\d{1,2}(?::\d{1,2})?\s*(?:a\.?m\.?|p\.?m\.?)?|noon|midnight)\b/iu
  const pointMatch = pointPattern.exec(text)
  if (pointMatch?.index !== undefined && pointMatch[1]) {
    const clock = parseClock(pointMatch[1])
    if (clock) {
      return {
        startTime: clock.time,
        endTime: null,
        start: pointMatch.index,
        end: pointMatch.index + pointMatch[0].length,
        text: pointMatch[0],
        ambiguous: clock.ambiguous,
        period: null
      }
    }
  }

  const explicitClock = /\b(\d{1,2}(?::\d{1,2})?\s*(?:a\.?m\.?|p\.?m\.?)|noon|midnight)\b/iu.exec(
    text
  )
  if (explicitClock?.index !== undefined && explicitClock[1]) {
    const clock = parseClock(explicitClock[1])
    if (clock) {
      return {
        startTime: clock.time,
        endTime: null,
        start: explicitClock.index,
        end: explicitClock.index + explicitClock[0].length,
        text: explicitClock[0],
        ambiguous: false,
        period: null
      }
    }
  }
  return null
}

function absoluteAnchor(date: Temporal.PlainDate): TemporalAnchor {
  return { kind: 'absolute', date: date.toString() }
}

function queryWindow(
  text: string,
  localDate: string,
  date: DateMatch | null,
  endDate: DateMatch | null,
  time: TimeMatch | null
): { window: TemporalWindow; start: number; end: number } {
  const current = Temporal.PlainDate.from(localDate)
  const absoluteRange = (
    match: RegExpExecArray,
    startDate: Temporal.PlainDate,
    endDate: Temporal.PlainDate
  ): { window: TemporalWindow; start: number; end: number } => ({
    window: {
      start: { date: absoluteAnchor(startDate), time: null },
      end: { date: absoluteAnchor(endDate), time: null },
      allDay: true,
      timezone: null
    },
    start: match.index,
    end: match.index + match[0].length
  })

  const rolling =
    /\b(?:what(?:'s|s| is) (?:my )?next(?: (?:class|course|lecture|lab|discussion|event|meeting|appointment|plan|item|reminder))?|show (?:me )?(?:my )?next (?:class|course|lecture|lab|discussion|event|meeting|appointment|plan|item|reminder)|coming up|upcoming(?: plans?| events?)?)\b/iu.exec(
      text
    )
  if (rolling) return absoluteRange(rolling, current, current.add({ days: 30 }))

  const partialWeek = /\b(?:earlier this week|(?:the )?rest of (?:this )?week)\b/iu.exec(text)
  if (partialWeek) {
    const monday = current.subtract({ days: current.dayOfWeek - 1 })
    const earlier = /earlier/iu.test(partialWeek[0])
    return absoluteRange(
      partialWeek,
      earlier ? monday : current,
      earlier ? current : monday.add({ days: 6 })
    )
  }

  const partialMonth = /\b(?:earlier this month|(?:the )?rest of (?:this )?month)\b/iu.exec(text)
  if (partialMonth) {
    const first = current.with({ day: 1 })
    const last = first.add({ months: 1 }).subtract({ days: 1 })
    const earlier = /earlier/iu.test(partialMonth[0])
    return absoluteRange(partialMonth, earlier ? first : current, earlier ? current : last)
  }

  const monthPeriod = /\b(last|this|next) month\b/iu.exec(text)
  if (monthPeriod?.[1]) {
    const monthOffset =
      monthPeriod[1].toLocaleLowerCase() === 'last'
        ? -1
        : monthPeriod[1].toLocaleLowerCase() === 'next'
          ? 1
          : 0
    const first = current.with({ day: 1 }).add({ months: monthOffset })
    return absoluteRange(monthPeriod, first, first.add({ months: 1 }).subtract({ days: 1 }))
  }

  const yearPeriod = /\b(last|this|next) year\b/iu.exec(text)
  if (yearPeriod?.[1]) {
    const yearOffset =
      yearPeriod[1].toLocaleLowerCase() === 'last'
        ? -1
        : yearPeriod[1].toLocaleLowerCase() === 'next'
          ? 1
          : 0
    const first = Temporal.PlainDate.from({ year: current.year + yearOffset, month: 1, day: 1 })
    return absoluteRange(yearPeriod, first, first.with({ month: 12, day: 31 }))
  }

  const thisWeek = /\bthis week\b/iu.exec(text)
  const nextWeek = /\bnext week\b/iu.exec(text)
  const lastWeek = /\blast week\b/iu.exec(text)
  if (thisWeek || nextWeek || lastWeek) {
    const match = nextWeek ?? lastWeek ?? thisWeek
    if (!match) throw new Error('Expected a matched week period')
    const weekOffset = nextWeek ? 7 : lastWeek ? -7 : 0
    const monday = current.subtract({ days: current.dayOfWeek - 1 }).add({ days: weekOffset })
    const sunday = monday.add({ days: 6 })
    return absoluteRange(match, monday, sunday)
  }

  const anchor = date?.anchor ?? { kind: 'relative-day', offset: 0 }
  const endAnchor = endDate?.anchor ?? anchor
  if (time) {
    return {
      window: {
        start: { date: anchor, time: time.startTime },
        end:
          time.endTime || endDate
            ? { date: endAnchor, time: time.endTime ?? time.startTime }
            : null,
        allDay: false,
        timezone: null
      },
      start: Math.min(date?.start ?? time.start, time.start),
      end: Math.max(date?.end ?? time.end, endDate?.end ?? time.end, time.end)
    }
  }
  return {
    window: {
      start: { date: anchor, time: null },
      end: endDate ? { date: endAnchor, time: null } : null,
      allDay: true,
      timezone: null
    },
    start: date?.start ?? 0,
    end: endDate?.end ?? date?.end ?? text.length
  }
}

function isOrdinalCalendarQuery(value: string): boolean {
  const hasOrdinalItem =
    /\b(?:first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|earliest|next|previous|last|final|latest)\s+(?:class|course|lecture|lab|discussion|seminar|practicum|recitation|tutorial|event|meeting|appointment|plan|item|reminder|thing)\b|\b(?:class|course|lecture|lab|discussion|seminar|practicum|recitation|tutorial|event|meeting|appointment|plan|item|reminder|thing)\s+(?:comes?|is)\s+(?:first|second|third|fourth|fifth|earliest|next|previous|last|final|latest)\b/iu.test(
      value
    )
  if (!hasOrdinalItem) return false
  return (
    /\b(?:what(?:'s|s)?|which|where|when|show|tell|give|list)\b/iu.test(value) ||
    /^(?:my\s+|the\s+)?(?:first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|earliest|next|previous|last|final|latest)\b/iu.test(
      value.trim()
    )
  )
}

function mutationWindow(
  date: DateMatch,
  endDate: DateMatch | null,
  time: TimeMatch | null,
  allDay: boolean
): TemporalWindow {
  if (allDay) {
    return {
      start: { date: date.anchor, time: null },
      end: endDate ? { date: endDate.anchor, time: null } : null,
      allDay: true,
      timezone: null
    }
  }
  if (!time) throw new Error('Timed mutation window requires a time')
  return {
    start: { date: date.anchor, time: time.startTime },
    end:
      time.endTime || endDate
        ? { date: endDate?.anchor ?? date.anchor, time: time.endTime ?? time.startTime }
        : null,
    allDay: false,
    timezone: null
  }
}

function storedDateMatch(instant: string, timezone: string): DateMatch {
  const date = Temporal.Instant.from(instant).toZonedDateTimeISO(timezone).toPlainDate().toString()
  return { anchor: { kind: 'absolute', date }, start: 0, end: 0, text: date }
}

function storedTimeMatch(instant: string, timezone: string): TimeMatch {
  const time = Temporal.Instant.from(instant)
    .toZonedDateTimeISO(timezone)
    .toPlainTime()
    .toString({ smallestUnit: 'minute' })
  return {
    startTime: time,
    endTime: null,
    start: 0,
    end: 0,
    text: time,
    ambiguous: false,
    period: null
  }
}

function outsideSpans<T extends { start: number; end: number }>(
  match: T | null,
  spans: ReadonlyArray<{ start: number; end: number } | null>
): T | null {
  if (!match) return null
  return spans.some((span) => span && match.start < span.end && match.end > span.start)
    ? null
    : match
}

function shiftedMatch<T extends { start: number; end: number }>(
  match: T | null,
  offset: number
): T | null {
  return match ? { ...match, start: match.start + offset, end: match.end + offset } : null
}

function requestedWindowSpan(
  sourceText: string,
  date: DateMatch | null,
  time: TimeMatch | null
): { start: number; end: number } {
  const starts = [date?.start, time?.start].filter((value): value is number => value !== undefined)
  const ends = [date?.end, time?.end].filter((value): value is number => value !== undefined)
  return {
    start: starts.length ? Math.min(...starts) : 0,
    end: ends.length ? Math.max(...ends) : sourceText.length
  }
}

function recurrenceFromText(text: string, localDate: string): RecurrenceRule | null {
  const everyWeekday = /\b(?:every weekday|weekdays)\b/iu.test(text)
  const intervalMatch = /\bevery\s+(\d+)\s+(day|week|month|year)s?\b/iu.exec(text)
  const weekdayNames = weekdays.filter((weekday) =>
    new RegExp(`\\b${weekday.slice(0, 3)}(?:${weekday.slice(3)})?s?\\b`, 'iu').test(text)
  )
  const namedWeekdayRecurrence = new RegExp(
    `\\bevery\\s+(?:${weekdays.join('|')}|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)`,
    'iu'
  ).test(text)
  const pluralWeekdayList =
    weekdayNames.length > 1 &&
    /\b(?:mondays|tuesdays|wednesdays|thursdays|fridays|saturdays|sundays)\b/iu.test(text)
  const intervalUnit = intervalMatch?.[2]?.toLocaleLowerCase()
  let frequency: RecurrenceRule['frequency'] | null = null
  if (
    everyWeekday ||
    /\b(?:every week|weekly)\b/iu.test(text) ||
    namedWeekdayRecurrence ||
    pluralWeekdayList
  ) {
    frequency = 'weekly'
  } else if (/\b(?:every day|daily)\b/iu.test(text) || intervalUnit === 'day') {
    frequency = 'daily'
  } else if (/\b(?:every month|monthly)\b/iu.test(text) || intervalUnit === 'month') {
    frequency = 'monthly'
  } else if (/\b(?:every year|yearly|annually)\b/iu.test(text) || intervalUnit === 'year') {
    frequency = 'yearly'
  } else if (intervalUnit === 'week') {
    frequency = 'weekly'
  }
  if (!frequency) return null

  const countMatch = /\bfor\s+(\d+)\s+(?:times|occurrences?)\b/iu.exec(text)
  const untilMatch = /\buntil\s+(.+)$/iu.exec(text)
  const untilDate = untilMatch?.[1] ? parseDateMatch(untilMatch[1], localDate) : null
  const current = Temporal.PlainDate.from(localDate)
  const recurrenceDate = parseDateMatch(text, localDate)
  const monthDay =
    recurrenceDate?.anchor.kind === 'absolute'
      ? Temporal.PlainDate.from(recurrenceDate.anchor.date).day
      : current.day
  return {
    frequency,
    interval: intervalMatch?.[1] ? Math.max(1, Number(intervalMatch[1])) : 1,
    byWeekday: everyWeekday
      ? ['monday', 'tuesday', 'wednesday', 'thursday', 'friday']
      : frequency === 'weekly'
        ? weekdayNames
        : [],
    byMonthDay: frequency === 'monthly' ? [monthDay] : [],
    end: countMatch?.[1]
      ? { kind: 'count', count: Math.max(1, Number(countMatch[1])) }
      : untilDate?.anchor.kind === 'absolute'
        ? { kind: 'until', date: untilDate.anchor.date }
        : { kind: 'never' }
  }
}

function normalizedTokens(text: string): string[] {
  return text
    .toLocaleLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9\s]/gu, ' ')
    .split(/\s+/u)
    .filter((token) => token.length > 0 && !stopWords.has(token))
}

function similarity(query: string, title: string): number {
  const normalizedQuery = normalizedTokens(query).join(' ')
  const normalizedTitle = normalizedTokens(title).join(' ')
  if (!normalizedQuery || !normalizedTitle) return 0
  if (normalizedQuery === normalizedTitle) return 1
  if (normalizedTitle.includes(normalizedQuery) || normalizedQuery.includes(normalizedTitle))
    return 0.86
  return typoPhraseSimilarity(normalizedQuery, normalizedTitle)
}

function dialogueReferenceNumber(query: string): 'singular' | 'plural' | null {
  const normalized = query
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[.!?]+$/gu, '')
    .trim()
  if (/^(?:it|this|that|this one|that one|the (?:event|item|reminder))$/u.test(normalized)) {
    return 'singular'
  }
  if (
    /^(?:them|these|those|they|these ones|those ones|the (?:events|items|reminders))$/u.test(
      normalized
    )
  ) {
    return 'plural'
  }
  return null
}

function dialogueReferencePosition(
  query: string
): { kind: 'index'; index: number } | { kind: 'last' } | null {
  const normalized = query
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[.!?]+$/gu, '')
    .trim()
  const ordinal =
    /^(?:the\s+)?(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|last|final)(?:\s+(?:one|item|event|meeting|appointment|class|course|reminder|task))?$/u.exec(
      normalized
    )?.[1]
  if (!ordinal) return null
  if (ordinal === 'last' || ordinal === 'final') return { kind: 'last' }
  const index = {
    first: 0,
    '1st': 0,
    second: 1,
    '2nd': 1,
    third: 2,
    '3rd': 2,
    fourth: 3,
    '4th': 3,
    fifth: 4,
    '5th': 4
  }[ordinal]
  return index === undefined ? null : { kind: 'index', index }
}

interface DescriptiveTargetCandidate {
  id: string
  kind: 'event' | 'reminder'
  title: string
  date: string
  time: string
  location: string
}

function resolvedSelectorDate(anchor: TemporalAnchor, localDate: string): string | null {
  const current = Temporal.PlainDate.from(localDate)
  switch (anchor.kind) {
    case 'absolute':
      return anchor.date
    case 'relative-day':
      return current.add({ days: anchor.offset }).toString()
    case 'weekday': {
      const targetDay = weekdays.indexOf(anchor.weekday) + 1
      const delta = (targetDay - current.dayOfWeek + 7) % 7
      return current.add({ days: anchor.relation === 'next' && delta === 0 ? 7 : delta }).toString()
    }
    case 'verbatim':
      return null
  }
}

function eraseSelectorSpans(
  value: string,
  spans: ReadonlyArray<{ start: number; end: number } | null>
): string {
  const characters = value.split('')
  for (const span of spans) {
    if (!span) continue
    for (
      let index = Math.max(0, span.start);
      index < Math.min(characters.length, span.end);
      index++
    ) {
      characters[index] = ' '
    }
  }
  return characters.join('').replace(/\s+/gu, ' ').trim()
}

function descriptiveLocationQuery(
  query: string,
  date: DateMatch | null,
  time: TimeMatch | null
): string | null {
  const remainder = eraseSelectorSpans(query, [date, time])
  const match = /\b(?:in|inside|at)\s+(.+?)$/iu.exec(remainder)
  const value = match?.[1]
    ?.replace(
      /\b(?:the\s+)?(?:one|item|event|meeting|appointment|class|course|reminder|task)$/iu,
      ''
    )
    .trim()
  return value ? value : null
}

function candidateMatchesTime(candidateTime: string, selector: TimeMatch): boolean {
  if (selector.ambiguous) return false
  if (selector.period && selector.endTime) {
    return candidateTime >= selector.startTime && candidateTime < selector.endTime
  }
  return candidateTime === selector.startTime
}

function descriptiveTargetMatch(
  query: string,
  candidates: readonly DescriptiveTargetCandidate[],
  focus: {
    eventIds?: readonly string[] | undefined
    reminderIds?: readonly string[] | undefined
    localDate?: string | undefined
  }
): TargetMatch | null {
  const date = focus.localDate ? parseDateMatch(query, focus.localDate) : null
  const selectorDate =
    date && focus.localDate ? resolvedSelectorDate(date.anchor, focus.localDate) : null
  const time = parseTimeMatch(query)
  const locationQuery = descriptiveLocationQuery(query, date, time)
  const normalizedQuery = normalizedTokens(query).join(' ')
  const queryContainsKnownLocation = candidates.some((candidate) => {
    const location = normalizedTokens(candidate.location).join(' ')
    return location.length > 0 && normalizedQuery.includes(location)
  })
  const hasDescriptor = Boolean(selectorDate || time || locationQuery || queryContainsKnownLocation)
  if (!hasDescriptor) return null

  const focusedIds = new Set([...(focus.eventIds ?? []), ...(focus.reminderIds ?? [])])
  const deictic = /\b(?:it|one|ones|this|that|these|those|them)\b/iu.test(query)
  const scoped =
    deictic && focusedIds.size > 0
      ? candidates.filter((candidate) => focusedIds.has(candidate.id))
      : candidates
  const matched = scoped.filter((candidate) => {
    if (selectorDate && candidate.date !== selectorDate) return false
    if (time && !candidateMatchesTime(candidate.time, time)) return false
    if (locationQuery && similarity(locationQuery, candidate.location) < 0.72) return false
    if (
      !locationQuery &&
      queryContainsKnownLocation &&
      !normalizedQuery.includes(normalizedTokens(candidate.location).join(' '))
    ) {
      return false
    }
    return true
  })
  if (matched.length === 1) {
    const selected = matched[0]
    if (!selected) return null
    return {
      eventIds: selected.kind === 'event' ? [selected.id] : [],
      reminderIds: selected.kind === 'reminder' ? [selected.id] : [],
      ambiguity: null
    }
  }
  return {
    eventIds: [],
    reminderIds: [],
    ambiguity: {
      code: matched.length > 1 ? 'multiple-targets' : 'unclear-reference',
      message:
        matched.length > 1
          ? 'More than one item matches those details. Which one do you mean?'
          : 'I could not find an item matching those details.',
      options: (matched.length > 0 ? matched : scoped)
        .map((candidate) => candidate.title)
        .slice(0, 10),
      sourceSpan: null
    }
  }
}

function targetMatch(
  query: string,
  events: readonly EventEntity[],
  reminders: readonly ReminderEntity[],
  preference: 'event' | 'reminder' | 'either',
  focus: {
    eventIds?: readonly string[] | undefined
    reminderIds?: readonly string[] | undefined
    allowMultiple?: boolean
    localDate?: string | undefined
  } = {}
): TargetMatch {
  const referenceNumber = dialogueReferenceNumber(query)
  const referencePosition = dialogueReferencePosition(query)
  const singularReference = referenceNumber === 'singular'
  const pluralReference = referenceNumber === 'plural'
  if (singularReference || pluralReference || referencePosition) {
    const eventById = new Map(events.map((event) => [event.id, event]))
    const reminderById = new Map(reminders.map((reminder) => [reminder.id, reminder]))
    const focusedEvents = (focus.eventIds ?? [])
      .map((id) => eventById.get(id))
      .filter((event): event is EventEntity =>
        Boolean(event && preference !== 'reminder' && event.status === 'active')
      )
    const focusedReminders = (focus.reminderIds ?? [])
      .map((id) => reminderById.get(id))
      .filter((reminder): reminder is ReminderEntity =>
        Boolean(reminder && preference !== 'event' && reminder.status === 'active')
      )
    const focusedItems = [
      ...focusedEvents.map((event, index) => ({
        id: event.id,
        kind: 'event' as const,
        title: event.title,
        at: event.startUtc,
        stableIndex: index
      })),
      ...focusedReminders.map((reminder, index) => ({
        id: reminder.id,
        kind: 'reminder' as const,
        title: reminder.title,
        at: reminder.dueAtUtc ?? reminder.updatedAt,
        stableIndex: focusedEvents.length + index
      }))
    ].sort((left, right) => {
      if (focusedEvents.length === 0 || focusedReminders.length === 0) {
        return left.stableIndex - right.stableIndex
      }
      return Date.parse(left.at) - Date.parse(right.at) || left.stableIndex - right.stableIndex
    })
    const focusedCount = focusedItems.length
    if (referencePosition) {
      const selected =
        referencePosition.kind === 'last'
          ? focusedItems.at(-1)
          : focusedItems[referencePosition.index]
      if (selected) {
        return {
          eventIds: selected.kind === 'event' ? [selected.id] : [],
          reminderIds: selected.kind === 'reminder' ? [selected.id] : [],
          ambiguity: null
        }
      }
      return {
        eventIds: [],
        reminderIds: [],
        ambiguity: {
          code: 'unclear-reference',
          message:
            focusedCount === 0
              ? 'There is no recent calendar result to select from.'
              : `That position is outside the ${focusedCount} recent item${focusedCount === 1 ? '' : 's'}.`,
          options: focusedItems.map((item) => item.title).slice(0, 10),
          sourceSpan: null
        }
      }
    }
    if (focusedCount === 1 || (pluralReference && focus.allowMultiple && focusedCount > 0)) {
      return {
        eventIds: focusedItems.filter((item) => item.kind === 'event').map((item) => item.id),
        reminderIds: focusedItems.filter((item) => item.kind === 'reminder').map((item) => item.id),
        ambiguity: null
      }
    }
    if (focusedCount > 1) {
      return {
        eventIds: [],
        reminderIds: [],
        ambiguity: {
          code: 'multiple-targets',
          message: 'More than one recent item is in focus. Which one do you mean?',
          options: focusedItems.map((item) => item.title).slice(0, 10),
          sourceSpan: null
        }
      }
    }
  }
  const descriptiveCandidates: DescriptiveTargetCandidate[] = [
    ...(preference === 'reminder'
      ? []
      : events
          .filter((event) => event.status === 'active')
          .map((event) => {
            const local = Temporal.Instant.from(event.startUtc).toZonedDateTimeISO(event.timezone)
            return {
              id: event.id,
              kind: 'event' as const,
              title: event.title,
              date: local.toPlainDate().toString(),
              time: local.toPlainTime().toString({ smallestUnit: 'minute' }),
              location: event.location
            }
          })),
    ...(preference === 'event'
      ? []
      : reminders
          .filter((reminder) => reminder.status === 'active')
          .map((reminder) => {
            const local = reminder.dueAtUtc
              ? Temporal.Instant.from(reminder.dueAtUtc).toZonedDateTimeISO(reminder.timezone)
              : null
            return {
              id: reminder.id,
              kind: 'reminder' as const,
              title: reminder.title,
              date: local?.toPlainDate().toString() ?? '',
              time: local?.toPlainTime().toString({ smallestUnit: 'minute' }) ?? '',
              location: ''
            }
          }))
  ]
  const strongTitleMatches = descriptiveCandidates
    .map((candidate) => ({ ...candidate, score: similarity(query, candidate.title) }))
    .filter((candidate) => candidate.score === 1)
    .sort((left, right) => right.score - left.score)
  const strongTitle = strongTitleMatches[0]
  const nextStrongTitle = strongTitleMatches[1]
  if (strongTitle && (!nextStrongTitle || strongTitle.score - nextStrongTitle.score >= 0.08)) {
    return {
      eventIds: strongTitle.kind === 'event' ? [strongTitle.id] : [],
      reminderIds: strongTitle.kind === 'reminder' ? [strongTitle.id] : [],
      ambiguity: null
    }
  }
  const descriptive = descriptiveTargetMatch(query, descriptiveCandidates, focus)
  if (descriptive) return descriptive
  const candidates = [
    ...(preference === 'reminder'
      ? []
      : events
          .filter((event) => event.status === 'active')
          .map((event) => ({
            id: event.id,
            kind: 'event' as const,
            title: event.title,
            score: similarity(query, event.title)
          }))),
    ...(preference === 'event'
      ? []
      : reminders
          .filter((reminder) => reminder.status === 'active')
          .map((reminder) => ({
            id: reminder.id,
            kind: 'reminder' as const,
            title: reminder.title,
            score: similarity(query, reminder.title)
          })))
  ]
    .filter((candidate) => candidate.score >= 0.34)
    .sort((left, right) => right.score - left.score)

  const top = candidates[0]
  if (!top) {
    return {
      eventIds: [],
      reminderIds: [],
      ambiguity: {
        code: 'unclear-reference',
        message: `I couldn't find an active item matching “${query.trim()}”.`,
        options: [],
        sourceSpan: null
      }
    }
  }
  const close = candidates.filter((candidate) => top.score - candidate.score <= 0.08)
  if (close.length > 1) {
    return {
      eventIds: [],
      reminderIds: [],
      ambiguity: {
        code: 'multiple-targets',
        message: `More than one item could match “${query.trim()}”.`,
        options: close.map((candidate) => candidate.title).slice(0, 10),
        sourceSpan: null
      }
    }
  }
  return {
    eventIds: top.kind === 'event' ? [top.id] : [],
    reminderIds: top.kind === 'reminder' ? [top.id] : [],
    ambiguity: null
  }
}

function selection(
  match: TargetMatch,
  query: string,
  evidenceId: string,
  source: string
): NonNullable<CalendarIRDraft['selection']> {
  return {
    eventIds: match.eventIds,
    reminderIds: match.reminderIds,
    query: sourcedText(query, source, evidenceId)
  }
}

function clarify(
  context: DeterministicParserContext,
  sourceText: string,
  code: CalendarIRDraft['ambiguities'][number]['code'],
  message: string,
  options: string[] = [],
  confidence = 0.45
): DeterministicParseResult {
  const draft = baseDraft(context, sourceText, 'assistant.clarify', 'read', confidence)
  draft.ambiguities = [{ code, message, options, sourceSpan: null }]
  return { draft: calendarIRDraftSchema.parse(draft), sourceText, matchedPattern: 'clarification' }
}

function unsupported(
  context: DeterministicParserContext,
  sourceText: string
): DeterministicParseResult {
  const draft = baseDraft(context, sourceText, 'assistant.unsupported', 'read', 0.2)
  return { draft: calendarIRDraftSchema.parse(draft), sourceText, matchedPattern: 'unsupported' }
}

function titleBeforeTemporal(raw: string, date: DateMatch | null, time: TimeMatch | null): string {
  const boundary = Math.min(
    date?.start ?? raw.length,
    time?.start ?? raw.length,
    /\b(?:every|daily|weekly|monthly|yearly)\b/iu.exec(raw)?.index ?? raw.length
  )
  return raw
    .slice(0, boundary)
    .replace(
      /^\s*(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+|i(?:'d| would)\s+like\s+(?:you\s+)?to\s+)?(?:add|create|schedule|book|put|block|make)\s+(?:(?:an?|the|my)\s+)?(?:event|meeting|appointment)?\s*/iu,
      ''
    )
    .replace(/^\s*(?:called|named)\s+/iu, '')
    .replace(/\ball[- ]day\b/giu, '')
    .replace(/\s+(?:on|at|for|from)\s*$/iu, '')
    .trim()
}

function reminderTitle(raw: string, date: DateMatch | null, time: TimeMatch | null): string {
  const trailingAction = /\bto\s+(.+)$/iu.exec(raw)
  if (
    remindMeRequestPattern.test(raw) &&
    trailingAction?.index !== undefined &&
    trailingAction[1] &&
    trailingAction.index > Math.min(date?.start ?? raw.length, time?.start ?? raw.length)
  ) {
    return titleBeforeTemporal(trailingAction[1], null, null)
  }
  const withoutPrefix = raw.replace(reminderPrefixPattern, '')
  const shiftedDate = date
    ? { ...date, start: Math.max(0, date.start - (raw.length - withoutPrefix.length)) }
    : null
  const shiftedTime = time
    ? { ...time, start: Math.max(0, time.start - (raw.length - withoutPrefix.length)) }
    : null
  return titleBeforeTemporal(withoutPrefix, shiftedDate, shiftedTime)
}

function shouldUsePrevious(text: string, previous: string | null): boolean {
  if (!previous) return false
  const wordCount = text.trim().split(/\s+/u).length
  return (
    wordCount <= 7 &&
    /^(?:at|on|from|between|next|this|today|tomorrow|morning|afternoon|evening|all day|the (?:whole|entire) series|all occurrences|\d)/iu.test(
      text.trim()
    )
  )
}

function requestsSeriesScope(text: string): boolean {
  return /\b(?:(?:the\s+)?(?:whole|entire)\s+series|all\s+occurrences)\b/iu.test(text)
}

function stripScopeWords(text: string): string {
  return text
    .replace(/\b(?:(?:the\s+)?(?:whole|entire)\s+series|all\s+occurrences|series)\b/giu, '')
    .trim()
}

function targetIsRecurring(
  match: TargetMatch,
  events: readonly EventEntity[],
  reminders: readonly ReminderEntity[]
): boolean {
  const eventId = match.eventIds[0]
  const reminderId = match.reminderIds[0]
  return Boolean(
    (eventId && events.find((event) => event.id === eventId)?.recurrence) ||
    (reminderId && reminders.find((reminder) => reminder.id === reminderId)?.recurrence)
  )
}

function recurringScopeClarification(
  context: DeterministicParserContext,
  sourceText: string,
  match: TargetMatch
): DeterministicParseResult | null {
  if (
    !requestsSeriesScope(sourceText) &&
    targetIsRecurring(match, context.events, context.reminders)
  ) {
    return clarify(
      context,
      sourceText,
      'unclear-scope',
      'That item repeats. Do you mean the entire series?',
      ['the entire series', 'cancel']
    )
  }
  return null
}

function parseSource(context: DeterministicParserContext): string {
  const text = context.text.trim()
  const followUp = /^(?:(?:what|how) about|and(?: on)?)\s+(.+?)[?.!]*$/iu.exec(text)
  const previous = context.previousUserText?.trim() ?? ''
  if (followUp?.[1] && previous) {
    const detail = followUp[1].trim()
    const previousDate = parseDateMatch(previous, context.localDate)
    const nextDate = parseDateMatch(detail, context.localDate)
    const previousTime = parseTimeMatch(previous)
    const nextTime = parseTimeMatch(detail)
    const contextualDetail = [
      !nextDate ? previousDate?.text : null,
      detail,
      !nextTime ? previousTime?.text : null
    ]
      .filter((item): item is string => Boolean(item))
      .join(' ')
    if (/\b(?:free|available|open)\b/iu.test(previous)) {
      return `Am I free ${contextualDetail}?`
    }
    if (/\b(?:conflicts?|overlaps?|double[- ]book)\b/iu.test(previous)) {
      return `Are there conflicts ${contextualDetail}?`
    }
    if (
      /\b(?:agenda|calendar|schedule|what (?:do|did) i have|show|list|summari[sz]e)\b/iu.test(
        previous
      )
    ) {
      return `What do I have ${contextualDetail}?`
    }
  }
  return shouldUsePrevious(text, context.previousUserText)
    ? `${context.previousUserText?.trim()} ${text}`
    : text
}

export function parseCalendarText(
  inputContext: DeterministicParserContext
): DeterministicParseResult {
  const context: DeterministicParserContext = {
    ...inputContext,
    text: inputContext.text.trim()
  }
  const sourceText = parseSource(context)
  const lower = sourceText.toLocaleLowerCase()
  const date = parseDateMatch(sourceText, context.localDate)
  const endDate = parseEndDateMatch(sourceText, context.localDate, date)
  const time = parseTimeMatch(sourceText)
  const evidenceId = `evidence:${context.requestId.replace(/[^a-zA-Z0-9._:-]/g, '-')}`

  if (
    /\b(?:conflicts?|overlaps?|double[- ]book(?:ed|ings?)?)\b/iu.test(sourceText) ||
    context.semanticHint?.operation === 'calendar.conflicts'
  ) {
    const draft = baseDraft(
      context,
      sourceText,
      'calendar.conflicts',
      'read',
      context.semanticHint?.operation === 'calendar.conflicts'
        ? Math.min(0.96, context.semanticHint.confidence)
        : 0.96
    )
    const range = queryWindow(sourceText, context.localDate, date, endDate, time)
    draft.fields.when = sourcedWindow(range.window, range.start, range.end, evidenceId)
    return {
      draft: calendarIRDraftSchema.parse(draft),
      sourceText,
      matchedPattern: 'conflict-query'
    }
  }

  if (
    /\b(?:am i|are we|is (?:the |that )?(?:time|slot))?\s*(?:free|available|open)\b/iu.test(
      sourceText
    ) ||
    context.semanticHint?.operation === 'calendar.availability'
  ) {
    if (!date) {
      return clarify(context, sourceText, 'missing-date', 'Which day would you like me to check?', [
        'today',
        'tomorrow'
      ])
    }
    if (time?.ambiguous) {
      return clarify(
        context,
        sourceText,
        'missing-time',
        `Did you mean ${time.startTime.slice(0, 2)} AM or PM?`,
        ['AM', 'PM']
      )
    }
    const draft = baseDraft(
      context,
      sourceText,
      'calendar.availability',
      'read',
      context.semanticHint?.operation === 'calendar.availability'
        ? Math.min(0.98, context.semanticHint.confidence)
        : 0.98
    )
    const range = queryWindow(sourceText, context.localDate, date, endDate, time)
    draft.fields.when = sourcedWindow(range.window, range.start, range.end, evidenceId)
    return {
      draft: calendarIRDraftSchema.parse(draft),
      sourceText,
      matchedPattern: 'availability-query'
    }
  }

  if (
    (isOrdinalCalendarQuery(sourceText) ||
      /\b(?:what(?:'s|s| is)? (?:on|in|happening|scheduled|(?:my )?next)|what(?:'s|s| is) (?:tomorrow|tmr|tmrw|tmw|today)|what (?:do|did) i have|what (?:classes?|courses?|lectures?|labs?|events?|meetings?|appointments?|reminders?) do i have|what (?:was|is) on my (?:calendar|schedule|agenda)|what does (?:my day|today|tomorrow|tmr|tmrw|tmw|(?:(?:next|this|last)\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)) look like|do i have anything|where (?:do i (?:need to )?be|am i going|was i)|show (?:me )?(?:my )?|list (?:my )?|how (?:busy|full)|summari[sz]e|walk me through|tell me (?:more )?about|give me (?:the )?details? (?:for|on)|what(?:'s|s| is) coming up|upcoming (?:plans?|events?))\b/iu.test(
        sourceText
      ) ||
      context.semanticHint?.operation === 'calendar.list') &&
    (context.semanticHint?.operation === 'calendar.list' ||
      date !== null ||
      /\b(?:calendar|schedule|agenda|plans?|class|course|lecture|lab|discussion|seminar|practicum|recitation|tutorial|event|meeting|appointment|reminder|today|tomorrow|tmr|tmrw|tmw|yesterday|week|month|year|first|second|third|fourth|fifth|last|next|past|previous|earlier|coming|upcoming|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/iu.test(
        sourceText
      ))
  ) {
    const draft = baseDraft(
      context,
      sourceText,
      'calendar.list',
      'read',
      context.semanticHint?.operation === 'calendar.list'
        ? Math.min(0.97, context.semanticHint.confidence)
        : 0.97
    )
    const range = queryWindow(sourceText, context.localDate, date, endDate, time)
    draft.fields.when = sourcedWindow(range.window, range.start, range.end, evidenceId)
    return {
      draft: calendarIRDraftSchema.parse(draft),
      sourceText,
      matchedPattern: 'schedule-query'
    }
  }

  const searchMatch =
    /^(?:when is|where is|find|search(?: for)?|look up|tell me (?:more )?about|give me (?:the )?details? (?:for|on))\s+(.+?)[?.!]*$/iu.exec(
      sourceText
    )
  const hintedQuery =
    context.semanticHint?.operation === 'calendar.search'
      ? hintedText(sourceText, context.semanticHint.targetSpan, evidenceId)
      : null
  if (searchMatch?.[1] || hintedQuery) {
    const query = searchMatch?.[1]?.trim() ?? hintedQuery?.value ?? ''
    const draft = baseDraft(
      context,
      sourceText,
      'calendar.search',
      'read',
      hintedQuery ? Math.min(0.93, context.semanticHint?.confidence ?? 0.93) : 0.93
    )
    const focused = targetMatch(query, context.events, context.reminders, 'either', {
      eventIds: context.focusedEventIds,
      reminderIds: context.focusedReminderIds,
      allowMultiple: true,
      localDate: context.localDate
    })
    if (dialogueReferenceNumber(query) && focused.ambiguity) {
      return clarify(
        context,
        sourceText,
        focused.ambiguity.code,
        focused.ambiguity.message,
        focused.ambiguity.options
      )
    }
    draft.selection = {
      eventIds: focused.ambiguity ? [] : focused.eventIds,
      reminderIds: focused.ambiguity ? [] : focused.reminderIds,
      query: sourcedText(query, sourceText, evidenceId)
    }
    return {
      draft: calendarIRDraftSchema.parse(draft),
      sourceText,
      matchedPattern: 'search-query'
    }
  }

  const completeMatch =
    /^(?:mark|complete|finish|check off)\s+(.+?)(?:\s+(?:as\s+)?done)?[.!]*$/iu.exec(sourceText)
  const hintedComplete = context.semanticHint?.operation === 'reminder.complete'
  if (completeMatch?.[1] || hintedComplete) {
    const query = (
      completeMatch?.[1] ??
      hintedText(sourceText, context.semanticHint?.targetSpan ?? null, evidenceId)?.value ??
      ''
    )
      .replace(/\b(?:the|my)?\s*reminder\b/giu, '')
      .trim()
    const match = targetMatch(query, context.events, context.reminders, 'reminder', {
      eventIds: context.focusedEventIds,
      reminderIds: context.focusedReminderIds,
      localDate: context.localDate
    })
    if (match.ambiguity) {
      return clarify(
        context,
        sourceText,
        match.ambiguity.code,
        match.ambiguity.message,
        match.ambiguity.options
      )
    }
    const draft = baseDraft(
      context,
      sourceText,
      'reminder.complete',
      'low',
      hintedComplete ? Math.min(0.92, context.semanticHint?.confidence ?? 0.92) : 0.96
    )
    draft.selection = selection(match, query, evidenceId, sourceText)
    draft.fields.status = 'completed'
    return {
      draft: calendarIRDraftSchema.parse(draft),
      sourceText,
      matchedPattern: 'reminder-complete'
    }
  }

  const repeatUpdateMatch =
    /^(?:make|set|change|update)\s+(.+?)\s+(?:to\s+)?(?:repeat|recur)\s+(.+)$/iu.exec(sourceText)
  if (repeatUpdateMatch?.[1] && repeatUpdateMatch[2]) {
    const targetQuery = stripScopeWords(repeatUpdateMatch[1])
    const target = targetMatch(targetQuery, context.events, context.reminders, 'either', {
      eventIds: context.focusedEventIds,
      reminderIds: context.focusedReminderIds,
      localDate: context.localDate
    })
    if (target.ambiguity) {
      return clarify(
        context,
        sourceText,
        target.ambiguity.code,
        target.ambiguity.message,
        target.ambiguity.options
      )
    }
    const recurrence = recurrenceFromText(repeatUpdateMatch[2], context.localDate)
    if (!recurrence) {
      return clarify(
        context,
        sourceText,
        'unsupported-expression',
        'Which days should it repeat? Try “every Tuesday and Thursday” or “every 2 weeks.”'
      )
    }
    const operation = target.reminderIds.length ? 'reminder.update' : 'event.update'
    const draft = baseDraft(context, sourceText, operation, 'high', 0.94)
    draft.selection = selection(target, targetQuery, evidenceId, sourceText)
    draft.scope = 'series'
    draft.recurrence = recurrence
    return {
      draft: calendarIRDraftSchema.parse(draft),
      sourceText,
      matchedPattern: 'recurrence-update'
    }
  }

  const updateHint =
    context.semanticHint?.operation === 'event.update' ||
    context.semanticHint?.operation === 'reminder.update'
      ? context.semanticHint
      : null
  if (updateHint) {
    const targetQuery =
      hintedText(sourceText, context.semanticHint?.targetSpan ?? null, evidenceId)?.value ?? ''
    const kind = updateHint.operation === 'reminder.update' ? 'reminder' : 'event'
    const target = targetMatch(targetQuery, context.events, context.reminders, kind, {
      eventIds: context.focusedEventIds,
      reminderIds: context.focusedReminderIds,
      localDate: context.localDate
    })
    if (target.ambiguity) {
      return clarify(
        context,
        sourceText,
        target.ambiguity.code,
        target.ambiguity.message,
        target.ambiguity.options
      )
    }
    const scopeClarification = recurringScopeClarification(context, sourceText, target)
    if (scopeClarification) return scopeClarification
    const nextTitle = hintedText(sourceText, updateHint.titleSpan, evidenceId)
    const nextDescription = hintedText(sourceText, updateHint.descriptionSpan, evidenceId)
    const nextLocation = hintedText(sourceText, updateHint.locationSpan, evidenceId)
    const nextRecurrence = recurrenceFromText(sourceText, context.localDate)
    const protectedSpans = [
      updateHint.targetSpan,
      updateHint.titleSpan,
      updateHint.descriptionSpan,
      updateHint.locationSpan
    ]
    const requestedDate = nextRecurrence ? null : outsideSpans(date, protectedSpans)
    const requestedTime = outsideSpans(time, protectedSpans)
    if (requestedTime?.ambiguous) {
      return clarify(
        context,
        sourceText,
        'missing-time',
        'Should that updated time be in the morning or afternoon?',
        ['AM', 'PM']
      )
    }
    if (
      !nextTitle &&
      !nextDescription &&
      !nextLocation &&
      !nextRecurrence &&
      !requestedDate &&
      !requestedTime
    ) {
      return clarify(
        context,
        sourceText,
        'unsupported-expression',
        'What should I change: the name, notes, location, day, time, or repeat pattern?'
      )
    }
    const draft = baseDraft(
      context,
      sourceText,
      updateHint.operation,
      nextRecurrence ? 'high' : 'medium',
      Math.min(0.9, updateHint.confidence)
    )
    draft.selection = selection(target, targetQuery, evidenceId, sourceText)
    draft.scope = nextRecurrence || requestsSeriesScope(sourceText) ? 'series' : 'single'
    draft.fields.title = nextTitle
    draft.fields.description = nextDescription
    draft.fields.location = kind === 'event' ? nextLocation : null
    draft.recurrence = nextRecurrence
    if (requestedDate || requestedTime) {
      const windowSpan = requestedWindowSpan(sourceText, requestedDate, requestedTime)
      if (kind === 'event') {
        const event = context.events.find((candidate) => candidate.id === target.eventIds[0])
        if (!event) return clarify(context, sourceText, 'unclear-reference', 'Which event?')
        const effectiveDate = requestedDate ?? storedDateMatch(event.startUtc, event.timezone)
        const effectiveTime = requestedTime ?? storedTimeMatch(event.startUtc, event.timezone)
        draft.fields.when = sourcedWindow(
          mutationWindow(
            effectiveDate,
            requestedDate ? endDate : null,
            event.allDay && !requestedTime ? null : effectiveTime,
            event.allDay && !requestedTime
          ),
          windowSpan.start,
          windowSpan.end,
          evidenceId
        )
      } else {
        const reminder = context.reminders.find(
          (candidate) => candidate.id === target.reminderIds[0]
        )
        if (!reminder) return clarify(context, sourceText, 'unclear-reference', 'Which reminder?')
        const existingDueAt = reminder.dueAtUtc
        if (existingDueAt === null && (!requestedDate || !requestedTime)) {
          return clarify(
            context,
            sourceText,
            'missing-time',
            'That reminder has no due date yet. Include both a day and time to schedule it.'
          )
        }
        const effectiveDate = requestedDate ?? storedDateMatch(existingDueAt!, reminder.timezone)
        const effectiveTime = requestedTime ?? storedTimeMatch(existingDueAt!, reminder.timezone)
        draft.fields.when = sourcedWindow(
          mutationWindow(effectiveDate, null, { ...effectiveTime, endTime: null }, false),
          windowSpan.start,
          windowSpan.end,
          evidenceId
        )
      }
    }
    return {
      draft: calendarIRDraftSchema.parse(draft),
      sourceText,
      matchedPattern: 'model-assisted-update'
    }
  }

  const duplicateMatch = /^(?:duplicate|copy|clone)\s+(.+?)\s+(?:to|on|for)\s+(.+)$/iu.exec(
    sourceText
  )
  const hintedDuplicate = context.semanticHint?.operation === 'event.duplicate'
  if (duplicateMatch?.[1] || hintedDuplicate) {
    const targetQuery =
      duplicateMatch?.[1]?.trim() ??
      hintedText(sourceText, context.semanticHint?.targetSpan ?? null, evidenceId)?.value ??
      ''
    const target = targetMatch(targetQuery, context.events, context.reminders, 'event', {
      eventIds: context.focusedEventIds,
      reminderIds: context.focusedReminderIds,
      localDate: context.localDate
    })
    if (target.ambiguity) {
      return clarify(
        context,
        sourceText,
        target.ambiguity.code,
        target.ambiguity.message,
        target.ambiguity.options
      )
    }
    const destinationText = duplicateMatch?.[2] ?? null
    const destinationOffset = destinationText ? sourceText.lastIndexOf(destinationText) : 0
    const requestedDate = hintedDuplicate
      ? outsideSpans(date, [context.semanticHint?.targetSpan ?? null])
      : destinationText
        ? shiftedMatch(parseDateMatch(destinationText, context.localDate), destinationOffset)
        : date
    const requestedEndDate = destinationText
      ? shiftedMatch(
          parseEndDateMatch(
            destinationText,
            context.localDate,
            parseDateMatch(destinationText, context.localDate)
          ),
          destinationOffset
        )
      : endDate
    const requestedTime = hintedDuplicate
      ? outsideSpans(time, [context.semanticHint?.targetSpan ?? null])
      : destinationText
        ? shiftedMatch(parseTimeMatch(destinationText), destinationOffset)
        : time
    if (!requestedDate) {
      return clarify(context, sourceText, 'missing-date', 'What day should the copy begin?')
    }
    const source = context.events.find((event) => event.id === target.eventIds[0])
    if (!source)
      return clarify(context, sourceText, 'unclear-reference', 'Which event should I copy?')
    const sourceStart = Temporal.Instant.from(source.startUtc).toZonedDateTimeISO(source.timezone)
    const sourceEnd = Temporal.Instant.from(source.endUtc).toZonedDateTimeISO(source.timezone)
    const effectiveTime: TimeMatch =
      requestedTime ??
      ({
        startTime: sourceStart.toPlainTime().toString({ smallestUnit: 'minute' }),
        endTime: sourceEnd.toPlainTime().toString({ smallestUnit: 'minute' }),
        start: requestedDate.start,
        end: requestedDate.end,
        text: requestedDate.text,
        ambiguous: false,
        period: null
      } satisfies TimeMatch)
    if (effectiveTime.ambiguous) {
      return clarify(
        context,
        sourceText,
        'missing-time',
        'Should the copied event be in the morning or afternoon?',
        ['AM', 'PM']
      )
    }
    const draft = baseDraft(
      context,
      sourceText,
      'event.duplicate',
      'low',
      hintedDuplicate ? Math.min(0.92, context.semanticHint?.confidence ?? 0.92) : 0.94
    )
    draft.selection = selection(target, targetQuery, evidenceId, sourceText)
    const recurrence = recurrenceFromText(sourceText, context.localDate)
    draft.fields.when = sourcedWindow(
      mutationWindow(
        requestedDate,
        recurrence ? null : requestedEndDate,
        effectiveTime,
        source.allDay
      ),
      Math.min(requestedDate.start, effectiveTime.start),
      Math.max(requestedDate.end, effectiveTime.end),
      evidenceId
    )
    draft.recurrence = recurrence
    return {
      draft: calendarIRDraftSchema.parse(draft),
      sourceText,
      matchedPattern: 'event-duplicate'
    }
  }

  const deleteMatch = /^(?:delete|remove|cancel)\s+(.+?)[.!]*$/iu.exec(sourceText)
  const hintedDelete =
    context.semanticHint?.operation === 'event.delete' ||
    context.semanticHint?.operation === 'reminder.delete'
  if (deleteMatch?.[1] || hintedDelete) {
    const rawTarget =
      deleteMatch?.[1] ??
      hintedText(sourceText, context.semanticHint?.targetSpan ?? null, evidenceId)?.value ??
      ''
    const query = stripScopeWords(rawTarget)
      .replace(/^(?:the|my)\s+/iu, '')
      .replace(/\b(?:event|reminder)\b/giu, '')
      .trim()
    const preference =
      context.semanticHint?.operation === 'reminder.delete' || /\breminder\b/iu.test(rawTarget)
        ? 'reminder'
        : context.semanticHint?.operation === 'event.delete'
          ? 'event'
          : 'either'
    const match = targetMatch(query, context.events, context.reminders, preference, {
      eventIds: context.focusedEventIds,
      reminderIds: context.focusedReminderIds,
      localDate: context.localDate
    })
    if (match.ambiguity) {
      return clarify(
        context,
        sourceText,
        match.ambiguity.code,
        match.ambiguity.message,
        match.ambiguity.options
      )
    }
    const scopeClarification = recurringScopeClarification(context, sourceText, match)
    if (scopeClarification) return scopeClarification
    const operation = match.reminderIds.length ? 'reminder.delete' : 'event.delete'
    const draft = baseDraft(
      context,
      sourceText,
      operation,
      'destructive',
      hintedDelete ? Math.min(0.9, context.semanticHint?.confidence ?? 0.9) : 0.93
    )
    draft.selection = selection(match, query, evidenceId, sourceText)
    draft.scope = requestsSeriesScope(sourceText) ? 'series' : 'single'
    return {
      draft: calendarIRDraftSchema.parse(draft),
      sourceText,
      matchedPattern: 'delete'
    }
  }

  const moveMatch = /^(?:move|reschedule|shift)\s+(.+?)\s+(?:to|for)\s+(.+)$/iu.exec(sourceText)
  const hintedMove = context.semanticHint?.operation === 'event.move'
  if ((moveMatch?.[1] && moveMatch[2]) || hintedMove) {
    const targetQuery = stripScopeWords(
      moveMatch?.[1] ??
        hintedText(sourceText, context.semanticHint?.targetSpan ?? null, evidenceId)?.value ??
        ''
    )
    const target = targetMatch(targetQuery, context.events, context.reminders, 'event', {
      eventIds: context.focusedEventIds,
      reminderIds: context.focusedReminderIds,
      localDate: context.localDate
    })
    if (target.ambiguity) {
      return clarify(
        context,
        sourceText,
        target.ambiguity.code,
        target.ambiguity.message,
        target.ambiguity.options
      )
    }
    const scopeClarification = recurringScopeClarification(context, sourceText, target)
    if (scopeClarification) return scopeClarification
    const source = context.events.find((event) => event.id === target.eventIds[0])
    if (!source)
      return clarify(context, sourceText, 'unclear-reference', 'Which event should I move?')
    const destinationText = moveMatch?.[2] ?? null
    const destinationOffset = destinationText ? sourceText.lastIndexOf(destinationText) : 0
    const destinationDate = destinationText
      ? parseDateMatch(destinationText, context.localDate)
      : null
    const requestedDate = hintedMove
      ? outsideSpans(date, [context.semanticHint?.targetSpan ?? null])
      : destinationText
        ? shiftedMatch(destinationDate, destinationOffset)
        : date
    const requestedEndDate = destinationText
      ? shiftedMatch(
          parseEndDateMatch(destinationText, context.localDate, destinationDate),
          destinationOffset
        )
      : endDate
    const requestedTime = hintedMove
      ? outsideSpans(time, [context.semanticHint?.targetSpan ?? null])
      : destinationText
        ? shiftedMatch(parseTimeMatch(destinationText), destinationOffset)
        : time
    if (!requestedDate && !requestedTime) {
      return clarify(context, sourceText, 'missing-date', 'What day or time should I move it to?')
    }
    if (requestedTime?.ambiguous) {
      return clarify(
        context,
        sourceText,
        'missing-time',
        'Should that be in the morning or afternoon?',
        ['AM', 'PM']
      )
    }
    const effectiveDate = requestedDate ?? storedDateMatch(source.startUtc, source.timezone)
    const effectiveTime = requestedTime ?? storedTimeMatch(source.startUtc, source.timezone)
    const windowSpan = requestedWindowSpan(sourceText, requestedDate, requestedTime)
    const draft = baseDraft(
      context,
      sourceText,
      'event.move',
      'medium',
      hintedMove ? Math.min(0.9, context.semanticHint?.confidence ?? 0.9) : 0.91
    )
    draft.selection = selection(target, targetQuery, evidenceId, sourceText)
    draft.scope = requestsSeriesScope(sourceText) ? 'series' : 'single'
    draft.fields.when = sourcedWindow(
      mutationWindow(
        effectiveDate,
        requestedDate ? requestedEndDate : null,
        source.allDay && !requestedTime ? null : effectiveTime,
        source.allDay && !requestedTime
      ),
      windowSpan.start,
      windowSpan.end,
      evidenceId
    )
    return {
      draft: calendarIRDraftSchema.parse(draft),
      sourceText,
      matchedPattern: 'event-move'
    }
  }

  const renameMatch = /^rename\s+(.+?)\s+to\s+(.+?)[.!]*$/iu.exec(sourceText)
  if (renameMatch?.[1] && renameMatch[2]) {
    const targetQuery = stripScopeWords(renameMatch[1])
    const target = targetMatch(targetQuery, context.events, context.reminders, 'either', {
      eventIds: context.focusedEventIds,
      reminderIds: context.focusedReminderIds,
      localDate: context.localDate
    })
    if (target.ambiguity) {
      return clarify(
        context,
        sourceText,
        target.ambiguity.code,
        target.ambiguity.message,
        target.ambiguity.options
      )
    }
    const scopeClarification = recurringScopeClarification(context, sourceText, target)
    if (scopeClarification) return scopeClarification
    const operation = target.reminderIds.length ? 'reminder.update' : 'event.update'
    const draft = baseDraft(context, sourceText, operation, 'medium', 0.92)
    draft.selection = selection(target, targetQuery, evidenceId, sourceText)
    draft.scope = requestsSeriesScope(sourceText) ? 'series' : 'single'
    draft.fields.title = sourcedText(renameMatch[2], sourceText, evidenceId)
    return {
      draft: calendarIRDraftSchema.parse(draft),
      sourceText,
      matchedPattern: 'rename'
    }
  }

  const isReminder =
    reminderRequestPattern.test(sourceText) || context.semanticHint?.operation === 'reminder.create'
  if (isReminder) {
    if (!date) {
      const recurrence = recurrenceFromText(sourceText, context.localDate)
      if (!time && recurrence === null) {
        const hintedTitle =
          context.semanticHint?.operation === 'reminder.create'
            ? hintedText(sourceText, context.semanticHint.titleSpan, evidenceId)
            : null
        const hintedDescription =
          context.semanticHint?.operation === 'reminder.create'
            ? hintedText(sourceText, context.semanticHint.descriptionSpan, evidenceId)
            : null
        const title = hintedTitle?.value ?? reminderTitle(sourceText, null, null)
        if (!title)
          return clarify(
            context,
            sourceText,
            'unclear-reference',
            'What should I remind you about?'
          )
        const draft = baseDraft(
          context,
          sourceText,
          'reminder.create',
          'low',
          hintedTitle ? Math.min(0.95, context.semanticHint?.confidence ?? 0.95) : 0.95
        )
        draft.fields.title = hintedTitle ?? sourcedText(title, sourceText, evidenceId)
        draft.fields.description = hintedDescription
        return {
          draft: calendarIRDraftSchema.parse(draft),
          sourceText,
          matchedPattern: 'undated-reminder-create'
        }
      }
      return clarify(context, sourceText, 'missing-date', 'What day should I remind you?', [
        'today',
        'tomorrow'
      ])
    }
    if (endDate) {
      return clarify(
        context,
        sourceText,
        'unsupported-expression',
        'A reminder needs one due time. For a multi-day block, ask me to create an event instead.'
      )
    }
    if (!time) {
      return clarify(context, sourceText, 'missing-time', 'What time should the reminder arrive?', [
        '9:00 AM',
        '12:00 PM',
        '6:00 PM'
      ])
    }
    if (time.endTime) {
      return clarify(
        context,
        sourceText,
        'unsupported-expression',
        'I found a time range, but a reminder has one due time. Should I create this as a calendar event instead?',
        ['Create calendar events']
      )
    }
    if (time.ambiguous) {
      return clarify(
        context,
        sourceText,
        'missing-time',
        'Should that reminder be in the morning or evening?',
        ['AM', 'PM']
      )
    }
    const hintedTitle =
      context.semanticHint?.operation === 'reminder.create'
        ? hintedText(sourceText, context.semanticHint.titleSpan, evidenceId)
        : null
    const hintedDescription =
      context.semanticHint?.operation === 'reminder.create'
        ? hintedText(sourceText, context.semanticHint.descriptionSpan, evidenceId)
        : null
    const title = hintedTitle?.value ?? reminderTitle(sourceText, date, time)
    if (!title)
      return clarify(context, sourceText, 'unclear-reference', 'What should I remind you about?')
    const draft = baseDraft(
      context,
      sourceText,
      'reminder.create',
      'low',
      hintedTitle ? Math.min(0.95, context.semanticHint?.confidence ?? 0.95) : 0.95
    )
    draft.fields.title = hintedTitle ?? sourcedText(title, sourceText, evidenceId)
    draft.fields.description = hintedDescription
    draft.fields.when = sourcedWindow(
      mutationWindow(date, null, { ...time, endTime: null }, false),
      Math.min(date.start, time.start),
      Math.max(date.end, time.end),
      evidenceId
    )
    draft.recurrence = recurrenceFromText(sourceText, context.localDate)
    return {
      draft: calendarIRDraftSchema.parse(draft),
      sourceText,
      matchedPattern: 'reminder-create'
    }
  }

  const explicitEventVerb =
    /^(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+|i(?:'d| would)\s+like\s+(?:you\s+)?to\s+)?(?:add|create|schedule|book|put|block|make)\b/iu.test(
      sourceText
    )
  const hasEventVerb = explicitEventVerb || context.semanticHint?.operation === 'event.create'
  const looksLikeDatedEvent = Boolean(date && (time || /\ball day\b/iu.test(sourceText)))
  if (hasEventVerb || looksLikeDatedEvent) {
    if (!date) {
      return clarify(
        context,
        sourceText,
        'missing-date',
        'What day should I put that on the calendar?',
        ['today', 'tomorrow']
      )
    }
    const allDay = /\ball[- ]day\b/iu.test(sourceText) || Boolean(endDate && !time)
    if (!allDay && !time) {
      return clarify(context, sourceText, 'missing-time', 'What time should the event start?', [
        '9:00 AM',
        '1:00 PM',
        '6:00 PM'
      ])
    }
    if (time?.ambiguous) {
      return clarify(
        context,
        sourceText,
        'missing-time',
        'Should that event be in the morning or afternoon?',
        ['AM', 'PM']
      )
    }
    const hintedTitle =
      context.semanticHint?.operation === 'event.create'
        ? hintedText(sourceText, context.semanticHint.titleSpan, evidenceId)
        : null
    const hintedDescription =
      context.semanticHint?.operation === 'event.create'
        ? hintedText(sourceText, context.semanticHint.descriptionSpan, evidenceId)
        : null
    const hintedLocation =
      context.semanticHint?.operation === 'event.create'
        ? hintedText(sourceText, context.semanticHint.locationSpan, evidenceId)
        : null
    const title = hintedTitle?.value ?? titleBeforeTemporal(sourceText, date, time)
    if (!title)
      return clarify(context, sourceText, 'unclear-reference', 'What is the event called?')
    const draft = baseDraft(
      context,
      sourceText,
      'event.create',
      'low',
      hintedTitle ? Math.min(0.93, context.semanticHint?.confidence ?? 0.93) : 0.93
    )
    draft.fields.title = hintedTitle ?? sourcedText(title, sourceText, evidenceId)
    draft.fields.description = hintedDescription
    draft.fields.location = hintedLocation
    const recurrence = recurrenceFromText(sourceText, context.localDate)
    draft.fields.when = sourcedWindow(
      mutationWindow(date, recurrence ? null : endDate, time, allDay),
      Math.min(date.start, time?.start ?? date.start),
      Math.max(date.end, endDate?.end ?? date.end, time?.end ?? date.end),
      evidenceId
    )
    draft.recurrence = recurrence
    if (/\b(?:every|daily|weekly|monthly|yearly)\b/iu.test(lower) && !draft.recurrence) {
      return clarify(
        context,
        sourceText,
        'unsupported-expression',
        'I found a repeat phrase, but I need a simpler pattern such as “every week” or “every weekday.”'
      )
    }
    return {
      draft: calendarIRDraftSchema.parse(draft),
      sourceText,
      matchedPattern:
        explicitEventVerb || context.semanticHint ? 'event-create' : 'event-create-inferred'
    }
  }

  return unsupported(context, sourceText)
}
