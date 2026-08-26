import { Temporal } from '@js-temporal/polyfill'
import type { RecurrenceRule, Weekday } from '@remind-me/contracts'

const weekdays: readonly Weekday[] = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday'
]

const weekdayAliases: Readonly<Record<string, Weekday>> = {
  m: 'monday',
  mo: 'monday',
  mon: 'monday',
  monday: 'monday',
  mondays: 'monday',
  tu: 'tuesday',
  tue: 'tuesday',
  tues: 'tuesday',
  tuesday: 'tuesday',
  tuesdays: 'tuesday',
  w: 'wednesday',
  we: 'wednesday',
  wed: 'wednesday',
  weds: 'wednesday',
  wednesday: 'wednesday',
  wednesdays: 'wednesday',
  r: 'thursday',
  th: 'thursday',
  thu: 'thursday',
  thur: 'thursday',
  thurs: 'thursday',
  thursday: 'thursday',
  thursdays: 'thursday',
  f: 'friday',
  fr: 'friday',
  fri: 'friday',
  friday: 'friday',
  fridays: 'friday',
  sa: 'saturday',
  sat: 'saturday',
  saturday: 'saturday',
  saturdays: 'saturday',
  su: 'sunday',
  sun: 'sunday',
  sunday: 'sunday',
  sundays: 'sunday'
}

const compactWeekdayAliases: Readonly<Record<string, readonly Weekday[]>> = {
  mw: ['monday', 'wednesday'],
  wf: ['wednesday', 'friday'],
  mwf: ['monday', 'wednesday', 'friday'],
  tr: ['tuesday', 'thursday'],
  tth: ['tuesday', 'thursday'],
  mtwrf: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday']
}

const sourceWeekdayAliases: Readonly<Record<string, Weekday>> = {
  mon: 'monday',
  monday: 'monday',
  tue: 'tuesday',
  tues: 'tuesday',
  tuesday: 'tuesday',
  wed: 'wednesday',
  weds: 'wednesday',
  wednesday: 'wednesday',
  thu: 'thursday',
  thur: 'thursday',
  thurs: 'thursday',
  thursday: 'thursday',
  fri: 'friday',
  friday: 'friday',
  sat: 'saturday',
  saturday: 'saturday',
  sun: 'sunday',
  sunday: 'sunday'
}

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
  sept: 9,
  sep: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12
}

const weekdayExpression =
  '(?:monday|mon|tuesday|tues?|wednesday|weds?|thursday|thurs?|friday|fri|saturday|sat|sunday|sun)'
const monthExpression =
  '(?:january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept?|october|oct|november|nov|december|dec)'
const dateExpression =
  `(?:today|tomorrow|yesterday|(?:(?:last|this|next)\\s+)?${weekdayExpression}|` +
  `\\d{4}-\\d{1,2}-\\d{1,2}|\\d{1,2}[/-]\\d{1,2}(?:[/-]\\d{2,4})?|` +
  `${monthExpression}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?)`
const actionExpression =
  '(?:copy|duplicate|clone|repeat|mirror|reuse|replicate|apply|use|spread|put|place|carry)'
const scheduleExpression = '(?:schedule|agenda|plans?|events?|routine|calendar)'
const targetConnector = '(?:to|onto|on|across|over|for|every)'

const extractionPatterns = [
  new RegExp(
    `\\b${actionExpression}\\s+(?:(?:my|the)\\s+)?(?<source>${dateExpression})(?:['’]s)?\\s+${scheduleExpression}\\s+${targetConnector}\\s+(?<targets>.+)$`,
    'iu'
  ),
  new RegExp(
    `\\b${actionExpression}\\s+(?:(?:my|the)\\s+)?${scheduleExpression}\\s+(?:from|of|for|on)\\s+(?<source>${dateExpression})\\s+${targetConnector}\\s+(?<targets>.+)$`,
    'iu'
  ),
  new RegExp(
    `\\b${actionExpression}\\s+(?:the\\s+)?same\\s+${scheduleExpression}\\s+(?:as|from)\\s+(?<source>${dateExpression})\\s+${targetConnector}\\s+(?<targets>.+)$`,
    'iu'
  ),
  new RegExp(
    `\\b(?:make|have|set)\\s+(?:(?:my|the)\\s+)?(?<source>${dateExpression})(?:['’]s)?\\s+${scheduleExpression}\\s+(?:(?:repeat|copy|recur|run)\\s+)?${targetConnector}\\s+(?<targets>.+)$`,
    'iu'
  ),
  new RegExp(
    `\\b(?:take\\s+)?(?<source>${dateExpression})(?:['’]s)?\\s+${scheduleExpression}\\s+(?:and\\s+)?${actionExpression}(?:\\s+it)?\\s+${targetConnector}\\s+(?<targets>.+)$`,
    'iu'
  ),
  new RegExp(
    `\\b${actionExpression}\\s+(?:everything|all\\s+(?:my\\s+)?(?:events|plans))\\s+(?:from|on)\\s+(?<source>${dateExpression})\\s+${targetConnector}\\s+(?<targets>.+)$`,
    'iu'
  ),
  new RegExp(
    `\\b(?:take|grab)\\s+(?:everything|all\\s+(?:my\\s+)?(?:events|plans))\\s+(?:from|on)\\s+(?<source>${dateExpression})\\s+(?:and\\s+)?${actionExpression}(?:\\s+(?:it|them))?\\s+${targetConnector}\\s+(?<targets>.+)$`,
    'iu'
  ),
  new RegExp(
    `\\b(?:use|treat)\\s+(?:(?:my|the)\\s+)?(?<source>${dateExpression})(?:['’]s)?(?:\\s+${scheduleExpression})?\\s+as\\s+(?:the\\s+)?(?:template|pattern|basis)\\s+(?:for|on)\\s+(?<targets>.+)$`,
    'iu'
  ),
  new RegExp(
    `\\bmake\\s+(?<targets>.+?)\\s+look\\s+like\\s+(?<source>${dateExpression})(?:['’]s)?(?:\\s+${scheduleExpression})?(?:\\s+(?<ending>(?:until|through|ending(?:\\s+on)?|up\\s+to)\\s+${dateExpression}|for\\s+(?:the\\s+)?(?:next\\s+)?\\d{1,2}\\s+weeks?|forever|indefinitely|ongoing))?[.!]*$`,
    'iu'
  ),
  new RegExp(
    `\\b(?:make|have)\\s+(?<targets>.+?)\\s+(?:the\\s+same\\s+as|match)\\s+(?<source>${dateExpression})(?:['’]s)?(?:\\s+${scheduleExpression})?(?:\\s+(?<ending>(?:until|through|ending(?:\\s+on)?|up\\s+to)\\s+${dateExpression}|for\\s+(?:the\\s+)?(?:next\\s+)?\\d{1,2}\\s+weeks?|forever|indefinitely|ongoing))?[.!]*$`,
    'iu'
  ),
  new RegExp(
    `\\b${actionExpression}\\s+(?:(?:my|the)\\s+)?(?<source>${dateExpression})(?:['’]s)?(?:\\s+day)?\\s+${targetConnector}\\s+(?<targets>.+)$`,
    'iu'
  )
]

const targetFillers = new Set([
  'and',
  'across',
  'day',
  'days',
  'each',
  'every',
  'for',
  'from',
  'my',
  'next',
  'on',
  'onto',
  'over',
  'please',
  'starting',
  'the',
  'this',
  'to',
  'week',
  'weekly'
])

export interface ScheduleReplicationIntent {
  kind: 'intent'
  sourceDate: string
  targetWeekdays: Weekday[]
  firstTargetDate: string
  recurrenceEnd: RecurrenceRule['end']
  usedDefaultEnd: boolean
}

export interface ScheduleReplicationClarification {
  kind: 'clarification'
  message: string
  options: string[]
}

export type ScheduleReplicationParseResult =
  ScheduleReplicationIntent | ScheduleReplicationClarification | null

function safeDate(year: number, month: number, day: number): Temporal.PlainDate | null {
  try {
    return Temporal.PlainDate.from({ year, month, day })
  } catch {
    return null
  }
}

function resolveDateExpression(value: string, localDate: string): Temporal.PlainDate | null {
  const normalized = value
    .trim()
    .toLocaleLowerCase()
    .replace(/^(?:the)\s+/u, '')
    .replace(/[,.!?]+$/u, '')
    .trim()
  const base = Temporal.PlainDate.from(localDate)
  if (normalized === 'today') return base
  if (normalized === 'tomorrow') return base.add({ days: 1 })
  if (normalized === 'yesterday') return base.subtract({ days: 1 })

  const weekdayMatch = /^(?:(last|this|next)\s+)?([a-z]+)$/u.exec(normalized)
  const weekday = weekdayMatch?.[2] ? sourceWeekdayAliases[weekdayMatch[2]] : null
  if (weekday) {
    const targetDay = weekdays.indexOf(weekday) + 1
    const relation = weekdayMatch?.[1] ?? 'this'
    if (relation === 'last') {
      const difference = (base.dayOfWeek - targetDay + 7) % 7
      return base.subtract({ days: difference === 0 ? 7 : difference })
    }
    if (relation === 'next') {
      const difference = (targetDay - base.dayOfWeek + 7) % 7
      return base.add({ days: difference === 0 ? 7 : difference })
    }
    const weekStart = base.subtract({ days: base.dayOfWeek - 1 })
    return weekStart.add({ days: targetDay - 1 })
  }

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/u.exec(normalized)
  if (iso?.[1] && iso[2] && iso[3]) {
    return safeDate(Number(iso[1]), Number(iso[2]), Number(iso[3]))
  }
  const numeric = /^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?$/u.exec(normalized)
  if (numeric?.[1] && numeric[2]) {
    const parsedYear = numeric[3] ? Number(numeric[3]) : base.year
    const year = parsedYear < 100 ? 2_000 + parsedYear : parsedYear
    return safeDate(year, Number(numeric[1]), Number(numeric[2]))
  }
  const named = new RegExp(
    `^(${monthExpression.slice(3, -1)})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?$`,
    'iu'
  ).exec(normalized)
  if (named?.[1] && named[2]) {
    const month = monthNumbers[named[1].toLocaleLowerCase()]
    if (!month) return null
    return safeDate(Number(named[3] ?? base.year), month, Number(named[2]))
  }
  return null
}

function firstMatchingDateAfter(sourceDate: Temporal.PlainDate, targets: readonly Weekday[]) {
  for (let offset = 1; offset <= 7; offset += 1) {
    const candidate = sourceDate.add({ days: offset })
    if (targets.includes(weekdays[candidate.dayOfWeek - 1] ?? 'monday')) return candidate
  }
  return sourceDate.add({ weeks: 1 })
}

function parseTargets(
  value: string
): { weekdays: Weekday[] } | { clarification: ScheduleReplicationClarification } {
  const normalized = value.toLocaleLowerCase().replace(/\./gu, ' ')
  const selected = new Set<Weekday>()
  if (/\b(?:weekday|weekdays|workday|workdays)\b/u.test(normalized)) {
    for (const weekday of weekdays.slice(0, 5)) selected.add(weekday)
  }
  if (/\b(?:weekend|weekends)\b/u.test(normalized)) {
    selected.add('saturday')
    selected.add('sunday')
  }
  if (/\b(?:daily|all\s+week|every\s+day)\b/u.test(normalized)) {
    for (const weekday of weekdays) selected.add(weekday)
  }

  const unknown: string[] = []
  for (const token of normalized.match(/[a-z]+/gu) ?? []) {
    if (
      targetFillers.has(token) ||
      [
        'weekday',
        'weekdays',
        'workday',
        'workdays',
        'weekend',
        'weekends',
        'daily',
        'all'
      ].includes(token)
    ) {
      continue
    }
    if (token === 't' || token === 's') {
      return {
        clarification: {
          kind: 'clarification',
          message: `“${token.toLocaleUpperCase()}” can mean more than one weekday. Which full day did you mean?`,
          options: token === 't' ? ['Tuesday', 'Thursday'] : ['Saturday', 'Sunday']
        }
      }
    }
    const compactWeekdays = compactWeekdayAliases[token]
    if (compactWeekdays) {
      for (const weekday of compactWeekdays) selected.add(weekday)
      continue
    }
    const weekday = weekdayAliases[token]
    if (weekday) selected.add(weekday)
    else unknown.push(token)
  }

  if (unknown.length > 0) {
    return {
      clarification: {
        kind: 'clarification',
        message: `I could not safely map ${unknown.map((token) => `“${token}”`).join(', ')} to target weekdays.`,
        options: ['Monday', 'Wednesday', 'Friday', 'Weekdays', 'Weekends']
      }
    }
  }
  const ordered = weekdays.filter((weekday) => selected.has(weekday))
  if (ordered.length === 0) {
    return {
      clarification: {
        kind: 'clarification',
        message: 'Which weekdays should receive the copied schedule?',
        options: ['Monday', 'Wednesday', 'Friday', 'Weekdays', 'Weekends']
      }
    }
  }
  return { weekdays: ordered }
}

export function parseScheduleReplicationRequest(
  text: string,
  localDate: string
): ScheduleReplicationParseResult {
  const source = text.trim()
  let extracted: { source: string; targets: string } | null = null
  for (const pattern of extractionPatterns) {
    const match = pattern.exec(source)
    if (match?.groups?.source && match.groups.targets) {
      extracted = {
        source: match.groups.source,
        targets: [match.groups.targets, match.groups.ending].filter(Boolean).join(' ')
      }
      break
    }
  }
  if (!extracted) return null

  const sourceDate = resolveDateExpression(extracted.source, localDate)
  if (!sourceDate) {
    return {
      kind: 'clarification',
      message: `I recognized a whole-day copy, but could not resolve the source day “${extracted.source}”.`,
      options: ['Today', 'Tomorrow', 'This Monday', 'Last Friday']
    }
  }

  let targetText = extracted.targets.trim().replace(/[.!?]+$/u, '')
  let recurrenceEnd: RecurrenceRule['end'] = {
    kind: 'until',
    date: sourceDate.add({ weeks: 8 }).toString()
  }
  let usedDefaultEnd = true

  if (/\b(?:forever|indefinitely|ongoing|without\s+an?\s+end)\b/iu.test(targetText)) {
    recurrenceEnd = { kind: 'never' }
    usedDefaultEnd = false
    targetText = targetText.replace(
      /\b(?:forever|indefinitely|ongoing|without\s+an?\s+end)\b/giu,
      ''
    )
  } else {
    const duration = /\bfor\s+(?:the\s+)?(?:next\s+)?(\d{1,2})\s+weeks?\b/iu.exec(targetText)
    if (duration?.[1]) {
      recurrenceEnd = {
        kind: 'until',
        date: sourceDate.add({ weeks: Number(duration[1]) }).toString()
      }
      usedDefaultEnd = false
      targetText = `${targetText.slice(0, duration.index)} ${targetText.slice(duration.index + duration[0].length)}`
    } else {
      const explicitEnd = new RegExp(
        `\\b(?:until|through|ending(?:\\s+on)?|up\\s+to)\\s+(${dateExpression})\\s*$`,
        'iu'
      ).exec(targetText)
      if (explicitEnd?.[1]) {
        const endDate = resolveDateExpression(explicitEnd[1], localDate)
        if (!endDate) {
          return {
            kind: 'clarification',
            message: `I could not resolve the repeat ending “${explicitEnd[1]}”.`,
            options: ['For 4 weeks', 'For 8 weeks', 'Forever']
          }
        }
        recurrenceEnd = { kind: 'until', date: endDate.toString() }
        usedDefaultEnd = false
        targetText = targetText.slice(0, explicitEnd.index)
      }
    }
  }

  const targets = parseTargets(targetText)
  if ('clarification' in targets) return targets.clarification
  const firstTargetDate = firstMatchingDateAfter(sourceDate, targets.weekdays)
  if (
    recurrenceEnd.kind === 'until' &&
    Temporal.PlainDate.compare(recurrenceEnd.date, firstTargetDate) < 0
  ) {
    return {
      kind: 'clarification',
      message:
        'The repeat would end before its first target weekday. What later ending should I use?',
      options: ['For 4 weeks', 'For 8 weeks', 'Forever']
    }
  }

  return {
    kind: 'intent',
    sourceDate: sourceDate.toString(),
    targetWeekdays: targets.weekdays,
    firstTargetDate: firstTargetDate.toString(),
    recurrenceEnd,
    usedDefaultEnd
  }
}
