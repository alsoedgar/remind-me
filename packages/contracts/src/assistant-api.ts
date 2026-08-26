import { z } from 'zod'
import {
  calendarBatchItemSchema,
  calendarSnapshotRequestSchema,
  calendarSnapshotSchema,
  eventFormSchema,
  mutationReceiptSchema,
  reminderFormSchema
} from './calendar-api'
import { calendarIRResolvedSchema, calendarOperationSchema, riskLevelSchema } from './calendar-ir'
import { identifierSchema, isoInstantSchema } from './common'
import { assistantDialogueStateSchema } from './dialogue-state'
import { conversationTurnEntitySchema } from './entities'

const assistantProposalItemSchema = calendarBatchItemSchema

export const assistantProposalPayloadSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('event-save'), form: eventFormSchema }).strict(),
  z.object({ kind: z.literal('event-delete'), id: identifierSchema }).strict(),
  z.object({ kind: z.literal('reminder-save'), form: reminderFormSchema }).strict(),
  z.object({ kind: z.literal('reminder-complete'), id: identifierSchema }).strict(),
  z.object({ kind: z.literal('reminder-delete'), id: identifierSchema }).strict(),
  z
    .object({
      kind: z.literal('bulk-delete'),
      scope: z.enum(['events', 'reminders', 'both']),
      eventIds: z.array(identifierSchema).max(50_000),
      reminderIds: z.array(identifierSchema).max(50_000)
    })
    .strict()
    .superRefine((payload, context) => {
      if (payload.eventIds.length === 0 && payload.reminderIds.length === 0) {
        context.addIssue({
          code: 'custom',
          message: 'A bulk delete must capture at least one calendar item'
        })
      }
      if (new Set(payload.eventIds).size !== payload.eventIds.length) {
        context.addIssue({ code: 'custom', message: 'Bulk event IDs must be unique' })
      }
      if (new Set(payload.reminderIds).size !== payload.reminderIds.length) {
        context.addIssue({ code: 'custom', message: 'Bulk reminder IDs must be unique' })
      }
      if (payload.scope === 'events' && payload.reminderIds.length > 0) {
        context.addIssue({
          code: 'custom',
          message: 'An events-only clear cannot delete reminders'
        })
      }
      if (payload.scope === 'reminders' && payload.eventIds.length > 0) {
        context.addIssue({ code: 'custom', message: 'A reminders-only clear cannot delete events' })
      }
    }),
  z
    .object({
      kind: z.literal('batch'),
      items: z.array(assistantProposalItemSchema).min(2).max(50),
      itemSummaries: z.array(z.string().trim().min(1).max(1_000)).min(2).max(50)
    })
    .strict()
    .superRefine((payload, context) => {
      if (payload.items.length !== payload.itemSummaries.length) {
        context.addIssue({
          code: 'custom',
          message: 'Every batch item requires one review summary',
          path: ['itemSummaries']
        })
      }
    })
])

export const assistantProposalStatusSchema = z.enum(['pending', 'applied', 'rejected', 'failed'])

export const assistantProposalSchema = z
  .object({
    id: identifierSchema,
    conversationId: identifierSchema,
    requestId: identifierSchema,
    operation: calendarOperationSchema,
    risk: riskLevelSchema,
    status: assistantProposalStatusSchema,
    payload: assistantProposalPayloadSchema,
    resolvedCommand: calendarIRResolvedSchema,
    summary: z.string().min(1).max(2_000),
    requiresConfirmation: z.boolean(),
    sourceText: z.string().min(1).max(50_000),
    createdAt: isoInstantSchema,
    updatedAt: isoInstantSchema
  })
  .strict()

export const assistantConversationSchema = z
  .object({
    id: identifierSchema,
    title: z.string().min(1).max(500),
    turns: z.array(conversationTurnEntitySchema).max(500),
    activeProposal: assistantProposalSchema.nullable(),
    dialogueState: assistantDialogueStateSchema,
    createdAt: isoInstantSchema,
    updatedAt: isoInstantSchema
  })
  .strict()

export const assistantResponseSchema = z
  .object({
    kind: z.enum([
      'answer',
      'clarification',
      'preview',
      'receipt',
      'rejected',
      'unsupported',
      'error'
    ]),
    text: z.string().min(1).max(50_000),
    relatedEventIds: z.array(identifierSchema).max(100),
    relatedReminderIds: z.array(identifierSchema).max(100),
    receipt: mutationReceiptSchema.nullable(),
    feedbackEligible: z.boolean().optional()
  })
  .strict()

export const assistantExchangeSchema = z
  .object({
    conversation: assistantConversationSchema,
    response: assistantResponseSchema,
    snapshot: calendarSnapshotSchema
  })
  .strict()

export const assistantConversationRequestSchema = z
  .object({ conversationId: identifierSchema.nullable() })
  .strict()

export const assistantConversationResponseSchema = assistantConversationSchema

export const assistantClearRequestSchema = z.object({ conversationId: identifierSchema }).strict()

export const assistantFeedbackRequestSchema = z
  .object({
    conversationId: identifierSchema,
    requestId: identifierSchema,
    rating: z.enum(['helpful', 'unhelpful'])
  })
  .strict()

export const assistantFeedbackResponseSchema = z
  .object({
    accepted: z.boolean(),
    learnedPreferences: z.number().int().nonnegative().max(64),
    message: z.string().min(1).max(300)
  })
  .strict()

export const assistantSendRequestSchema = z
  .object({
    conversationId: identifierSchema.nullable(),
    text: z.string().trim().min(1).max(50_000),
    range: calendarSnapshotRequestSchema
  })
  .strict()

export const assistantConfirmRequestSchema = z
  .object({ proposalId: identifierSchema, range: calendarSnapshotRequestSchema })
  .strict()

export const assistantRejectRequestSchema = z
  .object({
    proposalId: identifierSchema,
    mode: z.enum(['cancel', 'edit']),
    range: calendarSnapshotRequestSchema
  })
  .strict()

export type AssistantProposalPayload = z.infer<typeof assistantProposalPayloadSchema>
export type AssistantProposal = z.infer<typeof assistantProposalSchema>
export type AssistantProposalStatus = z.infer<typeof assistantProposalStatusSchema>
export type AssistantConversation = z.infer<typeof assistantConversationSchema>
export type AssistantClearRequest = z.infer<typeof assistantClearRequestSchema>
export type AssistantFeedbackRequest = z.infer<typeof assistantFeedbackRequestSchema>
export type AssistantFeedbackResponse = z.infer<typeof assistantFeedbackResponseSchema>
export type AssistantResponse = z.infer<typeof assistantResponseSchema>
export type AssistantExchange = z.infer<typeof assistantExchangeSchema>
export type AssistantSendRequest = z.infer<typeof assistantSendRequestSchema>
export type AssistantConfirmRequest = z.infer<typeof assistantConfirmRequestSchema>
export type AssistantRejectRequest = z.infer<typeof assistantRejectRequestSchema>
