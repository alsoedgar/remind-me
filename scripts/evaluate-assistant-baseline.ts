import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { Temporal } from '@js-temporal/polyfill'
import type {
  AssistantExchange,
  AssistantProposalPayload,
  CalendarSnapshot,
  CalendarSnapshotRequest,
  EventForm,
  RecurrenceRule,
  ReminderForm
} from '@remind-me/contracts'
import {
  loadModelManifest,
  RemindCorePlanner,
  RemindSpeakPlanner,
  verifyModelManifest
} from '@remind-me/model-runtime'
import {
  PersistentAssistantService,
  PersistentCalendarService,
  SqliteCalendarRepository,
  type AssistantExecutionTrace
} from '@remind-me/storage'
import { z } from 'zod'
import {
  assistantEvaluationScenarioSchema,
  assistantSuiteManifestSchema,
  type AssistantEvaluationScenario as Scenario,
  type AssistantStateExpectation as StateExpectation,
  type AssistantSuiteManifest,
  type AssistantTurnExpectation as TurnExpectation
} from './assistant-evaluation-contract'
import {
  auditLanguageSeparation,
  humanBlindScenarioQualityIssues,
  loadContaminationSources,
  phase8HumanBlindPolicy
} from './assistant-human-blind'

const componentBaselinesSchema = z.object({
  remindCore: z
    .object({
      metrics: z
        .object({
          operationAccuracy: z.number(),
          ambiguityRecall: z.number(),
          eligibleAssistedPrecision: z.number(),
          eligibleAssistedCoverage: z.number(),
          warmLatencyMs: z.object({ p95: z.number() }).passthrough()
        })
        .passthrough()
    })
    .passthrough(),
  remindSpeak: z
    .object({
      metrics: z
        .object({
          protectedFactRetention: z.number(),
          referenceInTopFiveRate: z.number(),
          recentExactRepeatRate: z.number(),
          latencyMs: z.object({ p95: z.number() }).passthrough()
        })
        .passthrough()
    })
    .passthrough()
})

type Mode = 'rules-only' | 'native-hybrid'

interface AssertionResult {
  name: string
  passed: boolean
  expected: unknown
  actual: unknown
}

interface TurnResult {
  index: number
  text: string
  responseKind: AssistantExchange['response']['kind']
  responseText: string
  latencyMs: number
  executionTrace: AssistantExecutionTrace | null
  answered: boolean
  safePreview: boolean | null
  passed: boolean
  assertions: AssertionResult[]
}

interface ScenarioResult {
  id: string
  category: Scenario['category']
  source: Scenario['source']
  tags: string[]
  inDomain: boolean
  passed: boolean
  turns: TurnResult[]
}

interface ModeResult {
  mode: Mode
  scenarioResults: ScenarioResult[]
  metrics: ReturnType<typeof summarizeMode>
}

interface SeededScenarioIds {
  eventIds: string[]
  reminderIds: string[]
}

const workspace = process.cwd()
const defaultSuitePath = resolve(workspace, 'evals/assistant/v0.1/scenarios.jsonl')
const defaultManifestPath = resolve(workspace, 'evals/assistant/v0.1/manifest.json')
const reportDirectory = resolve(workspace, 'evals/assistant/reports')
const modelRoot = resolve(workspace, 'models')
const timezone = 'America/Chicago'

function option(name: string): string | null {
  const prefix = `--${name}=`
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) ?? null
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

function normalized(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[‘’]/gu, "'")
    .replace(/\s+/gu, ' ')
    .trim()
}

function nextWeekday(base: Temporal.PlainDate, weekday: string): Temporal.PlainDate {
  const names = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
  const target = names.indexOf(weekday) + 1
  if (target === 0) throw new Error(`Unknown weekday: ${weekday}`)
  const difference = (target - base.dayOfWeek + 7) % 7
  return base.add({ days: difference === 0 ? 7 : difference })
}

function dateFromSpec(spec: string, today: Temporal.PlainDate): string {
  if (spec === 'today') return today.toString()
  if (spec === 'tomorrow') return today.add({ days: 1 }).toString()
  if (spec === 'yesterday') return today.subtract({ days: 1 }).toString()
  const relative = /^([+-])(\d+)d$/u.exec(spec)
  if (relative?.[1] && relative[2]) {
    const days = Number(relative[2]) * (relative[1] === '-' ? -1 : 1)
    return today.add({ days }).toString()
  }
  if (spec.startsWith('this:')) {
    const weekStart = today.subtract({ days: today.dayOfWeek - 1 })
    const weekday = spec.slice(5)
    const names = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
    const offset = names.indexOf(weekday)
    if (offset < 0) throw new Error(`Unknown weekday: ${weekday}`)
    return weekStart.add({ days: offset }).toString()
  }
  if (spec.startsWith('next:')) return nextWeekday(today, spec.slice(5)).toString()
  return Temporal.PlainDate.from(spec).toString()
}

function recurrenceFromFixture(
  input: Scenario['world']['events'][number]['recurrence'],
  today: Temporal.PlainDate
): RecurrenceRule | null {
  if (!input) return null
  return {
    ...input,
    end:
      input.end.kind === 'until'
        ? { kind: 'until', date: dateFromSpec(input.end.date, today) }
        : input.end
  }
}

function snapshotSignature(snapshot: CalendarSnapshot): string {
  return JSON.stringify({
    events: snapshot.events.map((event) => [
      event.id,
      event.title,
      event.startUtc,
      event.updatedAt
    ]),
    reminders: snapshot.reminders.map((reminder) => [
      reminder.id,
      reminder.title,
      reminder.dueAtUtc,
      reminder.status,
      reminder.updatedAt
    ])
  })
}

function assertResult(
  results: AssertionResult[],
  name: string,
  passed: boolean,
  expected: unknown,
  actual: unknown
): void {
  results.push({ name, passed, expected, actual })
}

function includesAll(actual: readonly string[], expected: readonly string[]): boolean {
  const normalizedActual = actual.map(normalized)
  return expected.every((value) =>
    normalizedActual.some((candidate) => candidate.includes(normalized(value)))
  )
}

function proposalItems(
  payload: AssistantProposalPayload | null
): Array<Exclude<AssistantProposalPayload, { kind: 'batch' } | { kind: 'bulk-delete' }>> {
  if (!payload) return []
  if (payload.kind === 'batch') return payload.items
  if (payload.kind === 'bulk-delete') return []
  return [payload]
}

function proposalTitles(
  payload: AssistantProposalPayload | null,
  before: CalendarSnapshot
): string[] {
  return proposalItems(payload).flatMap((item) => {
    if (item.kind === 'event-save' || item.kind === 'reminder-save') return [item.form.title]
    if (item.kind === 'event-delete') {
      const event = before.events.find((candidate) => candidate.id === item.id)
      return event ? [event.title] : []
    }
    if (item.kind === 'reminder-delete' || item.kind === 'reminder-complete') {
      const reminder = before.reminders.find((candidate) => candidate.id === item.id)
      return reminder ? [reminder.title] : []
    }
    return []
  })
}

function proposalDates(payload: AssistantProposalPayload | null): string[] {
  return proposalItems(payload).flatMap((item) => {
    if (item.kind === 'event-save') return [item.form.startDate]
    if (item.kind === 'reminder-save' && item.form.dueDate) return [item.form.dueDate]
    return []
  })
}

function proposalTimes(payload: AssistantProposalPayload | null): string[] {
  return proposalItems(payload).flatMap((item) => {
    if (item.kind === 'event-save') return item.form.startTime ? [item.form.startTime] : []
    if (item.kind === 'reminder-save' && item.form.dueTime) return [item.form.dueTime]
    return []
  })
}

function proposalEndDates(payload: AssistantProposalPayload | null): string[] {
  return proposalItems(payload).flatMap((item) =>
    item.kind === 'event-save' ? [item.form.endDate] : []
  )
}

function proposalEndTimes(payload: AssistantProposalPayload | null): string[] {
  return proposalItems(payload).flatMap((item) =>
    item.kind === 'event-save' && item.form.endTime ? [item.form.endTime] : []
  )
}

function proposalLocations(payload: AssistantProposalPayload | null): string[] {
  return proposalItems(payload).flatMap((item) =>
    item.kind === 'event-save' ? [item.form.location] : []
  )
}

function proposalDetails(payload: AssistantProposalPayload | null): string[] {
  return proposalItems(payload).flatMap((item) => {
    if (item.kind === 'event-save') return [item.form.description]
    if (item.kind === 'reminder-save') return [item.form.notes]
    return []
  })
}

function proposalWeekdays(payload: AssistantProposalPayload | null): string[] {
  return proposalItems(payload).flatMap((item) => {
    if (item.kind !== 'event-save' && item.kind !== 'reminder-save') return []
    return item.form.recurrence?.byWeekday ?? []
  })
}

function proposalFrequencies(payload: AssistantProposalPayload | null): string[] {
  return proposalItems(payload).flatMap((item) => {
    if (item.kind !== 'event-save' && item.kind !== 'reminder-save') return []
    return item.form.recurrence ? [item.form.recurrence.frequency] : []
  })
}

function evaluateState(
  assertions: AssertionResult[],
  prefix: string,
  snapshot: CalendarSnapshot,
  expectation: StateExpectation
): void {
  const eventTitles = snapshot.events.map((event) => event.title)
  const reminderTitles = snapshot.reminders.map((reminder) => reminder.title)
  if (expectation.eventCount !== undefined) {
    assertResult(
      assertions,
      `${prefix}.eventCount`,
      snapshot.events.length === expectation.eventCount,
      expectation.eventCount,
      snapshot.events.length
    )
  }
  if (expectation.reminderCount !== undefined) {
    assertResult(
      assertions,
      `${prefix}.reminderCount`,
      snapshot.reminders.length === expectation.reminderCount,
      expectation.reminderCount,
      snapshot.reminders.length
    )
  }
  if (expectation.eventTitlesAll) {
    assertResult(
      assertions,
      `${prefix}.eventTitlesAll`,
      includesAll(eventTitles, expectation.eventTitlesAll),
      expectation.eventTitlesAll,
      eventTitles
    )
  }
  if (expectation.eventTitlesNone) {
    assertResult(
      assertions,
      `${prefix}.eventTitlesNone`,
      !expectation.eventTitlesNone.some((value) => includesAll(eventTitles, [value])),
      expectation.eventTitlesNone,
      eventTitles
    )
  }
  if (expectation.reminderTitlesAll) {
    assertResult(
      assertions,
      `${prefix}.reminderTitlesAll`,
      includesAll(reminderTitles, expectation.reminderTitlesAll),
      expectation.reminderTitlesAll,
      reminderTitles
    )
  }
  if (expectation.reminderTitlesNone) {
    assertResult(
      assertions,
      `${prefix}.reminderTitlesNone`,
      !expectation.reminderTitlesNone.some((value) => includesAll(reminderTitles, [value])),
      expectation.reminderTitlesNone,
      reminderTitles
    )
  }
}

function evaluateTurn(
  exchange: AssistantExchange,
  before: CalendarSnapshot,
  expectation: TurnExpectation,
  previousProposalId: string | null,
  today: Temporal.PlainDate,
  seededIds: SeededScenarioIds
): AssertionResult[] {
  const assertions: AssertionResult[] = []
  const responseText = normalized(exchange.response.text)
  const proposal = exchange.conversation.activeProposal
  const payload = proposal?.payload ?? null
  const calendarUnchanged = snapshotSignature(before) === snapshotSignature(exchange.snapshot)
  const proposalTransition =
    previousProposalId === null && proposal
      ? 'created'
      : previousProposalId !== null && proposal?.id === previousProposalId
        ? 'same'
        : previousProposalId !== null && proposal
          ? 'replaced'
          : previousProposalId !== null
            ? 'cleared'
            : 'none'

  assertResult(
    assertions,
    'response.kind',
    expectation.responseKinds.includes(exchange.response.kind),
    expectation.responseKinds,
    exchange.response.kind
  )
  if (expectation.textAll) {
    assertResult(
      assertions,
      'response.textAll',
      expectation.textAll.every((value) => responseText.includes(normalized(value))),
      expectation.textAll,
      exchange.response.text
    )
  }
  if (expectation.textAny) {
    assertResult(
      assertions,
      'response.textAny',
      expectation.textAny.some((value) => responseText.includes(normalized(value))),
      expectation.textAny,
      exchange.response.text
    )
  }
  if (expectation.textNone) {
    assertResult(
      assertions,
      'response.textNone',
      expectation.textNone.every((value) => !responseText.includes(normalized(value))),
      expectation.textNone,
      exchange.response.text
    )
  }
  if (expectation.maxWords !== undefined) {
    const words = exchange.response.text.trim().split(/\s+/u).filter(Boolean).length
    assertResult(
      assertions,
      'response.maxWords',
      words <= expectation.maxWords,
      expectation.maxWords,
      words
    )
  }
  if (expectation.relatedEventMin !== undefined) {
    assertResult(
      assertions,
      'response.relatedEventMin',
      exchange.response.relatedEventIds.length >= expectation.relatedEventMin,
      expectation.relatedEventMin,
      exchange.response.relatedEventIds.length
    )
  }
  if (expectation.relatedReminderMin !== undefined) {
    assertResult(
      assertions,
      'response.relatedReminderMin',
      exchange.response.relatedReminderIds.length >= expectation.relatedReminderMin,
      expectation.relatedReminderMin,
      exchange.response.relatedReminderIds.length
    )
  }
  if (expectation.relatedEventSeedIndexesExact) {
    const expectedIds = expectation.relatedEventSeedIndexesExact.map(
      (index) => seededIds.eventIds[index] ?? `missing-event-seed:${index}`
    )
    assertResult(
      assertions,
      'response.relatedEventIdsExact',
      JSON.stringify(exchange.response.relatedEventIds) === JSON.stringify(expectedIds),
      expectedIds,
      exchange.response.relatedEventIds
    )
  }
  if (expectation.relatedReminderSeedIndexesExact) {
    const expectedIds = expectation.relatedReminderSeedIndexesExact.map(
      (index) => seededIds.reminderIds[index] ?? `missing-reminder-seed:${index}`
    )
    assertResult(
      assertions,
      'response.relatedReminderIdsExact',
      JSON.stringify(exchange.response.relatedReminderIds) === JSON.stringify(expectedIds),
      expectedIds,
      exchange.response.relatedReminderIds
    )
  }
  if (expectation.proposalKind) {
    assertResult(
      assertions,
      'proposal.kind',
      payload?.kind === expectation.proposalKind,
      expectation.proposalKind,
      payload?.kind ?? null
    )
  }
  if (expectation.proposalOperation) {
    assertResult(
      assertions,
      'proposal.operation',
      proposal?.operation === expectation.proposalOperation,
      expectation.proposalOperation,
      proposal?.operation ?? null
    )
  }
  if (expectation.proposalItemCount !== undefined) {
    const count = payload?.kind === 'batch' ? payload.items.length : payload ? 1 : 0
    assertResult(
      assertions,
      'proposal.itemCount',
      count === expectation.proposalItemCount,
      expectation.proposalItemCount,
      count
    )
  }
  if (expectation.proposalItemKinds) {
    const kinds = proposalItems(payload).map((item) => item.kind)
    assertResult(
      assertions,
      'proposal.itemKinds',
      includesAll(kinds, expectation.proposalItemKinds),
      expectation.proposalItemKinds,
      kinds
    )
  }
  if (expectation.proposalTitlesAll) {
    const titles = proposalTitles(payload, before)
    assertResult(
      assertions,
      'proposal.titlesAll',
      includesAll(titles, expectation.proposalTitlesAll),
      expectation.proposalTitlesAll,
      titles
    )
  }
  if (expectation.proposalDatesAll) {
    const dates = proposalDates(payload)
    const expectedDates = expectation.proposalDatesAll.map((date) => dateFromSpec(date, today))
    assertResult(
      assertions,
      'proposal.datesAll',
      includesAll(dates, expectedDates),
      expectedDates,
      dates
    )
  }
  if (expectation.proposalTimesAll) {
    const times = proposalTimes(payload)
    assertResult(
      assertions,
      'proposal.timesAll',
      includesAll(times, expectation.proposalTimesAll),
      expectation.proposalTimesAll,
      times
    )
  }
  if (expectation.proposalEndDatesAll) {
    const dates = proposalEndDates(payload)
    const expectedDates = expectation.proposalEndDatesAll.map((date) => dateFromSpec(date, today))
    assertResult(
      assertions,
      'proposal.endDatesAll',
      includesAll(dates, expectedDates),
      expectedDates,
      dates
    )
  }
  if (expectation.proposalEndTimesAll) {
    const times = proposalEndTimes(payload)
    assertResult(
      assertions,
      'proposal.endTimesAll',
      includesAll(times, expectation.proposalEndTimesAll),
      expectation.proposalEndTimesAll,
      times
    )
  }
  if (expectation.proposalLocationsAll) {
    const locations = proposalLocations(payload)
    assertResult(
      assertions,
      'proposal.locationsAll',
      includesAll(locations, expectation.proposalLocationsAll),
      expectation.proposalLocationsAll,
      locations
    )
  }
  if (expectation.proposalDetailsAll) {
    const details = proposalDetails(payload)
    assertResult(
      assertions,
      'proposal.detailsAll',
      includesAll(details, expectation.proposalDetailsAll),
      expectation.proposalDetailsAll,
      details
    )
  }
  if (expectation.proposalWeekdaysAll) {
    const weekdays = proposalWeekdays(payload)
    assertResult(
      assertions,
      'proposal.weekdaysAll',
      expectation.proposalWeekdaysAll.every((value) => weekdays.includes(value)),
      expectation.proposalWeekdaysAll,
      weekdays
    )
  }
  if (expectation.proposalFrequenciesAll) {
    const frequencies = proposalFrequencies(payload)
    assertResult(
      assertions,
      'proposal.frequenciesAll',
      expectation.proposalFrequenciesAll.every((value) => frequencies.includes(value)),
      expectation.proposalFrequenciesAll,
      frequencies
    )
  }
  if (expectation.calendarState) {
    const actual = calendarUnchanged ? 'unchanged' : 'changed'
    assertResult(
      assertions,
      'calendar.state',
      actual === expectation.calendarState,
      expectation.calendarState,
      actual
    )
  }
  if (expectation.activeProposal) {
    const actual = proposal ? 'present' : 'absent'
    assertResult(
      assertions,
      'proposal.active',
      actual === expectation.activeProposal,
      expectation.activeProposal,
      actual
    )
  }
  if (expectation.proposalTransition) {
    assertResult(
      assertions,
      'proposal.transition',
      proposalTransition === expectation.proposalTransition,
      expectation.proposalTransition,
      proposalTransition
    )
  }
  if (expectation.bulkScope) {
    const actual = payload?.kind === 'bulk-delete' ? payload.scope : null
    assertResult(
      assertions,
      'proposal.bulkScope',
      actual === expectation.bulkScope,
      expectation.bulkScope,
      actual
    )
  }
  if (expectation.bulkEventCount !== undefined) {
    const actual = payload?.kind === 'bulk-delete' ? payload.eventIds.length : 0
    assertResult(
      assertions,
      'proposal.bulkEventCount',
      actual === expectation.bulkEventCount,
      expectation.bulkEventCount,
      actual
    )
  }
  if (expectation.bulkReminderCount !== undefined) {
    const actual = payload?.kind === 'bulk-delete' ? payload.reminderIds.length : 0
    assertResult(
      assertions,
      'proposal.bulkReminderCount',
      actual === expectation.bulkReminderCount,
      expectation.bulkReminderCount,
      actual
    )
  }
  if (expectation.state) evaluateState(assertions, 'state', exchange.snapshot, expectation.state)
  if (exchange.response.kind === 'preview') {
    assertResult(
      assertions,
      'safety.noMutationBeforeConfirm',
      calendarUnchanged,
      'unchanged snapshot',
      calendarUnchanged ? 'unchanged snapshot' : 'mutated snapshot'
    )
  }
  if (exchange.response.kind !== 'receipt') {
    assertResult(
      assertions,
      'safety.noMutationWithoutReceipt',
      calendarUnchanged,
      'unchanged snapshot',
      calendarUnchanged ? 'unchanged snapshot' : 'mutated snapshot'
    )
  }
  return assertions
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0
}

function rate(numerator: number, denominator: number): number {
  return numerator / Math.max(1, denominator)
}

function languageSha256(scenarios: readonly Scenario[]): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        scenarios.map((scenario) => ({
          id: scenario.id,
          turns: scenario.turns.map((turn) => turn.text)
        }))
      )
    )
    .digest('hex')
}

function summarizeMode(results: readonly ScenarioResult[]) {
  const turns = results.flatMap((scenario) => scenario.turns)
  const assertions = turns.flatMap((turn) => turn.assertions)
  const inDomainTurns = results.flatMap((scenario) => (scenario.inDomain ? scenario.turns : []))
  const outOfDomainScenarios = results.filter((scenario) => !scenario.inDomain)
  const previewChecks = turns.filter((turn) => turn.safePreview !== null)
  const referentAssertions = assertions.filter((assertion) =>
    /^response\.related(?:Event|Reminder)IdsExact$/u.test(assertion.name)
  )
  const calendarFactAssertions = assertions.filter((assertion) =>
    /^response\.(?:textAll|textAny|textNone|related(?:Event|Reminder)IdsExact)$/u.test(
      assertion.name
    )
  )
  const mutationSafetyAssertions = assertions.filter((assertion) =>
    /^(?:safety\.|proposal\.|after\.(?:confirm|reject)\.(?:proposalAvailable|state\.))/u.test(
      assertion.name
    )
  )
  const contextualFollowUps = results.flatMap((scenario) =>
    scenario.tags.includes('contextual-follow-up') ? scenario.turns.slice(1) : []
  )
  const categories = Object.fromEntries(
    [...new Set(results.map((result) => result.category))].sort().map((category) => {
      const selected = results.filter((result) => result.category === category)
      return [
        category,
        {
          scenarios: selected.length,
          passed: selected.filter((result) => result.passed).length,
          passRate: rate(selected.filter((result) => result.passed).length, selected.length)
        }
      ]
    })
  )
  return {
    scenarios: results.length,
    scenariosPassed: results.filter((result) => result.passed).length,
    scenarioPassRate: rate(results.filter((result) => result.passed).length, results.length),
    turns: turns.length,
    turnsPassed: turns.filter((turn) => turn.passed).length,
    turnPassRate: rate(turns.filter((turn) => turn.passed).length, turns.length),
    assertions: assertions.length,
    assertionsPassed: assertions.filter((assertion) => assertion.passed).length,
    assertionPassRate: rate(
      assertions.filter((assertion) => assertion.passed).length,
      assertions.length
    ),
    inDomainAnsweredRate: rate(
      inDomainTurns.filter((turn) => turn.answered).length,
      inDomainTurns.length
    ),
    outOfDomainScenarioPassRate: rate(
      outOfDomainScenarios.filter((scenario) => scenario.passed).length,
      outOfDomainScenarios.length
    ),
    safePreviewRate: rate(
      previewChecks.filter((turn) => turn.safePreview).length,
      previewChecks.length
    ),
    release: {
      exactReferentAssertions: referentAssertions.length,
      exactReferentAccuracy: rate(
        referentAssertions.filter((assertion) => assertion.passed).length,
        referentAssertions.length
      ),
      calendarFactAssertions: calendarFactAssertions.length,
      calendarFactGroundingRate: rate(
        calendarFactAssertions.filter((assertion) => assertion.passed).length,
        calendarFactAssertions.length
      ),
      mutationSafetyAssertions: mutationSafetyAssertions.length,
      mutationSafetyRate: rate(
        mutationSafetyAssertions.filter((assertion) => assertion.passed).length,
        mutationSafetyAssertions.length
      ),
      contextualFollowUpTurns: contextualFollowUps.length,
      contextualFollowUpAccuracy: rate(
        contextualFollowUps.filter((turn) => turn.passed).length,
        contextualFollowUps.length
      )
    },
    latencyMs: {
      median: percentile(
        turns.map((turn) => turn.latencyMs),
        0.5
      ),
      p95: percentile(
        turns.map((turn) => turn.latencyMs),
        0.95
      )
    },
    categories
  }
}

async function loadSuite(path: string): Promise<{ contents: string; scenarios: Scenario[] }> {
  const contents = await readFile(path, 'utf8')
  const scenarios = contents
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return assistantEvaluationScenarioSchema.parse(JSON.parse(line))
      } catch (error) {
        throw new Error(
          `Invalid evaluation scenario on line ${index + 1}: ${error instanceof Error ? error.message : 'unknown schema error'}`,
          { cause: error }
        )
      }
    })
  const ids = scenarios.map((scenario) => scenario.id)
  if (new Set(ids).size !== ids.length) throw new Error('Evaluation scenario IDs must be unique')
  return { contents, scenarios }
}

function rangeAround(today: Temporal.PlainDate): CalendarSnapshotRequest {
  return {
    rangeStartUtc: today
      .subtract({ years: 1 })
      .toZonedDateTime({ timeZone: timezone, plainTime: '00:00' })
      .toInstant()
      .toString({ fractionalSecondDigits: 3 }),
    rangeEndUtc: today
      .add({ years: 2 })
      .toZonedDateTime({ timeZone: timezone, plainTime: '00:00' })
      .toInstant()
      .toString({ fractionalSecondDigits: 3 })
  }
}

function configureRepository(repository: SqliteCalendarRepository): void {
  const preferences = repository.getPreferences()
  repository.updatePreferences({
    ...preferences,
    locale: 'en-US',
    timezone,
    updatedAt: new Date().toISOString()
  })
}

function seedScenario(
  repository: SqliteCalendarRepository,
  scenario: Scenario,
  today: Temporal.PlainDate,
  range: CalendarSnapshotRequest
): SeededScenarioIds {
  const calendar = new PersistentCalendarService(repository)
  const eventIds: string[] = []
  const reminderIds: string[] = []
  for (const seed of scenario.world.events) {
    const date = dateFromSpec(seed.date, today)
    const form: EventForm = {
      id: null,
      calendarId: null,
      title: seed.title,
      description: seed.description,
      location: seed.location,
      startDate: date,
      startTime: seed.startTime,
      endDate: date,
      endTime: seed.endTime,
      timezone,
      allDay: false,
      recurrence: recurrenceFromFixture(seed.recurrence, today)
    }
    const beforeIds = new Set(repository.listEvents().map((event) => event.id))
    const created = calendar
      .saveEvent(form, range)
      .snapshot.events.find((event) => !beforeIds.has(event.id))
    if (!created) throw new Error(`Could not identify seeded event for ${scenario.id}`)
    eventIds.push(created.id)
  }
  for (const seed of scenario.world.reminders) {
    const form: ReminderForm = {
      id: null,
      calendarId: null,
      title: seed.title,
      notes: seed.notes,
      dueDate: dateFromSpec(seed.date, today),
      dueTime: seed.time,
      timezone,
      recurrence: recurrenceFromFixture(seed.recurrence, today)
    }
    const beforeIds = new Set(repository.listReminders().map((reminder) => reminder.id))
    const created = calendar
      .saveReminder(form, range)
      .snapshot.reminders.find((reminder) => !beforeIds.has(reminder.id))
    if (!created) throw new Error(`Could not identify seeded reminder for ${scenario.id}`)
    reminderIds.push(created.id)
  }
  return { eventIds, reminderIds }
}

async function evaluateMode(
  mode: Mode,
  scenarios: readonly Scenario[],
  selectedCase: string | null,
  native: { planner: RemindCorePlanner; speaker: RemindSpeakPlanner } | null
): Promise<ModeResult> {
  const scenarioResults: ScenarioResult[] = []
  for (const scenario of scenarios) {
    if (selectedCase && scenario.id !== selectedCase) continue
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      configureRepository(repository)
      const today = Temporal.Now.instant().toZonedDateTimeISO(timezone).toPlainDate()
      const range = rangeAround(today)
      const seededIds = seedScenario(repository, scenario, today, range)
      const assistant = new PersistentAssistantService(
        repository,
        mode === 'native-hybrid' ? (native?.planner ?? null) : null,
        mode === 'native-hybrid' ? (native?.planner.info ?? null) : null,
        mode === 'native-hybrid' ? (native?.speaker ?? null) : null,
        mode === 'native-hybrid' ? (native?.speaker.info ?? null) : null
      )
      let conversationId: string | null = null
      let previousProposalId: string | null = null
      const turns: TurnResult[] = []
      for (const [index, turn] of scenario.turns.entries()) {
        const before = new PersistentCalendarService(repository).getSnapshot(range)
        const started = performance.now()
        const exchange = await assistant.send({ conversationId, text: turn.text, range })
        const latencyMs = performance.now() - started
        conversationId = exchange.conversation.id
        const assertions = evaluateTurn(
          exchange,
          before,
          turn.expect,
          previousProposalId,
          today,
          seededIds
        )
        const safePreviewAssertion = assertions.find(
          (assertion) => assertion.name === 'safety.noMutationBeforeConfirm'
        )

        let nextProposalId = exchange.conversation.activeProposal?.id ?? null
        if (turn.after === 'confirm' || turn.after === 'reject') {
          const proposal = exchange.conversation.activeProposal
          assertResult(
            assertions,
            `after.${turn.after}.proposalAvailable`,
            Boolean(proposal),
            true,
            Boolean(proposal)
          )
          if (proposal) {
            const afterExchange =
              turn.after === 'confirm'
                ? assistant.confirm({ proposalId: proposal.id, range })
                : assistant.reject({ proposalId: proposal.id, mode: 'cancel', range })
            nextProposalId = afterExchange.conversation.activeProposal?.id ?? null
            if (turn.postState)
              evaluateState(
                assertions,
                `after.${turn.after}.state`,
                afterExchange.snapshot,
                turn.postState
              )
          }
        }
        previousProposalId = nextProposalId

        turns.push({
          index,
          text: turn.text,
          responseKind: exchange.response.kind,
          responseText: exchange.response.text,
          latencyMs,
          executionTrace: assistant.getLastExecutionTrace(),
          answered: !['unsupported', 'error'].includes(exchange.response.kind),
          safePreview: safePreviewAssertion ? safePreviewAssertion.passed : null,
          passed: assertions.every((assertion) => assertion.passed),
          assertions
        })
      }
      scenarioResults.push({
        id: scenario.id,
        category: scenario.category,
        source: scenario.source,
        tags: scenario.tags,
        inDomain: scenario.inDomain,
        passed: turns.every((turn) => turn.passed),
        turns
      })
    } finally {
      repository.close()
    }
  }
  return { mode, scenarioResults, metrics: summarizeMode(scenarioResults) }
}

function markdownReport(report: {
  generatedAt: string
  suite: {
    path: string
    sha256: string
    scenarios: number
    humanBlindScenarios: number
    independentHumanBlind: boolean
    syntheticEngineeringProxy: boolean
  }
  componentBaselines: z.infer<typeof componentBaselinesSchema>
  modes: ModeResult[]
  gate: {
    requested: boolean
    independentHumanBlind: boolean
    passed: boolean
    maxP95Ms: number
    failures: string[]
  }
}): string {
  const lines = [
    '# Assistant evaluation report',
    '',
    `Generated: ${report.generatedAt}`,
    '',
    `Suite: \`${report.suite.path}\` (${report.suite.scenarios} frozen scenarios; SHA-256 \`${report.suite.sha256}\`)`,
    '',
    report.suite.independentHumanBlind
      ? `Independent human-blind scenarios scored: **${report.suite.humanBlindScenarios}**. The manifest binds collection consent, contamination audit, protocol, and model-lock attestations.`
      : report.suite.syntheticEngineeringProxy
        ? `Synthetic engineering scenarios scored: **${report.suite.scenarios}**. Human-blind scenarios collected: **0**; this generated proxy is not participant evidence.`
        : `Human-blind scenarios collected: **0**. This suite is regression/challenge data and is never presented as an independent human-blind set.`,
    '',
    '| Mode | Scenario pass | Turn pass | In-domain answered | Safe previews | Median | p95 |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |'
  ]
  for (const mode of report.modes) {
    const metric = mode.metrics
    lines.push(
      `| ${mode.mode} | ${(metric.scenarioPassRate * 100).toFixed(1)}% (${metric.scenariosPassed}/${metric.scenarios}) | ${(metric.turnPassRate * 100).toFixed(1)}% | ${(metric.inDomainAnsweredRate * 100).toFixed(1)}% | ${(metric.safePreviewRate * 100).toFixed(1)}% | ${metric.latencyMs.median.toFixed(1)} ms | ${metric.latencyMs.p95.toFixed(1)} ms |`
    )
  }
  lines.push(
    '',
    '## Automated gate',
    '',
    report.gate.requested
      ? report.gate.passed
        ? `Passed with a ${report.gate.maxP95Ms} ms p95 ceiling.`
        : `Failed: ${report.gate.failures.join('; ')}.`
      : `Not requested for this run. The configured p95 ceiling is ${report.gate.maxP95Ms} ms.`
  )
  const categories = [
    ...new Set(report.modes.flatMap((mode) => Object.keys(mode.metrics.categories)))
  ].sort()
  lines.push(
    '',
    '## Capability breakdown',
    '',
    `| Category | ${report.modes.map((mode) => mode.mode).join(' | ')} |`,
    `| --- | ${report.modes.map(() => '---:').join(' | ')} |`
  )
  for (const category of categories) {
    const cells = report.modes.map((mode) => {
      const metric = mode.metrics.categories[category]
      return metric
        ? `${(metric.passRate * 100).toFixed(1)}% (${metric.passed}/${metric.scenarios})`
        : '—'
    })
    lines.push(`| ${category} | ${cells.join(' | ')} |`)
  }
  const core = report.componentBaselines.remindCore.metrics
  const speak = report.componentBaselines.remindSpeak.metrics
  lines.push(
    '',
    '## Native component checks',
    '',
    `- RemindCore generated-fixture operation accuracy: **${(core.operationAccuracy * 100).toFixed(1)}%**. Its confidence gate reaches **${(core.eligibleAssistedCoverage * 100).toFixed(1)}%** coverage at **${(core.eligibleAssistedPrecision * 100).toFixed(1)}%** eligible precision; ambiguity recall is **${(core.ambiguityRecall * 100).toFixed(1)}%** and component p95 is **${core.warmLatencyMs.p95.toFixed(1)} ms**.`,
    `- RemindSpeak protected-fact retention: **${(speak.protectedFactRetention * 100).toFixed(1)}%**; reference response in top five: **${(speak.referenceInTopFiveRate * 100).toFixed(1)}%**; recent exact-repeat rate: **${(speak.recentExactRepeatRate * 100).toFixed(1)}%**; component p95 is **${speak.latencyMs.p95.toFixed(1)} ms**.`,
    '- The generated component fixtures and this full-service challenge suite answer different questions. High isolated component scores do not erase end-to-end routing failures.'
  )
  for (const mode of report.modes) {
    lines.push('', `## ${mode.mode} failures`, '')
    const failures = mode.scenarioResults.filter((scenario) => !scenario.passed)
    if (failures.length === 0) {
      lines.push('None.')
      continue
    }
    for (const scenario of failures) {
      lines.push(`- **${scenario.id}** (${scenario.category})`)
      for (const turn of scenario.turns.filter((candidate) => !candidate.passed)) {
        const failed = turn.assertions
          .filter((assertion) => !assertion.passed)
          .map((assertion) => assertion.name)
          .join(', ')
        lines.push(`  - \`${turn.text}\` → ${turn.responseKind}; failed: ${failed}`)
      }
    }
  }
  lines.push('')
  return `${lines.join('\n')}\n`
}

const suitePath = resolve(workspace, option('suite') ?? defaultSuitePath)
const relativeSuitePath = suitePath.slice(workspace.length + 1).replaceAll('\\', '/')
const manifestOption = option('manifest')
const manifestPath = manifestOption
  ? resolve(workspace, manifestOption)
  : suitePath === defaultSuitePath
    ? defaultManifestPath
    : null
const modeOption = option('mode')
if (modeOption && modeOption !== 'rules-only' && modeOption !== 'native-hybrid') {
  throw new Error('--mode must be rules-only or native-hybrid')
}
const selectedCase = option('case')
const requireHumanBlind = flag('require-human-blind')
const requireContextualRelease = flag('require-contextual-release')
const requireGate = flag('require-gate') || requireHumanBlind || requireContextualRelease
const { contents, scenarios } = await loadSuite(suitePath)
const suiteSha256 = createHash('sha256').update(contents).digest('hex')
if (requireGate && !manifestPath) {
  throw new Error('A frozen --manifest is required when gating a custom assistant suite')
}
let suiteManifest: AssistantSuiteManifest | null = null
if (manifestPath) {
  const manifest = assistantSuiteManifestSchema.parse(
    JSON.parse(await readFile(manifestPath, 'utf8'))
  )
  suiteManifest = manifest
  const turns = scenarios.reduce((total, scenario) => total + scenario.turns.length, 0)
  if (
    manifest.path !== relativeSuitePath ||
    manifest.sha256 !== suiteSha256 ||
    manifest.scenarios !== scenarios.length ||
    manifest.turns !== turns
  ) {
    throw new Error(`The frozen assistant evaluation suite does not match ${manifestPath}`)
  }
}
if (requireHumanBlind) {
  if (!suiteManifest?.independentHumanBlind) {
    throw new Error('The Phase 8 gate requires a hash-bound independent-human-blind manifest')
  }
  const boundFiles = [
    suiteManifest.collectionProtocol,
    suiteManifest.modelLock,
    ...suiteManifest.contaminationAudit.sources
  ]
  for (const boundFile of boundFiles) {
    const contents = await readFile(resolve(workspace, boundFile.path))
    const digest = createHash('sha256').update(contents).digest('hex')
    if (digest !== boundFile.sha256) {
      throw new Error(`The Phase 8 manifest-bound file changed: ${boundFile.path}`)
    }
  }
  const modelManifest = await loadModelManifest(modelRoot)
  const modelVerification = await verifyModelManifest(modelRoot, modelManifest)
  if (!modelVerification.valid) {
    const failures = modelVerification.artifacts
      .filter((artifact) => artifact.artifact.required && !artifact.valid)
      .map((artifact) => `${artifact.artifact.id}: ${artifact.error ?? 'invalid artifact'}`)
    throw new Error(`The Phase 8 model inventory failed verification: ${failures.join('; ')}`)
  }
  if (selectedCase) throw new Error('The Phase 8 gate cannot run a selected-case subset')
  if (scenarios.length < phase8HumanBlindPolicy.minimumScenarios) {
    throw new Error(
      `The Phase 8 gate requires at least ${phase8HumanBlindPolicy.minimumScenarios} scenarios`
    )
  }
  if (scenarios.some((scenario) => scenario.source !== 'user-reported')) {
    throw new Error(
      'Every Phase 8 scenario must have independently authored user-reported provenance'
    )
  }
  const qualityIssues = scenarios.flatMap((scenario) =>
    humanBlindScenarioQualityIssues(scenario).map((issue) => `${scenario.id}: ${issue}`)
  )
  if (qualityIssues.length > 0) {
    throw new Error(`The Phase 8 annotation-quality audit failed:\n- ${qualityIssues.join('\n- ')}`)
  }
  for (const [category, minimum] of Object.entries(phase8HumanBlindPolicy.categoryMinimums)) {
    const actual = scenarios.filter((scenario) => scenario.category === category).length
    if (minimum !== undefined && actual < minimum) {
      throw new Error(`The Phase 8 suite needs ${minimum} ${category} scenarios; found ${actual}`)
    }
  }
  const outOfDomain = scenarios.filter((scenario) => !scenario.inDomain).length
  if (outOfDomain < phase8HumanBlindPolicy.minimumOutOfDomain) {
    throw new Error(
      `The Phase 8 suite needs ${phase8HumanBlindPolicy.minimumOutOfDomain} out-of-domain scenarios; found ${outOfDomain}`
    )
  }
  const noisyLanguage = scenarios.filter((scenario) =>
    scenario.tags.some((tag) => /(?:asr|noise|ocr|spacing|typo)/iu.test(tag))
  ).length
  if (noisyLanguage < phase8HumanBlindPolicy.minimumNoisyLanguage) {
    throw new Error(
      `The Phase 8 suite needs ${phase8HumanBlindPolicy.minimumNoisyLanguage} noisy-language scenarios; found ${noisyLanguage}`
    )
  }
  const languageSeparation = auditLanguageSeparation(
    scenarios.flatMap((scenario) => scenario.turns.map((turn) => turn.text)),
    await loadContaminationSources(workspace),
    phase8HumanBlindPolicy.nearDuplicateThreshold
  )
  if (
    languageSeparation.exactInternalDuplicates > 0 ||
    languageSeparation.nearInternalDuplicates > 0 ||
    languageSeparation.exactContaminationMatches > 0 ||
    languageSeparation.nearContaminationMatches > 0
  ) {
    throw new Error(
      `The Phase 8 language-separation audit failed: ${JSON.stringify(languageSeparation)}`
    )
  }
}
if (requireContextualRelease) {
  if (!suiteManifest || !('contextualRelease' in suiteManifest)) {
    throw new Error('The contextual Phase 7 gate requires its hash-bound release manifest')
  }
  if (selectedCase) throw new Error('The contextual Phase 7 gate cannot run a selected-case subset')
  const sourcePath = resolve(workspace, suiteManifest.sourceSuite.path)
  const source = await loadSuite(sourcePath)
  const sourceSha256 = createHash('sha256').update(source.contents).digest('hex')
  if (sourceSha256 !== suiteManifest.sourceSuite.sha256) {
    throw new Error('The frozen Phase 0 source suite changed after the contextual release freeze')
  }
  const sourceLanguage = source.scenarios.map((scenario) => ({
    id: scenario.id,
    turns: scenario.turns.map((turn) => turn.text)
  }))
  const releaseLanguage = scenarios.map((scenario) => ({
    id: scenario.id,
    turns: scenario.turns.map((turn) => turn.text)
  }))
  if (JSON.stringify(sourceLanguage) !== JSON.stringify(releaseLanguage)) {
    throw new Error('The contextual Phase 7 suite changed the frozen request language')
  }
  if (languageSha256(scenarios) !== suiteManifest.languageSha256) {
    throw new Error('The contextual Phase 7 language digest does not match its manifest')
  }
  const exactReferentTurns = scenarios
    .flatMap((scenario) => scenario.turns)
    .filter(
      (turn) =>
        turn.expect.relatedEventSeedIndexesExact !== undefined ||
        turn.expect.relatedReminderSeedIndexesExact !== undefined
    ).length
  const contextualFollowUpTurns = scenarios.reduce(
    (total, scenario) =>
      total + (scenario.tags.includes('contextual-follow-up') ? scenario.turns.length - 1 : 0),
    0
  )
  if (
    exactReferentTurns !== suiteManifest.coverage.exactReferentTurns ||
    contextualFollowUpTurns !== suiteManifest.coverage.contextualFollowUpTurns
  ) {
    throw new Error('The contextual Phase 7 coverage counts do not match the frozen manifest')
  }
}
if (selectedCase && !scenarios.some((scenario) => scenario.id === selectedCase)) {
  throw new Error(`Unknown evaluation case: ${selectedCase}`)
}
const modes: Mode[] = modeOption ? [modeOption as Mode] : ['rules-only', 'native-hybrid']
const native = modes.includes('native-hybrid')
  ? {
      planner: await RemindCorePlanner.load(modelRoot),
      speaker: await RemindSpeakPlanner.load(modelRoot)
    }
  : null
const results: ModeResult[] = []
for (const mode of modes) results.push(await evaluateMode(mode, scenarios, selectedCase, native))

const maxP95Ms = Number(
  option('max-p95-ms') ?? (requireHumanBlind || requireContextualRelease ? '100' : '500')
)
if (!Number.isFinite(maxP95Ms) || maxP95Ms <= 0) {
  throw new Error('--max-p95-ms must be a positive number')
}
const gateFailures = results.flatMap((result) => {
  const metrics = result.metrics
  const hasPreviewChecks = result.scenarioResults.some((scenario) =>
    scenario.turns.some((turn) => turn.safePreview !== null)
  )
  const common = [
    !hasPreviewChecks || metrics.safePreviewRate === 1
      ? null
      : `${result.mode}: safe-preview rate is below 100%`,
    metrics.latencyMs.p95 <= maxP95Ms
      ? null
      : `${result.mode}: ${metrics.latencyMs.p95.toFixed(1)} ms p95 exceeds ${maxP95Ms} ms`
  ]
  if (requireContextualRelease) {
    return [
      metrics.scenarioPassRate === 1 ? null : `${result.mode}: scenario pass rate is below 100%`,
      metrics.release.exactReferentAssertions > 0 && metrics.release.exactReferentAccuracy === 1
        ? null
        : `${result.mode}: exact referent-ID accuracy is below 100% or was not measured`,
      metrics.release.calendarFactAssertions > 0 && metrics.release.calendarFactGroundingRate === 1
        ? null
        : `${result.mode}: calendar-fact grounding is below 100% or was not measured`,
      metrics.release.contextualFollowUpTurns > 0 &&
      metrics.release.contextualFollowUpAccuracy >= 0.95
        ? null
        : `${result.mode}: contextual follow-up accuracy is below 95% or was not measured`,
      metrics.inDomainAnsweredRate >= 0.99
        ? null
        : `${result.mode}: benign in-domain resolution is below 99%`,
      ...common
    ].filter((failure): failure is string => failure !== null)
  }
  if (!requireHumanBlind) {
    return [
      metrics.scenarioPassRate === 1 ? null : `${result.mode}: scenario pass rate is below 100%`,
      metrics.turnPassRate === 1 ? null : `${result.mode}: turn pass rate is below 100%`,
      metrics.assertionPassRate === 1 ? null : `${result.mode}: assertion pass rate is below 100%`,
      metrics.inDomainAnsweredRate >= 0.95
        ? null
        : `${result.mode}: in-domain answered rate is below 95%`,
      ...common
    ].filter((failure): failure is string => failure !== null)
  }

  const categoryTarget = (category: Scenario['category'], minimum: number): string | null => {
    const metric = metrics.categories[category]
    if (!metric) return `${result.mode}: Phase 8 suite has no ${category} scenarios`
    return metric.passRate >= minimum
      ? null
      : `${result.mode}: ${category} pass rate is below ${(minimum * 100).toFixed(0)}%`
  }
  const safetyAssertions = result.scenarioResults.flatMap((scenario) =>
    scenario.turns.flatMap((turn) =>
      turn.assertions.filter((assertion) => assertion.name.startsWith('safety.'))
    )
  )
  const factAssertions = result.scenarioResults.flatMap((scenario) =>
    scenario.turns.flatMap((turn) =>
      turn.assertions.filter((assertion) =>
        /^(?:response\.(?:textAll|textAny|textNone)|proposal\.(?:kind|operation|itemCount|itemKinds|titlesAll|datesAll|timesAll|endDatesAll|endTimesAll|locationsAll|detailsAll|weekdaysAll|frequenciesAll|bulkScope|bulkEventCount|bulkReminderCount)|state\.|after\.(?:confirm|reject)\.state\.)/u.test(
          assertion.name
        )
      )
    )
  )
  const categoryThresholds: ReadonlyArray<[Scenario['category'], number]> = [
    ['single-action', 0.95],
    ['multi-action', 0.9],
    ['mutation', 0.95],
    ['bulk', 1],
    ['query', 0.95],
    ['multi-turn', 0.9],
    ['conversation', 0.9],
    ['memory', 0.9],
    ['ambiguity', 0.95],
    ['safety', 1],
    ['open-dialogue', 0.9]
  ]
  return [
    metrics.scenarioPassRate >= 0.9
      ? null
      : `${result.mode}: overall human-blind scenario pass rate is below 90%`,
    metrics.inDomainAnsweredRate >= 0.99
      ? null
      : `${result.mode}: human-blind in-domain answered rate is below 99%`,
    metrics.outOfDomainScenarioPassRate >= 0.95
      ? null
      : `${result.mode}: human-blind out-of-domain handling is below 95%`,
    ...categoryThresholds.map(([category, minimum]) => categoryTarget(category, minimum)),
    safetyAssertions.length > 0 && safetyAssertions.every((assertion) => assertion.passed)
      ? null
      : `${result.mode}: a human-blind no-write safety assertion failed or was absent`,
    factAssertions.length > 0 && factAssertions.every((assertion) => assertion.passed)
      ? null
      : `${result.mode}: protected human-blind calendar facts were not retained exactly`,
    ...common
  ].filter((failure): failure is string => failure !== null)
})

const componentBaselines = componentBaselinesSchema.parse({
  remindCore: JSON.parse(
    await readFile(resolve(workspace, 'ml/remindcore/reports/runtime-metrics.json'), 'utf8')
  ),
  remindSpeak: JSON.parse(
    await readFile(resolve(workspace, 'ml/remindspeak/reports/runtime-metrics.json'), 'utf8')
  )
})

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  suite: {
    path: relativeSuitePath,
    sha256: suiteSha256,
    scenarios: selectedCase ? 1 : scenarios.length,
    humanBlindScenarios: suiteManifest?.independentHumanBlind ? scenarios.length : 0,
    independentHumanBlind: suiteManifest?.independentHumanBlind ?? false,
    contextualRelease: Boolean(suiteManifest && 'contextualRelease' in suiteManifest),
    syntheticEngineeringProxy: Boolean(
      suiteManifest && 'syntheticEngineeringProxy' in suiteManifest
    ),
    trainingExcluded: scenarios.every((scenario) => scenario.trainingExcluded),
    provenance: Object.fromEntries(
      [...new Set(scenarios.map((scenario) => scenario.source))]
        .sort()
        .map((source) => [
          source,
          scenarios.filter((scenario) => scenario.source === source).length
        ])
    )
  },
  componentBaselines,
  models: native
    ? {
        remindCore: native.planner.info,
        remindSpeak: native.speaker.info,
        optionalFallbackEvaluated: false
      }
    : { optionalFallbackEvaluated: false },
  gate: {
    requested: requireGate,
    independentHumanBlind: requireHumanBlind,
    passed: gateFailures.length === 0,
    maxP95Ms,
    failures: gateFailures
  },
  modes: results,
  phase0Status: {
    committedSeedSuiteFrozen: true,
    independentHumanBlindTarget: 2_000,
    independentHumanBlindCollected: suiteManifest?.independentHumanBlind ? scenarios.length : 0,
    syntheticEngineeringProxyScenarios:
      suiteManifest && 'syntheticEngineeringProxy' in suiteManifest ? scenarios.length : 0,
    fallbackBenchmarkPending: true,
    status:
      requireHumanBlind && gateFailures.length === 0
        ? 'independent-human-blind-gate-passed'
        : 'in-progress'
  }
}

if (!flag('no-write')) {
  await mkdir(reportDirectory, { recursive: true })
  await Promise.all([
    writeFile(
      resolve(reportDirectory, 'assistant-baseline.latest.json'),
      `${JSON.stringify(report, null, 2)}\n`,
      'utf8'
    ),
    writeFile(
      resolve(reportDirectory, 'assistant-baseline.latest.md'),
      markdownReport(report),
      'utf8'
    )
  ])
}

for (const result of results) {
  const metric = result.metrics
  console.log(
    `${result.mode}: ${(metric.scenarioPassRate * 100).toFixed(1)}% scenarios, ${(metric.inDomainAnsweredRate * 100).toFixed(1)}% in-domain answered, ${metric.latencyMs.p95.toFixed(1)}ms p95`
  )
  const failed = result.scenarioResults
    .filter((scenario) => !scenario.passed)
    .map((scenario) => scenario.id)
  if (failed.length > 0) {
    if (flag('summary-only')) {
      console.log(
        `  gaps: ${failed.length}; first cases: ${failed.slice(0, 12).join(', ')}${failed.length > 12 ? ', …' : ''}`
      )
      const familyResults = new Map<string, { passed: number; total: number }>()
      for (const scenario of result.scenarioResults) {
        const family = scenario.id.split('.')[1] ?? scenario.category
        const current = familyResults.get(family) ?? { passed: 0, total: 0 }
        current.total += 1
        if (scenario.passed) current.passed += 1
        familyResults.set(family, current)
      }
      console.log(
        `  families: ${[...familyResults.entries()]
          .map(([family, value]) => `${family} ${value.passed}/${value.total}`)
          .join(', ')}`
      )
    } else {
      console.log(`  gaps: ${failed.join(', ')}`)
      for (const scenario of result.scenarioResults.filter((candidate) => !candidate.passed)) {
        for (const turn of scenario.turns.filter((candidate) => !candidate.passed)) {
          const assertions = turn.assertions
            .filter((assertion) => !assertion.passed)
            .map(
              (assertion) =>
                `${assertion.name} expected ${JSON.stringify(assertion.expected)}, received ${JSON.stringify(assertion.actual)}`
            )
          console.log(`    ${scenario.id} turn ${turn.index + 1}: ${assertions.join('; ')}`)
        }
      }
    }
  }
}
console.log(
  flag('no-write')
    ? 'Baseline completed without writing a report.'
    : `Wrote ${resolve(reportDirectory, 'assistant-baseline.latest.md')}`
)
if (requireGate) {
  if (gateFailures.length === 0) console.log(`Assistant gate passed (p95 ceiling ${maxP95Ms} ms).`)
  else {
    console.error(`Assistant gate failed:\n- ${gateFailures.join('\n- ')}`)
    process.exitCode = 1
  }
}
