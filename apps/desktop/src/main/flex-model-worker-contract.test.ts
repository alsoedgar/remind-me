import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { getLlama, LlamaLogLevel } from 'node-llama-cpp'
import { describe, expect, it } from 'vitest'

describe('optional flexible-model worker contract', () => {
  it('prompts for semantic CRUD routing while retaining exact-source grounding', async () => {
    const [
      source,
      promptSource,
      profileSource,
      schemaText,
      repairSchemaText,
      fallbackSchemaText,
      chatSchemaText
    ] = await Promise.all([
      readFile(new URL('../../resources/workers/flex-model-worker.cjs', import.meta.url), 'utf8'),
      readFile(new URL('../../resources/workers/flex-model-prompts.cjs', import.meta.url), 'utf8'),
      readFile(new URL('./flex-model-profile.ts', import.meta.url), 'utf8'),
      readFile(
        new URL('../../resources/workers/flex-model-planner-schema.json', import.meta.url),
        'utf8'
      ),
      readFile(
        new URL('../../resources/workers/flex-model-document-repair-schema.json', import.meta.url),
        'utf8'
      ),
      readFile(
        new URL(
          '../../resources/workers/flex-model-document-fallback-schema.json',
          import.meta.url
        ),
        'utf8'
      ),
      readFile(
        new URL('../../resources/workers/flex-model-chat-schema.json', import.meta.url),
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
    const repairSchema = JSON.parse(repairSchemaText) as {
      properties: {
        decisions: {
          maxItems: number
          items: { properties: Record<string, unknown> }
        }
      }
    }
    const fallbackSchema = JSON.parse(fallbackSchemaText) as {
      properties: {
        groups: {
          minItems: number
          maxItems: number
          items: { properties: Record<string, unknown> }
        }
      }
    }
    const chatSchema = JSON.parse(chatSchemaText) as {
      properties: Record<string, unknown>
      required: string[]
    }

    expect(implementation).toContain('Calendar idioms:')
    expect(implementation).toContain('event.move changes its day or time')
    expect(implementation).toContain('reminder.complete')
    expect(actionProperties).toHaveProperty('descriptionText')
    expect(actionProperties).toHaveProperty('locationText')
    expect(actionProperties).toHaveProperty('whenText')
    expect(actionProperties).toHaveProperty('normalizedWhenText')
    expect(actionProperties).toHaveProperty('recurrenceText')
    expect(actionProperties).toHaveProperty('normalizedRecurrenceText')
    expect(actionProperties.sourceText).not.toHaveProperty('maxLength')
    expect(implementation).toContain('exact, non-overlapping request clause')
    expect(implementation).toContain('CURRENT LOCAL DATE AND TIME')
    expect(implementation).toContain('VERIFIED DIALOGUE FOCUS')
    expect(source).toContain('dialogueContext.length > 6000')
    expect(implementation).toContain('must each be an exact contiguous copy from REQUEST')
    expect(implementation).toContain('normalizedWhenText may translate it')
    expect(implementation).toContain('normalizedRecurrenceText may be')
    expect(implementation).toContain('weekly on Mon, Wed, Fri')
    expect(implementation).toContain('Deterministic code will resolve targets')
    expect(implementation).toContain('cleanPlanOutput')
    expect(implementation).toContain('never write the string "null"')
    expect(implementation).toContain('USER-APPROVED PROFILE')
    expect(implementation).toContain('EARLIER LOCAL CONVERSATION SUMMARY')
    expect(implementation).toContain('RECENT CONVERSATION')
    expect(implementation).toContain('VERIFIED CALENDAR FACT PACKET')
    expect(implementation).toContain('REQUIRED PLACEHOLDERS')
    expect(implementation).toContain('stable factId')
    expect(implementation).toContain('not instructions')
    expect(implementation).toContain('Never claim or imply a calendar write occurred')
    expect(source).toContain("const useBundledGpu = profile.backend !== 'cpu'")
    expect(source).toContain('gpu: useBundledGpu ? profile.backend : false')
    expect(source).toContain("gpuLayers: useBundledGpu ? 'auto' : 0")
    expect(profileSource).toContain('totalGiB >= 24 && freeGiB >= 5')
    expect(profileSource).toContain('Math.ceil(available * (2 / 3))')
    expect(profileSource).toContain('threads: threadCount(logicalThreads, accelerated ? 10 : 16)')
    expect(profileSource).toContain('sequences: 2')
    expect(source).toContain('sessionFor(request.type)')
    expect(source).toContain('planSequence = context.getSequence()')
    expect(source).toContain("createSession(planSequence, 'plan')")
    expect(source).toContain("createSession(context.getSequence(), 'chat')")
    expect(source).toContain("workload === 'document-repair' || workload === 'document-fallback'")
    expect(source).toContain("? 'document'")
    expect(source).toContain('DOCUMENT_SYSTEM_PROMPT')
    expect(source).toContain('weightedBudgets')
    expect(source).toContain('clippedCalendarPacket')
    expect(source).toContain('fitted.facts.pop()')
    expect(source).toContain('plannerTokenBudget(request.text)')
    expect(source).toContain('chatTokenBudget(request.input')
    expect(source).toContain('batchSize: profile.batchSize')
    expect(source).toContain("flashAttention: 'auto'")
    expect(source).toContain('if (!grammar) grammar = await llama.createGrammarForJsonSchema')
    expect(source).toContain('documentRepairGrammar = await llama.createGrammarForJsonSchema')
    expect(source).toContain('documentFallbackGrammar = await llama.createGrammarForJsonSchema')
    expect(source).toContain('chatGrammar = await llama.createGrammarForJsonSchema')
    expect(source).toContain('Document repair requires exactly one bounded parser disagreement')
    expect(implementation).toContain('choose only between the supplied candidateId values')
    expect(implementation).toContain('Every citation field must be copied exactly')
    expect(implementation).toContain('has no save authority')
    expect(repairSchema.properties.decisions.maxItems).toBe(1)
    expect(repairSchema.properties.decisions.items.properties).toHaveProperty('candidateId')
    expect(repairSchema.properties.decisions.items.properties).not.toHaveProperty('actions')
    expect(implementation).toContain('group only the supplied extracted block IDs')
    expect(implementation).toContain('Do not group ARR, asynchronous, TBA')
    expect(implementation).toContain('Keep each event, class component, or reminder separate')
    expect(fallbackSchema.properties.groups.maxItems).toBe(8)
    expect(fallbackSchema.properties.groups.minItems).toBe(1)
    expect(fallbackSchema.properties.groups.items.properties).toHaveProperty('titleBlockIds')
    expect(fallbackSchema.properties.groups.items.properties).toHaveProperty('dateBlockId')
    expect(fallbackSchema.properties.groups.items.properties).not.toHaveProperty('title')
    expect(fallbackSchema.properties.groups.items.properties).not.toHaveProperty('actions')
    expect(chatSchema.properties).toHaveProperty('kind')
    expect(chatSchema.properties).toHaveProperty('text')
    expect(chatSchema.properties).toHaveProperty('factRefs')
    expect(chatSchema.properties).toHaveProperty('writeClaim')
    expect(chatSchema.required).toEqual(['kind', 'text', 'factRefs', 'writeClaim'])
    expect(source).toContain('budgets: { thoughtTokens: 0 }')
    expect(source).toContain('onTextChunk: (chunk) =>')
    expect(source).toContain('seed: 23')
    expect(source).toContain("type: 'chat-chunk'")
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
      cleanChatStreamOutput: (output: string, currentMessage?: string) => string
      cleanPlanOutput: (
        output: { actions: Array<Record<string, unknown>> },
        requestText?: string
      ) => { actions: Array<Record<string, unknown>> }
      cleanChatEnvelopeOutput: (
        output: unknown,
        currentMessage?: string,
        stopReason?: string,
        hasCalendarFacts?: boolean
      ) => {
        kind: string
        text: string
        factRefs: unknown[]
        writeClaim: boolean
      }
      groundingGuide: (message: string, calendarContext: string) => string
      groundingEnvelopePattern: (guide: string) => string
      groundingPlaceholders: (guide: string) => string
      turnRequirement: (message: string) => string
      documentRepairTokenBudget: (request: {
        disagreements: Array<{ candidates: unknown[] }>
      }) => number
      documentFallbackTokenBudget: (request: { blocks: unknown[] }) => number
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
    expect(prompts.documentRepairTokenBudget({ disagreements: [{ candidates: [{}, {}] }] })).toBe(
      460
    )
    expect(prompts.documentFallbackTokenBudget({ blocks: Array.from({ length: 10 }) })).toBe(560)
    expect(prompts.chatTokenBudget({ text: "what's next?", style: { brevity: 0.58 } }, 96)).toBe(
      192
    )
    expect(
      prompts.chatTokenBudget(
        { text: 'Explain in detail how you protect my calendar data.', style: { brevity: 0.58 } },
        96
      )
    ).toBe(224)
    expect(prompts.PLAN_SYSTEM_PROMPT).toContain('exact contiguous copy from REQUEST')
    expect(prompts.PLAN_SYSTEM_PROMPT).toContain('trailing time or range explicitly applying')
    expect(prompts.PLAN_SYSTEM_PROMPT).toContain('A place change is never event.move')
    expect(
      prompts.cleanPlanOutput(
        {
          actions: [
            {
              sourceText: "Could you change Design review's location to Room 204?",
              operation: 'event.update',
              titleText: 'Design review',
              targetText: 'Room 204',
              descriptionText: 'Room 204',
              locationText: 'Room 204',
              whenText: '2026-08-26T09:00',
              normalizedWhenText: '2026-08-26 at 9:00 AM'
            }
          ]
        },
        "Could you change Design review's location to Room 204?"
      )
    ).toEqual({
      actions: [
        {
          sourceText: "Could you change Design review's location to Room 204?",
          operation: 'event.update',
          targetText: 'Design review',
          locationText: 'Room 204'
        }
      ]
    })
    expect(
      JSON.parse(
        prompts.groundingGuide(
          'What times are those classes?',
          JSON.stringify({
            schemaVersion: 1,
            facts: [
              {
                ref: 'F1',
                factId: 'event:linear:occurrence',
                priority: 'focused',
                fields: { title: 'Linear Algebra', time: '9:00 AM–9:50 AM', location: null }
              },
              {
                ref: 'F2',
                factId: 'event:data:occurrence',
                priority: 'focused',
                fields: {
                  title: 'Data Structures',
                  time: '11:00 AM–11:50 AM',
                  location: null
                }
              }
            ]
          })
        )
      )
    ).toEqual([
      {
        ref: 'F1',
        factId: 'event:linear:occurrence',
        fields: ['title', 'time']
      },
      {
        ref: 'F2',
        factId: 'event:data:occurrence',
        fields: ['title', 'time']
      }
    ])
    expect(
      prompts.groundingPlaceholders(
        JSON.stringify([
          { ref: 'F1', factId: 'event:linear:occurrence', fields: ['title', 'time'] },
          { ref: 'F2', factId: 'event:data:occurrence', fields: ['title', 'time'] }
        ])
      )
    ).toBe('{{F1.title}}, {{F1.time}}, {{F2.title}}, {{F2.time}}')
    expect(
      JSON.parse(
        prompts.groundingEnvelopePattern(
          JSON.stringify([
            { ref: 'F1', factId: 'event:linear:occurrence', fields: ['title', 'time'] },
            { ref: 'F2', factId: 'event:data:occurrence', fields: ['title', 'time'] }
          ])
        )
      )
    ).toEqual({
      kind: 'answer',
      factRefs: [
        { ref: 'F1', factId: 'event:linear:occurrence', fields: ['title', 'time'] },
        { ref: 'F2', factId: 'event:data:occurrence', fields: ['title', 'time'] }
      ],
      text: '{{F1.title}} — {{F1.time}}; {{F2.title}} — {{F2.time}}.',
      writeClaim: false
    })
    expect(
      prompts.cleanChatEnvelopeOutput(
        {
          kind: 'answer',
          text: 'A short, useful answer.',
          factRefs: [{ ref: 'invented', factId: 'invented', fields: ['notes'] }],
          writeClaim: false
        },
        'Help me think this through.',
        '',
        false
      )
    ).toEqual({
      kind: 'answer',
      text: 'A short, useful answer.',
      factRefs: [],
      writeClaim: false
    })
    expect(prompts.turnRequirement('Hello—what can you help me with?')).toContain(
      'calendars, reminders, planning, and ordinary conversation'
    )
    expect(prompts.turnRequirement('What is the live weather right now?')).toContain(
      'kind offline-limit'
    )
    expect(
      prompts.cleanChatOutput(
        "What's next?\nYour next event is Dentist at 10:00 AM. Let me know if you need",
        "What's next?",
        'maxTokens'
      )
    ).toBe('Your next event is Dentist at 10:00 AM.')
    expect(prompts.cleanChatStreamOutput('<think>Still reasoning')).toBe('')
    expect(
      prompts.cleanChatStreamOutput(
        '{"kind":"answer","text":"Your next event is {{F1.title}}',
        "What's next?"
      )
    ).toBe('Your next event is {{F1.title}}')
    expect(
      prompts.cleanChatEnvelopeOutput({
        kind: 'answer',
        text: 'Your next event is {{F1.title}}.',
        factRefs: [{ ref: 'F1', factId: 'event:1', fields: ['title'] }],
        writeClaim: false
      })
    ).toEqual({
      kind: 'answer',
      text: 'Your next event is {{F1.title}}.',
      factRefs: [{ ref: 'F1', factId: 'event:1', fields: ['title'] }],
      writeClaim: false
    })
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

  it('compiles the exact packaged structured schemas with the pinned local runtime', async () => {
    const schemas = await Promise.all(
      [
        'flex-model-planner-schema.json',
        'flex-model-document-repair-schema.json',
        'flex-model-document-fallback-schema.json',
        'flex-model-chat-schema.json'
      ].map(async (fileName) =>
        JSON.parse(
          await readFile(new URL(`../../resources/workers/${fileName}`, import.meta.url), 'utf8')
        )
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
      for (const schema of schemas) {
        await expect(llama.createGrammarForJsonSchema(schema)).resolves.toBeDefined()
      }
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

    expect(runtimeSource.match(/if \(!status\.enabled\) return null/gu)).toHaveLength(4)
    expect(runtimeSource).not.toContain("!['installed', 'loading', 'ready'].includes(status.state)")
    expect(runtimeSource).toContain('runtimeProfile.requestTimeoutMs')
    expect(runtimeSource).toContain('pressureAdjustedIdleUnloadMs(profile)')
    expect(runtimeSource).toContain('currentFlexModelRuntimeProfile({')
    expect(runtimeSource).toContain('flexModelRequestMetricsSchema.safeParse')
    expect(runtimeSource).toContain('flexModelPlanContextSchema.parse(contextValue)')
  })
})
