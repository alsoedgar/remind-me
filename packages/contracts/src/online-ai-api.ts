import { z } from 'zod'
import { documentFallbackRequestSchema, maximumDocumentReviewImageCharacters } from './document-api'

export const defaultOnlineAiModel = 'gpt-6-astra'
const modelSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9._:-]+$/u)

export const onlineAiConnectRequestSchema = z
  .object({
    apiKey: z
      .string()
      .trim()
      .min(20)
      .max(512)
      .regex(/^[\x21-\x7e]+$/u),
    model: modelSchema,
    useForAssistant: z.boolean()
  })
  .strict()

export const onlineAiStatusSchema = z
  .object({
    configured: z.boolean(),
    provider: z.literal('OpenAI'),
    model: modelSchema,
    useForAssistant: z.boolean(),
    credentialStorageAvailable: z.boolean(),
    lastError: z.string().max(500).nullable()
  })
  .strict()

export const onlineAiConfigureRequestSchema = z.object({ useForAssistant: z.boolean() }).strict()

export const onlineAiDocumentRequestSchema = z
  .object({
    request: documentFallbackRequestSchema,
    pageImageDataUrl: z
      .string()
      .max(maximumDocumentReviewImageCharacters)
      .regex(/^data:image\/(?:jpeg|png);base64,[a-zA-Z0-9+/]+=*$/u),
    consentToUpload: z.literal(true)
  })
  .strict()

export type OnlineAiStatus = z.infer<typeof onlineAiStatusSchema>
export type OnlineAiDocumentRequest = z.infer<typeof onlineAiDocumentRequestSchema>
