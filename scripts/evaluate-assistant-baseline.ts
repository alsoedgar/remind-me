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
import { RemindCorePlanner, RemindSpeakPlanner } from '@remind-me/model-runtime'
import {
  PersistentAssistantService,
  PersistentCalendarService,
  SqliteCalendarRepository
} from '@remind-me/storage'
import { z } from 'zod'

const dateSpecSchema = z
  .string()
  .regex(
    /^(?:today|tomorrow|yesterday|[+-]\d+d|(?:this|next):(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|\d{4}-\d{2}-\d{2})$/u
  )

const recurrenceSchema = z
  .object({
    frequency: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
    interval: z.number().int().positive().max(365),
    byWeekday: z
      .array(z.enum(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']))
      .max(7),
    byMonthDay: z.array(z.number().int().min(-31).max(31)).max(31),
    end: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('never') }).strict(),
      z.object({ kind: z.literal('count'), count: z.number().int().positive() }).strict(),
      z.object({ kind: z.literal('until'), date: dateSpecSchema }).strict()
    ])
  })
  .strict()

const seedEventSchema = z
  .object({
    title: z.string().min(1),
    date: dateSpecSchema,
    startTime: z.string().regex(/^\d{2}:\d{2}$/u),
    endTime: z.string().regex(/^\d{2}:\d{2}$/u),
    location: z.string().default(''),
    description: z.string().default(''),
    recurrence: recurrenceSchema.nullable().default(null)
  })
  .strict()

const seedReminderSchema = z
  .object({
    title: z.string().min(1),
    date: dateSpecSchema,
    time: z.string().regex(/^\d{2}:\d{2}$/u),
    notes: z.string().default(''),
    recurrence: recurrenceSchema.nullable().default(null)
  })
  .strict()

const stateExpectationSchema = z
  .object({
    eventCount: z.number().int().nonnegative().optional(),
    reminderCount: z.number().int().nonnegative().optional(),
    eventTitlesAll: z.array(z.string().min(1)).optional(),
    eventTitlesNone: z.array(z.string().min(1)).optional(),
    reminderTitlesAll: z.array(z.string().min(1)).optional(),
    reminderTitlesNone: z.array(z.string().min(1)).optional()
  })
  .strict()

const turnExpectationSchema = z
  .object({
    responseKinds: z
      .array(
        z.enum([
          'answer',
          'clarification',
          'preview',
          'receipt',
          'rejected',
          'unsupported',
          'error'
        ])
      )
      .min(1),
    textAll: z.array(z.string().min(1)).optional(),
    textAny: z.array(z.string().min(1)).optional(),
    textNone: z.array(z.string().min(1)).optional(),
    maxWords: z.number().int().positive().optional(),
    relatedEventMin: z.number().int().nonnegative().optional(),
    relatedReminderMin: z.number().int().nonnegative().optional(),
    proposalKind: z
      .enum([
        'event-save',
        'event-delete',
        'reminder-save',
        'reminder-complete',
        'reminder-delete',
        'bulk-delete',
        'batch'
      ])
      .optional(),
    proposalOperation: z.string().min(1).optional(),
    proposalItemCount: z.number().int().positive().optional(),
    proposalItemKinds: z.array(z.string().min(1)).optional(),
    proposalTitlesAll: z.array(z.string().min(1)).optional(),
    proposalTimesAll: z.array(z.string().regex(/^\d{2}:\d{2}$/u)).optional(),
    proposalWeekdaysAll: z.array(z.string().min(1)).optional(),
    bulkScope: z.enum(['events', 'reminders', 'both']).optional(),
    bulkEventCount: z.number().int().nonnegative().optional(),
    bulkReminderCount: z.number().int().nonnegative().optional(),
    state: stateExpectationSchema.optional()
  })
  .strict()

const turnSchema = z
  .object({
    text: z.string().trim().min(1),
    expect: turnExpectationSchema,
    after: z.enum(['confirm', 'reject']).optional(),
    postState: stateExpectationSchema.optional()
  })
  .strict()

const scenarioSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/u),
    category: z.enum([
      'single-action',
      'multi-action',
      'mutation',
      'bulk',
      'query',
      'multi-turn',
      'conversation',
      'memory',
      'ambiguity',
      'safety',
      'open-dialogue'
    ]),
    source: z.enum(['user-reported', 'developer-challenge', 'safety-contract']),
    inDomain: z.boolean(),
    trainingExcluded: z.literal(true),
    tags: z.array(z.string().min(1)).default([]),
    world: z
      .object({
        events: z.array(seedEventSchema).default([]),
        reminders: z.array(seedReminderSchema).default([])
      })
      .strict()
      .default({ events: [], reminders: [] }),
    turns: z.array(turnSchema).min(1)
  })
  .strict()

const suiteManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    suiteVersion: z.string().min(1),
    path: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    scenarios: z.number().int().positive(),
    turns: z.number().int().positive(),
    trainingExcluded: z.literal(true),
    independentHumanBlind: z.literal(false),
    frozen: z.literal(true)
  })
  .strict()

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

type Scenario = z.infer<typeof scenarioSchema>
type StateExpectation = z.infer<typeof stateExpectationSchema>
type TurnExpectation = z.infer<typeof turnExpectationSchema>
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
  answered: boolean
  safePreview: boolean | null
  passed: boolean
  assertions: AssertionResult[]
}

interface ScenarioResult {
  id: string
  category: Scenario['category']
  source: Scenario['source']
  inDomain: boolean
  passed: boolean
  turns: TurnResult[]
}

interface ModeResult {
  mode: Mode
  scenarioResults: ScenarioResult[]
  metrics: ReturnType<typeof summarizeMode>
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
  input: z.infer<typeof recurrenceSchema> | null,
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

function proposalTitles(payload: AssistantProposalPayload | null): string[] {
  return proposalItems(payload).flatMap((item) => {
    if (item.kind === 'event-save' || item.kind === 'reminder-save') return [item.form.title]
    return []
  })
}

function proposalTimes(payload: AssistantProposalPayload | null): string[] {
  return proposalItems(payload).flatMap((item) => {
    if (item.kind === 'event-save') return item.form.startTime ? [item.form.startTime] : []
    if (item.kind === 'reminder-save') return [item.form.dueTime]
    return []
  })
}

function proposalWeekdays(payload: AssistantProposalPayload | null): string[] {
  return proposalItems(payload).flatMap((item) => {
    if (item.kind !== 'event-save' && item.kind !== 'reminder-save') return []
    return item.form.recurrence?.byWeekday ?? []
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
  expectation: TurnExpectation
): AssertionResult[] {
  const assertions: AssertionResult[] = []
  const responseText = normalized(exchange.response.text)
  const proposal = exchange.conversation.activeProposal
  const payload = proposal?.payload ?? null

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
    const titles = proposalTitles(payload)
    assertResult(
      assertions,
      'proposal.titlesAll',
      includesAll(titles, expectation.proposalTitlesAll),
      expectation.proposalTitlesAll,
      titles
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
      snapshotSignature(before) === snapshotSignature(exchange.snapshot),
      'unchanged snapshot',
      snapshotSignature(before) === snapshotSignature(exchange.snapshot)
        ? 'unchanged snapshot'
        : 'mutated snapshot'
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

function summarizeMode(results: readonly ScenarioResult[]) {
  const turns = results.flatMap((scenario) => scenario.turns)
  const assertions = turns.flatMap((turn) => turn.assertions)
  const inDomainTurns = results.flatMap((scenario) => (scenario.inDomain ? scenario.turns : []))
  const previewChecks = turns.filter((turn) => turn.safePreview !== null)
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
    safePreviewRate: rate(
      previewChecks.filter((turn) => turn.safePreview).length,
      previewChecks.length
    ),
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
        return scenarioSchema.parse(JSON.parse(line))
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
): void {
  const calendar = new PersistentCalendarService(repository)
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
    calendar.saveEvent(form, range)
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
    calendar.saveReminder(form, range)
  }
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
      seedScenario(repository, scenario, today, range)
      const assistant = new PersistentAssistantService(
        repository,
        mode === 'native-hybrid' ? (native?.planner ?? null) : null,
        mode === 'native-hybrid' ? (native?.planner.info ?? null) : null,
        mode === 'native-hybrid' ? (native?.speaker ?? null) : null,
        mode === 'native-hybrid' ? (native?.speaker.info ?? null) : null
      )
      let conversationId: string | null = null
      const turns: TurnResult[] = []
      for (const [index, turn] of scenario.turns.entries()) {
        const before = new PersistentCalendarService(repository).getSnapshot(range)
        const started = performance.now()
        const exchange = await assistant.send({ conversationId, text: turn.text, range })
        const latencyMs = performance.now() - started
        conversationId = exchange.conversation.id
        const assertions = evaluateTurn(exchange, before, turn.expect)
        const safePreviewAssertion = assertions.find(
          (assertion) => assertion.name === 'safety.noMutationBeforeConfirm'
        )

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
            if (turn.postState)
              evaluateState(
                assertions,
                `after.${turn.after}.state`,
                afterExchange.snapshot,
                turn.postState
              )
          }
        }

        turns.push({
          index,
          text: turn.text,
          responseKind: exchange.response.kind,
          responseText: exchange.response.text,
          latencyMs,
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
  suite: { path: string; sha256: string; scenarios: number; humanBlindScenarios: number }
  componentBaselines: z.infer<typeof componentBaselinesSchema>
  modes: ModeResult[]
}): string {
  const lines = [
    '# Assistant Phase 0 baseline',
    '',
    `Generated: ${report.generatedAt}`,
    '',
    `Suite: \`${report.suite.path}\` (${report.suite.scenarios} frozen scenarios; SHA-256 \`${report.suite.sha256}\`)`,
    '',
    `Human-blind scenarios collected: **${report.suite.humanBlindScenarios}**. The committed seed suite is regression/challenge data and is never presented as an independent human-blind set.`,
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
const modeOption = option('mode')
if (modeOption && modeOption !== 'rules-only' && modeOption !== 'native-hybrid') {
  throw new Error('--mode must be rules-only or native-hybrid')
}
const selectedCase = option('case')
const { contents, scenarios } = await loadSuite(suitePath)
const suiteSha256 = createHash('sha256').update(contents).digest('hex')
if (suitePath === defaultSuitePath) {
  const manifest = suiteManifestSchema.parse(
    JSON.parse(await readFile(defaultManifestPath, 'utf8'))
  )
  const turns = scenarios.reduce((total, scenario) => total + scenario.turns.length, 0)
  if (
    manifest.path !== 'evals/assistant/v0.1/scenarios.jsonl' ||
    manifest.sha256 !== suiteSha256 ||
    manifest.scenarios !== scenarios.length ||
    manifest.turns !== turns
  ) {
    throw new Error('The frozen assistant evaluation suite does not match its manifest')
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

const componentBaselines = componentBaselinesSchema.parse({
  remindCore: JSON.parse(
    await readFile(resolve(workspace, 'ml/remindcore/reports/runtime-metrics.json'), 'utf8')
  ),
  remindSpeak: JSON.parse(
    await readFile(resolve(workspace, 'ml/remindspeak/reports/runtime-metrics.json'), 'utf8')
  )
})

const relativeSuitePath = suitePath.slice(workspace.length + 1).replaceAll('\\', '/')
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  suite: {
    path: relativeSuitePath,
    sha256: suiteSha256,
    scenarios: selectedCase ? 1 : scenarios.length,
    humanBlindScenarios: relativeSuitePath.includes('human-blind') ? scenarios.length : 0,
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
  modes: results,
  phase0Status: {
    committedSeedSuiteFrozen: true,
    independentHumanBlindTarget: 2_000,
    independentHumanBlindCollected: relativeSuitePath.includes('human-blind')
      ? scenarios.length
      : 0,
    fallbackBenchmarkPending: true,
    status: 'in-progress'
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
  if (failed.length > 0) console.log(`  gaps: ${failed.join(', ')}`)
}
console.log(
  flag('no-write')
    ? 'Baseline completed without writing a report.'
    : `Wrote ${resolve(reportDirectory, 'assistant-baseline.latest.md')}`
)
