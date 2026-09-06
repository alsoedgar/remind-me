import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  documentFallbackRequestSchema,
  flexModelPlanSchema,
  type FlexModelChatRequest
} from '@remind-me/contracts'
import { groundFlexChatResponse } from '../../../../packages/storage/src/flex-chat-grounding'
import {
  connectedAssistantFallbacks,
  OnlineAiService,
  onlineAiJsonSchema
} from './online-ai-service'

const directories: string[] = []
const key = 'sk-test-secret-never-display-this-key'
const context = {
  currentLocalDateTime: '2026-09-05T09:00',
  timezone: 'America/Chicago',
  locale: 'en-US'
}
const vault = {
  isAvailable: async () => true,
  encrypt: async (value: string) => Buffer.from(value).toString('base64'),
  decrypt: async (value: string) => Buffer.from(value, 'base64').toString('utf8')
}

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    // Every target is created by mkdtemp under this test's fixed temporary prefix.
    await rm(directory, { recursive: true, force: true })
  }
})

function response(output: unknown, status = 'completed'): Response {
  return Response.json({
    status,
    output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(output) }] }]
  })
}

async function setup(
  reply: (init: RequestInit) => Promise<Response> = async () => response({ actions: [] }),
  timeout?: number
) {
  const directory = await mkdtemp(join(tmpdir(), 'remind-me-online-ai-'))
  directories.push(directory)
  const path = join(directory, 'connection.json')
  const fetcher = vi.fn<typeof fetch>(async (_url, init) =>
    init?.method === 'GET' ? Response.json({ id: 'gpt-6-astra' }) : reply(init ?? {})
  )
  const service = new OnlineAiService({
    connectionPath: path,
    credentialVault: vault,
    fetchImplementation: fetcher,
    ...(timeout ? { requestTimeoutMs: timeout } : {})
  })
  return { service, fetcher, path }
}

async function connect(service: OnlineAiService, useForAssistant = true) {
  return service.connect({ apiKey: key, model: 'gpt-6-astra', useForAssistant })
}

const documentRequest = documentFallbackRequestSchema.parse({
  schemaVersion: 1,
  requestId: 'request:doc',
  selectionId: 'document:test',
  sourceSha256: 'a'.repeat(64),
  reason: 'coverage-gap',
  page: 1,
  blocks: ['Design review', 'September 8, 2026', '9:00 AM - 10:00 AM'].map((text, index) => ({
    id: `block:${index}`,
    page: 1,
    text,
    boundingBox: { x: 0.1, y: 0.1 + index * 0.05, width: 0.5, height: 0.03 },
    confidence: 0.94,
    method: 'ocr',
    claimed: false
  }))
})
const group = {
  titleBlockIds: ['block:0'],
  dateBlockId: 'block:1',
  timeBlockId: 'block:2',
  locationBlockId: null,
  recurrenceBlockId: null,
  descriptionBlockIds: []
}
const pageImageDataUrl = 'data:image/png;base64,iVBORw0KGgo='

describe('optional OpenAI connection', () => {
  it('stays offline by default and protects a verified user key outside status data', async () => {
    const { service, path, fetcher } = await setup()
    expect(await service.getStatus()).toMatchObject({ configured: false, useForAssistant: false })
    expect(await service.planCalendar('Remind me to call Mom', context)).toEqual({
      kind: 'disabled'
    })
    expect(fetcher).not.toHaveBeenCalled()
    expect(await connect(service, false)).toMatchObject({
      configured: true,
      useForAssistant: false
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://api.openai.com/v1/models/gpt-6-astra')
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: 'GET',
      redirect: 'error',
      headers: { Authorization: `Bearer ${key}` }
    })
    expect(await readFile(path, 'utf8')).not.toContain(key)
    expect(JSON.stringify(await service.getStatus())).not.toContain(key)
    await service.configure({ useForAssistant: true })
    expect(await service.assistantEnabled()).toBe(true)
    expect(fetcher).toHaveBeenCalledTimes(1)
    await service.disconnect()
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('requires OS-protected storage and disables online calls in smoke runs', async () => {
    const { path, fetcher } = await setup()
    const unavailable = new OnlineAiService({
      connectionPath: path,
      credentialVault: { ...vault, isAvailable: async () => false },
      fetchImplementation: fetcher
    })
    await expect(connect(unavailable)).rejects.toThrow('credential store')
    const offline = new OnlineAiService({
      connectionPath: path,
      credentialVault: vault,
      fetchImplementation: fetcher,
      disabled: true
    })
    await expect(connect(offline)).rejects.toThrow('credential store')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('keeps the old connection when verification fails and never echoes provider errors', async () => {
    const { service, fetcher, path } = await setup()
    await connect(service)
    const saved = await readFile(path, 'utf8')
    fetcher.mockResolvedValueOnce(new Response(`invalid credential ${key}`, { status: 401 }))
    await expect(connect(service)).rejects.toThrow('rejected this API key')
    expect(await readFile(path, 'utf8')).toBe(saved)
    expect(JSON.stringify(await service.getStatus())).not.toContain(key)
  })

  it('sends strict structured requests with no storage or tools and preserves undated actions', async () => {
    const plan = {
      actions: [
        {
          sourceText: 'Remind me to call Mom',
          operation: 'reminder.create',
          titleText: 'call Mom',
          whenText: null,
          normalizedWhenText: null
        }
      ]
    }
    const { service, fetcher } = await setup(async () => response(plan))
    await connect(service)
    expect(await service.planCalendar('Remind me to call Mom', context)).toEqual({
      kind: 'plan',
      plan
    })
    const body = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))
    expect(body).toMatchObject({
      model: 'gpt-6-astra',
      store: false,
      text: { format: { type: 'json_schema', strict: true } }
    })
    expect(body.tools).toBeUndefined()
    expect(body.input[0].content).toHaveLength(1)
    expect(body.instructions).toContain('Reminders may have no due date')
  })

  it.each([
    ['incomplete', () => response({ actions: [{ operation: 'event.create' }] }, 'incomplete')],
    [
      'malformed',
      () => response({ actions: [{ operation: 'delete-everything', sourceText: 'oops' }] })
    ],
    [
      'refused',
      () =>
        Response.json({
          status: 'completed',
          output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }]
        })
    ],
    ['oversized', () => new Response('x'.repeat(512_001))]
  ])('rejects %s output without accepting partial actions', async (_name, reply) => {
    const { service } = await setup(async () => reply())
    await connect(service)
    expect(await service.planCalendar('Add my events', context)).toEqual({ kind: 'invalid-output' })
  })

  it('reports quota problems without exposing provider bodies', async () => {
    const { service } = await setup(async () => new Response(key, { status: 429 }))
    await connect(service)
    expect(await service.planCalendar('Add my events', context)).toEqual({ kind: 'unavailable' })
    expect((await service.getStatus()).lastError).toContain('billing')
    expect(JSON.stringify(await service.getStatus())).not.toContain(key)
  })

  it.each(['cancel', 'disconnect'] as const)(
    'aborts in-flight generation on %s',
    async (action) => {
      let started!: () => void
      const running = new Promise<void>((resolve) => {
        started = resolve
      })
      const { service } = await setup(async (init) => {
        started()
        return new Promise((_resolve, reject) =>
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
        )
      })
      await connect(service)
      const pending = service.planCalendar('Add my events', context, {
        cancellationId: 'test:cancel'
      })
      await running
      if (action === 'cancel') expect(service.cancel('test:cancel')).toBe(true)
      else await service.disconnect()
      expect(await pending).toEqual({ kind: 'cancelled' })
    }
  )

  it('times out without losing or returning a partial result', async () => {
    const { service } = await setup(
      async (init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
        }),
      30
    )
    await connect(service)
    expect(await service.planCalendar('Add my events', context)).toEqual({ kind: 'timeout' })
  })

  it('uploads document images only on an explicit document request and grounds every returned ID', async () => {
    const { service, fetcher } = await setup(async () => response({ groups: [group] }))
    await connect(service, false)
    await expect(
      service.groupDocument({ request: documentRequest, pageImageDataUrl, consentToUpload: false })
    ).rejects.toThrow()
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(
      await service.groupDocument({
        request: documentRequest,
        pageImageDataUrl,
        consentToUpload: true
      })
    ).toMatchObject({ groups: [group], modelId: 'openai', hasMutationAuthority: false })
    const body = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))
    expect(body.input[0].content[1]).toEqual({
      type: 'input_image',
      image_url: pageImageDataUrl,
      detail: 'high'
    })
    fetcher.mockResolvedValueOnce(
      response({ groups: [{ ...group, dateBlockId: 'invented:block' }] })
    )
    await expect(
      service.groupDocument({ request: documentRequest, pageImageDataUrl, consentToUpload: true })
    ).rejects.toThrow('reliably')
  })

  it('can abstain from document grouping instead of forcing a guessed event', async () => {
    const { service } = await setup(async () => response({ groups: [] }))
    await connect(service)
    expect(
      await service.groupDocument({
        request: documentRequest,
        pageImageDataUrl,
        consentToUpload: true
      })
    ).toBeNull()
  })

  it('uses the existing local fallback when online assistance is not enabled', async () => {
    const { service, fetcher } = await setup()
    const planCalendar = vi.fn(async () => ({ kind: 'not-calendar' as const }))
    const providers = connectedAssistantFallbacks(service, {
      calendarPlanner: { planCalendar },
      generalResponder: null
    })
    expect(await providers.calendarPlanner?.planCalendar('hello', context)).toEqual({
      kind: 'not-calendar'
    })
    expect(planCalendar).toHaveBeenCalledTimes(1)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('keeps calendar answers in protected placeholders until the factual validator approves', async () => {
    const envelope = {
      kind: 'answer',
      text: '{{F1.title}} is in {{F1.location}}.',
      factRefs: [{ ref: 'F1', factId: 'fact:test', fields: ['title', 'location'] }],
      writeClaim: false
    }
    const { service } = await setup(async () => response(envelope))
    await connect(service)
    // Use real default profile/style contracts, as provided by the assistant service.
    const { assistantProfileSchema, responseStyleSchema } = await import('@remind-me/contracts')
    const input = {
      text: 'Where is design review?',
      turns: [],
      conversationSummary: '',
      calendarContext: '',
      currentLocalDateTime: context.currentLocalDateTime,
      timezone: context.timezone,
      profile: assistantProfileSchema.parse({
        preferredName: '',
        customInstructions: '',
        memoryEnabled: false,
        memories: []
      }),
      style: responseStyleSchema.parse({
        warmth: 0.5,
        brevity: 0.7,
        formality: 0.4,
        humor: 0,
        emoji: 0,
        contractions: true,
        proactivity: 0
      })
    } as FlexModelChatRequest
    const chunk = vi.fn()
    const result = await service.respondGeneral(input, chunk)
    expect(result).toEqual(envelope)
    expect(chunk).not.toHaveBeenCalled()
    expect(
      groundFlexChatResponse(
        result,
        { schemaVersion: 1, range: null, facts: [], truncated: false },
        input.text
      )
    ).toEqual({ ok: false, reason: 'fact-rejected' })
  })

  it('makes optional fields nullable and required in the OpenAI JSON schema', () => {
    const schema = onlineAiJsonSchema(flexModelPlanSchema)
    const properties = schema.properties as Record<
      string,
      {
        items: {
          properties: Record<string, unknown>
          required: string[]
          additionalProperties: boolean
        }
      }
    >
    const action = properties.actions!.items
    expect(action.required).toContain('whenText')
    expect(action.additionalProperties).toBe(false)
    expect(action.properties.whenText).toHaveProperty('anyOf')
  })
})
