import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { arch, cpus, freemem, homedir, platform, totalmem } from 'node:os'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { getLlama, LlamaChatSession, LlamaLogLevel } from 'node-llama-cpp'

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url))
const WORKSPACE = resolve(SCRIPT_DIRECTORY, '..', '..', '..')
const OUTPUT_DIRECTORY = resolve(WORKSPACE, 'ml', 'teacher_assisted', 'raw')
const SPEAK_PREFERENCE_CASES_PATH = resolve(OUTPUT_DIRECTORY, 'remindspeak-preference-cases.json')
const ASSISTANT_CORPUS_DIRECTORY = resolve(WORKSPACE, 'ml', 'assistant_corpus', 'raw')
const ASSISTANT_JOBS_PATH = resolve(ASSISTANT_CORPUS_DIRECTORY, 'teacher-jobs.json')
const ASSISTANT_REPAIR_JOBS_PATH = resolve(ASSISTANT_CORPUS_DIRECTORY, 'teacher-repair-jobs.json')
const REMINDCORE_NEXT_DIRECTORY = resolve(WORKSPACE, 'ml', 'remindcore_next', 'teacher')
const REMINDCORE_NEXT_JOBS_PATH = resolve(REMINDCORE_NEXT_DIRECTORY, 'teacher-jobs.json')
const REMINDCORE_NEXT_REPAIR_JOBS_PATH = resolve(
  REMINDCORE_NEXT_DIRECTORY,
  'teacher-repair-jobs.json'
)
const MODEL_FILE = 'Qwen3-1.7B-Q4_K_M.gguf'
const MODEL_BYTES = 1_282_439_264
const MODEL_SHA256 = 'd2387ca2dbfee2ffabce7120d3770dadca0b293052bc2f0e138fdc940d9bc7b5'
const GENERATOR_VERSION = '0.1.0'
const SEED = 2_608_250

const CORE_SPECS = [
  {
    operation: 'event.create',
    placeholders: ['TITLE', 'DATE', 'TIME', 'RECURRENCE'],
    meaning: 'create one new calendar event with the supplied title, date, time, and repeat rule'
  },
  {
    operation: 'event.duplicate',
    placeholders: ['TARGET', 'DATE', 'TIME', 'RECURRENCE'],
    meaning: 'make another copy of an existing event at the supplied date, time, and repeat rule'
  },
  {
    operation: 'event.update',
    placeholders: ['TARGET', 'TITLE'],
    meaning: 'rename an existing event from the supplied target reference to the supplied new title'
  },
  {
    operation: 'event.move',
    placeholders: ['TARGET', 'DATE', 'TIME'],
    meaning: 'move an existing event to the supplied date and time'
  },
  {
    operation: 'event.delete',
    placeholders: ['TARGET'],
    meaning: 'remove the supplied existing calendar event'
  },
  {
    operation: 'reminder.create',
    placeholders: ['TITLE', 'DATE', 'TIME', 'RECURRENCE'],
    meaning: 'create a reminder with the supplied title, date, time, and repeat rule'
  },
  {
    operation: 'reminder.update',
    placeholders: ['TARGET', 'TITLE'],
    meaning:
      'change the wording of an existing reminder from the supplied target to the supplied new title'
  },
  {
    operation: 'reminder.complete',
    placeholders: ['TARGET'],
    meaning: 'mark the supplied reminder complete'
  },
  {
    operation: 'reminder.delete',
    placeholders: ['TARGET'],
    meaning: 'delete the supplied reminder without referring to a calendar event'
  },
  {
    operation: 'calendar.list',
    placeholders: ['DATE', 'TIME'],
    meaning: 'summarize what is scheduled in the supplied date/time window'
  },
  {
    operation: 'calendar.search',
    placeholders: ['TARGET'],
    meaning: 'find a calendar item matching the supplied target'
  },
  {
    operation: 'calendar.availability',
    placeholders: ['DATE', 'TIME'],
    meaning: 'ask whether the calendar is free in the supplied date/time window'
  },
  {
    operation: 'calendar.conflicts',
    placeholders: ['DATE', 'TIME'],
    meaning: 'ask whether scheduled items overlap in the supplied date/time window'
  }
]

const SPEAK_SPECS = [
  { speechAct: 'proposal', signature: ['SUMMARY'], meaning: 'present an unsaved draft for review' },
  {
    speechAct: 'creation-confirmed',
    signature: ['RECEIPT'],
    meaning: 'confirm a reviewed creation was saved'
  },
  {
    speechAct: 'update-confirmed',
    signature: ['RECEIPT'],
    meaning: 'confirm a reviewed update was saved'
  },
  {
    speechAct: 'deletion-confirmed',
    signature: ['RECEIPT'],
    meaning: 'confirm a reviewed deletion was applied'
  },
  {
    speechAct: 'completion-confirmed',
    signature: ['RECEIPT'],
    meaning: 'confirm a reminder was completed'
  },
  {
    speechAct: 'availability-answer',
    signature: ['SLOT', 'DETAIL'],
    meaning: 'state a verified availability result'
  },
  {
    speechAct: 'schedule-summary',
    signature: ['SUMMARY'],
    meaning: 'summarize verified calendar items'
  },
  {
    speechAct: 'clarification',
    signature: ['DETAIL'],
    meaning: 'ask for a missing detail without implying a write'
  },
  {
    speechAct: 'conversation-clarification',
    signature: ['DETAIL'],
    meaning: 'ask a natural conversational follow-up without calendar safety wording'
  },
  {
    speechAct: 'runtime-unavailable',
    signature: ['DETAIL'],
    meaning: 'explain that the optional local language runtime is unavailable'
  },
  {
    speechAct: 'offline-fact-limit',
    signature: ['DETAIL'],
    meaning: 'explain that a changing external fact cannot be verified offline'
  },
  {
    speechAct: 'policy-boundary',
    signature: ['DETAIL'],
    meaning: 'decline a genuinely disallowed request and offer a safer direction'
  },
  {
    speechAct: 'conflict-warning',
    signature: ['SUMMARY'],
    meaning: 'warn about a verified overlap without changing anything'
  },
  {
    speechAct: 'unsupported',
    signature: ['DETAIL'],
    meaning: 'explain an honest capability boundary'
  },
  { speechAct: 'error', signature: ['DETAIL'], meaning: 'explain a contained local failure' }
]

const CORE_REPAIR_OPERATIONS = ['event.move', 'reminder.create', 'reminder.delete']

const STYLE_TAGS = ['minimal', 'warm', 'formal', 'playful', 'proactive', 'neutral']

function defaultModelPath() {
  if (platform() === 'win32') {
    const appData = process.env.APPDATA
    if (appData) {
      return resolve(
        appData,
        '@remind-me',
        'desktop',
        'optional-models',
        'qwen3-1.7b-q4',
        MODEL_FILE
      )
    }
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
  const bytes = await readFile(path)
  return createHash('sha256').update(bytes).digest('hex')
}

function stablePromptHash(value) {
  return createHash('sha256').update(value).digest('hex')
}

function coreSchema(operations) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['items'],
    properties: {
      items: {
        type: 'array',
        minItems: operations.length * 6,
        maxItems: operations.length * 6,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['operation', 'template', 'register'],
          properties: {
            operation: { type: 'string', enum: operations.map((item) => item.operation) },
            template: { type: 'string', minLength: 8, maxLength: 180 },
            register: {
              type: 'string',
              enum: ['casual', 'indirect', 'voice', 'terse', 'polite', 'conversational']
            }
          }
        }
      }
    }
  }
}

function speakSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['sets'],
    properties: {
      sets: {
        type: 'array',
        minItems: 2,
        maxItems: 2,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['lead', 'bodies', 'close', 'styleTag'],
          properties: {
            lead: { type: 'string', minLength: 1, maxLength: 120 },
            bodies: {
              type: 'array',
              minItems: 2,
              maxItems: 2,
              items: { type: 'string', minLength: 1, maxLength: 180 }
            },
            close: { type: 'string', minLength: 1, maxLength: 120 },
            styleTag: { type: 'string', enum: STYLE_TAGS }
          }
        }
      }
    }
  }
}

function corePrompt(specs) {
  const specification = specs
    .map(
      (item) =>
        `- ${item.operation}: ${item.meaning}. Required markers exactly once each: ${item.placeholders.map((name) => `<${name}>`).join(', ')}`
    )
    .join('\n')
  return `/no_think\nTASK: REMINDCORE_DATA\nGenerate exactly six semantically faithful English request templates for EACH operation below.\n${specification}\n\nRules:\n- A template is a realistic thing a user might type or say to a personal calendar assistant.\n- Preserve every required marker literally, exactly once. Use no other angle-bracket marker.\n- The marker text is opaque data; do not add, remove, rename, split, or normalize it.\n- Keep one intent per template. Do not answer the request.\n- Vary syntax and vocabulary substantially: casual, indirect, voice-like, terse, polite, and conversational.\n- Include less literal but still unambiguous phrasing. Avoid merely adding "please" to the same sentence.\n- Do not include explanations outside the JSON.\n- Return six rows per operation, with the operation copied exactly.`
}

function oodPrompt(batchIndex) {
  const themes = [
    'greetings, capability questions, and casual conversation',
    'writing help, explanations, and knowledge questions',
    'questions about the past or future and non-calendar planning advice',
    'hard calendar-adjacent negatives using words like free, busy, plan, event, date, move, or schedule in a non-calendar meaning'
  ]
  return `/no_think\nTASK: REMINDCORE_OOD_DATA\nGenerate exactly six plain, short user messages about ${themes[batchIndex]}. Every message must be general conversation or a non-calendar task, NOT a request to read or change a calendar/reminder. Do not create sample records, fields, XML, HTML, tags, placeholders, names, dates, times, locations, or status values. Do not use the characters < or >. Do not include any request to create, edit, delete, search, list, copy, or check a calendar item. Each array item must be one natural standalone sentence. Return only JSON.`
}

function oodSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['items'],
    properties: {
      items: {
        type: 'array',
        minItems: 6,
        maxItems: 6,
        items: { type: 'string', minLength: 4, maxLength: 180 }
      }
    }
  }
}

function speakPrompt(spec) {
  const markers = spec.signature.map((name) => `<${name}>`).join(', ')
  return `/no_think\nTASK: REMINDSPEAK_DATA\nSpeech act: ${spec.speechAct}\nMeaning: ${spec.meaning}.\nCreate exactly two different phrase sets. Each set has one lead, exactly two bodies, and one close.\n\nHard rules:\n- lead: a short standalone introduction with NO < character, NO > character, and no factual value.\n- close: a short standalone ending with NO < character, NO > character, and no factual value.\n- each body: include these literal markers exactly once each: ${markers}. Use no other marker.\n- Never write a sample name, date, weekday, time, number, count, location, schedule, receipt, or outcome outside a marker.\n- Do not answer or fill in a marker. Do not write the marker name without its angle brackets.\n- Keep every phrase concise and natural for a warm private calendar assistant.\n- Do not claim a write for proposal, availability-answer, schedule-summary, clarification, conflict-warning, unsupported, or error.\n- Do not claim personal memory, feelings, consciousness, or knowledge beyond the protected fact.\n- The two sets must use different wording and different style tags. No emoji, markup, commentary, or digits.\nReturn only JSON.`
}

function preferenceSchema(cases) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['choices'],
    properties: {
      choices: {
        type: 'array',
        minItems: cases.length,
        maxItems: cases.length,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'choice'],
          properties: {
            id: { type: 'string', enum: cases.map((value) => value.id) },
            choice: { type: 'integer', minimum: 0, maximum: 3 }
          }
        }
      }
    }
  }
}

function preferencePrompt(cases) {
  const rendered = cases
    .map(
      (value) =>
        `CASE ${value.id}\nDesired style: ${value.styleTag}; warmth=${value.style.warmth}; brevity=${value.style.brevity}; formality=${value.style.formality}; proactivity=${value.style.proactivity}.\n` +
        value.candidates.map((candidate, index) => `${index}: ${candidate.text}`).join('\n')
    )
    .join('\n\n')
  return `/no_think\nTASK: REMINDSPEAK_PREFERENCE_DISTILLATION\nFor every case, choose exactly one candidate index from zero through three. All candidates are fact-safe and use protected markers. Judge only naturalness, coherence, non-repetition, and fit to the desired style. Prefer a concise human-sounding calendar-assistant reply. Do not rewrite any candidate and do not explain. Return one choice for every case ID.\n\n${rendered}`
}

function assistantParaphraseSchema(jobs, paraphrasesPerJob) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['items'],
    properties: {
      items: {
        type: 'array',
        minItems: jobs.length,
        maxItems: jobs.length,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'paraphrases'],
          properties: {
            id: { type: 'string', enum: jobs.map((job) => job.id) },
            paraphrases: {
              type: 'array',
              minItems: paraphrasesPerJob,
              maxItems: paraphrasesPerJob,
              items: { type: 'string', minLength: 8, maxLength: 220 }
            }
          }
        }
      }
    }
  }
}

function assistantParaphrasePrompt(jobs, paraphrasesPerJob) {
  const rendered = jobs
    .map((job) => {
      const markers = job.placeholders.map((name) => `<${name}>`).join(', ') || 'none'
      return (
        `JOB ${job.id}\n` +
        `Meaning: ${job.meaning}\n` +
        `Seed: ${job.seedTemplate}\n` +
        `Required markers: ${markers}\n` +
        `Required action word (use it naturally): ${job.cues[0]}`
      )
    })
    .join('\n\n')
  return `/no_think\nTASK: ASSISTANT_PLAN_V2_PARAPHRASES\nFor every job, write exactly ${paraphrasesPerJob} substantially different, natural user requests with exactly the same meaning as its seed.\n\nHard rules:\n- Output only each supplied job ID and its paraphrases. The job ID is opaque; do not change it.\n- Copy every required angle-bracket marker literally and exactly once. Use no other marker.\n- Markers are protected values. Never fill, rename, split, normalize, or explain them.\n- Do not add a second action, a date, time, name, number, location, result, or factual detail that is absent from the seed.\n- Write a complete thing a real user would ask or command, with at least four ordinary words. Never return a keyword list or a passive fragment such as "<TARGET> to be moved".\n- Do not mention review, approval, safety, implementation, or these instructions unless that exact word already appears in the seed.\n- Do not answer the request. Do not begin with Sure, Okay, Done, Certainly, Here is, or I have.\n- Preserve whether the request reads data, previews a change, controls the app, chats, or manages local memory.\n- EVERY paraphrase MUST use its single required action word naturally. Never write the words intent, anchor, capability, job, marker, or seed.\n- Do not copy the seed or another paraphrase. Vary word order and vocabulary; do not merely add please. Keep each request under thirty words.\n- Return JSON only, with every job exactly once.\n\n${rendered}`
}

async function writeCheckpoint(path, payload) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
}

async function loadCheckpoint(path, kind) {
  if (!existsSync(path)) return { kind, batches: [] }
  const parsed = JSON.parse(await readFile(path, 'utf8'))
  if (parsed.kind !== kind || !Array.isArray(parsed.batches)) {
    throw new Error(`Invalid ${kind} teacher checkpoint at ${path}`)
  }
  return parsed
}

async function main() {
  const requested = new Set(process.argv.slice(2).filter((value) => !value.startsWith('--')))
  const runCore = requested.size === 0 || requested.has('all') || requested.has('core')
  const runSpeak = requested.size === 0 || requested.has('all') || requested.has('speak')
  const runPreferences =
    requested.size === 0 || requested.has('all') || requested.has('preferences')
  const runAssistant = requested.has('assistant')
  const runAssistantRepairs = requested.has('assistant-repairs')
  const runAssistantNext = requested.has('assistant-next')
  const runAssistantNextRepairs = requested.has('assistant-next-repairs')
  const force = process.argv.includes('--force')
  const modelPath = resolve(process.env.REMIND_ME_QWEN_PATH || defaultModelPath())
  const modelStats = await stat(modelPath)
  if (!modelStats.isFile() || modelStats.size !== MODEL_BYTES) {
    throw new Error(`The pinned Qwen teacher was not found at ${modelPath}`)
  }
  const digest = await sha256(modelPath)
  if (digest !== MODEL_SHA256) throw new Error('The Qwen teacher failed its pinned SHA-256 check')

  await mkdir(OUTPUT_DIRECTORY, { recursive: true })
  const useGpu = platform() === 'darwin' && arch() === 'arm64'
  const threadCount = Math.max(2, Math.min(8, cpus().length - 1))
  const gibibyte = 1024 * 1024 * 1024
  const available = { free: freemem() / gibibyte, total: totalmem() / gibibyte }
  const contextSize = available.total >= 16 && available.free >= 5 ? 8192 : 6144
  const llama = await getLlama({
    gpu: useGpu ? 'auto' : false,
    build: 'never',
    skipDownload: true,
    progressLogs: false,
    logLevel: LlamaLogLevel.error,
    maxThreads: threadCount
  })
  const model = await llama.loadModel({ modelPath, gpuLayers: useGpu ? 'auto' : 0, useMmap: true })
  const context = await model.createContext({
    contextSize,
    batchSize: 256,
    flashAttention: useGpu ? 'auto' : false,
    threads: threadCount
  })
  const session = new LlamaChatSession({
    contextSequence: context.getSequence(),
    systemPrompt:
      'You generate compact research data for two original calendar-assistant student models. ' +
      'Follow the requested schema exactly. Never replace protected angle-bracket markers, never add facts, and never include analysis.'
  })

  const metadata = {
    schemaVersion: 1,
    generatorVersion: GENERATOR_VERSION,
    teacher: {
      modelId: 'Qwen3-1.7B-Q4_K_M',
      byteLength: MODEL_BYTES,
      sha256: MODEL_SHA256,
      license: 'Apache-2.0'
    },
    generation: {
      seed: SEED,
      temperature: 0.7,
      topK: 30,
      topP: 0.85,
      thoughtTokens: 0,
      contextSize,
      device: useGpu ? 'metal' : 'cpu'
    }
  }

  const generate = async (prompt, schema, seedOffset, maxTokens) => {
    session.resetChatHistory()
    const grammar = await llama.createGrammarForJsonSchema(schema)
    const started = Date.now()
    const output = await session.prompt(prompt, {
      grammar,
      budgets: { thoughtTokens: 0 },
      maxTokens,
      temperature: 0.7,
      topK: 30,
      topP: 0.85,
      seed: SEED + seedOffset
    })
    return {
      promptSha256: stablePromptHash(prompt),
      elapsedMs: Date.now() - started,
      output: JSON.parse(output)
    }
  }

  try {
    if (runCore) {
      const path = resolve(OUTPUT_DIRECTORY, 'remindcore.json')
      const checkpoint = force
        ? { kind: 'remindcore', batches: [] }
        : await loadCheckpoint(path, 'remindcore')
      const groups = []
      for (let index = 0; index < CORE_SPECS.length; index += 2) {
        groups.push(CORE_SPECS.slice(index, index + 2))
      }
      for (let index = 0; index < groups.length; index += 1) {
        const id = `core-${index + 1}`
        if (checkpoint.batches.some((batch) => batch.id === id)) continue
        const specs = groups[index]
        process.stdout.write(
          `Generating ${id}/${groups.length} (${specs.map((item) => item.operation).join(', ')})…\n`
        )
        const result = await generate(corePrompt(specs), coreSchema(specs), index * 101, 950)
        checkpoint.batches.push({ id, specs, ...result })
        await writeCheckpoint(path, { ...metadata, ...checkpoint })
      }
      for (let index = 0; index < CORE_REPAIR_OPERATIONS.length; index += 1) {
        const operation = CORE_REPAIR_OPERATIONS[index]
        const spec = CORE_SPECS.find((item) => item.operation === operation)
        if (!spec) throw new Error(`Missing repair specification for ${operation}`)
        const specs = [spec]
        const id = `core-repair-${index + 1}`
        if (checkpoint.batches.some((batch) => batch.id === id)) continue
        process.stdout.write(
          `Generating targeted repair ${index + 1}/${CORE_REPAIR_OPERATIONS.length} (${operation})…\n`
        )
        const result = await generate(corePrompt(specs), coreSchema(specs), 1_201 + index * 59, 520)
        checkpoint.batches.push({ id, specs, ...result })
        await writeCheckpoint(path, { ...metadata, ...checkpoint })
      }
      for (let index = 0; index < 4; index += 1) {
        const id = `core-ood-${index + 1}`
        if (checkpoint.batches.some((batch) => batch.id === id)) continue
        process.stdout.write(`Generating hard out-of-domain negatives ${index + 1}/4…\n`)
        const result = await generate(oodPrompt(index), oodSchema(), 907 + index * 43, 320)
        checkpoint.batches.push({ id, specs: [], ...result })
        await writeCheckpoint(path, { ...metadata, ...checkpoint })
      }
    }

    if (runSpeak) {
      const path = resolve(OUTPUT_DIRECTORY, 'remindspeak.json')
      const checkpoint = force
        ? { kind: 'remindspeak', batches: [] }
        : await loadCheckpoint(path, 'remindspeak')
      for (let index = 0; index < SPEAK_SPECS.length; index += 1) {
        const id = `speak-${index + 1}`
        if (checkpoint.batches.some((batch) => batch.id === id)) continue
        const spec = SPEAK_SPECS[index]
        process.stdout.write(`Generating ${id}/${SPEAK_SPECS.length} (${spec.speechAct})…\n`)
        const rawResult = await generate(speakPrompt(spec), speakSchema(), 2_003 + index * 131, 520)
        const items = rawResult.output.sets.flatMap((set) => [
          { speechAct: spec.speechAct, head: 'lead', text: set.lead, styleTag: set.styleTag },
          ...set.bodies.map((text) => ({
            speechAct: spec.speechAct,
            head: 'body',
            text,
            styleTag: set.styleTag
          })),
          { speechAct: spec.speechAct, head: 'close', text: set.close, styleTag: set.styleTag }
        ])
        checkpoint.batches.push({
          id,
          specs: [spec],
          ...rawResult,
          output: { items }
        })
        await writeCheckpoint(path, { ...metadata, ...checkpoint })
      }
    }

    if (runPreferences) {
      const casesPayload = JSON.parse(await readFile(SPEAK_PREFERENCE_CASES_PATH, 'utf8'))
      if (!Array.isArray(casesPayload.cases)) {
        throw new Error('Run the deterministic RemindSpeak preference preparation first')
      }
      const grouped = new Map()
      for (const value of casesPayload.cases) {
        const values = grouped.get(value.speechAct) || []
        values.push(value)
        grouped.set(value.speechAct, values)
      }
      const path = resolve(OUTPUT_DIRECTORY, 'remindspeak-preferences.json')
      const checkpoint = force
        ? { kind: 'remindspeak-preferences', batches: [] }
        : await loadCheckpoint(path, 'remindspeak-preferences')
      let index = 0
      for (const [speechAct, cases] of grouped) {
        index += 1
        const id = `preference-${speechAct}`
        if (checkpoint.batches.some((batch) => batch.id === id)) continue
        process.stdout.write(`Ranking preference group ${index}/${grouped.size} (${speechAct})…\n`)
        const result = await generate(
          preferencePrompt(cases),
          preferenceSchema(cases),
          4_001 + index * 149,
          260
        )
        checkpoint.batches.push({ id, caseIds: cases.map((value) => value.id), ...result })
        await writeCheckpoint(path, { ...metadata, ...checkpoint })
      }
      const chosenIds = new Set(
        checkpoint.batches.flatMap((batch) =>
          Array.isArray(batch.output?.choices) ? batch.output.choices.map((value) => value.id) : []
        )
      )
      const missingCases = casesPayload.cases.filter((value) => !chosenIds.has(value.id))
      for (let repairIndex = 0; repairIndex < missingCases.length; repairIndex += 1) {
        const value = missingCases[repairIndex]
        const id = `preference-repair-${value.speechAct}-${value.styleTag}`
        if (checkpoint.batches.some((batch) => batch.id === id)) continue
        process.stdout.write(
          `Repairing omitted preference ${repairIndex + 1}/${missingCases.length} (${value.id})…\n`
        )
        const result = await generate(
          preferencePrompt([value]),
          preferenceSchema([value]),
          7_001 + repairIndex * 181,
          80
        )
        checkpoint.batches.push({ id, caseIds: [value.id], ...result })
        await writeCheckpoint(path, { ...metadata, ...checkpoint })
      }
    }

    if (runAssistant) {
      const jobsPayload = JSON.parse(await readFile(ASSISTANT_JOBS_PATH, 'utf8'))
      if (
        !Array.isArray(jobsPayload.jobs) ||
        jobsPayload.teacherModelId !== 'Qwen3-1.7B-Q4_K_M' ||
        jobsPayload.teacherSha256 !== MODEL_SHA256
      ) {
        throw new Error('Run the deterministic AssistantPlan corpus preparation first')
      }
      const paraphrasesPerJob = jobsPayload.paraphrasesPerJob
      if (!Number.isInteger(paraphrasesPerJob) || paraphrasesPerJob < 1 || paraphrasesPerJob > 4) {
        throw new Error('AssistantPlan teacher job count is outside the supported bound')
      }
      const path = resolve(ASSISTANT_CORPUS_DIRECTORY, 'qwen-paraphrases.json')
      const checkpoint = force
        ? { kind: 'assistant-paraphrases', batches: [] }
        : await loadCheckpoint(path, 'assistant-paraphrases')
      const groups = []
      for (let index = 0; index < jobsPayload.jobs.length; index += 3) {
        groups.push(jobsPayload.jobs.slice(index, index + 3))
      }
      for (let index = 0; index < groups.length; index += 1) {
        const jobs = groups[index]
        const id = `assistant-${index + 1}`
        if (checkpoint.batches.some((batch) => batch.id === id)) continue
        process.stdout.write(
          `Generating AssistantPlan paraphrases ${index + 1}/${groups.length}…\n`
        )
        const result = await generate(
          assistantParaphrasePrompt(jobs, paraphrasesPerJob),
          assistantParaphraseSchema(jobs, paraphrasesPerJob),
          9_001 + index * 211,
          650
        )
        checkpoint.batches.push({ id, jobIds: jobs.map((job) => job.id), ...result })
        await writeCheckpoint(path, { ...metadata, ...checkpoint })
      }
      const generatedIds = new Set(
        checkpoint.batches.flatMap((batch) =>
          Array.isArray(batch.output?.items) ? batch.output.items.map((item) => item.id) : []
        )
      )
      const missingJobs = jobsPayload.jobs.filter((job) => !generatedIds.has(job.id))
      for (let index = 0; index < missingJobs.length; index += 1) {
        const job = missingJobs[index]
        const id = `assistant-repair-${index + 1}`
        if (checkpoint.batches.some((batch) => batch.id === id)) continue
        process.stdout.write(
          `Repairing omitted AssistantPlan job ${index + 1}/${missingJobs.length} (${job.id})…\n`
        )
        const result = await generate(
          assistantParaphrasePrompt([job], paraphrasesPerJob),
          assistantParaphraseSchema([job], paraphrasesPerJob),
          14_001 + index * 223,
          260
        )
        checkpoint.batches.push({ id, jobIds: [job.id], repair: true, ...result })
        await writeCheckpoint(path, { ...metadata, ...checkpoint })
      }
    }

    if (runAssistantRepairs) {
      const jobsPayload = JSON.parse(await readFile(ASSISTANT_REPAIR_JOBS_PATH, 'utf8'))
      if (
        !Array.isArray(jobsPayload.jobs) ||
        jobsPayload.teacherModelId !== 'Qwen3-1.7B-Q4_K_M' ||
        jobsPayload.teacherSha256 !== MODEL_SHA256 ||
        jobsPayload.repairRound !== 1
      ) {
        throw new Error('Run the deterministic AssistantPlan repair preparation first')
      }
      const paraphrasesPerJob = jobsPayload.paraphrasesPerJob
      const path = resolve(ASSISTANT_CORPUS_DIRECTORY, 'qwen-paraphrases.json')
      const checkpoint = await loadCheckpoint(path, 'assistant-paraphrases')
      for (let index = 0; index < jobsPayload.jobs.length; index += 1) {
        const job = jobsPayload.jobs[index]
        const id = `assistant-curation-repair-${index + 1}`
        if (checkpoint.batches.some((batch) => batch.id === id)) continue
        process.stdout.write(
          `Repairing rejected AssistantPlan surface ${index + 1}/${jobsPayload.jobs.length} (${job.id})…\n`
        )
        const result = await generate(
          assistantParaphrasePrompt([job], paraphrasesPerJob),
          assistantParaphraseSchema([job], paraphrasesPerJob),
          19_001 + index * 227,
          260
        )
        checkpoint.batches.push({
          id,
          jobIds: [job.id],
          curationRepair: true,
          repairRound: 1,
          ...result
        })
        await writeCheckpoint(path, { ...metadata, ...checkpoint })
      }
    }

    if (runAssistantNext) {
      const jobsPayload = JSON.parse(await readFile(REMINDCORE_NEXT_JOBS_PATH, 'utf8'))
      if (
        !Array.isArray(jobsPayload.jobs) ||
        jobsPayload.teacherModelId !== 'Qwen3-1.7B-Q4_K_M' ||
        jobsPayload.teacherSha256 !== MODEL_SHA256 ||
        jobsPayload.teacherRole !== 'training-only delexicalized surface paraphrase'
      ) {
        throw new Error('Run the deterministic RemindCore Next preparation first')
      }
      if (!jobsPayload.jobs.every((job) => job.sourceSplit === 'train')) {
        throw new Error('RemindCore Next teacher jobs must use training-only seeds')
      }
      const paraphrasesPerJob = jobsPayload.paraphrasesPerJob
      const path = resolve(REMINDCORE_NEXT_DIRECTORY, 'qwen-training-paraphrases.json')
      const checkpoint = force
        ? { kind: 'assistant-paraphrases', batches: [] }
        : await loadCheckpoint(path, 'assistant-paraphrases')
      const groups = []
      for (let index = 0; index < jobsPayload.jobs.length; index += 3) {
        groups.push(jobsPayload.jobs.slice(index, index + 3))
      }
      for (let index = 0; index < groups.length; index += 1) {
        const jobs = groups[index]
        const id = `remindcore-next-${index + 1}`
        if (checkpoint.batches.some((batch) => batch.id === id)) continue
        process.stdout.write(
          `Generating RemindCore Next training surfaces ${index + 1}/${groups.length}…\n`
        )
        const result = await generate(
          assistantParaphrasePrompt(jobs, paraphrasesPerJob),
          assistantParaphraseSchema(jobs, paraphrasesPerJob),
          21_001 + index * 251,
          850
        )
        checkpoint.batches.push({ id, jobIds: jobs.map((job) => job.id), ...result })
        await writeCheckpoint(path, { ...metadata, ...checkpoint })
      }
    }

    if (runAssistantNextRepairs) {
      const jobsPayload = JSON.parse(await readFile(REMINDCORE_NEXT_REPAIR_JOBS_PATH, 'utf8'))
      if (
        !Array.isArray(jobsPayload.jobs) ||
        jobsPayload.teacherModelId !== 'Qwen3-1.7B-Q4_K_M' ||
        jobsPayload.teacherSha256 !== MODEL_SHA256 ||
        jobsPayload.repairRound !== 1 ||
        jobsPayload.teacherRole !== 'training-only delexicalized surface paraphrase repair'
      ) {
        throw new Error('Run the deterministic RemindCore Next repair preparation first')
      }
      if (!jobsPayload.jobs.every((job) => job.sourceSplit === 'train')) {
        throw new Error('RemindCore Next repair jobs must use training-only seeds')
      }
      const paraphrasesPerJob = jobsPayload.paraphrasesPerJob
      const path = resolve(REMINDCORE_NEXT_DIRECTORY, 'qwen-training-repair-paraphrases.json')
      const checkpoint = force
        ? { kind: 'assistant-paraphrases', batches: [] }
        : await loadCheckpoint(path, 'assistant-paraphrases')
      const groups = []
      for (let index = 0; index < jobsPayload.jobs.length; index += 3) {
        groups.push(jobsPayload.jobs.slice(index, index + 3))
      }
      for (let index = 0; index < groups.length; index += 1) {
        const jobs = groups[index]
        const id = `remindcore-next-repair-${index + 1}`
        if (checkpoint.batches.some((batch) => batch.id === id)) continue
        process.stdout.write(
          `Repairing RemindCore Next training surfaces ${index + 1}/${groups.length}…\n`
        )
        const result = await generate(
          assistantParaphrasePrompt(jobs, paraphrasesPerJob),
          assistantParaphraseSchema(jobs, paraphrasesPerJob),
          31_001 + index * 263,
          850
        )
        checkpoint.batches.push({ id, jobIds: jobs.map((job) => job.id), ...result })
        await writeCheckpoint(path, { ...metadata, ...checkpoint })
      }
    }
  } finally {
    session.dispose({ disposeSequence: true })
    await context.dispose()
    await model.dispose()
    await llama.dispose()
  }
}

await main()
