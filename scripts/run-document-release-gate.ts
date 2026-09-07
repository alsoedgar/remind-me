import { spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { CalendarSnapshotRequest, ReviewedDocumentItem } from '@remind-me/contracts'
import { PersistentCalendarService, SqliteCalendarRepository } from '@remind-me/storage'

interface GateConfiguration {
  schemaVersion: number
  suiteVersion: string
  thresholds: {
    proposalPrecision: number
    nativeRecall: number
    scannedRecall: number
    recurrenceExactAccuracy: number
    evidenceCoverage: number
  }
  packagedCases: Array<{
    caseId: string
    expectedExtraction: 'native-text' | 'ocr' | 'mixed'
  }>
  requiredRuntimeAssertions: string[]
}

interface CorpusItem {
  kind: 'event' | 'reminder'
  title: string
  startDate: string
  endDate: string | null
  startTime: string | null
  endTime: string | null
  timezone: string
  allDay: boolean
  location: string | null
  recurrence: unknown
  schedule: unknown
}

interface CorpusRecord {
  id: string
  fixture: string
  inputClass: string
  expectedItems: CorpusItem[]
}

interface MetricGroup {
  expectedItems: number
  observedItems: number
  matchedItems: number
  exactItems: number
  precision: number
  recall: number
  exactRecall: number
}

interface BaselineReport {
  suiteVersion: string
  coverage: {
    corpusDocuments: number
    scoredDocuments: number
    erroredDocuments: number
    coverage: number
  }
  overall: MetricGroup & {
    evidenceCoverage: number
  }
  fields: Record<
    string,
    {
      accuracy: number
      presentAccuracy: number | null
    }
  >
  byInputClass: Record<string, MetricGroup>
  byLayoutFamily: Record<string, MetricGroup>
  failures: unknown[]
}

interface PackagedCaseReport {
  schemaVersion: number
  caseId: string
  inputClass: string
  runtime: {
    platform: string
    arch: string
    packaged: boolean
    offline: boolean
  }
  passed: boolean
  failures: string[]
  checks?: Record<string, boolean>
  metrics?: {
    expectedItems: number
    observedItems: number
    exactMatches: number
    proposalPrecision: number
    proposalRecall: number
    evidenceItems: number
    evidenceCoverage: number
  }
  error?: string
}

interface PackageRunResult {
  exitCode: number | null
  timedOut: boolean
}

interface AggregateMetric {
  expectedItems: number
  observedItems: number
  exactMatches: number
  precision: number
  recall: number
}

const workspaceRoot = resolve(process.cwd())
const configurationPath = join(workspaceRoot, 'evals', 'documents', 'v0.1', 'release-gates.json')
const corpusPath = join(workspaceRoot, 'evals', 'documents', 'v0.1', 'corpus.jsonl')
const baselinePath = join(
  workspaceRoot,
  'evals',
  'documents',
  'reports',
  'document-baseline.latest.json'
)

function argument(name: string): string | null {
  const prefix = `--${name}=`
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? null
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function findPackagedExecutable(): Promise<string> {
  const explicit = argument('package')
  if (explicit) {
    const target = resolve(explicit)
    const details = await stat(target)
    if (details.isFile()) return target
    if (target.endsWith('.app')) return join(target, 'Contents', 'MacOS', 'Remind Me')
    return join(target, process.platform === 'win32' ? 'Remind Me.exe' : 'remind-me')
  }

  const dist = join(workspaceRoot, 'dist')
  if (process.platform === 'win32') return join(dist, 'win-unpacked', 'Remind Me.exe')
  if (process.platform === 'linux') return join(dist, 'linux-unpacked', 'remind-me')
  for (const directory of await readdir(dist, { withFileTypes: true })) {
    if (!directory.isDirectory()) continue
    const parent = join(dist, directory.name)
    for (const child of await readdir(parent, { withFileTypes: true })) {
      if (child.isDirectory() && child.name.endsWith('.app')) {
        return join(parent, child.name, 'Contents', 'MacOS', 'Remind Me')
      }
    }
  }
  throw new Error('A packaged macOS application was not found under dist')
}

function runPackage(
  executable: string,
  fixture: string,
  expected: string,
  reportPath: string,
  userDataPath: string
): Promise<PackageRunResult> {
  return new Promise((resolveRun, rejectRun) => {
    const args =
      process.platform === 'linux'
        ? ['--no-sandbox', '--document-release-gate', '--offline-smoke']
        : ['--document-release-gate', '--offline-smoke']
    const child = spawn(executable, args, {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        REMIND_ME_SMOKE_DOCUMENT: fixture,
        REMIND_ME_DOCUMENT_GATE_EXPECTED: expected,
        REMIND_ME_DOCUMENT_GATE_REPORT: reportPath,
        REMIND_ME_DOCUMENT_GATE_USER_DATA: userDataPath
      },
      stdio: 'inherit',
      windowsHide: true
    })
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill()
    }, 330_000)
    child.once('error', (error) => {
      clearTimeout(timeout)
      rejectRun(error)
    })
    child.once('close', (exitCode) => {
      clearTimeout(timeout)
      resolveRun({ exitCode, timedOut })
    })
  })
}

function aggregateCases(cases: readonly PackagedCaseReport[]): AggregateMetric {
  const counts = cases.reduce(
    (total, report) => ({
      expectedItems: total.expectedItems + (report.metrics?.expectedItems ?? 0),
      observedItems: total.observedItems + (report.metrics?.observedItems ?? 0),
      exactMatches: total.exactMatches + (report.metrics?.exactMatches ?? 0)
    }),
    { expectedItems: 0, observedItems: 0, exactMatches: 0 }
  )
  return {
    ...counts,
    precision: counts.observedItems === 0 ? 0 : counts.exactMatches / counts.observedItems,
    recall: counts.expectedItems === 0 ? 0 : counts.exactMatches / counts.expectedItems
  }
}

function aggregateBaselineGroups(groups: readonly MetricGroup[]): {
  expectedItems: number
  matchedItems: number
  recall: number
} {
  const counts = groups.reduce(
    (total, group) => ({
      expectedItems: total.expectedItems + group.expectedItems,
      matchedItems: total.matchedItems + group.matchedItems
    }),
    { expectedItems: 0, matchedItems: 0 }
  )
  return {
    ...counts,
    recall: counts.expectedItems === 0 ? 0 : counts.matchedItems / counts.expectedItems
  }
}

function courseIdentityProbe(): {
  passed: boolean
  crns: string[]
  components: string[]
  oneUndoRemovedBatch: boolean
  error?: string
} {
  const repository = new SqliteCalendarRepository(':memory:')
  const service = new PersistentCalendarService(repository)
  const range: CalendarSnapshotRequest = {
    rangeStartUtc: '2026-01-01T00:00:00.000Z',
    rangeEndUtc: '2027-01-01T00:00:00.000Z'
  }
  try {
    const recurrence = {
      frequency: 'weekly' as const,
      interval: 1,
      byWeekday: ['monday' as const, 'wednesday' as const, 'friday' as const],
      byMonthDay: [],
      end: { kind: 'until' as const, date: '2026-12-04' }
    }
    const items: ReviewedDocumentItem[] = [
      {
        draftId: 'release:lecture',
        kind: 'event',
        sourceIdentity: {
          sourceSha256: '7'.repeat(64),
          sourceRowId: 'row:0000000000000100'
        },
        schedule: {
          courseCode: 'CS 251',
          sectionCode: 'A',
          crn: '12345',
          creditHours: 4,
          component: 'lecture',
          termStartDate: '2026-08-24',
          termEndDate: '2026-12-04',
          weekdays: ['monday', 'wednesday', 'friday'],
          verification: 'layout'
        },
        form: {
          id: null,
          calendarId: 'calendar:local',
          title: 'CS 251',
          description: 'Lecture',
          location: 'CDRL 1426',
          startDate: '2026-08-24',
          startTime: '14:00',
          endDate: '2026-08-24',
          endTime: '14:50',
          timezone: 'America/Chicago',
          allDay: false,
          recurrence
        }
      },
      {
        draftId: 'release:lab',
        kind: 'event',
        sourceIdentity: {
          sourceSha256: '7'.repeat(64),
          sourceRowId: 'row:0000000000000101'
        },
        schedule: {
          courseCode: 'CS 251',
          sectionCode: 'B',
          crn: '67890',
          creditHours: 0,
          component: 'laboratory',
          termStartDate: '2026-08-24',
          termEndDate: '2026-12-04',
          weekdays: ['monday', 'wednesday', 'friday'],
          verification: 'layout'
        },
        form: {
          id: null,
          calendarId: 'calendar:local',
          title: 'CS 251',
          description: 'Laboratory',
          location: 'CDRL 1426',
          startDate: '2026-08-24',
          startTime: '14:00',
          endDate: '2026-08-24',
          endTime: '14:50',
          timezone: 'America/Chicago',
          allDay: false,
          recurrence
        }
      }
    ]
    const imported = service.importReviewedDocumentItems(items, 'identity-gate.pdf', range)
    const crns = imported.snapshot.events
      .map((event) => event.importIdentity?.course?.crn)
      .filter((value): value is string => Boolean(value))
      .sort()
    const components = imported.snapshot.events
      .map((event) => event.importIdentity?.course?.component)
      .filter(
        (value): value is 'lecture' | 'laboratory' => value === 'lecture' || value === 'laboratory'
      )
      .sort()
    const undone = service.undoLastAction(range)
    const oneUndoRemovedBatch = undone.snapshot.events.length === 0
    return {
      passed:
        imported.snapshot.events.length === 2 &&
        new Set(imported.snapshot.events.map((event) => event.importIdentity?.semanticKey)).size ===
          2 &&
        JSON.stringify(crns) === JSON.stringify(['12345', '67890']) &&
        JSON.stringify(components) === JSON.stringify(['laboratory', 'lecture']) &&
        oneUndoRemovedBatch,
      crns,
      components,
      oneUndoRemovedBatch
    }
  } catch (error) {
    return {
      passed: false,
      crns: [],
      components: [],
      oneUndoRemovedBatch: false,
      error: error instanceof Error ? error.message : String(error)
    }
  } finally {
    repository.close()
  }
}

const [configuration, baseline, corpusText] = await Promise.all([
  readFile(configurationPath, 'utf8').then((value) => JSON.parse(value) as GateConfiguration),
  readFile(baselinePath, 'utf8').then((value) => JSON.parse(value) as BaselineReport),
  readFile(corpusPath, 'utf8')
])
if (configuration.schemaVersion !== 1 || configuration.suiteVersion !== baseline.suiteVersion) {
  throw new Error('Document release gate configuration and baseline suite versions do not match')
}
const corpus = corpusText
  .split(/\r?\n/u)
  .filter(Boolean)
  .map((line) => JSON.parse(line) as CorpusRecord)
const executable = await findPackagedExecutable()
if (!(await exists(executable))) throw new Error(`Packaged executable not found: ${executable}`)

const temporaryDirectory = await mkdtemp(join(tmpdir(), 'remind-me-document-release-'))
const caseReports: PackagedCaseReport[] = []
const processResults: Record<string, PackageRunResult> = {}
try {
  for (const packagedCase of configuration.packagedCases) {
    const record = corpus.find((candidate) => candidate.id === packagedCase.caseId)
    if (!record)
      throw new Error(`Packaged case is not in the frozen corpus: ${packagedCase.caseId}`)
    const reportPath = join(temporaryDirectory, `${packagedCase.caseId}.json`)
    const userDataPath = join(temporaryDirectory, `${packagedCase.caseId}.user-data`)
    await mkdir(userDataPath, { recursive: true })
    console.log(`Running packaged document gate: ${packagedCase.caseId}`)
    const expected = JSON.stringify({
      caseId: record.id,
      inputClass: record.inputClass,
      expectedExtraction: packagedCase.expectedExtraction,
      expectedItems: record.expectedItems
    })
    const processResult = await runPackage(
      executable,
      resolve(workspaceRoot, record.fixture),
      expected,
      reportPath,
      userDataPath
    )
    processResults[packagedCase.caseId] = processResult
    if (await exists(reportPath)) {
      caseReports.push(JSON.parse(await readFile(reportPath, 'utf8')) as PackagedCaseReport)
    } else {
      caseReports.push({
        schemaVersion: 1,
        caseId: packagedCase.caseId,
        inputClass: record.inputClass,
        runtime: {
          platform: process.platform,
          arch: process.arch,
          packaged: false,
          offline: false
        },
        passed: false,
        failures: ['missing-case-report'],
        error: `Packaged process exited ${String(processResult.exitCode)} without a report`
      })
    }
  }

  const nativeBaseline = baseline.byInputClass['born-digital']
  if (!nativeBaseline) throw new Error('The born-digital baseline group is missing')
  const scannedBaseline = aggregateBaselineGroups(
    Object.entries(baseline.byInputClass)
      .filter(([inputClass]) => inputClass !== 'born-digital')
      .map(([, metrics]) => metrics)
  )
  const nativeCases = caseReports.filter((report) => report.inputClass === 'born-digital')
  const scannedCases = caseReports.filter((report) => report.inputClass !== 'born-digital')
  const runtimeOverall = aggregateCases(caseReports)
  const runtimeNative = aggregateCases(nativeCases)
  const runtimeScanned = aggregateCases(scannedCases)
  const runtimeEvidenceItems = caseReports.reduce(
    (total, report) => total + (report.metrics?.evidenceItems ?? 0),
    0
  )
  const runtimeEvidenceCoverage =
    runtimeOverall.expectedItems === 0 ? 0 : runtimeEvidenceItems / runtimeOverall.expectedItems
  const recurrenceExactAccuracy =
    baseline.fields.recurrence?.presentAccuracy ?? baseline.fields.recurrence?.accuracy ?? 0
  const rowTable = baseline.byLayoutFamily['row-table']
  const identityProbe = courseIdentityProbe()

  const assertions: Record<string, boolean> = {
    frozenCorpusComplete:
      baseline.coverage.coverage === 1 &&
      baseline.coverage.erroredDocuments === 0 &&
      baseline.failures.length === 0,
    proposalPrecision:
      baseline.overall.precision >= configuration.thresholds.proposalPrecision &&
      runtimeOverall.precision >= configuration.thresholds.proposalPrecision,
    nativeRecall:
      nativeBaseline.recall >= configuration.thresholds.nativeRecall &&
      runtimeNative.recall >= configuration.thresholds.nativeRecall,
    scannedRecall:
      scannedBaseline.recall >= configuration.thresholds.scannedRecall &&
      runtimeScanned.recall >= configuration.thresholds.scannedRecall,
    exactRecurrenceWeekdaysAndTerm:
      recurrenceExactAccuracy >= configuration.thresholds.recurrenceExactAccuracy &&
      nativeCases
        .filter((report) => report.caseId === 'course-syllabus.multipage')
        .every((report) => report.checks?.exactFieldPlacement === true),
    noCrossRowBorrowing:
      rowTable?.exactRecall === 1 &&
      caseReports
        .filter((report) => report.caseId.startsWith('row-table.'))
        .every((report) => report.checks?.exactFieldPlacement === true),
    distinctCrnsAndComponents: identityProbe.passed,
    evidenceCoverage:
      baseline.overall.evidenceCoverage >= configuration.thresholds.evidenceCoverage &&
      runtimeEvidenceCoverage >= configuration.thresholds.evidenceCoverage,
    packagedOnCurrentPlatform: caseReports.every(
      (report) =>
        report.runtime.packaged &&
        report.runtime.platform === process.platform &&
        report.runtime.arch === process.arch
    ),
    offlineExtraction: caseReports.every(
      (report) => report.runtime.offline && report.checks?.offlineRuntime === true
    ),
    allPackagedCasesPassed:
      caseReports.length === configuration.packagedCases.length &&
      caseReports.every((report) => report.passed),
    allRuntimeAssertionsPresent: caseReports.every((report) =>
      configuration.requiredRuntimeAssertions.every((name) => report.checks?.[name] === true)
    ),
    childProcessesClean: Object.values(processResults).every(
      (result) => result.exitCode === 0 && !result.timedOut
    )
  }
  const failures = Object.entries(assertions)
    .filter(([, passed]) => !passed)
    .map(([name]) => name)
  const outputPath = resolve(
    argument('output') ??
      join(
        workspaceRoot,
        'evals',
        'documents',
        'reports',
        `document-release.${process.platform}-${process.arch}.json`
      )
  )
  await mkdir(dirname(outputPath), { recursive: true })
  const report = {
    schemaVersion: 1,
    suiteVersion: configuration.suiteVersion,
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    executable,
    thresholds: configuration.thresholds,
    corpus: {
      documents: baseline.coverage.scoredDocuments,
      proposalPrecision: baseline.overall.precision,
      nativeRecall: nativeBaseline.recall,
      scannedRecall: scannedBaseline.recall,
      recurrenceExactAccuracy,
      evidenceCoverage: baseline.overall.evidenceCoverage,
      rowTableExactRecall: rowTable?.exactRecall ?? 0
    },
    packagedRuntime: {
      overall: runtimeOverall,
      native: runtimeNative,
      scanned: runtimeScanned,
      evidenceCoverage: runtimeEvidenceCoverage,
      cases: caseReports,
      processResults
    },
    identityProbe,
    assertions,
    passed: failures.length === 0,
    failures
  }
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(
    `Document release gate ${failures.length === 0 ? 'passed' : 'failed'} on ${process.platform}-${process.arch}: ` +
      `${runtimeOverall.exactMatches}/${runtimeOverall.expectedItems} exact packaged proposals, ` +
      `${Math.round(runtimeEvidenceCoverage * 1000) / 10}% visible evidence coverage.`
  )
  console.log(`Report: ${outputPath}`)
  if (failures.length > 0) {
    console.error(`Failed assertions: ${failures.join(', ')}`)
    process.exitCode = 1
  }
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true })
}
