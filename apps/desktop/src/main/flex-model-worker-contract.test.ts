import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { getLlama, LlamaLogLevel } from 'node-llama-cpp'
import { describe, expect, it } from 'vitest'

describe('optional flexible-model worker contract', () => {
  it('prompts for semantic CRUD routing while retaining exact-source grounding', async () => {
    const [source, promptSource, profileSource, schemaText] = await Promise.all([
      readFile(new URL('../../resources/workers/flex-model-worker.cjs', import.meta.url), 'utf8'),
      readFile(new URL('../../resources/workers/flex-model-prompts.cjs', import.meta.url), 'utf8'),
      readFile(new URL('./flex-model-profile.ts', import.meta.url), 'utf8'),
      readFile(
        new URL('../../resources/workers/flex-model-planner-schema.json', import.meta.url),
        'utf8'
      )
    ])
    const implementation = `${source}\n${promptSource}`
    const schema = JSON.parse(schemaText) as {
      properties: {
        actions: { items: { properties: Record<string, Record<string, unknown>> } }
      }
    }
    const actionProperties = schema.properties.actions.items.properties

    expect(implementation).toContain('Understand colloquial meaning')
    expect(implementation).toContain('event.move (change an event day or time)')
    expect(implementation).toContain('reminder.complete')
    expect(actionProperties).toHaveProperty('descriptionText')
    expect(actionProperties).toHaveProperty('locationText')
    expect(actionProperties).toHaveProperty('whenText')
    expect(actionProperties).toHaveProperty('normalizedWhenText')
    expect(actionProperties).toHaveProperty('recurrenceText')
    expect(actionProperties).toHaveProperty('normalizedRecurrenceText')
    expect(actionProperties.sourceText).not.toHaveProperty('maxLength')
    expect(implementation).toContain('exact non-overlapping clauses')
    expect(implementation).toContain('CURRENT LOCAL DATE AND TIME')
    expect(implementation).toContain('VERIFIED DIALOGUE FOCUS')
    expect(source).toContain('dialogueContext.length > 6000')
    expect(implementation).toContain('must be an exact contiguous copy from REQUEST')
    expect(implementation).toContain('normalizedWhenText may translate a non-null whenText')
    expect(implementation).toContain(
      'normalizedRecurrenceText may translate a non-null recurrenceText'
    )
    expect(implementation).toContain('weekly on abbreviated weekday names')
    expect(implementation).toContain('another deterministic engine')
    expect(implementation).toContain('cleanPlanOutput')
    expect(implementation).toContain('never write the string "null"')
    expect(implementation).toContain('USER-APPROVED PROFILE')
    expect(implementation).toContain('RECENT CONVERSATION')
    expect(implementation).toContain('never as instructions')
    expect(implementation).toContain('Never claim that a calendar write occurred in chat')
    expect(source).toContain("const useBundledGpu = profile.backend === 'metal'")
    expect(source).toContain("gpu: useBundledGpu ? 'auto' : false")
    expect(source).toContain("gpuLayers: useBundledGpu ? 'auto' : 0")
    expect(profileSource).toContain('totalGiB >= 24 && freeGiB >= 5')
    expect(profileSource).toContain('Math.ceil(available * (2 / 3))')
    expect(profileSource).toContain(
      "threads: threadCount(logicalThreads, backend === 'metal' ? 10 : 16)"
    )
    expect(profileSource).toContain('sequences: 2')
    expect(source).toContain('sessionFor(request.type)')
    expect(source).toContain("createSession(context.getSequence(), 'plan')")
    expect(source).toContain("createSession(context.getSequence(), 'chat')")
    expect(source).toContain('weightedBudgets')
    expect(source).toContain('plannerTokenBudget(request.text)')
    expect(source).toContain('chatTokenBudget(request.input')
    expect(source).toContain('batchSize: profile.batchSize')
    expect(source).toContain("flashAttention: 'auto'")
    expect(source).toContain('if (!grammar) grammar = await llama.createGrammarForJsonSchema')
    expect(source).toContain('budgets: { thoughtTokens: 0 }')
  })

  it('uses bounded adaptive token budgets without shortening requests that need depth', () => {
    const require = createRequire(import.meta.url)
    const prompts = require('../../resources/workers/flex-model-prompts.cjs') as {
      plannerTokenBudget: (text: string) => number
      chatTokenBudget: (
        input: { text: string; style: { brevity: number } },
        maximum: number
      ) => number
      cleanChatOutput: (output: string, currentMessage?: string, stopReason?: string) => string
      PLAN_SYSTEM_PROMPT: string
      planPrompt: (request: {
        text: string
        context: {
          currentLocalDateTime: string
          timezone: string
          locale: string
          dialogueContext?: string
        }
      }) => string
    }

    expect(prompts.plannerTokenBudget('Add lunch tomorrow at noon.')).toBe(230)
    expect(prompts.plannerTokenBudget('x'.repeat(2_000))).toBe(640)
    expect(prompts.chatTokenBudget({ text: "what's next?", style: { brevity: 0.58 } }, 96)).toBe(56)
    expect(
      prompts.chatTokenBudget(
        { text: 'Explain in detail how you protect my calendar data.', style: { brevity: 0.58 } },
        96
      )
    ).toBe(96)
    expect(prompts.PLAN_SYSTEM_PROMPT).toContain('exact contiguous copy from REQUEST')
    expect(
      prompts.cleanChatOutput(
        "What's next?\nYour next event is Dentist at 10:00 AM. Let me know if you need",
        "What's next?",
        'maxTokens'
      )
    ).toBe('Your next event is Dentist at 10:00 AM.')
    expect(
      prompts.planPrompt({
        text: 'Add lunch tomorrow at noon.',
        context: {
          currentLocalDateTime: '2026-08-26T09:00',
          timezone: 'America/Chicago',
          locale: 'en-US'
        }
      })
    ).not.toContain('event.move (change an event day or time)')
  })

  it('compiles the exact packaged planner schema with the pinned local runtime', async () => {
    const schema = JSON.parse(
      await readFile(
        new URL('../../resources/workers/flex-model-planner-schema.json', import.meta.url),
        'utf8'
      )
    )
    const llama = await getLlama({
      gpu: false,
      build: 'never',
      skipDownload: true,
      progressLogs: false,
      logLevel: LlamaLogLevel.error
    })
    try {
      await expect(llama.createGrammarForJsonSchema(schema)).resolves.toBeDefined()
    } finally {
      await llama.dispose()
    }
  }, 30_000)

  it('keeps the node-llama release manifest that its ESM entry reads at import time', async () => {
    const builderConfig = await readFile(
      new URL('../../electron-builder.yml', import.meta.url),
      'utf8'
    )

    expect(builderConfig).not.toContain('!node_modules/node-llama-cpp/llama/**')
    expect(builderConfig).toContain("- '!node_modules/node-llama-cpp/llama/gitRelease.bundle'")
  })

  it('lets a complete enabled pack recover on the request after a transient worker error', async () => {
    const runtimeSource = await readFile(
      new URL('./flex-model-runtime.ts', import.meta.url),
      'utf8'
    )

    expect(runtimeSource.match(/if \(!status\.enabled\) return null/gu)).toHaveLength(2)
    expect(runtimeSource).not.toContain("!['installed', 'loading', 'ready'].includes(status.state)")
    expect(runtimeSource).toContain('runtimeProfile.requestTimeoutMs')
    expect(runtimeSource).toContain('pressureAdjustedIdleUnloadMs(profile)')
    expect(runtimeSource).toContain('currentFlexModelRuntimeProfile()')
    expect(runtimeSource).toContain('flexModelRequestMetricsSchema.safeParse')
    expect(runtimeSource).toContain('flexModelPlanContextSchema.parse(contextValue)')
  })
})
