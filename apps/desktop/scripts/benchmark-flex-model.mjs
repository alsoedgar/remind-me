import console from 'node:console'
import { readFile } from 'node:fs/promises'
import { cpus, freemem, totalmem } from 'node:os'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { URL } from 'node:url'

const args = new Map(
  process.argv.slice(2).map((entry) => {
    const [key, ...value] = entry.replace(/^--/, '').split('=')
    return [key, value.join('=') || 'true']
  })
)

const modelPath = resolve(args.get('model') || '')
if (!args.get('model')) {
  throw new Error('Pass the installed GGUF path with --model=<path>')
}

const mode = args.get('mode') === 'plan' ? 'plan' : 'chat'
const gpuArg = args.get('gpu') || 'false'
const gpu = gpuArg === 'false' ? false : gpuArg === 'true' ? 'auto' : gpuArg
const threads = Number(args.get('threads') || Math.max(2, Math.min(8, cpus().length - 1)))
const contextSize = Number(args.get('context') || 8192)
const batchSize = Number(args.get('batch') || 256)
const maxTokens = Number(args.get('tokens') || (mode === 'plan' ? 640 : 80))
const rounds = Number(args.get('rounds') || 1)
const planRequest =
  args.get('request') || 'Add my CS 251 lab tomorrow at 1pm, and my calculus discussion at 2pm.'
const flashArg = args.get('flash') || 'false'
const flashAttention = flashArg === 'true' ? true : flashArg === 'auto' ? 'auto' : false

const elapsed = (startedAt) => Math.round((performance.now() - startedAt) * 10) / 10
const timings = {}
let llama
let model
let context
let session

try {
  let startedAt = performance.now()
  const runtime = await import('node-llama-cpp')
  timings.importMs = elapsed(startedAt)

  startedAt = performance.now()
  llama = await runtime.getLlama({
    gpu,
    build: 'never',
    skipDownload: true,
    progressLogs: false,
    logLevel: runtime.LlamaLogLevel.error,
    maxThreads: threads
  })
  timings.backendMs = elapsed(startedAt)

  startedAt = performance.now()
  model = await llama.loadModel({
    modelPath,
    gpuLayers: gpu === false ? 0 : 'auto',
    useMmap: true
  })
  timings.modelMs = elapsed(startedAt)

  startedAt = performance.now()
  context = await model.createContext({
    contextSize,
    batchSize,
    flashAttention,
    threads
  })
  timings.contextMs = elapsed(startedAt)

  session = new runtime.LlamaChatSession({
    contextSequence: context.getSequence(),
    systemPrompt:
      'You are Remind Me, a private local assistant. Follow the explicit TASK label. ' +
      'In PLAN, output only grounded JSON. In CHAT, answer directly, warmly, and concisely. ' +
      'Use only verified calendar facts and user-approved memory.'
  })

  let grammar
  if (mode === 'plan') {
    startedAt = performance.now()
    const schema = JSON.parse(
      await readFile(
        new URL('../resources/workers/flex-model-planner-schema.json', import.meta.url)
      )
    )
    grammar = await llama.createGrammarForJsonSchema(schema)
    timings.grammarMs = elapsed(startedAt)
  }

  const prompt =
    mode === 'plan'
      ? `/no_think
TASK: PLAN
CURRENT LOCAL DATE AND TIME: 2026-08-25T12:00
TIMEZONE: America/Chicago
LOCALE: en-US

Act as a conservative calendar command translator. Understand colloquial meaning, not just command words. Classify requests as event.create, event.move, event.update, event.duplicate, event.delete, reminder.create, reminder.update, reminder.complete, reminder.delete, calendar.list, calendar.search, calendar.availability, calendar.conflicts, or assistant.unsupported. Return 1 to 8 actions in source order. Split every requested add, modification, move, copy, completion, or deletion into its own action. For one intent, copy the full request into sourceText. For multiple intents, copy exact non-overlapping clauses in source order. Every supplied sourceText, titleText, targetText, descriptionText, locationText, whenText, and recurrenceText must be an exact contiguous copy from REQUEST. whenText is only the user's exact date, day, time, duration, or date-range phrase. recurrenceText is only the user's exact repeat phrase. For a rename, titleText is the new name and targetText is the old reference. For another mutation, targetText identifies the existing item. descriptionText contains only requested notes; locationText contains only the requested place. Omit every field that does not apply; never write the string "null". normalizedWhenText may translate a supplied whenText using the local clock, but only into one of: YYYY-MM-DD; YYYY-MM-DD all day; YYYY-MM-DD through YYYY-MM-DD all day; YYYY-MM-DD at h:mm AM; YYYY-MM-DD from h:mm AM to h:mm PM; at h:mm AM; or from h:mm AM to h:mm PM. Always include minutes and AM or PM. normalizedRecurrenceText may translate a supplied recurrenceText into: every day, every weekday, every week, every month, every year, every N days/weeks/months/years, or weekly on abbreviated weekday names. A shared date or time applies to later coordinated actions when ordinary language carries it forward.

EXAMPLE LOCAL CLOCK: 2026-08-25T12:00
EXAMPLE REQUEST: Please pencil in yoga tomorrow at half past one.
EXAMPLE JSON: {"actions":[{"sourceText":"Please pencil in yoga tomorrow at half past one.","operation":"event.create","titleText":"yoga","whenText":"tomorrow at half past one","normalizedWhenText":"2026-08-26 at 1:30 PM"}]}
Notice that whenText is copied from the request; only normalizedWhenText contains the translated date and time. Do not copy example values.

BEGIN REQUEST
${planRequest}
END REQUEST`
      : '/no_think\nTASK: CHAT\nCURRENT LOCAL DATE AND TIME: 2026-08-25T12:00:00-05:00\nTIMEZONE: America/Chicago\nRECENT CONVERSATION:\n(none)\n\nVERIFIED LOCAL CALENDAR DATA:\nTomorrow: CS 251 lab at 1:00 PM in SEO 1000; Calculus discussion at 2:00 PM in SES 130.\n\nCURRENT USER MESSAGE:\nWhat does tomorrow look like, and when should I leave if I want 15 minutes before my first class?\n\nAnswer directly and naturally.'

  const samples = []
  for (let round = 0; round < rounds; round += 1) {
    session.resetChatHistory()
    const beforeInput = session.sequence.tokenMeter.usedInputTokens
    const beforeOutput = session.sequence.tokenMeter.usedOutputTokens
    startedAt = performance.now()
    const output = await session.prompt(prompt, {
      ...(grammar ? { grammar } : {}),
      budgets: { thoughtTokens: 0 },
      maxTokens,
      temperature: grammar ? 0 : 0.7,
      ...(grammar ? { seed: 17 } : { topK: 20, topP: 0.8 })
    })
    const promptMs = elapsed(startedAt)
    const inputTokens = session.sequence.tokenMeter.usedInputTokens - beforeInput
    const outputTokens = session.sequence.tokenMeter.usedOutputTokens - beforeOutput
    samples.push({
      round: round + 1,
      promptMs,
      inputTokens,
      outputTokens,
      outputTokensPerSecond:
        Math.round((outputTokens / Math.max(promptMs / 1000, 0.001)) * 100) / 100,
      output: output.replace(/\s+/g, ' ').slice(0, 4000)
    })
  }

  console.log(
    JSON.stringify({
      mode,
      backend: llama.gpu,
      gpuSetting: gpu,
      threads,
      contextSize,
      batchSize,
      flashAttention,
      maxTokens,
      rounds,
      memoryGiB: {
        free: Math.round((freemem() / 1024 ** 3) * 10) / 10,
        total: Math.round((totalmem() / 1024 ** 3) * 10) / 10
      },
      timings,
      samples
    })
  )
} finally {
  session?.dispose({ disposeSequence: true })
  await context?.dispose()
  await model?.dispose()
  await llama?.dispose()
}
