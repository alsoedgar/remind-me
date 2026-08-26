import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, stat, writeFile } from 'node:fs/promises'
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
    return resolve(
      process.env.APPDATA,
      '@remind-me',
      'desktop',
      'optional-models',
      'qwen3-1.7b-q4',
      MODEL_FILE
    )
  }
  if (platform() === 'darwin') {
    return resolve(
      homedir(),
      'Library',
      'Application Support',
      '@remind-me',
      'desktop',
      'optional-models',
      'qwen3-1.7b-q4',
      MODEL_FILE
    )
  }
  return resolve(
    process.env.XDG_CONFIG_HOME || resolve(homedir(), '.config'),
    '@remind-me',
    'desktop',
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
      const cleanup = () => {
        child.off('message', listener)
        child.off('exit', exitListener)
        child.off('error', errorListener)
        clearTimeout(timeout)
      }
      const listener = (message) => {
        if (!message || message.jobId !== jobId) return
        cleanup()
        if (message.type === 'error') rejectResult(new Error(message.message))
        else resolveResult(message)
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

  try {
    const results = []
    results.push(
      await run({
        type: 'plan',
        text: 'Add a dentist visit tomorrow at 10 AM',
        context: planContext
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
        type: 'chat',
        input: {
          text: "What's next?",
          turns: [{ role: 'user', text: 'Please keep it concise.' }],
          calendarContext:
            'The next verified event is Dentist visit on 2026-08-27 from 10:00 AM to 11:00 AM.',
          currentLocalDateTime: planContext.currentLocalDateTime,
          timezone: planContext.timezone,
          profile,
          style
        }
      })
    )

    const planResults = [results[0], results[1], results[3], results[4]]
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
    if (!results[2].response?.text || !results[5].response?.text) {
      throw new Error('A chat probe returned no response')
    }
    const chatOutputs = [results[2].response.text, results[5].response.text]
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
    await mkdir(dirname(reportPath), { recursive: true })
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
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
