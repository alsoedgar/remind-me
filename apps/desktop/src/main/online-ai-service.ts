import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  defaultOnlineAiModel,
  documentFallbackModelOutputSchema,
  flexModelChatRequestSchema,
  flexModelChatResponseSchema,
  flexModelPlanContextSchema,
  flexModelPlanSchema,
  onlineAiConnectRequestSchema,
  onlineAiConfigureRequestSchema,
  onlineAiDocumentRequestSchema,
  onlineAiStatusSchema,
  type DocumentFallbackResponse,
  type FlexModelCalendarFallbackResult,
  type FlexModelChatRequest,
  type FlexModelGeneralFallbackResult,
  type FlexModelPlanContext,
  type OnlineAiStatus
} from '@remind-me/contracts'
import { validateDocumentFallbackResponse } from '@remind-me/importers/document'
import type { AssistantFallbackServices, FallbackInferenceOptions } from '@remind-me/storage'
import type { CanvasCredentialVault } from './canvas-service'
import {
  PLAN_SYSTEM_PROMPT,
  CHAT_SYSTEM_PROMPT,
  DOCUMENT_SYSTEM_PROMPT,
  planPrompt,
  chatPrompt,
  documentFallbackPrompt
} from '../../resources/workers/flex-model-prompts.cjs'

const storedConnectionSchema = z
  .object({
    version: z.literal(1),
    encryptedApiKey: z.string().min(1).max(16_000),
    model: onlineAiStatusSchema.shape.model,
    useForAssistant: z.boolean()
  })
  .strict()
type StoredConnection = z.infer<typeof storedConnectionSchema>

const planOutputSchema = flexModelPlanSchema.extend({
  actions: z.array(flexModelPlanSchema.shape.actions.element).max(8)
})
const documentOutputSchema = documentFallbackModelOutputSchema.extend({
  groups: z.array(documentFallbackModelOutputSchema.shape.groups.element).max(8)
})
// Structured Outputs requires an object at the root, including for discriminated unions.
const chatOutputSchema = z
  .object({
    kind: z.enum(['answer', 'clarification', 'offline-limit', 'refusal']),
    text: z.string().trim().min(1).max(8000),
    factRefs: flexModelChatResponseSchema.options[0].shape.factRefs,
    writeClaim: z.literal(false)
  })
  .strict()

/** Optional properties are required and nullable on the wire; local validation still applies. */
export function onlineAiJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema) as Record<string, unknown>
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    const node = value as Record<string, unknown>
    delete node.$schema
    if (node.type === 'object' && node.properties) {
      const properties = node.properties as Record<string, unknown>
      const required = new Set(node.required as string[] | undefined)
      for (const [name, property] of Object.entries(properties)) {
        if (!required.has(name)) properties[name] = { anyOf: [property, { type: 'null' }] }
      }
      node.required = Object.keys(properties)
      node.additionalProperties = false
    }
    Object.values(node).forEach(visit)
  }
  visit(json)
  return json
}

class OnlineAiError extends Error {
  constructor(
    message: string,
    readonly kind: 'unavailable' | 'invalid-output' | 'timeout' | 'cancelled' = 'unavailable'
  ) {
    super(message)
  }
}

interface OnlineAiOptions {
  connectionPath: string
  credentialVault: CanvasCredentialVault
  fetchImplementation?: typeof fetch
  disabled?: boolean
  requestTimeoutMs?: number
}

export class OnlineAiService {
  private readonly fetchImplementation: typeof fetch
  private lastError: string | null = null
  private readonly requests = new Map<string, AbortController>()
  private connectionRevision = 0
  private changingConnection = false

  constructor(private readonly options: OnlineAiOptions) {
    this.fetchImplementation = options.fetchImplementation ?? fetch
  }

  async getStatus(): Promise<OnlineAiStatus> {
    const connection = await this.readConnection()
    return onlineAiStatusSchema.parse({
      configured: connection !== null,
      provider: 'OpenAI',
      model: connection?.model ?? defaultOnlineAiModel,
      useForAssistant: connection?.useForAssistant ?? false,
      credentialStorageAvailable:
        !this.options.disabled && (await this.options.credentialVault.isAvailable()),
      lastError: this.lastError
    })
  }

  async connect(value: unknown): Promise<OnlineAiStatus> {
    if (this.changingConnection) throw new Error('An AI connection change is already in progress.')
    this.changingConnection = true
    let temporaryPath: string | null = null
    try {
      const input = onlineAiConnectRequestSchema.parse(value)
      if (this.options.disabled || !(await this.options.credentialVault.isAvailable())) {
        throw new OnlineAiError(
          'Enable the operating system credential store before connecting OpenAI.'
        )
      }
      // Verify access to the selected model without uploading user content or generating tokens.
      await this.fetchJson(
        `https://api.openai.com/v1/models/${encodeURIComponent(input.model)}`,
        input.apiKey,
        { method: 'GET' },
        AbortSignal.timeout(15_000)
      )
      const stored: StoredConnection = {
        version: 1,
        encryptedApiKey: await this.options.credentialVault.encrypt(input.apiKey),
        model: input.model,
        useForAssistant: input.useForAssistant
      }
      await mkdir(dirname(this.options.connectionPath), { recursive: true })
      temporaryPath = `${this.options.connectionPath}.${randomUUID()}.tmp`
      await writeFile(temporaryPath, JSON.stringify(stored), {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx'
      })
      await rename(temporaryPath, this.options.connectionPath)
      this.connectionRevision += 1
      this.cancelAll()
      this.lastError = null
      return await this.getStatus()
    } catch (error) {
      throw this.friendlyError(error)
    } finally {
      if (temporaryPath) await rm(temporaryPath, { force: true }).catch(() => undefined)
      this.changingConnection = false
    }
  }

  async disconnect(): Promise<OnlineAiStatus> {
    if (this.changingConnection) throw new Error('An AI connection change is already in progress.')
    this.changingConnection = true
    try {
      this.connectionRevision += 1
      this.cancelAll()
      await rm(this.options.connectionPath, { force: true })
      this.lastError = null
      return await this.getStatus()
    } finally {
      this.changingConnection = false
    }
  }

  async configure(value: unknown): Promise<OnlineAiStatus> {
    const input = onlineAiConfigureRequestSchema.parse(value)
    if (this.changingConnection) throw new Error('An AI connection change is already in progress.')
    this.changingConnection = true
    const temporaryPath = `${this.options.connectionPath}.${randomUUID()}.tmp`
    try {
      const connection = await this.readConnection()
      if (!connection) throw new OnlineAiError('Connect OpenAI in Settings first.')
      await writeFile(temporaryPath, JSON.stringify({ ...connection, ...input }), {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx'
      })
      await rename(temporaryPath, this.options.connectionPath)
      this.connectionRevision += 1
      this.cancelAll()
      return await this.getStatus()
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined)
      this.changingConnection = false
    }
  }

  cancel(cancellationId: string): boolean {
    const request = this.requests.get(cancellationId)
    request?.abort()
    return Boolean(request)
  }

  cancelAll(): void {
    for (const request of this.requests.values()) request.abort()
  }

  async assistantEnabled(): Promise<boolean> {
    return (await this.readConnection())?.useForAssistant ?? false
  }

  async planCalendar(
    text: string,
    context: FlexModelPlanContext,
    options: FallbackInferenceOptions = {}
  ): Promise<FlexModelCalendarFallbackResult> {
    if (!(await this.assistantEnabled())) return { kind: 'disabled' }
    try {
      const inputText = z.string().trim().min(1).max(4000).parse(text)
      const inputContext = flexModelPlanContextSchema.parse(context)
      const result = await this.generate(
        planOutputSchema,
        'calendar_plan',
        PLAN_SYSTEM_PROMPT,
        planPrompt({ text: inputText, context: inputContext }),
        options
      )
      if (result.actions.length === 0) return { kind: 'not-calendar' }
      return { kind: 'plan', plan: flexModelPlanSchema.parse(result) }
    } catch (error) {
      return { kind: this.friendlyError(error).kind }
    }
  }

  async respondGeneral(
    input: FlexModelChatRequest,
    _onChunk?: (text: string) => void,
    options: FallbackInferenceOptions = {}
  ): Promise<FlexModelGeneralFallbackResult> {
    if (!(await this.assistantEnabled())) return { kind: 'disabled' }
    try {
      const request = flexModelChatRequestSchema.parse(input)
      const result = await this.generate(
        chatOutputSchema,
        'calendar_answer',
        CHAT_SYSTEM_PROMPT,
        chatPrompt(request),
        options
      )
      // Never stream unvalidated facts. The assistant service resolves the protected placeholders.
      return flexModelChatResponseSchema.parse(result)
    } catch (error) {
      return { kind: this.friendlyError(error).kind }
    }
  }

  async groupDocument(value: unknown): Promise<DocumentFallbackResponse | null> {
    const input = onlineAiDocumentRequestSchema.parse(value)
    const result = await this.generate(
      documentOutputSchema,
      'document_groups',
      DOCUMENT_SYSTEM_PROMPT,
      documentFallbackPrompt(input.request) +
        '\nUse the page image to check row alignment. Never repair or invent OCR values. Return groups: [] when no complete group is certain.',
      { cancellationId: `online-document:${input.request.selectionId}` },
      input.pageImageDataUrl
    )
    if (result.groups.length === 0) return null
    const grounded = validateDocumentFallbackResponse(input.request, result)
    if (!grounded)
      throw new OnlineAiError(
        'OpenAI could not connect these fields reliably. Your existing proposals are preserved.',
        'invalid-output'
      )
    return { ...grounded, modelId: 'openai' }
  }

  private async generate<T extends z.ZodType>(
    schema: T,
    name: string,
    policy: string,
    text: string,
    options: FallbackInferenceOptions,
    image?: string
  ): Promise<z.infer<T>> {
    const revision = this.connectionRevision
    const controller = new AbortController()
    const cancellationId = options.cancellationId ?? randomUUID()
    if (this.requests.has(cancellationId))
      throw new OnlineAiError('This AI request is already running.')
    this.requests.set(cancellationId, controller)
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(this.options.requestTimeoutMs ?? 60_000)
    ])
    try {
      const connection = await this.readConnection()
      if (!connection)
        throw new OnlineAiError('Connect OpenAI in Settings to use online assistance.')
      const apiKey = await this.options.credentialVault.decrypt(connection.encryptedApiKey)
      signal.throwIfAborted()
      if (revision !== this.connectionRevision)
        throw new OnlineAiError('The AI connection changed. Please try again.', 'cancelled')
      options.onStatus?.({
        workload: name === 'calendar_answer' ? 'chat' : 'plan',
        phase: 'generating',
        queuePosition: 0,
        queuedJobs: 0,
        canCancel: true
      })
      const content: Record<string, unknown>[] = [
        { type: 'input_text', text: text.replace(/^\/no_think\s*/u, '') }
      ]
      if (image) content.push({ type: 'input_image', image_url: image, detail: 'high' })
      const response = await this.fetchJson(
        'https://api.openai.com/v1/responses',
        apiKey,
        {
          method: 'POST',
          body: JSON.stringify({
            model: connection.model,
            store: false,
            max_output_tokens: 8192,
            instructions:
              policy.replace(/private local/gu, 'connected') +
              ' Ask only for information that is missing and changes the result. Use existing verified context and never ask again for a detail already supplied. No tools or calendar writes are available. Return an empty actions or groups array instead of a guessed or partial batch.',
            input: [{ role: 'user', content }],
            text: {
              format: {
                type: 'json_schema',
                name,
                strict: true,
                schema: onlineAiJsonSchema(schema)
              }
            }
          })
        },
        signal
      )
      signal.throwIfAborted()
      if (revision !== this.connectionRevision)
        throw new OnlineAiError('The AI request was cancelled.', 'cancelled')
      const envelope = z
        .object({
          status: z.literal('completed'),
          output: z.array(
            z.object({
              type: z.string(),
              content: z
                .array(z.object({ type: z.string(), text: z.string().optional() }))
                .optional()
            })
          )
        })
        .safeParse(response)
      if (!envelope.success)
        throw new OnlineAiError(
          'OpenAI returned an incomplete response. Try a smaller request; nothing was changed.',
          'invalid-output'
        )
      const parts = envelope.data.output
        .filter((item) => item.type === 'message')
        .flatMap((item) => item.content ?? [])
      if (parts.some((part) => part.type === 'refusal'))
        throw new OnlineAiError(
          'OpenAI could not process this request. You can still enter the details manually.',
          'invalid-output'
        )
      const output = parts
        .filter((part) => part.type === 'output_text')
        .map((part) => part.text ?? '')
        .join('')
      const result = schema.parse(JSON.parse(output))
      this.lastError = null
      return result
    } catch (error) {
      throw this.friendlyError(error)
    } finally {
      this.requests.delete(cancellationId)
    }
  }

  private async fetchJson(
    url: string,
    apiKey: string,
    init: RequestInit,
    signal: AbortSignal
  ): Promise<unknown> {
    const response = await this.fetchImplementation(url, {
      ...init,
      signal,
      redirect: 'error',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
    })
    if (!response.ok) {
      // Provider error bodies can echo input/credentials; expose only our bounded messages.
      await response.body?.cancel()
      const message =
        response.status === 401
          ? 'OpenAI rejected this API key. Check the key in Settings.'
          : response.status === 429
            ? 'OpenAI usage or rate limit reached. Check API billing or try again later.'
            : response.status === 403 || response.status === 404
              ? 'This OpenAI key cannot access the selected model. Choose a model available to your API project.'
              : response.status === 400
                ? 'This model could not accept the request. Choose a model with image inputs and Structured Outputs.'
                : 'OpenAI is unavailable. Try again later; your draft is preserved.'
      throw new OnlineAiError(message)
    }
    if (!response.body)
      throw new OnlineAiError('OpenAI returned an empty response.', 'invalid-output')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let size = 0
    let body = ''
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > 512_000) {
          await reader.cancel()
          throw new OnlineAiError(
            'OpenAI returned too much data. Try a smaller request.',
            'invalid-output'
          )
        }
        body += decoder.decode(chunk.value, { stream: true })
      }
    } finally {
      reader.releaseLock()
    }
    return JSON.parse(body + decoder.decode())
  }

  private friendlyError(error: unknown): OnlineAiError {
    const result =
      error instanceof OnlineAiError
        ? error
        : error instanceof Error && error.name === 'TimeoutError'
          ? new OnlineAiError(
              'OpenAI took too long. Your draft is preserved; try again.',
              'timeout'
            )
          : error instanceof Error && error.name === 'AbortError'
            ? new OnlineAiError('The AI request was cancelled.', 'cancelled')
            : error instanceof z.ZodError || error instanceof SyntaxError
              ? new OnlineAiError(
                  'OpenAI returned an invalid result. Your draft is preserved.',
                  'invalid-output'
                )
              : new OnlineAiError(
                  'Could not reach OpenAI or unlock its key. Check your connection and reconnect in Settings.'
                )
    if (result.kind !== 'cancelled') this.lastError = result.message
    return result
  }

  private async readConnection(): Promise<StoredConnection | null> {
    if (this.options.disabled) return null
    try {
      return storedConnectionSchema.parse(
        JSON.parse(await readFile(this.options.connectionPath, 'utf8'))
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        this.lastError = 'The saved AI connection could not be read. Reconnect in Settings.'
      return null
    }
  }
}

export function connectedAssistantFallbacks(
  online: OnlineAiService,
  local: AssistantFallbackServices
): AssistantFallbackServices {
  const getFailureMessage = async (): Promise<string | null> => {
    const status = await online.getStatus()
    return status.useForAssistant ? status.lastError : null
  }
  const getStatus = async (provider: AssistantFallbackServices['calendarPlanner']) => {
    const status = await online.getStatus()
    if (status.configured && status.useForAssistant)
      return { state: 'ready' as const, enabled: true, error: status.lastError, lastRequest: null }
    return (
      (await provider?.getStatus?.()) ?? {
        state: 'not-installed' as const,
        enabled: false,
        error: null,
        lastRequest: null
      }
    )
  }
  return {
    calendarPlanner: {
      getFailureMessage,
      getStatus: () => getStatus(local.calendarPlanner),
      planCalendar: async (text, context, options) =>
        (await online.assistantEnabled())
          ? online.planCalendar(text, context, options)
          : (local.calendarPlanner?.planCalendar(text, context, options) ?? { kind: 'missing' })
    },
    generalResponder: {
      getFailureMessage,
      getStatus: async () => {
        if (await online.assistantEnabled()) return getStatus(null)
        return (
          (await local.generalResponder?.getStatus?.()) ?? {
            state: 'not-installed' as const,
            enabled: false,
            error: null,
            lastRequest: null
          }
        )
      },
      respondGeneral: async (input, onChunk, options) =>
        (await online.assistantEnabled())
          ? online.respondGeneral(input, onChunk, options)
          : (local.generalResponder?.respondGeneral(input, onChunk, options) ?? { kind: 'missing' })
    }
  }
}
