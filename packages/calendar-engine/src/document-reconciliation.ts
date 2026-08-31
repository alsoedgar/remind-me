import { Temporal } from '@js-temporal/polyfill'
import {
  documentImportIdentitySchema,
  documentReconciliationSchema,
  type DocumentImportCourseIdentity,
  type DocumentImportIdentity,
  type DocumentImportSourceIdentity,
  type DocumentReconciliation,
  type DocumentReconciliationMatch,
  type DocumentScheduleComponent,
  type DocumentScheduleMetadata,
  type EventEntity,
  type EventForm,
  type ReminderEntity,
  type ReminderForm,
  type Weekday
} from '@remind-me/contracts'

const componentFromLabel = new Map<string, DocumentScheduleComponent>([
  ['lecture', 'lecture'],
  ['lecture discussion', 'lecture-discussion'],
  ['laboratory', 'laboratory'],
  ['laboratory discussion', 'laboratory-discussion'],
  ['discussion', 'discussion'],
  ['seminar', 'seminar'],
  ['studio', 'studio'],
  ['clinical', 'clinical'],
  ['practicum', 'practicum'],
  ['primary section', 'primary-section'],
  ['linked section', 'linked-section'],
  ['class meeting', 'class-meeting']
])

function hash64(value: string): string {
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index))
    hash = BigInt.asUintN(64, hash * prime)
  }
  return hash.toString(16).padStart(16, '0')
}

export function canonicalDocumentText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/&/gu, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .toLocaleLowerCase()
    .replace(/\s+/gu, ' ')
}

export function canonicalDocumentLocation(value: string): string {
  return canonicalDocumentText(value)
    .replace(/\bscience and engineering south\b/gu, 'ses')
    .replace(/\bcomputer design research and learning (?:center|centre)\b/gu, 'cdrl')
    .replace(/\bresearch and learning (?:center|centre)\b/gu, 'rlc')
    .replace(/\b(?:location|building|bldg|room|rm|suite|floor)\b/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

export function documentSourceRowId(canonicalSourceRow: string): string {
  return `row:${hash64(canonicalSourceRow)}`
}

function semanticKey(prefix: 'class' | 'event' | 'reminder', parts: readonly string[]): string {
  return `${prefix}:${hash64(parts.join('\u0000'))}`
}

function sortedWeekdays(weekdays: readonly Weekday[]): Weekday[] {
  const order: readonly Weekday[] = [
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
    'saturday',
    'sunday'
  ]
  return [...new Set(weekdays)].sort((left, right) => order.indexOf(left) - order.indexOf(right))
}

function courseIdentity(
  schedule: DocumentScheduleMetadata,
  form: EventForm
): DocumentImportCourseIdentity {
  const weekly = form.recurrence?.frequency === 'weekly' ? form.recurrence : null
  return {
    courseCode: schedule.courseCode,
    sectionCode: schedule.sectionCode,
    crn: schedule.crn,
    component: schedule.component,
    termStartDate: schedule.termStartDate,
    termEndDate: weekly?.end.kind === 'until' ? weekly.end.date : schedule.termEndDate,
    weekdays: sortedWeekdays(weekly?.byWeekday ?? schedule.weekdays)
  }
}

function classSemanticKey(course: DocumentImportCourseIdentity, form: EventForm): string {
  return semanticKey('class', [
    canonicalDocumentText(course.courseCode),
    canonicalDocumentText(course.sectionCode ?? ''),
    canonicalDocumentText(course.crn ?? ''),
    course.component,
    course.weekdays.join(','),
    form.startTime ?? 'all-day',
    form.endTime ?? 'all-day',
    course.termStartDate,
    course.termEndDate,
    form.timezone
  ])
}

function generalEventSemanticKey(form: EventForm): string {
  return semanticKey('event', [
    canonicalDocumentText(form.title),
    form.startDate,
    form.startTime ?? 'all-day',
    form.endDate,
    form.endTime ?? 'all-day',
    form.timezone,
    canonicalDocumentLocation(form.location)
  ])
}

function reminderSemanticKey(form: ReminderForm): string {
  return semanticKey('reminder', [
    canonicalDocumentText(form.title),
    form.dueDate ?? 'undated',
    form.dueTime ?? 'untimed',
    form.timezone
  ])
}

export function createEventDocumentImportIdentity(
  source: DocumentImportSourceIdentity,
  form: EventForm,
  schedule: DocumentScheduleMetadata | null
): DocumentImportIdentity {
  const course = schedule ? courseIdentity(schedule, form) : null
  return documentImportIdentitySchema.parse({
    ...source,
    semanticKind: course ? 'class-event' : 'event',
    semanticKey: course ? classSemanticKey(course, form) : generalEventSemanticKey(form),
    course
  })
}

export function createReminderDocumentImportIdentity(
  source: DocumentImportSourceIdentity,
  form: ReminderForm
): DocumentImportIdentity {
  return documentImportIdentitySchema.parse({
    ...source,
    semanticKind: 'reminder',
    semanticKey: reminderSemanticKey(form),
    course: null
  })
}

export function refreshEventDocumentImportIdentity(
  identity: DocumentImportIdentity,
  form: EventForm
): DocumentImportIdentity {
  if (!identity.course) {
    return documentImportIdentitySchema.parse({
      ...identity,
      semanticKind: 'event',
      semanticKey: generalEventSemanticKey(form),
      course: null
    })
  }
  const course = {
    ...identity.course,
    weekdays:
      form.recurrence?.frequency === 'weekly'
        ? sortedWeekdays(form.recurrence.byWeekday)
        : identity.course.weekdays,
    termEndDate:
      form.recurrence?.end.kind === 'until' ? form.recurrence.end.date : identity.course.termEndDate
  }
  return documentImportIdentitySchema.parse({
    ...identity,
    semanticKind: 'class-event',
    semanticKey: classSemanticKey(course, form),
    course
  })
}

export function refreshReminderDocumentImportIdentity(
  identity: DocumentImportIdentity,
  form: ReminderForm
): DocumentImportIdentity {
  return documentImportIdentitySchema.parse({
    ...identity,
    semanticKind: 'reminder',
    semanticKey: reminderSemanticKey(form),
    course: null
  })
}

function localParts(instant: string, timezone: string): { date: string; time: string } {
  const zoned = Temporal.Instant.from(instant).toZonedDateTimeISO(timezone)
  return {
    date: zoned.toPlainDate().toString(),
    time: zoned.toPlainTime().toString({ smallestUnit: 'minute' })
  }
}

function eventFormFromEntity(event: EventEntity): EventForm {
  const start = localParts(event.startUtc, event.timezone)
  const inclusiveEndInstant = event.allDay
    ? Temporal.Instant.from(event.endUtc).subtract({ nanoseconds: 1 }).toString()
    : event.endUtc
  const end = localParts(inclusiveEndInstant, event.timezone)
  return {
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
  }
}

function reminderFormFromEntity(reminder: ReminderEntity): ReminderForm {
  const due = reminder.dueAtUtc ? localParts(reminder.dueAtUtc, reminder.timezone) : null
  return {
    id: null,
    calendarId: reminder.calendarId,
    title: reminder.title,
    notes: reminder.notes,
    dueDate: due?.date ?? null,
    dueTime: due?.time ?? null,
    timezone: reminder.timezone,
    recurrence: reminder.recurrence
  }
}

function inferredCourseIdentity(event: EventEntity): DocumentImportCourseIdentity | null {
  if (event.importIdentity?.course) return event.importIdentity.course
  if (event.provenance !== 'import' || !/\bCourse:\s*/iu.test(event.description)) return null
  const parts = event.description.split(/\s*·\s*/u).map((part) => part.trim())
  const valueAfter = (label: string): string | null => {
    const part = parts.find((candidate) =>
      candidate.toLocaleLowerCase().startsWith(`${label.toLocaleLowerCase()}:`)
    )
    return part?.slice(part.indexOf(':') + 1).trim() || null
  }
  const courseCode = valueAfter('Course')
  if (!courseCode) return null
  const component = parts
    .map((part) => componentFromLabel.get(canonicalDocumentText(part)))
    .find((candidate): candidate is DocumentScheduleComponent => Boolean(candidate))
  const form = eventFormFromEntity(event)
  const weekdays =
    form.recurrence?.frequency === 'weekly' && form.recurrence.byWeekday.length > 0
      ? sortedWeekdays(form.recurrence.byWeekday)
      : []
  if (!component || weekdays.length === 0) return null
  return {
    courseCode,
    sectionCode: valueAfter('Section'),
    crn: valueAfter('CRN'),
    component,
    termStartDate: form.startDate,
    termEndDate: form.recurrence?.end.kind === 'until' ? form.recurrence.end.date : form.endDate,
    weekdays
  }
}

function tokenSimilarity(left: string, right: string): number {
  const leftTokens = new Set(canonicalDocumentText(left).split(' ').filter(Boolean))
  const rightTokens = new Set(canonicalDocumentText(right).split(' ').filter(Boolean))
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length
  const union = new Set([...leftTokens, ...rightTokens]).size
  return intersection / union
}

function compactEditSimilarity(left: string, right: string): number {
  const leftText = canonicalDocumentText(left).replace(/\s+/gu, '').slice(0, 160)
  const rightText = canonicalDocumentText(right).replace(/\s+/gu, '').slice(0, 160)
  if (leftText === rightText) return leftText ? 1 : 0
  if (!leftText || !rightText) return 0
  let previous = Array.from({ length: rightText.length + 1 }, (_, index) => index)
  for (let leftIndex = 1; leftIndex <= leftText.length; leftIndex += 1) {
    const current = [leftIndex]
    for (let rightIndex = 1; rightIndex <= rightText.length; rightIndex += 1) {
      const substitutionCost = leftText[leftIndex - 1] === rightText[rightIndex - 1] ? 0 : 1
      current[rightIndex] = Math.min(
        (current[rightIndex - 1] ?? 0) + 1,
        (previous[rightIndex] ?? 0) + 1,
        (previous[rightIndex - 1] ?? 0) + substitutionCost
      )
    }
    previous = current
  }
  const distance = previous[rightText.length] ?? Math.max(leftText.length, rightText.length)
  return 1 - distance / Math.max(leftText.length, rightText.length)
}

function documentTextSimilarity(left: string, right: string): number {
  return Math.max(tokenSimilarity(left, right), compactEditSimilarity(left, right))
}

function locationsAreCompatible(left: string, right: string): boolean {
  const leftLocation = canonicalDocumentLocation(left)
  const rightLocation = canonicalDocumentLocation(right)
  if (!leftLocation || !rightLocation || leftLocation === rightLocation) return true
  const leftTokens = new Set(leftLocation.split(' ').filter(Boolean))
  const rightTokens = new Set(rightLocation.split(' ').filter(Boolean))
  const [smaller, larger] =
    leftTokens.size <= rightTokens.size ? [leftTokens, rightTokens] : [rightTokens, leftTokens]
  return [...smaller].every((token) => larger.has(token))
}

function sameSource(
  candidate: DocumentImportIdentity,
  existing: DocumentImportIdentity | null | undefined
): boolean {
  return Boolean(
    existing &&
    candidate.sourceSha256 === existing.sourceSha256 &&
    candidate.sourceRowId === existing.sourceRowId
  )
}

function courseConflict(
  candidate: DocumentImportCourseIdentity,
  existing: DocumentImportCourseIdentity
): boolean {
  return (
    (candidate.crn !== null && existing.crn !== null && candidate.crn !== existing.crn) ||
    (candidate.sectionCode !== null &&
      existing.sectionCode !== null &&
      canonicalDocumentText(candidate.sectionCode) !==
        canonicalDocumentText(existing.sectionCode)) ||
    candidate.component !== existing.component
  )
}

function courseOverlap(
  candidate: DocumentImportCourseIdentity,
  existing: DocumentImportCourseIdentity,
  candidateForm: EventForm,
  existingForm: EventForm
): boolean {
  const sameCourse =
    canonicalDocumentText(candidate.courseCode) === canonicalDocumentText(existing.courseCode)
  const sameTime =
    candidateForm.startTime === existingForm.startTime &&
    candidateForm.endTime === existingForm.endTime
  const weekdayOverlap = candidate.weekdays.some((weekday) => existing.weekdays.includes(weekday))
  const termOverlap = courseTermsOverlap(candidate, existing)
  return sameCourse && sameTime && weekdayOverlap && termOverlap
}

function courseTermsOverlap(
  candidate: DocumentImportCourseIdentity,
  existing: DocumentImportCourseIdentity
): boolean {
  return (
    candidate.termStartDate <= existing.termEndDate &&
    existing.termStartDate <= candidate.termEndDate
  )
}

function sameCourseRegistration(
  candidate: DocumentImportCourseIdentity,
  existing: DocumentImportCourseIdentity
): boolean {
  if (
    canonicalDocumentText(candidate.courseCode) !== canonicalDocumentText(existing.courseCode) ||
    courseConflict(candidate, existing) ||
    !courseTermsOverlap(candidate, existing)
  ) {
    return false
  }
  const sameCrn = candidate.crn !== null && existing.crn !== null && candidate.crn === existing.crn
  const sameSection =
    candidate.sectionCode !== null &&
    existing.sectionCode !== null &&
    canonicalDocumentText(candidate.sectionCode) === canonicalDocumentText(existing.sectionCode)
  return sameCrn || sameSection
}

function eventDetail(form: EventForm): string {
  const time = form.allDay ? 'all day' : `${form.startTime ?? '—'}–${form.endTime ?? '—'}`
  return `${form.startDate} · ${time}${form.location ? ` · ${form.location}` : ''}`
}

function reminderDetail(form: ReminderForm): string {
  return `${form.dueDate} · ${form.dueTime}`
}

function eventMatch(
  event: EventEntity,
  relationship: DocumentReconciliationMatch['relationship']
): DocumentReconciliationMatch {
  return {
    entityKind: 'event',
    entityId: event.id,
    title: event.title,
    detail: eventDetail(eventFormFromEntity(event)),
    relationship
  }
}

function reminderMatch(
  reminder: ReminderEntity,
  relationship: DocumentReconciliationMatch['relationship']
): DocumentReconciliationMatch {
  return {
    entityKind: 'reminder',
    entityId: reminder.id,
    title: reminder.title,
    detail: reminderDetail(reminderFormFromEntity(reminder)),
    relationship
  }
}

function reconciliationFromMatches(
  matches: readonly DocumentReconciliationMatch[]
): DocumentReconciliation {
  const priority: Record<DocumentReconciliationMatch['relationship'], number> = {
    'same-source-row': 0,
    'same-semantic-item': 1,
    'likely-semantic-overlap': 2,
    'protected-distinct-course': 3
  }
  const limited = [...matches]
    .sort((left, right) => priority[left.relationship] - priority[right.relationship])
    .slice(0, 5)
  const relationships = new Set(limited.map((match) => match.relationship))
  const state = relationships.has('same-source-row')
    ? 'same-source'
    : relationships.has('same-semantic-item') || relationships.has('likely-semantic-overlap')
      ? 'likely-duplicate'
      : relationships.has('protected-distinct-course')
        ? 'protected-distinct'
        : 'new'
  return documentReconciliationSchema.parse({
    state,
    recommendedSelected: state === 'new' || state === 'protected-distinct',
    matches: limited
  })
}

export function reconcileDocumentEvent(
  candidateIdentity: DocumentImportIdentity,
  candidateForm: EventForm,
  events: readonly EventEntity[],
  reminders: readonly ReminderEntity[] = []
): DocumentReconciliation {
  const matches: DocumentReconciliationMatch[] = []
  for (const reminder of reminders) {
    if (sameSource(candidateIdentity, reminder.importIdentity)) {
      matches.push(reminderMatch(reminder, 'same-source-row'))
    }
  }
  for (const event of events) {
    if (sameSource(candidateIdentity, event.importIdentity)) {
      matches.push(eventMatch(event, 'same-source-row'))
      continue
    }
    if (event.status !== 'active') continue
    if (candidateIdentity.semanticKey === event.importIdentity?.semanticKey) {
      matches.push(eventMatch(event, 'same-semantic-item'))
      continue
    }
    const existingForm = eventFormFromEntity(event)
    if (candidateIdentity.course) {
      const existingCourse = inferredCourseIdentity(event)
      if (!existingCourse) continue
      if (sameCourseRegistration(candidateIdentity.course, existingCourse)) {
        matches.push(eventMatch(event, 'likely-semantic-overlap'))
        continue
      }
      if (!courseOverlap(candidateIdentity.course, existingCourse, candidateForm, existingForm)) {
        continue
      }
      matches.push(
        eventMatch(
          event,
          courseConflict(candidateIdentity.course, existingCourse)
            ? 'protected-distinct-course'
            : 'likely-semantic-overlap'
        )
      )
      continue
    }
    if (inferredCourseIdentity(event)) continue
    const sameWindow =
      candidateForm.startDate === existingForm.startDate &&
      candidateForm.startTime === existingForm.startTime &&
      candidateForm.endDate === existingForm.endDate &&
      candidateForm.endTime === existingForm.endTime
    const titleSimilarity = documentTextSimilarity(candidateForm.title, existingForm.title)
    if (
      sameWindow &&
      titleSimilarity >= 0.72 &&
      locationsAreCompatible(candidateForm.location, existingForm.location)
    ) {
      matches.push(eventMatch(event, 'likely-semantic-overlap'))
    }
  }
  return reconciliationFromMatches(matches)
}

export function reconcileDocumentReminder(
  candidateIdentity: DocumentImportIdentity,
  candidateForm: ReminderForm,
  reminders: readonly ReminderEntity[],
  events: readonly EventEntity[] = []
): DocumentReconciliation {
  const matches: DocumentReconciliationMatch[] = []
  for (const event of events) {
    if (sameSource(candidateIdentity, event.importIdentity)) {
      matches.push(eventMatch(event, 'same-source-row'))
    }
  }
  for (const reminder of reminders) {
    if (sameSource(candidateIdentity, reminder.importIdentity)) {
      matches.push(reminderMatch(reminder, 'same-source-row'))
      continue
    }
    if (reminder.status !== 'active') continue
    if (candidateIdentity.semanticKey === reminder.importIdentity?.semanticKey) {
      matches.push(reminderMatch(reminder, 'same-semantic-item'))
      continue
    }
    const existingForm = reminderFormFromEntity(reminder)
    const sameDue =
      candidateForm.dueDate === existingForm.dueDate &&
      candidateForm.dueTime === existingForm.dueTime
    if (sameDue && documentTextSimilarity(candidateForm.title, existingForm.title) >= 0.72) {
      matches.push(reminderMatch(reminder, 'likely-semantic-overlap'))
    }
  }
  return reconciliationFromMatches(matches)
}
