import type {
  DocumentFallbackRequest,
  FlexModelChatRequest,
  FlexModelPlanContext
} from '@remind-me/contracts'

export const PLAN_SYSTEM_PROMPT: string
export const CHAT_SYSTEM_PROMPT: string
export const DOCUMENT_SYSTEM_PROMPT: string
export function planPrompt(request: { text: string; context: FlexModelPlanContext }): string
export function chatPrompt(input: FlexModelChatRequest): string
export function documentFallbackPrompt(request: DocumentFallbackRequest): string
