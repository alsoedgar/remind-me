'use strict'

const { readFileSync } = require('node:fs')
const { isAbsolute, join } = require('node:path')
const { performance: perf } = require('node:perf_hooks')
const { pathToFileURL } = require('node:url')
const {
  CHAT_SYSTEM_PROMPT,
  PLAN_SYSTEM_PROMPT,
  chatPrompt,
  chatTokenBudget,
  cleanChatOutput,
  cleanPlanOutput,
  historyText,
  planPrompt,
  plannerTokenBudget,
  profileText
} = require('./flex-model-prompts.cjs')

const parentPort = process.parentPort
if (!parentPort) throw new Error('Flexible language worker must run as an Electron utility process')

const plannerSchema = JSON.parse(
  readFileSync(join(__dirname, 'flex-model-planner-schema.json'), 'utf8')
)

let runtime = null
let llama = null
let model = null
let context = null
let grammar = null
let planSession = null
let chatSession = null
let sharedSession = null
let sharedSessionType = null
let sharedSequence = null
let loadedKey = null
let loadedProfile = null
let active = false

function post(message) {
  parentPort.postMessage(message)
}

function assertRuntimeProfile(profile) {
  if (!profile || typeof profile !== 'object') throw new Error('Missing runtime profile')
  if (!['compact', 'balanced', 'performance'].includes(profile.id)) {
    throw new Error('Invalid runtime profile ID')
  }
  if (!['cpu', 'metal'].includes(profile.backend)) throw new Error('Invalid model backend')
  if (
    !Number.isInteger(profile.threads) ||
    profile.threads < 1 ||
    profile.threads > 64 ||
    !Number.isInteger(profile.contextSize) ||
    profile.contextSize < 2048 ||
    profile.contextSize > 32768 ||
    ![1, 2].includes(profile.sequences) ||
    ![256, 512].includes(profile.batchSize) ||
    !Number.isInteger(profile.maxChatTokens) ||
    profile.maxChatTokens < 32 ||
    profile.maxChatTokens > 512
  ) {
    throw new Error('Runtime profile is outside supported bounds')
  }
  const metalAvailable = process.platform === 'darwin' && process.arch === 'arm64'
  if ((profile.backend === 'metal') !== metalAvailable) {
    throw new Error('The requested model backend does not match this packaged platform')
  }
}

function assertRequest(request) {
  if (
    !request ||
    typeof request !== 'object' ||
    (request.type !== 'plan' && request.type !== 'chat')
  ) {
    throw new Error('Invalid flexible language request')
  }
  if (typeof request.jobId !== 'string' || request.jobId.length > 128) {
    throw new Error('Invalid flexible language job ID')
  }
  if (
    request.type === 'plan' &&
    (typeof request.text !== 'string' || request.text.length < 1 || request.text.length > 2000)
  ) {
    throw new Error('Flexible language text is outside the supported bounds')
  }
  if (request.type === 'plan') assertPlanContext(request.context)
  if (request.type === 'chat') assertChatInput(request.input)
  if (
    typeof request.runtimeEntry !== 'string' ||
    typeof request.modelPath !== 'string' ||
    !isAbsolute(request.runtimeEntry) ||
    !isAbsolute(request.modelPath)
  ) {
    throw new Error('Flexible language runtime paths are invalid')
  }
  assertRuntimeProfile(request.runtimeProfile)
}

function assertPlanContext(input) {
  if (!input || typeof input !== 'object') throw new Error('Invalid calendar planning context')
  if (
    typeof input.currentLocalDateTime !== 'string' ||
    input.currentLocalDateTime.length < 1 ||
    input.currentLocalDateTime.length > 100 ||
    typeof input.timezone !== 'string' ||
    input.timezone.length < 1 ||
    input.timezone.length > 100 ||
    typeof input.locale !== 'string' ||
    input.locale.length < 1 ||
    input.locale.length > 100 ||
    (input.dialogueContext !== undefined &&
      (typeof input.dialogueContext !== 'string' || input.dialogueContext.length > 6000))
  ) {
    throw new Error('Calendar planning context is outside the supported bounds')
  }
}

function assertChatInput(input) {
  if (!input || typeof input !== 'object') throw new Error('Invalid contextual chat input')
  if (typeof input.text !== 'string' || input.text.length < 1 || input.text.length > 4000) {
    throw new Error('Contextual chat text is outside the supported bounds')
  }
  if (!Array.isArray(input.turns) || input.turns.length > 8) {
    throw new Error('Contextual chat history is outside the supported bounds')
  }
  if (typeof input.calendarContext !== 'string' || input.calendarContext.length > 8000) {
    throw new Error('Calendar context is outside the supported bounds')
  }
}

function createSession(sequence, workload) {
  return new runtime.LlamaChatSession({
    contextSequence: sequence,
    systemPrompt: workload === 'plan' ? PLAN_SYSTEM_PROMPT : CHAT_SYSTEM_PROMPT,
    contextShift: { strategy: 'eraseFirstResponseAndKeepFirstSystem' }
  })
}

function sessionFor(workload) {
  if (loadedProfile.sequences === 2) {
    return workload === 'plan' ? planSession : chatSession
  }
  if (!sharedSequence) throw new Error('The shared local-model sequence is unavailable')
  if (!sharedSession || sharedSessionType !== workload) {
    sharedSession?.dispose()
    sharedSession = createSession(sharedSequence, workload)
    sharedSessionType = workload
  }
  return sharedSession
}

async function disposeRuntime() {
  try {
    if (planSession) planSession.dispose({ disposeSequence: true })
    if (chatSession) chatSession.dispose({ disposeSequence: true })
    if (sharedSession) sharedSession.dispose({ disposeSequence: true })
    await context?.dispose()
    await model?.dispose()
    await llama?.dispose()
  } finally {
    runtime = null
    llama = null
    model = null
    context = null
    grammar = null
    planSession = null
    chatSession = null
    sharedSession = null
    sharedSessionType = null
    sharedSequence = null
    loadedKey = null
    loadedProfile = null
  }
}

async function ensureRuntime(request) {
  const profile = request.runtimeProfile
  const key = JSON.stringify([
    request.runtimeEntry,
    request.modelPath,
    profile.backend,
    profile.threads,
    profile.contextSize,
    profile.sequences,
    profile.batchSize,
    profile.maxChatTokens
  ])
  if (context && key === loadedKey) return false
  await disposeRuntime()
  runtime = await import(pathToFileURL(request.runtimeEntry).href)
  const useBundledGpu = profile.backend === 'metal'
  llama = await runtime.getLlama({
    gpu: useBundledGpu ? 'auto' : false,
    build: 'never',
    skipDownload: true,
    progressLogs: false,
    logLevel: runtime.LlamaLogLevel.error,
    maxThreads: profile.threads
  })
  model = await llama.loadModel({
    modelPath: request.modelPath,
    gpuLayers: useBundledGpu ? 'auto' : 0,
    useMmap: true
  })
  context = await model.createContext({
    contextSize: profile.contextSize,
    sequences: profile.sequences,
    batchSize: profile.batchSize,
    flashAttention: 'auto',
    threads: profile.threads
  })
  if (profile.sequences === 2) {
    planSession = createSession(context.getSequence(), 'plan')
    chatSession = createSession(context.getSequence(), 'chat')
  } else {
    sharedSequence = context.getSequence()
  }
  loadedProfile = profile
  loadedKey = key
  return true
}

function tokenLength(text) {
  return model.tokenize(text).length
}

function clippedText(text, budget, mode) {
  const tokens = model.tokenize(text)
  if (tokens.length <= budget) return { text, truncated: false }
  if (budget <= 8) return { text: '', truncated: true }
  if (mode === 'tail') {
    return { text: `[…] ${model.detokenize(tokens.slice(-(budget - 4)))}`, truncated: true }
  }
  if (mode === 'middle') {
    const usable = budget - 6
    const head = Math.ceil(usable * 0.7)
    const tail = usable - head
    return {
      text: `${model.detokenize(tokens.slice(0, head))} […] ${model.detokenize(tokens.slice(-tail))}`,
      truncated: true
    }
  }
  return { text: `${model.detokenize(tokens.slice(0, budget - 4))} […]`, truncated: true }
}

function weightedBudgets(lengths, available) {
  const weights = { message: 5, calendar: 3, history: 2, profile: 1 }
  const budgets = { message: 0, calendar: 0, history: 0, profile: 0 }
  let remaining = Math.max(0, available)
  while (remaining > 0) {
    const open = Object.keys(budgets).filter((key) => budgets[key] < lengths[key])
    if (open.length === 0) break
    const totalWeight = open.reduce((sum, key) => sum + weights[key], 0)
    let progressed = false
    for (const key of open) {
      if (remaining <= 0) break
      const grant = Math.min(
        lengths[key] - budgets[key],
        Math.max(1, Math.floor((remaining * weights[key]) / totalWeight))
      )
      if (grant <= 0) continue
      budgets[key] += grant
      remaining -= grant
      progressed = true
    }
    if (!progressed) break
  }
  return budgets
}

function fitChatPrompt(input, maxTokens, session) {
  const raw = {
    profile: profileText(input),
    history: historyText(input.turns),
    calendar: input.calendarContext,
    message: input.text
  }
  const blankPrompt = chatPrompt(input, {
    profile: '',
    history: '',
    calendar: '',
    message: ''
  })
  const fixedTokens = tokenLength(CHAT_SYSTEM_PROMPT) + tokenLength(blankPrompt) + 192
  const available = Math.max(0, session.sequence.contextSize - maxTokens - fixedTokens)
  const lengths = Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [key, tokenLength(value)])
  )
  const budgets = weightedBudgets(lengths, available)
  const fitted = {
    profile: clippedText(raw.profile, budgets.profile, 'head'),
    history: clippedText(raw.history, budgets.history, 'tail'),
    calendar: clippedText(raw.calendar, budgets.calendar, 'head'),
    message: clippedText(raw.message, budgets.message, 'middle')
  }
  const prompt = chatPrompt(input, {
    profile: fitted.profile.text,
    history: fitted.history.text,
    calendar: fitted.calendar.text,
    message: fitted.message.text
  })
  return {
    prompt,
    inputTokens: Math.min(
      session.sequence.contextSize,
      tokenLength(CHAT_SYSTEM_PROMPT) + tokenLength(prompt) + 32
    ),
    inputTruncated: Object.values(fitted).some((section) => section.truncated)
  }
}

function fitPlanPrompt(request, maxTokens, session) {
  const withoutDialogue = planPrompt({
    ...request,
    context: { ...request.context, dialogueContext: '' }
  })
  const fixedTokens = tokenLength(PLAN_SYSTEM_PROMPT) + tokenLength(withoutDialogue) + 192
  const dialogueBudget = Math.max(0, session.sequence.contextSize - maxTokens - fixedTokens)
  const dialogue = clippedText(request.context.dialogueContext || '', dialogueBudget, 'head')
  const prompt = planPrompt({
    ...request,
    context: { ...request.context, dialogueContext: dialogue.text }
  })
  return {
    prompt,
    inputTokens: Math.min(
      session.sequence.contextSize,
      tokenLength(PLAN_SYSTEM_PROMPT) + tokenLength(prompt) + 32
    ),
    inputTruncated: dialogue.truncated
  }
}

function requestMetrics(workload, started, fitted, output, tokenLimit, stopReason, coldStart) {
  return {
    workload,
    elapsedMs: Math.max(0, Math.round(perf.now() - started)),
    inputTokens: fitted.inputTokens,
    outputTokens: tokenLength(output),
    tokenLimit,
    stopReason,
    inputTruncated: fitted.inputTruncated,
    coldStart
  }
}

async function handle(request) {
  assertRequest(request)
  if (active) throw new Error('Another flexible language request is already running')
  active = true
  const started = perf.now()
  try {
    const coldStart = await ensureRuntime(request)
    const session = sessionFor(request.type)
    session.resetChatHistory()
    if (request.type === 'plan') {
      if (!grammar) grammar = await llama.createGrammarForJsonSchema(plannerSchema)
      const maxTokens = plannerTokenBudget(request.text)
      const fitted = fitPlanPrompt(request, maxTokens, session)
      const generated = await session.promptWithMeta(fitted.prompt, {
        grammar,
        budgets: { thoughtTokens: 0 },
        maxTokens,
        temperature: 0,
        seed: 17,
        trimWhitespaceSuffix: true
      })
      const plan = cleanPlanOutput(JSON.parse(generated.responseText))
      if (
        !plan ||
        !Array.isArray(plan.actions) ||
        plan.actions.length < 1 ||
        plan.actions.length > 8
      ) {
        throw new Error('The local model returned an invalid action group')
      }
      post({
        type: 'plan-result',
        jobId: request.jobId,
        plan,
        metrics: requestMetrics(
          'plan',
          started,
          fitted,
          generated.responseText,
          maxTokens,
          generated.stopReason,
          coldStart
        )
      })
      return
    }

    const maxTokens = chatTokenBudget(request.input, request.runtimeProfile.maxChatTokens)
    const fitted = fitChatPrompt(request.input, maxTokens, session)
    const generated = await session.promptWithMeta(fitted.prompt, {
      budgets: { thoughtTokens: 0 },
      maxTokens,
      temperature: Math.max(0.55, Math.min(0.8, 0.6 + request.input.style.warmth * 0.16)),
      topK: 20,
      topP: 0.8,
      repeatPenalty: { penalty: 1.08, frequencyPenalty: 0.04 },
      trimWhitespaceSuffix: true
    })
    const text = cleanChatOutput(generated.responseText, request.input.text, generated.stopReason)
    post({
      type: 'chat-result',
      jobId: request.jobId,
      response: { text },
      metrics: requestMetrics(
        'chat',
        started,
        fitted,
        text,
        maxTokens,
        generated.stopReason,
        coldStart
      )
    })
  } finally {
    active = false
  }
}

parentPort.on('message', (event) => {
  const request = event.data
  void handle(request).catch((error) => {
    console.error(error)
    post({
      type: 'error',
      jobId: request && typeof request.jobId === 'string' ? request.jobId : 'unknown',
      message: 'The isolated local language engine could not finish that request.'
    })
  })
})

process.once('exit', () => {
  planSession?.dispose({ disposeSequence: true })
  chatSession?.dispose({ disposeSequence: true })
  sharedSession?.dispose({ disposeSequence: true })
})
