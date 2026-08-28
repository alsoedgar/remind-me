import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { availableParallelism, freemem, homedir, platform, totalmem } from 'node:os'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { clearTimeout, setTimeout } from 'node:timers'
import { fileURLToPath } from 'node:url'
import { app, utilityProcess } from 'electron'

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url))
const WORKSPACE = resolve(SCRIPT_DIRECTORY, '..', '..', '..')
const MODEL_FILE = 'Qwen3-1.7B-Q4_K_M.gguf'
const MODEL_BYTES = 1_282_439_264
const MODEL_SHA256 = 'd2387ca2dbfee2ffabce7120d3770dadca0b293052bc2f0e138fdc940d9bc7b5'
const GiB = 1_024 * 1_024 * 1_024

function defaultModelPath() {
  if (platform() === 'win32' && process.env.APPDATA) {
    return resolve(process.env.APPDATA, 'Remind Me', 'optional-models', 'qwen3-1.7b-q4', MODEL_FILE)
  }
  if (platform() === 'darwin') {
    return resolve(
      homedir(),
      'Library',
      'Application Support',
      'Remind Me',
      'optional-models',
      'qwen3-1.7b-q4',
      MODEL_FILE
    )
  }
  return resolve(
    process.env.XDG_CONFIG_HOME || resolve(homedir(), '.config'),
    'Remind Me',
    'optional-models',
    'qwen3-1.7b-q4',
    MODEL_FILE
  )
}

async function sha256(path) {
  return await new Promise((resolveHash, rejectHash) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path, { highWaterMark: 4 * 1_024 * 1_024 })
    stream.on('data', (chunk) => hash.update(chunk))
    stream.once('error', rejectHash)
    stream.once('end', () => resolveHash(hash.digest('hex')))
  })
}

function performanceProfile() {
  const logicalThreads = availableParallelism()
  const metal = process.platform === 'darwin' && process.arch === 'arm64'
  const largeEnough = totalmem() >= 24 * GiB && freemem() >= 5 * GiB && logicalThreads >= 12
  if (!largeEnough) {
    return {
      id: totalmem() < 12 * GiB || freemem() < 3 * GiB ? 'compact' : 'balanced',
      label:
        totalmem() < 12 * GiB || freemem() < 3 * GiB ? 'Automatic compact' : 'Automatic balanced',
      backend: metal ? 'metal' : 'cpu',
      threads: Math.max(
        2,
        Math.min(metal ? 8 : 12, logicalThreads - 1, Math.ceil(logicalThreads * (2 / 3)))
      ),
      contextSize: 4096,
      sequences: 1,
      batchSize: totalmem() < 12 * GiB || freemem() < 3 * GiB ? 256 : 512,
      maxChatTokens: metal ? 112 : 80,
      idleUnloadMs: 300_000,
      requestTimeoutMs: 120_000
    }
  }
  return {
    id: 'performance',
    label: 'Automatic performance',
    backend: metal ? 'metal' : 'cpu',
    threads: Math.max(
      2,
      Math.min(metal ? 10 : 16, logicalThreads - 1, Math.ceil(logicalThreads * (2 / 3)))
    ),
    contextSize: 4096,
    sequences: 2,
    batchSize: 512,
    maxChatTokens: metal ? 128 : 96,
    idleUnloadMs: 600_000,
    requestTimeoutMs: 90_000
  }
}

function assertDocumentFallbackResult(result) {
  const groups = result?.fallback?.groups
  if (!Array.isArray(groups) || groups.length !== 1) {
    throw new Error(
      `The document fallback probe did not return one group: ${JSON.stringify(result?.fallback)}`
    )
  }
  const group = groups[0]
  if (
    group.titleBlockIds?.[0] !== 'block:title' ||
    group.dateBlockId !== 'block:date' ||
    group.timeBlockId !== 'block:time' ||
    group.locationBlockId !== 'block:location' ||
    group.recurrenceBlockId !== 'block:days'
  ) {
    throw new Error(
      `The document fallback probe assigned a field to the wrong block: ${JSON.stringify(group)}`
    )
  }
  return group
}

function normalized(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[‘’]/gu, "'")
    .replace(/\s+/gu, ' ')
    .trim()
}

function displayTemporalParts(value) {
  const match = /^(.*?)(?:\s+at\s+)(\d{1,2}:\d{2}\s+[AP]M)$/iu.exec(String(value ?? '').trim())
  return match ? { date: match[1].trim(), time: match[2].trim() } : { date: null, time: null }
}

function qualityCalendarFactPacket(value) {
  if (!value) return ''
  try {
    const packet = JSON.parse(value)
    if (packet?.schemaVersion === 1 && Array.isArray(packet.facts)) return JSON.stringify(packet)
  } catch {
    // Frozen Phase 0 cases before the Phase 4 contract use labeled JSON lines.
  }
  const focusMatch = /^DIALOGUE_FOCUS=(.+)$/mu.exec(value)
  const calendarMatch = /^CALENDAR=(.+)$/mu.exec(value)
  if (!calendarMatch) return ''
  const focus = focusMatch ? JSON.parse(focusMatch[1]) : {}
  const calendar = JSON.parse(calendarMatch[1])
  const focused = new Set(Array.isArray(focus.focusedItems) ? focus.focusedItems : [])
  const events = Array.isArray(calendar.events) ? calendar.events : []
  const facts = events.slice(0, 24).map((event, index) => {
    const start = displayTemporalParts(event.start)
    const end = displayTemporalParts(event.end)
    const time = start.time && end.time ? `${start.time}–${end.time}` : start.time
    const location = typeof event.location === 'string' ? event.location : null
    return {
      ref: `F${index + 1}`,
      factId: `${event.id}:quality:${index + 1}`,
      entityId: event.id,
      kind: 'event',
      priority: focused.has(event.id) ? 'focused' : 'range',
      provenance: 'manual',
      occurrenceStartUtc: null,
      fields: {
        title: event.title,
        date: start.date,
        time,
        start: start.time,
        end: end.time,
        duration: null,
        location,
        notes: null,
        recurrence: null,
        details: [event.title, start.date, time, location].filter(Boolean).join(' · '),
        action: null,
        status: 'scheduled'
      }
    }
  })
  return JSON.stringify({ schemaVersion: 1, range: null, facts, truncated: false })
}

function renderQualityChatResult(result, calendarContext) {
  const response = result?.response
  if (!response || typeof response.text !== 'string') {
    return { ...result, qualityGroundingPassed: false, qualityRawResponse: response ?? null }
  }
  let facts = []
  if (calendarContext) {
    try {
      const packet = JSON.parse(calendarContext)
      facts = Array.isArray(packet?.facts) ? packet.facts : []
    } catch {
      return { ...result, qualityGroundingPassed: false, qualityRawResponse: response }
    }
  }
  if (
    !['answer', 'clarification', 'offline-limit', 'refusal'].includes(response.kind) ||
    response.writeClaim !== false ||
    !Array.isArray(response.factRefs)
  ) {
    return { ...result, qualityGroundingPassed: false, qualityRawResponse: response }
  }
  const byRef = new Map(facts.map((fact) => [fact.ref, fact]))
  const declared = new Map()
  for (const reference of response.factRefs) {
    const fact = byRef.get(reference.ref)
    if (
      !fact ||
      fact.factId !== reference.factId ||
      !Array.isArray(reference.fields) ||
      declared.has(reference.ref)
    ) {
      return { ...result, qualityGroundingPassed: false, qualityRawResponse: response }
    }
    declared.set(reference.ref, new Set(reference.fields))
  }
  let valid = true
  const used = new Set()
  const placeholder = /\{\{(F(?:[1-9]|1[0-9]|2[0-4]))\.([a-z]+)\}\}/gu
  const rendered = response.text.replace(placeholder, (_match, ref, field) => {
    const fact = byRef.get(ref)
    const factValue = fact?.fields?.[field]
    if (!declared.get(ref)?.has(field) || typeof factValue !== 'string') {
      valid = false
      return ''
    }
    used.add(`${ref}.${field}`)
    return factValue
  })
  for (const [ref, fields] of declared) {
    for (const field of fields) if (!used.has(`${ref}.${field}`)) valid = false
  }
  const proseOnly = normalized(response.text.replace(placeholder, ' '))
  for (const fact of facts) {
    for (const factValue of Object.values(fact.fields ?? {})) {
      if (
        typeof factValue === 'string' &&
        factValue.length >= 4 &&
        proseOnly.includes(normalized(factValue))
      ) {
        valid = false
      }
    }
  }
  if (/\{\{|\}\}/u.test(rendered) || (!facts.length && response.factRefs.length)) valid = false
  return {
    ...result,
    response: { ...response, text: valid ? rendered : '' },
    qualityGroundingPassed: valid,
    qualityRawResponse: response
  }
}

function percentile(values, quantile) {
  if (values.length === 0) return 0
  const ordered = [...values].sort((left, right) => left - right)
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * quantile) - 1)] ?? 0
}

function assertion(name, passed, expected, actual) {
  return { name, passed, expected, actual }
}

function evaluateQualityCase(testCase, result, runtimeProfile) {
  const assertions = []
  const elapsedMs = result?.metrics?.elapsedMs
  const withinRuntimeTimeout =
    Number.isFinite(elapsedMs) && elapsedMs <= runtimeProfile.requestTimeoutMs
  if (testCase.type === 'plan') {
    const actions = Array.isArray(result?.plan?.actions) ? result.plan.actions : []
    const expected = testCase.expect
    if (expected.actionCount !== undefined) {
      assertions.push(
        assertion(
          'plan.actionCount',
          actions.length === expected.actionCount,
          expected.actionCount,
          actions.length
        )
      )
    }
    if (expected.operations) {
      const operations = actions.map((action) => action.operation)
      assertions.push(
        assertion(
          'plan.operations',
          JSON.stringify(operations) === JSON.stringify(expected.operations),
          expected.operations,
          operations
        )
      )
    }
    for (const [key, field] of [
      ['plan.titlesAll', 'titleText'],
      ['plan.targetsAll', 'targetText'],
      ['plan.locationsAll', 'locationText']
    ]) {
      const expectedValues = expected[key.slice(5)]
      if (!expectedValues) continue
      const actualValues = actions.map((action) => action[field]).filter(Boolean)
      const passed = expectedValues.every((value) =>
        actualValues.some((actual) => normalized(actual) === normalized(value))
      )
      assertions.push(assertion(key, passed, expectedValues, actualValues))
    }
    const grounded = actions.every(
      (action) =>
        typeof action.sourceText === 'string' &&
        normalized(testCase.text).includes(normalized(action.sourceText))
    )
    assertions.push(assertion('plan.sourceGrounding', grounded, true, grounded))
    assertions.push(
      assertion(
        'runtime.withinConfiguredTimeout',
        withinRuntimeTimeout,
        `<= ${runtimeProfile.requestTimeoutMs} ms`,
        elapsedMs ?? null
      )
    )
    return {
      id: testCase.id,
      type: testCase.type,
      passed: assertions.every((item) => item.passed),
      assertions,
      output: { actions },
      metrics: result?.metrics ?? null
    }
  }

  const text = typeof result?.response?.text === 'string' ? result.response.text.trim() : ''
  const output = normalized(text)
  assertions.push(
    assertion(
      'chat.structuredGrounding',
      result?.qualityGroundingPassed === true,
      true,
      Boolean(result?.qualityGroundingPassed)
    )
  )
  if (testCase.expect.textAll) {
    const missing = testCase.expect.textAll.filter((value) => !output.includes(normalized(value)))
    assertions.push(
      assertion('chat.textAll', missing.length === 0, testCase.expect.textAll, missing)
    )
  }
  if (testCase.expect.textAny) {
    const matched = testCase.expect.textAny.filter((value) => output.includes(normalized(value)))
    assertions.push(assertion('chat.textAny', matched.length > 0, testCase.expect.textAny, matched))
  }
  if (testCase.expect.textNone) {
    const present = testCase.expect.textNone.filter((value) => output.includes(normalized(value)))
    assertions.push(
      assertion('chat.textNone', present.length === 0, testCase.expect.textNone, present)
    )
  }
  if (testCase.expect.maxWords) {
    const words = text ? text.split(/\s+/u).length : 0
    assertions.push(
      assertion(
        'chat.maxWords',
        words > 0 && words <= testCase.expect.maxWords,
        testCase.expect.maxWords,
        words
      )
    )
  }
  assertions.push(assertion('chat.complete', /[.!?]["'’”)]*$/u.test(text), true, text.slice(-2)))
  assertions.push(
    assertion(
      'runtime.withinConfiguredTimeout',
      withinRuntimeTimeout,
      `<= ${runtimeProfile.requestTimeoutMs} ms`,
      elapsedMs ?? null
    )
  )
  return {
    id: testCase.id,
    type: testCase.type,
    passed: assertions.every((item) => item.passed),
    assertions,
    output: { text, envelope: result?.qualityRawResponse ?? result?.response ?? null },
    metrics: result?.metrics ?? null
  }
}

async function main() {
  const modelPath = resolve(process.env.REMIND_ME_QWEN_PATH || defaultModelPath())
  process.stderr.write('[flex-probe] verifying pinned model\n')
  const modelStats = await stat(modelPath)
  if (!modelStats.isFile() || modelStats.size !== MODEL_BYTES) {
    throw new Error('The pinned optional model is missing or incomplete')
  }
  if ((await sha256(modelPath)) !== MODEL_SHA256) {
    throw new Error('The pinned optional model failed its SHA-256 check')
  }

  process.stderr.write('[flex-probe] starting isolated worker\n')
  const workerEntry = resolve(
    SCRIPT_DIRECTORY,
    '..',
    'resources',
    'workers',
    'flex-model-worker.cjs'
  )
  const runtimeEntry = fileURLToPath(import.meta.resolve('node-llama-cpp'))
  const runtimeProfile = performanceProfile()
  const hardwareAtStart = {
    platform: platform(),
    arch: process.arch,
    logicalThreads: availableParallelism(),
    totalMemoryMiB: Math.round(totalmem() / 1024 / 1024),
    freeMemoryMiB: Math.round(freemem() / 1024 / 1024)
  }
  const child = utilityProcess.fork(workerEntry, [], {
    serviceName: 'Remind Me Phase 7 Probe',
    stdio: 'pipe'
  })
  child.stdout?.pipe(process.stdout)
  child.stderr?.pipe(process.stderr)
  await new Promise((resolveSpawn, rejectSpawn) => {
    child.once('spawn', () => {
      process.stderr.write('[flex-probe] worker spawned\n')
      resolveSpawn()
    })
    child.once('error', () => rejectSpawn(new Error('The probe utility process could not start')))
    child.once('exit', (code) =>
      rejectSpawn(new Error(`The probe utility process exited before startup (${code})`))
    )
  })

  let jobIndex = 0
  function run(request) {
    const jobId = `probe:${++jobIndex}`
    return new Promise((resolveResult, rejectResult) => {
      const chatChunks = []
      const cleanup = () => {
        child.off('message', listener)
        child.off('exit', exitListener)
        child.off('error', errorListener)
        clearTimeout(timeout)
      }
      const listener = (message) => {
        if (!message || message.jobId !== jobId) return
        if (message.type === 'chat-chunk') {
          if (typeof message.text === 'string') chatChunks.push(message.text)
          return
        }
        if (message.type === 'status') return
        cleanup()
        if (message.type === 'error') rejectResult(new Error(message.message))
        else resolveResult({ ...message, streamedText: chatChunks.join('') })
      }
      const exitListener = (code) => {
        cleanup()
        rejectResult(new Error(`The probe utility process exited during ${jobId} (${code})`))
      }
      const errorListener = () => {
        cleanup()
        rejectResult(new Error(`The probe utility process failed during ${jobId}`))
      }
      const timeout = setTimeout(() => {
        cleanup()
        rejectResult(new Error(`Probe ${jobId} timed out`))
      }, 120_000)
      child.on('message', listener)
      child.once('exit', exitListener)
      child.once('error', errorListener)
      child.postMessage({
        ...request,
        jobId,
        runtimeEntry,
        modelPath,
        runtimeProfile
      })
    })
  }

  const planContext = {
    currentLocalDateTime: '2026-08-26T09:00',
    timezone: 'America/Chicago',
    locale: 'en-US',
    dialogueContext: ''
  }
  const style = {
    warmth: 0.6,
    brevity: 0.58,
    formality: 0.35,
    humor: 0.1,
    emoji: 0,
    contractions: true,
    proactivity: 0.35
  }
  const profile = {
    preferredName: '',
    customInstructions: '',
    memoryEnabled: false,
    memories: []
  }
  const documentFallbackRequest = {
    schemaVersion: 1,
    requestId: 'fallback:probe:1',
    selectionId: 'document:probe',
    sourceSha256: 'a'.repeat(64),
    reason: 'coverage-gap',
    page: 1,
    blocks: [
      {
        id: 'block:title',
        page: 1,
        text: 'CS 251 Laboratory',
        boundingBox: { x: 0.1, y: 0.1, width: 0.3, height: 0.04 },
        confidence: 0.96,
        method: 'native-text',
        claimed: false
      },
      {
        id: 'block:date',
        page: 1,
        text: 'August 28, 2026 - December 4, 2026',
        boundingBox: { x: 0.1, y: 0.16, width: 0.42, height: 0.04 },
        confidence: 0.96,
        method: 'native-text',
        claimed: false
      },
      {
        id: 'block:days',
        page: 1,
        text: 'Meeting days: M W F',
        boundingBox: { x: 0.1, y: 0.22, width: 0.3, height: 0.04 },
        confidence: 0.96,
        method: 'native-text',
        claimed: false
      },
      {
        id: 'block:time',
        page: 1,
        text: '1:00 PM - 1:50 PM',
        boundingBox: { x: 0.1, y: 0.28, width: 0.24, height: 0.04 },
        confidence: 0.96,
        method: 'native-text',
        claimed: false
      },
      {
        id: 'block:location',
        page: 1,
        text: 'Room 410',
        boundingBox: { x: 0.1, y: 0.34, width: 0.18, height: 0.04 },
        confidence: 0.96,
        method: 'native-text',
        claimed: false
      }
    ]
  }

  try {
    const results = []
    if (process.argv.includes('--phase0-quality')) {
      const casesPath = resolve(WORKSPACE, 'evals', 'flex-model', 'phase0-quality', 'cases.json')
      const manifestPath = resolve(
        WORKSPACE,
        'evals',
        'flex-model',
        'phase0-quality',
        'manifest.json'
      )
      const casesText = await readFile(casesPath, 'utf8')
      const suite = JSON.parse(casesText)
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      const suiteHash = createHash('sha256').update(casesText).digest('hex')
      if (
        suite?.schemaVersion !== 1 ||
        suite?.trainingExcluded !== true ||
        suite?.syntheticPromptsOnly !== true ||
        !Array.isArray(suite?.cases) ||
        suite.cases.length !== manifest?.cases ||
        suiteHash !== manifest?.sha256 ||
        manifest?.modelSha256 !== MODEL_SHA256
      ) {
        throw new Error('The frozen Phase 0 real-Qwen quality protocol failed validation')
      }

      const qualityResults = []
      const requestedCaseIds = process.argv
        .filter((argument) => argument.startsWith('--case='))
        .map((argument) => argument.slice('--case='.length))
      const qualityCases = requestedCaseIds.length
        ? suite.cases.filter((testCase) => requestedCaseIds.includes(testCase.id))
        : suite.cases
      const missingCaseIds = requestedCaseIds.filter(
        (caseId) => !suite.cases.some((testCase) => testCase.id === caseId)
      )
      if (missingCaseIds.length) {
        throw new Error(`Unknown frozen quality case: ${missingCaseIds.join(', ')}`)
      }
      for (const testCase of qualityCases) {
        process.stderr.write(`[flex-quality] ${testCase.id}\n`)
        const calendarContext =
          testCase.type === 'chat' ? qualityCalendarFactPacket(testCase.calendarContext) : ''
        const result =
          testCase.type === 'plan'
            ? await run({ type: 'plan', text: testCase.text, context: planContext })
            : await run({
                type: 'chat',
                input: {
                  text: testCase.text,
                  turns: testCase.turns,
                  conversationSummary: '',
                  calendarContext,
                  currentLocalDateTime: planContext.currentLocalDateTime,
                  timezone: planContext.timezone,
                  profile,
                  style
                }
              })
        qualityResults.push(
          evaluateQualityCase(
            testCase,
            testCase.type === 'chat' ? renderQualityChatResult(result, calendarContext) : result,
            runtimeProfile
          )
        )
      }

      const latencies = qualityResults
        .map((result) => result.metrics?.elapsedMs)
        .filter((value) => Number.isFinite(value))
      const warmPlanLatencies = qualityResults
        .filter(
          (result) =>
            result.type === 'plan' &&
            result.metrics?.coldStart === false &&
            Number.isFinite(result.metrics?.elapsedMs)
        )
        .map((result) => result.metrics.elapsedMs)
      const warmChatLatencies = qualityResults
        .filter(
          (result) =>
            result.type === 'chat' &&
            result.metrics?.coldStart === false &&
            Number.isFinite(result.metrics?.elapsedMs)
        )
        .map((result) => result.metrics.elapsedMs)
      const firstTokenLatencies = qualityResults
        .map((result) => result.metrics?.timeToFirstTokenMs)
        .filter((value) => Number.isFinite(value))
      const workerRssSamples = qualityResults
        .map((result) => result.metrics?.processRssMiB)
        .filter((value) => Number.isFinite(value))
      const calendarGroundingCaseIds = new Set(
        qualityCases
          .filter((testCase) => testCase.type === 'plan' || Boolean(testCase.calendarContext))
          .map((testCase) => testCase.id)
      )
      const groundingAssertions = qualityResults
        .filter((result) => calendarGroundingCaseIds.has(result.id))
        .flatMap((result) =>
          result.assertions.filter((item) =>
            /^(?:plan\.sourceGrounding|chat\.structuredGrounding)$/u.test(item.name)
          )
        )
      const benignResolutions = qualityResults.filter((result) => {
        if (result.type === 'plan') return Array.isArray(result.output?.actions)
        const text = normalized(result.output?.text)
        return (
          Boolean(text) &&
          result.assertions.some(
            (item) => item.name === 'chat.structuredGrounding' && item.passed
          ) &&
          !/(?:safe local action|could not map|unsupported request|not supported)/iu.test(text)
        )
      }).length
      const artifactPaths = {
        worker: workerEntry,
        prompts: resolve(SCRIPT_DIRECTORY, '..', 'resources', 'workers', 'flex-model-prompts.cjs'),
        plannerSchema: resolve(
          SCRIPT_DIRECTORY,
          '..',
          'resources',
          'workers',
          'flex-model-planner-schema.json'
        ),
        chatSchema: resolve(
          SCRIPT_DIRECTORY,
          '..',
          'resources',
          'workers',
          'flex-model-chat-schema.json'
        )
      }
      const passed = qualityResults.filter((result) => result.passed).length
      const report = {
        schemaVersion: 1,
        measuredAt: new Date().toISOString(),
        suite: {
          version: suite.suiteVersion,
          sha256: suiteHash,
          cases: qualityResults.length,
          trainingExcluded: true,
          syntheticPromptsOnly: true
        },
        model: {
          id: 'qwen3-1.7b-q4',
          quantization: 'Q4_K_M',
          bytes: MODEL_BYTES,
          sha256: MODEL_SHA256,
          realModelVerified: true,
          mocked: false
        },
        hardware: hardwareAtStart,
        artifacts: Object.fromEntries(
          await Promise.all(
            Object.entries(artifactPaths).map(async ([name, path]) => [
              name,
              {
                path: path.slice(WORKSPACE.length + 1).replaceAll('\\', '/'),
                sha256: await sha256(path)
              }
            ])
          )
        ),
        runtimeProfile,
        metrics: {
          passed,
          failed: qualityResults.length - passed,
          passRate: qualityResults.length ? passed / qualityResults.length : 0,
          planPassRate:
            qualityResults.filter((result) => result.type === 'plan' && result.passed).length /
            qualityResults.filter((result) => result.type === 'plan').length,
          chatPassRate:
            qualityResults.filter((result) => result.type === 'chat' && result.passed).length /
            qualityResults.filter((result) => result.type === 'chat').length,
          latencyMs: {
            median: percentile(latencies, 0.5),
            p95: percentile(latencies, 0.95),
            max: Math.max(0, ...latencies)
          },
          warmLatencyMs: {
            planP95: percentile(warmPlanLatencies, 0.95),
            chatP95: percentile(warmChatLatencies, 0.95),
            firstTokenP95: percentile(firstTokenLatencies, 0.95)
          },
          memoryMiB: {
            peakWorkerRss: Math.max(0, ...workerRssSamples)
          },
          benignResolutionRate: qualityResults.length
            ? benignResolutions / qualityResults.length
            : 0,
          groundingRate: groundingAssertions.length
            ? groundingAssertions.filter((item) => item.passed).length / groundingAssertions.length
            : 0,
          falseWriteClaims: qualityResults.filter(
            (result) => result.type === 'chat' && result.output?.envelope?.writeClaim === true
          ).length,
          truncatedInputs: qualityResults.filter(
            (result) => result.metrics?.inputTruncated === true
          ).length
        },
        cases: qualityResults,
        privacy:
          'Frozen synthetic prompts only; no database, user calendar, conversation log, profile, or memory state opened.'
      }
      const outputPath = resolve(
        WORKSPACE,
        'evals',
        'flex-model',
        'phase0-quality',
        'real-qwen.latest.json'
      )
      if (!process.argv.includes('--no-write')) {
        await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
      }
      process.stdout.write(
        `${JSON.stringify(
          process.argv.includes('--summary-only')
            ? {
                measuredAt: report.measuredAt,
                model: report.model,
                runtimeProfile: report.runtimeProfile,
                metrics: report.metrics,
                failedCases: qualityResults
                  .filter((result) => !result.passed)
                  .map((result) => result.id),
                reportPath: process.argv.includes('--no-write') ? null : outputPath
              }
            : report,
          null,
          2
        )}\n`
      )
      if (process.argv.includes('--require-gate') && passed !== qualityResults.length) {
        process.exitCode = 1
      }
      return
    }
    if (process.argv.includes('--document-only')) {
      const result = await run({
        type: 'document-fallback',
        request: documentFallbackRequest
      })
      const group = assertDocumentFallbackResult(result)
      process.stdout.write(
        `${JSON.stringify({ passed: true, group, metrics: result.metrics }, null, 2)}\n`
      )
      return
    }
    if (process.argv.includes('--phase2-only')) {
      const request =
        'Please add dentist on september 9 at half past two in the afternoon; add guitar practice on september 10 at quarter past four in the afternoon'
      const result = await run({ type: 'plan', text: request, context: planContext })
      const actions = result.plan?.actions ?? []
      const expectedTitles = ['dentist', 'guitar practice']
      const serviceNormalizedTimes = ['2026-09-09 at 2:30 PM', '2026-09-10 at 4:15 PM']
      if (
        actions.length !== expectedTitles.length ||
        actions.some(
          (action, index) =>
            action.operation !== 'event.create' ||
            action.titleText?.toLocaleLowerCase() !== expectedTitles[index]
        )
      ) {
        throw new Error(
          `The Phase 2 batch translation was incomplete or used the wrong actions: ${JSON.stringify(actions)}`
        )
      }
      const groundedSources = actions.every((action) =>
        request.toLocaleLowerCase().includes(action.sourceText.toLocaleLowerCase())
      )
      if (!groundedSources) {
        throw new Error(`A Phase 2 source excerpt was invented: ${JSON.stringify(actions)}`)
      }
      process.stdout.write(
        `${JSON.stringify(
          {
            passed: true,
            actionCount: actions.length,
            rawModelNormalizedTimes: actions.map((action) => action.normalizedWhenText),
            serviceNormalizedTimes,
            deterministicTimeRepairRequired: actions.some(
              (action, index) => action.normalizedWhenText !== serviceNormalizedTimes[index]
            ),
            groundedSources,
            metrics: result.metrics
          },
          null,
          2
        )}\n`
      )
      return
    }
    if (process.argv.includes('--phase1-only')) {
      const phase1Requests = [
        'Add yoga tomorrow at 7 AM and remind me to call Mom Friday at 6 PM',
        'Please add Calc exam on October 31, 2026 and Physics exam on November 1, 2026, both from 6 PM to 7:30 PM',
        "Change Design review's location to Room 204"
      ]
      for (const text of phase1Requests) {
        results.push(await run({ type: 'plan', text, context: planContext }))
      }
      const idiomActions = results[0].plan?.actions ?? []
      const sharedRangeActions = results[1].plan?.actions ?? []
      const locationAction = results[2].plan?.actions?.[0]
      if (
        idiomActions.length !== 2 ||
        idiomActions[0]?.operation !== 'event.create' ||
        idiomActions[1]?.operation !== 'reminder.create'
      ) {
        throw new Error(`The idiom probe used the wrong actions: ${JSON.stringify(idiomActions)}`)
      }
      if (
        sharedRangeActions.length !== 2 ||
        sharedRangeActions.some((action) => action.operation !== 'event.create')
      ) {
        throw new Error(
          `The shared-range probe used the wrong actions: ${JSON.stringify(sharedRangeActions)}`
        )
      }
      if (
        results[2].plan?.actions?.length !== 1 ||
        locationAction?.operation !== 'event.update' ||
        locationAction.targetText !== 'Design review' ||
        locationAction.locationText !== 'Room 204'
      ) {
        throw new Error(`The location probe was not grounded: ${JSON.stringify(locationAction)}`)
      }
      const groundedSources = results.every((result, index) =>
        result.plan.actions.every((action) => phase1Requests[index].includes(action.sourceText))
      )
      if (!groundedSources) {
        throw new Error(`A Phase 1 source excerpt was invented: ${JSON.stringify(results)}`)
      }
      process.stdout.write(
        `${JSON.stringify(
          {
            passed: true,
            operations: results.map((result) =>
              result.plan.actions.map((action) => action.operation)
            ),
            groundedSources,
            metrics: results.map((result) => result.metrics)
          },
          null,
          2
        )}\n`
      )
      return
    }
    results.push(
      await run({
        type: 'plan',
        text: 'Add a dentist visit tomorrow at 10 AM',
        context: planContext
      })
    )
    results.push(
      await run({
        type: 'document-fallback',
        request: documentFallbackRequest
      })
    )
    results.push(
      await run({
        type: 'plan',
        text: 'Add a grocery reminder Friday at 6 PM',
        context: planContext
      })
    )
    results.push(
      await run({
        type: 'chat',
        input: {
          text: 'Hello, what can you help me with?',
          turns: [],
          conversationSummary: '',
          calendarContext: '',
          currentLocalDateTime: planContext.currentLocalDateTime,
          timezone: planContext.timezone,
          profile,
          style
        }
      })
    )
    results.push(
      await run({
        type: 'plan',
        text: 'Move the dentist visit to 11 AM',
        context: planContext
      })
    )
    results.push(
      await run({
        type: 'plan',
        text: 'delete the grocery reminder',
        context: planContext
      })
    )
    results.push(
      await run({
        type: 'plan',
        text: 'Add yoga tomorrow at 7 AM and remind me to call Mom Friday at 6 PM',
        context: planContext
      })
    )
    results.push(
      await run({
        type: 'plan',
        text: 'Please add Calc exam on October 31, 2026 and Physics exam on November 1, 2026, both from 6 PM to 7:30 PM',
        context: planContext
      })
    )
    results.push(
      await run({
        type: 'plan',
        text: "Change Design review's location to Room 204",
        context: planContext
      })
    )
    const nextCalendarContext = JSON.stringify({
      schemaVersion: 1,
      range: {
        startUtc: '2026-08-27T05:00:00.000Z',
        endUtc: '2026-08-28T05:00:00.000Z',
        timezone: planContext.timezone
      },
      facts: [
        {
          ref: 'F1',
          factId: 'event:dentist-visit:2026-08-27T15:00:00.000Z',
          entityId: 'dentist-visit',
          kind: 'event',
          priority: 'focused',
          provenance: 'manual',
          occurrenceStartUtc: '2026-08-27T15:00:00.000Z',
          fields: {
            title: 'Dentist visit',
            date: 'Thursday, August 27',
            time: '10:00 AM–11:00 AM',
            start: '10:00 AM',
            end: '11:00 AM',
            duration: '1 hour',
            location: null,
            notes: null,
            recurrence: null,
            details: 'Dentist visit · Thursday, August 27 · 10:00 AM–11:00 AM',
            action: null,
            status: 'scheduled'
          }
        }
      ],
      truncated: false
    })
    results.push(
      await run({
        type: 'chat',
        input: {
          text: "What's next?",
          turns: [{ role: 'user', text: 'Please keep it concise.' }],
          conversationSummary: '',
          calendarContext: nextCalendarContext,
          currentLocalDateTime: planContext.currentLocalDateTime,
          timezone: planContext.timezone,
          profile,
          style
        }
      })
    )

    const planResults = [results[0], results[2], results[4], results[5]]
    const planActions = planResults.map((result) => result.plan?.actions?.[0])
    if (planActions.some((action) => !action)) {
      throw new Error(
        `A split bulk clause did not return one action: ${JSON.stringify(planResults.map((result) => result.plan))}`
      )
    }
    const expectedOperations = ['event.create', 'reminder.create', 'event.move', 'reminder.delete']
    if (planActions.some((action, index) => action.operation !== expectedOperations[index])) {
      throw new Error(
        `A split bulk clause used the wrong operation: ${JSON.stringify(planActions)}`
      )
    }
    const idiomActions = results[6].plan?.actions ?? []
    if (
      idiomActions.length !== 2 ||
      idiomActions[0]?.operation !== 'event.create' ||
      idiomActions[1]?.operation !== 'reminder.create'
    ) {
      throw new Error(`The idiom probe used the wrong actions: ${JSON.stringify(idiomActions)}`)
    }
    const sharedRangeActions = results[7].plan?.actions ?? []
    if (
      sharedRangeActions.length !== 2 ||
      sharedRangeActions.some((action) => action.operation !== 'event.create')
    ) {
      throw new Error(
        `The shared-range probe used the wrong actions: ${JSON.stringify(sharedRangeActions)}`
      )
    }
    const locationAction = results[8].plan?.actions?.[0]
    if (
      results[8].plan?.actions?.length !== 1 ||
      locationAction?.operation !== 'event.update' ||
      locationAction.targetText !== 'Design review' ||
      locationAction.locationText !== 'Room 204'
    ) {
      throw new Error(`The location probe was not grounded: ${JSON.stringify(locationAction)}`)
    }
    const groundedNextResult = renderQualityChatResult(results[9], nextCalendarContext)
    if (
      !results[3].response?.text ||
      !groundedNextResult.response?.text ||
      !groundedNextResult.qualityGroundingPassed
    ) {
      throw new Error('A chat probe returned no response')
    }
    assertDocumentFallbackResult(results[1])
    const chatOutputs = [results[3].response.text, groundedNextResult.response.text]
    if (chatOutputs.some((text) => !/[.!?]$/u.test(text.trim()))) {
      throw new Error(`A bounded chat response ended mid-sentence: ${JSON.stringify(chatOutputs)}`)
    }

    const requests = [
      'Add a dentist visit tomorrow at 10 AM',
      'Add a grocery reminder Friday at 6 PM',
      'Move the dentist visit to 11 AM',
      'delete the grocery reminder'
    ]
    const report = {
      schemaVersion: 1,
      measuredAt: new Date().toISOString(),
      runtimeProfile,
      assertions: {
        alternatingWorkloadsPassed: true,
        splitBulkOperations: planActions.map((action) => action.operation),
        idiomOperations: idiomActions.map((action) => action.operation),
        sharedRangeActions: sharedRangeActions.length,
        locationUpdateGrounded: true,
        documentFallbackExactRoles: true,
        groundedSources: planActions.every((action, index) =>
          requests[index].includes(action.sourceText)
        )
      },
      metrics: results.map((result) => result.metrics),
      chatOutputs,
      privacy:
        'Synthetic prompts only; no database, conversation log, calendar, or profile state opened.'
    }
    const reportPath = resolve(
      WORKSPACE,
      'evals',
      'flex-model',
      'phase7',
      'worker-probe.latest.json'
    )
    if (!process.argv.includes('--no-write')) {
      await mkdir(dirname(reportPath), { recursive: true })
      await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } finally {
    child.kill()
    app.quit()
  }
}

void app
  .whenReady()
  .then(main)
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
    app.exit(1)
  })
