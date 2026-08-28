import { strict as assert } from 'node:assert'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import {
  assistantCancelRequestSchema,
  assistantStreamEventSchema,
  flexModelConfigureRequestSchema,
  flexModelRequestMetricsSchema
} from '@remind-me/contracts'
import { packagesToKeep } from '../apps/desktop/scripts/prune-node-llama-binaries.mjs'

const require = createRequire(import.meta.url)
const prompts = require('../apps/desktop/resources/workers/flex-model-prompts.cjs') as {
  DOCUMENT_SYSTEM_PROMPT: string
  PLAN_SYSTEM_PROMPT: string
  plannerOperationGuide: (text: string) => string
  planPrompt: (request: {
    text: string
    context: {
      currentLocalDateTime: string
      timezone: string
      locale: string
      dialogueContext?: string
    }
  }) => string
  chatPrompt: (input: {
    text: string
    turns: Array<{ role: 'user' | 'assistant'; text: string }>
    conversationSummary: string
    calendarContext: string
    currentLocalDateTime: string
    timezone: string
    profile: {
      preferredName: string
      customInstructions: string
      memoryEnabled: boolean
      memories: string[]
    }
    style: {
      warmth: number
      brevity: number
      formality: number
      humor: number
      contractions: boolean
      proactivity: number
    }
  }) => string
}

const [runtimeSource, schedulerSource, storeSource, workerSource] = await Promise.all([
  readFile(new URL('../apps/desktop/src/main/flex-model-runtime.ts', import.meta.url), 'utf8'),
  readFile(new URL('../apps/desktop/src/main/flex-model-scheduler.ts', import.meta.url), 'utf8'),
  readFile(
    new URL('../apps/desktop/src/renderer/src/store/assistant-store.ts', import.meta.url),
    'utf8'
  ),
  readFile(
    new URL('../apps/desktop/resources/workers/flex-model-worker.cjs', import.meta.url),
    'utf8'
  )
])

const planningPrompt = prompts.planPrompt({
  text: 'Add lunch tomorrow at noon.',
  context: {
    currentLocalDateTime: '2026-08-28T09:00',
    timezone: 'America/Chicago',
    locale: 'en-US'
  }
})
const broadPrompt = prompts.chatPrompt({
  text: 'Write something encouraging.',
  turns: [],
  conversationSummary: '',
  calendarContext: '',
  currentLocalDateTime: '2026-08-28T09:00',
  timezone: 'America/Chicago',
  profile: {
    preferredName: '',
    customInstructions: '',
    memoryEnabled: false,
    memories: []
  },
  style: {
    warmth: 0.7,
    brevity: 0.58,
    formality: 0.3,
    humor: 0.08,
    contractions: true,
    proactivity: 0.45
  }
})

assert(prompts.PLAN_SYSTEM_PROMPT.length <= 3_500)
assert(prompts.DOCUMENT_SYSTEM_PROMPT.length <= 300)
assert(planningPrompt.length <= 400)
assert(!broadPrompt.includes('VERIFIED CALENDAR FACT PACKET'))
assert(prompts.plannerOperationGuide('Add lunch tomorrow at noon.').includes('event.create'))
assert(!prompts.plannerOperationGuide('Add lunch tomorrow at noon.').includes('event.delete'))

assert(schedulerSource.includes('preemptDocumentForForeground'))
assert(schedulerSource.includes('workloadPriority'))
assert(runtimeSource.includes('cancelInference(cancellationId: string)'))
assert(workerSource.includes('prefixCacheReused'))
assert(runtimeSource.includes('backendManifest'))
assert(storeSource.includes("event.type === 'status'"))
assert(storeSource.includes('cancelAssistantMessage(streamId)'))

assistantStreamEventSchema.parse({
  type: 'status',
  streamId: 'assistant-stream:phase6',
  status: {
    workload: 'chat',
    phase: 'generating',
    queuePosition: 0,
    queuedJobs: 0,
    canCancel: true
  }
})
assistantCancelRequestSchema.parse({ streamId: 'assistant-stream:phase6' })
flexModelConfigureRequestSchema.parse({
  warmthPolicy: 'automatic',
  accelerationPreference: 'auto'
})
flexModelRequestMetricsSchema.parse({
  workload: 'chat',
  elapsedMs: 120,
  inputTokens: 200,
  outputTokens: 24,
  tokenLimit: 192,
  stopReason: 'eogToken',
  inputTruncated: false,
  coldStart: false,
  queueWaitMs: 3,
  timeToFirstTokenMs: 42,
  backend: 'cpu',
  prefixCacheReused: true,
  processRssMiB: 2_048
})

assert.deepEqual(packagesToKeep('win32', 'x64', 'portable'), ['win-x64'])
assert.deepEqual(packagesToKeep('win32', 'x64', 'vulkan'), ['win-x64', 'win-x64-vulkan'])

console.log(
  JSON.stringify(
    {
      phase: 6,
      status: 'passed',
      plannerSystemCharacters: prompts.PLAN_SYSTEM_PROMPT.length,
      documentSystemCharacters: prompts.DOCUMENT_SYSTEM_PROMPT.length,
      simplePlannerCharacters: planningPrompt.length,
      broadChatCharacters: broadPrompt.length,
      portableBackends: packagesToKeep('win32', 'x64', 'portable'),
      optionalBackends: ['metal', 'vulkan', 'cuda']
    },
    null,
    2
  )
)
