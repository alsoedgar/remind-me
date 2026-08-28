'use strict'

const { readFileSync } = require('node:fs')
const { isAbsolute, join } = require('node:path')
const { performance: perf } = require('node:perf_hooks')
const { pathToFileURL } = require('node:url')
const {
  CHAT_SYSTEM_PROMPT,
  DOCUMENT_SYSTEM_PROMPT,
  PLAN_SYSTEM_PROMPT,
  chatPrompt,
  chatTokenBudget,
  cleanChatEnvelopeOutput,
  cleanChatStreamOutput,
  cleanDocumentFallbackOutput,
  cleanDocumentRepairOutput,
  cleanPlanOutput,
  documentFallbackPrompt,
  documentFallbackTokenBudget,
  documentRepairPrompt,
  documentRepairTokenBudget,
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
const chatSchema = JSON.parse(readFileSync(join(__dirname, 'flex-model-chat-schema.json'), 'utf8'))
const documentRepairSchema = JSON.parse(
  readFileSync(join(__dirname, 'flex-model-document-repair-schema.json'), 'utf8')
)
const documentFallbackSchema = JSON.parse(
  readFileSync(join(__dirname, 'flex-model-document-fallback-schema.json'), 'utf8')
)

let runtime = null
let llama = null
let model = null
let context = null
let grammar = null
let chatGrammar = null
let documentRepairGrammar = null
let documentFallbackGrammar = null
let planSession = null
let planSessionType = null
let planSequence = null
let chatSession = null
let sharedSession = null
let sharedSessionType = null
let sharedSequence = null
let loadedKey = null
let loadedProfile = null
let active = false
let activeController = null
let activeJobId = null
let sessionUseCounts = new WeakMap()

function post(message) {
  parentPort.postMessage(message)
}

function assertRuntimeProfile(profile) {
  if (!profile || typeof profile !== 'object') throw new Error('Missing runtime profile')
  if (!['compact', 'balanced', 'performance'].includes(profile.id)) {
    throw new Error('Invalid runtime profile ID')
  }
  if (!['cpu', 'metal', 'cuda', 'vulkan'].includes(profile.backend)) {
    throw new Error('Invalid model backend')
  }
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
  if (profile.backend === 'metal' && !(process.platform === 'darwin' && process.arch === 'arm64')) {
    throw new Error('The requested model backend does not match this packaged platform')
  }
  if (
    (profile.backend === 'cuda' || profile.backend === 'vulkan') &&
    (!['win32', 'linux'].includes(process.platform) || process.arch !== 'x64')
  ) {
    throw new Error('The requested model backend does not match this packaged platform')
  }
}

function assertRequest(request) {
  if (
    !request ||
    typeof request !== 'object' ||
    (request.type !== 'plan' &&
      request.type !== 'chat' &&
      request.type !== 'document-repair' &&
      request.type !== 'document-fallback')
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
  if (request.type === 'document-repair') assertDocumentRepairRequest(request.request)
  if (request.type === 'document-fallback') assertDocumentFallbackRequest(request.request)
  if (
    typeof request.runtimeEntry !== 'string' ||
    typeof request.modelPath !== 'string' ||
    !isAbsolute(request.runtimeEntry) ||
    !isAbsolute(request.modelPath)
  ) {
    throw new Error('Flexible language runtime paths are invalid')
  }
  assertRuntimeProfile(request.runtimeProfile)
  if (
    request.queueWaitMs !== undefined &&
    (!Number.isInteger(request.queueWaitMs) ||
      request.queueWaitMs < 0 ||
      request.queueWaitMs > 300000)
  ) {
    throw new Error('Invalid local-model queue wait')
  }
}

function assertDocumentRepairRequest(input) {
  if (!input || typeof input !== 'object' || JSON.stringify(input).length > 40000) {
    throw new Error('Document repair input is outside the supported bounds')
  }
  if (
    input.schemaVersion !== 1 ||
    input.reason !== 'parser-disagreement' ||
    !Array.isArray(input.disagreements) ||
    input.disagreements.length !== 1
  ) {
    throw new Error('Document repair requires exactly one bounded parser disagreement')
  }
}

function assertDocumentFallbackRequest(input) {
  if (!input || typeof input !== 'object' || JSON.stringify(input).length > 14000) {
    throw new Error('Document fallback input is outside the supported bounds')
  }
  if (
    input.schemaVersion !== 1 ||
    input.reason !== 'coverage-gap' ||
    !Number.isInteger(input.page) ||
    input.page < 1 ||
    !Array.isArray(input.blocks) ||
    input.blocks.length < 1 ||
    input.blocks.length > 18
  ) {
    throw new Error('Document fallback requires one bounded page window')
  }
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
  if (typeof input.conversationSummary !== 'string' || input.conversationSummary.length > 2000) {
    throw new Error('Conversation summary is outside the supported bounds')
  }
  if (typeof input.calendarContext !== 'string' || input.calendarContext.length > 8000) {
    throw new Error('Calendar context is outside the supported bounds')
  }
}

function createSession(sequence, workload) {
  return new runtime.LlamaChatSession({
    contextSequence: sequence,
    systemPrompt:
      workload === 'chat'
        ? CHAT_SYSTEM_PROMPT
        : workload === 'document'
          ? DOCUMENT_SYSTEM_PROMPT
          : PLAN_SYSTEM_PROMPT,
    contextShift: { strategy: 'eraseFirstResponseAndKeepFirstSystem' }
  })
}

function sessionTypeFor(workload) {
  return workload === 'document-repair' || workload === 'document-fallback' ? 'document' : workload
}

function sessionFor(workload) {
  const sessionType = sessionTypeFor(workload)
  if (loadedProfile.sequences === 2) {
    if (workload === 'chat') return chatSession
    if (!planSequence) throw new Error('The structured local-model sequence is unavailable')
    if (!planSession || planSessionType !== sessionType) {
      planSession?.dispose()
      planSession = createSession(planSequence, sessionType)
      planSessionType = sessionType
    }
    return planSession
  }
  if (!sharedSequence) throw new Error('The shared local-model sequence is unavailable')
  if (!sharedSession || sharedSessionType !== sessionType) {
    sharedSession?.dispose()
    sharedSession = createSession(sharedSequence, sessionType)
    sharedSessionType = sessionType
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
    chatGrammar = null
    documentRepairGrammar = null
    documentFallbackGrammar = null
    planSession = null
    planSessionType = null
    planSequence = null
    chatSession = null
    sharedSession = null
    sharedSessionType = null
    sharedSequence = null
    loadedKey = null
    loadedProfile = null
    sessionUseCounts = new WeakMap()
  }
}

async function ensureRuntime(request, signal) {
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
  if (signal.aborted) throw signal.reason
  const useBundledGpu = profile.backend !== 'cpu'
  llama = await runtime.getLlama({
    gpu: useBundledGpu ? profile.backend : false,
    build: 'never',
    skipDownload: true,
    progressLogs: false,
    logLevel: runtime.LlamaLogLevel.error,
    maxThreads: profile.threads
  })
  model = await llama.loadModel({
    modelPath: request.modelPath,
    gpuLayers: useBundledGpu ? 'auto' : 0,
    useMmap: true,
    loadSignal: signal
  })
  context = await model.createContext({
    contextSize: profile.contextSize,
    sequences: profile.sequences,
    batchSize: profile.batchSize,
    flashAttention: 'auto',
    threads: profile.threads,
    createSignal: signal
  })
  if (profile.sequences === 2) {
    planSequence = context.getSequence()
    planSession = createSession(planSequence, 'plan')
    planSessionType = 'plan'
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
  const weights = { message: 6, calendar: 5, history: 3, summary: 2, profile: 1 }
  const budgets = { message: 0, calendar: 0, history: 0, summary: 0, profile: 0 }
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

function clippedCalendarPacket(value, budget) {
  if (!value || budget <= 0) return { text: '', truncated: Boolean(value) }
  if (tokenLength(value) <= budget) return { text: value, truncated: false }
  try {
    const packet = JSON.parse(value)
    if (
      packet?.schemaVersion !== 1 ||
      !Array.isArray(packet.facts) ||
      typeof packet.truncated !== 'boolean'
    ) {
      return clippedText(value, budget, 'head')
    }
    const fitted = { ...packet, facts: [...packet.facts], truncated: true }
    let text = JSON.stringify(fitted)
    while (fitted.facts.length > 0 && tokenLength(text) > budget) {
      fitted.facts.pop()
      text = JSON.stringify(fitted)
    }
    return tokenLength(text) <= budget ? { text, truncated: true } : { text: '', truncated: true }
  } catch {
    return clippedText(value, budget, 'head')
  }
}

function fitChatPrompt(input, maxTokens, session) {
  const raw = {
    profile: profileText(input),
    summary: input.conversationSummary,
    history: historyText(input.turns),
    calendar: input.calendarContext,
    message: input.text
  }
  const blankPrompt = chatPrompt(input, {
    profile: '',
    summary: '',
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
    summary: clippedText(raw.summary, budgets.summary, 'tail'),
    history: clippedText(raw.history, budgets.history, 'tail'),
    calendar: clippedCalendarPacket(raw.calendar, budgets.calendar),
    message: clippedText(raw.message, budgets.message, 'middle')
  }
  const prompt = chatPrompt(input, {
    profile: fitted.profile.text,
    summary: fitted.summary.text,
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

function fitDocumentRepairPrompt(request, maxTokens, session) {
  const prompt = documentRepairPrompt(request)
  const inputTokens = tokenLength(DOCUMENT_SYSTEM_PROMPT) + tokenLength(prompt) + 32
  if (inputTokens + maxTokens + 64 > session.sequence.contextSize) {
    throw new Error('The parser disagreement is too large for the compact local-model context')
  }
  return { prompt, inputTokens, inputTruncated: false }
}

function fitDocumentFallbackPrompt(request, maxTokens, session) {
  const prompt = documentFallbackPrompt(request)
  const inputTokens = tokenLength(DOCUMENT_SYSTEM_PROMPT) + tokenLength(prompt) + 32
  if (inputTokens + maxTokens + 64 > session.sequence.contextSize) {
    throw new Error('The document fallback window is too large for the compact local-model context')
  }
  return { prompt, inputTokens, inputTruncated: false }
}

function requestMetrics(
  request,
  workload,
  started,
  fitted,
  output,
  tokenLimit,
  stopReason,
  coldStart,
  timeToFirstTokenMs,
  prefixCacheReused
) {
  return {
    workload,
    elapsedMs: Math.max(0, Math.round(perf.now() - started)),
    inputTokens: fitted.inputTokens,
    outputTokens: tokenLength(output),
    tokenLimit,
    stopReason,
    inputTruncated: fitted.inputTruncated,
    coldStart,
    queueWaitMs: request.queueWaitMs ?? 0,
    timeToFirstTokenMs,
    backend: llama.gpu || 'cpu',
    prefixCacheReused,
    processRssMiB: Math.max(0, Math.round(process.memoryUsage().rss / 1024 / 1024))
  }
}

async function handle(request, signal) {
  assertRequest(request)
  if (active) throw new Error('Another flexible language request is already running')
  active = true
  const started = perf.now()
  try {
    const coldStart = await ensureRuntime(request, signal)
    const session = sessionFor(request.type)
    const prefixCacheReused = !coldStart && (sessionUseCounts.get(session) || 0) > 0
    sessionUseCounts.set(session, (sessionUseCounts.get(session) || 0) + 1)
    session.resetChatHistory()
    post({ type: 'status', jobId: request.jobId, phase: 'generating' })
    if (request.type === 'plan') {
      if (!grammar) grammar = await llama.createGrammarForJsonSchema(plannerSchema)
      const maxTokens = plannerTokenBudget(request.text)
      const fitted = fitPlanPrompt(request, maxTokens, session)
      const generated = await session.promptWithMeta(fitted.prompt, {
        grammar,
        budgets: { thoughtTokens: 0 },
        maxTokens,
        signal,
        temperature: 0,
        seed: 17,
        evaluationPriority: 8,
        trimWhitespaceSuffix: true
      })
      post({ type: 'status', jobId: request.jobId, phase: 'validating' })
      const plan = cleanPlanOutput(JSON.parse(generated.responseText), request.text)
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
          request,
          'plan',
          started,
          fitted,
          generated.responseText,
          maxTokens,
          generated.stopReason,
          coldStart,
          null,
          prefixCacheReused
        )
      })
      return
    }

    if (request.type === 'document-repair') {
      if (!documentRepairGrammar) {
        documentRepairGrammar = await llama.createGrammarForJsonSchema(documentRepairSchema)
      }
      const maxTokens = documentRepairTokenBudget(request.request)
      const fitted = fitDocumentRepairPrompt(request.request, maxTokens, session)
      const generated = await session.promptWithMeta(fitted.prompt, {
        grammar: documentRepairGrammar,
        budgets: { thoughtTokens: 0 },
        maxTokens,
        signal,
        temperature: 0,
        seed: 29,
        evaluationPriority: 2,
        trimWhitespaceSuffix: true
      })
      post({ type: 'status', jobId: request.jobId, phase: 'validating' })
      const repair = cleanDocumentRepairOutput(JSON.parse(generated.responseText))
      if (!repair || !Array.isArray(repair.decisions) || repair.decisions.length !== 1) {
        throw new Error('The local model returned an invalid document repair choice')
      }
      post({
        type: 'document-repair-result',
        jobId: request.jobId,
        repair,
        metrics: requestMetrics(
          request,
          'document-repair',
          started,
          fitted,
          generated.responseText,
          maxTokens,
          generated.stopReason,
          coldStart,
          null,
          prefixCacheReused
        )
      })
      return
    }

    if (request.type === 'document-fallback') {
      if (!documentFallbackGrammar) {
        documentFallbackGrammar = await llama.createGrammarForJsonSchema(documentFallbackSchema)
      }
      const maxTokens = documentFallbackTokenBudget(request.request)
      const fitted = fitDocumentFallbackPrompt(request.request, maxTokens, session)
      const generated = await session.promptWithMeta(fitted.prompt, {
        grammar: documentFallbackGrammar,
        budgets: { thoughtTokens: 0 },
        maxTokens,
        signal,
        temperature: 0,
        seed: 31,
        evaluationPriority: 1,
        trimWhitespaceSuffix: true
      })
      post({ type: 'status', jobId: request.jobId, phase: 'validating' })
      const fallback = cleanDocumentFallbackOutput(JSON.parse(generated.responseText))
      if (
        !fallback ||
        !Array.isArray(fallback.groups) ||
        fallback.groups.length < 1 ||
        fallback.groups.length > 8
      ) {
        throw new Error('The local model returned an invalid document fallback grouping')
      }
      post({
        type: 'document-fallback-result',
        jobId: request.jobId,
        fallback,
        metrics: requestMetrics(
          request,
          'document-fallback',
          started,
          fitted,
          generated.responseText,
          maxTokens,
          generated.stopReason,
          coldStart,
          null,
          prefixCacheReused
        )
      })
      return
    }

    const maxTokens = chatTokenBudget(request.input, request.runtimeProfile.maxChatTokens)
    const fitted = fitChatPrompt(request.input, maxTokens, session)
    if (!chatGrammar) chatGrammar = await llama.createGrammarForJsonSchema(chatSchema)
    let streamedText = ''
    let lastVisibleText = ''
    let timeToFirstTokenMs = null
    const generated = await session.promptWithMeta(fitted.prompt, {
      grammar: chatGrammar,
      budgets: { thoughtTokens: 0 },
      maxTokens,
      signal,
      onTextChunk: (chunk) => {
        if (timeToFirstTokenMs === null) {
          timeToFirstTokenMs = Math.max(0, Math.round(perf.now() - started))
        }
        streamedText += chunk
        const visibleText = cleanChatStreamOutput(streamedText, request.input.text)
        if (!visibleText || visibleText === lastVisibleText) return
        lastVisibleText = visibleText
        post({ type: 'chat-chunk', jobId: request.jobId, text: visibleText })
      },
      temperature: Math.max(0.55, Math.min(0.8, 0.6 + request.input.style.warmth * 0.16)),
      seed: 23,
      evaluationPriority: 10,
      topK: 20,
      topP: 0.8,
      repeatPenalty: { penalty: 1.08, frequencyPenalty: 0.04 },
      trimWhitespaceSuffix: true
    })
    post({ type: 'status', jobId: request.jobId, phase: 'validating' })
    const response = cleanChatEnvelopeOutput(
      JSON.parse(generated.responseText),
      request.input.text,
      generated.stopReason,
      Boolean(request.input.calendarContext)
    )
    post({
      type: 'chat-result',
      jobId: request.jobId,
      response,
      metrics: requestMetrics(
        request,
        'chat',
        started,
        fitted,
        generated.responseText,
        maxTokens,
        generated.stopReason,
        coldStart,
        timeToFirstTokenMs,
        prefixCacheReused
      )
    })
  } finally {
    active = false
  }
}

parentPort.on('message', (event) => {
  const request = event.data
  if (request?.type === 'cancel') {
    if (request.jobId === activeJobId) activeController?.abort(new Error('cancelled'))
    return
  }
  const controller = new AbortController()
  activeController = controller
  activeJobId = request && typeof request.jobId === 'string' ? request.jobId : null
  void handle(request, controller.signal)
    .catch((error) => {
      if (controller.signal.aborted) {
        post({ type: 'cancelled', jobId: activeJobId ?? 'unknown' })
        return
      }
      console.error(error)
      post({
        type: 'error',
        jobId: activeJobId ?? 'unknown',
        message: 'The isolated local language engine could not finish that request.'
      })
    })
    .finally(() => {
      if (activeController === controller) activeController = null
      if (activeJobId === request?.jobId) activeJobId = null
    })
})

process.once('exit', () => {
  planSession?.dispose({ disposeSequence: true })
  chatSession?.dispose({ disposeSequence: true })
  sharedSession?.dispose({ disposeSequence: true })
})
