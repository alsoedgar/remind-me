import { z } from 'zod'
import {
  assistantConfirmRequestSchema,
  assistantConversationRequestSchema,
  assistantConversationResponseSchema,
  assistantClearRequestSchema,
  assistantExchangeSchema,
  assistantFeedbackRequestSchema,
  assistantFeedbackResponseSchema,
  assistantRejectRequestSchema,
  assistantSendRequestSchema
} from './assistant-api'
import { calendarIRDraftSchema, calendarIRResolvedSchema } from './calendar-ir'
import type { calendarBatchItemSchema } from './calendar-api'
import {
  availabilityRequestSchema,
  availabilityResultSchema,
  calendarBatchApplyRequestSchema,
  calendarMutationResultSchema,
  calendarSnapshotRequestSchema,
  calendarSnapshotSchema,
  dataExportRequestSchema,
  dataExportResultSchema,
  dataDeleteAllRequestSchema,
  dataDeleteAllResultSchema,
  dataImportRequestSchema,
  dataImportResultSchema,
  entityIdRequestSchema,
  eventFormSchema,
  reminderFormSchema
} from './calendar-api'
import { preferencesEntitySchema } from './entities'
import {
  flexModelCancelRequestSchema,
  flexModelInstallRequestSchema,
  flexModelRemoveRequestSchema,
  flexModelSetEnabledRequestSchema,
  flexModelStatusSchema,
  type FlexModelProgressEvent
} from './flex-model-api'
import {
  documentCommitRequestSchema,
  documentCommitResponseSchema,
  documentDiscardRequestSchema,
  documentDiscardResponseSchema,
  documentSelectRequestSchema,
  documentSelectResponseSchema,
  type ReviewedDocumentItem
} from './document-api'
import {
  voiceCancelRequestSchema,
  voiceCancelResponseSchema,
  voiceRuntimeInfoSchema,
  voiceStreamChunkRequestSchema,
  voiceStreamChunkResponseSchema,
  voiceStreamFinishRequestSchema,
  voiceStreamStartRequestSchema,
  voiceStreamStartResponseSchema,
  voiceTranscriptionRequestSchema,
  voiceTranscriptionResultSchema,
  voiceWarmRequestSchema,
  type VoiceProgressEvent
} from './voice-api'
import {
  appWindowGetStateRequestSchema,
  appWindowSetModeRequestSchema,
  appWindowSetPinnedRequestSchema,
  appWindowStateSchema,
  type AppWindowMode
} from './window-api'

export const ipcChannels = {
  appGetInfo: 'app:get-info',
  windowGetState: 'window:get-state',
  windowSetMode: 'window:set-mode',
  windowSetPinned: 'window:set-pinned',
  preferencesGet: 'preferences:get',
  preferencesUpdate: 'preferences:update',
  calendarGetSnapshot: 'calendar:get-snapshot',
  calendarCheckAvailability: 'calendar:check-availability',
  calendarApplyBatch: 'calendar:apply-batch',
  eventSave: 'event:save',
  eventDelete: 'event:delete',
  reminderSave: 'reminder:save',
  reminderComplete: 'reminder:complete',
  reminderDelete: 'reminder:delete',
  historyUndo: 'history:undo',
  dataExport: 'data:export',
  dataImport: 'data:import',
  dataDeleteAll: 'data:delete-all',
  documentSelect: 'document:select',
  documentCommit: 'document:commit',
  documentDiscard: 'document:discard',
  assistantGetConversation: 'assistant:get-conversation',
  assistantSend: 'assistant:send',
  assistantConfirm: 'assistant:confirm',
  assistantReject: 'assistant:reject',
  assistantClear: 'assistant:clear',
  assistantFeedback: 'assistant:feedback',
  flexModelGetStatus: 'flex-model:get-status',
  flexModelInstall: 'flex-model:install',
  flexModelCancel: 'flex-model:cancel',
  flexModelRemove: 'flex-model:remove',
  flexModelSetEnabled: 'flex-model:set-enabled',
  flexModelProgress: 'flex-model:progress',
  voiceGetInfo: 'voice:get-info',
  voiceWarm: 'voice:warm',
  voiceTranscribe: 'voice:transcribe',
  voiceStreamStart: 'voice:stream-start',
  voiceStreamAppend: 'voice:stream-append',
  voiceStreamFinish: 'voice:stream-finish',
  voiceCancel: 'voice:cancel',
  voiceProgress: 'voice:progress',
  assistantInterpret: 'assistant:interpret',
  calendarDryRun: 'calendar:dry-run'
} as const

export const appInfoRequestSchema = z.object({}).strict()
export const localReleaseStatusSchema = z
  .object({
    status: z.enum(['verified', 'degraded']),
    manifestSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    verifiedAt: z.string().datetime({ offset: true }),
    verificationDurationMs: z.number().nonnegative(),
    requiredArtifactCount: z.number().int().nonnegative(),
    verifiedArtifactCount: z.number().int().nonnegative(),
    installedModelBytes: z.number().int().nonnegative(),
    customModelBytes: z.number().int().nonnegative(),
    customWorkingSetBytes: z.number().int().nonnegative(),
    customModelBudgetBytes: z.number().int().positive(),
    goldenProbes: z
      .object({
        planner: z.boolean(),
        speaker: z.boolean(),
        document: z.boolean()
      })
      .strict(),
    providers: z
      .object({
        planner: z.literal('typescript-int8-cpu'),
        speaker: z.literal('typescript-int8-cpu'),
        document: z.literal('typescript-int8-cpu'),
        speech: z.literal('sherpa-onnx-wasm-cpu'),
        cpuFallback: z.literal(true),
        cacheHit: z.boolean(),
        benchmarkDurationMs: z.number().nonnegative()
      })
      .strict(),
    error: z.string().nullable()
  })
  .strict()

export const databaseRuntimeStatusSchema = z
  .object({
    status: z.enum(['healthy', 'recovered', 'memory']),
    schemaVersion: z.number().int().positive(),
    quickCheck: z.literal('ok'),
    recoveryCopyCreated: z.boolean(),
    error: z.string().nullable()
  })
  .strict()

export const appInfoResponseSchema = z
  .object({
    name: z.string().min(1),
    version: z.string().min(1),
    platform: z.enum([
      'aix',
      'android',
      'darwin',
      'freebsd',
      'haiku',
      'linux',
      'openbsd',
      'sunos',
      'win32',
      'cygwin',
      'netbsd'
    ]),
    arch: z.string().min(1),
    offlineReady: z.boolean(),
    appearance: z
      .object({
        nativeBackdrop: z.boolean(),
        transparentWindow: z.boolean(),
        windowControlsOverlay: z.boolean(),
        label: z.string().min(1)
      })
      .strict(),
    release: localReleaseStatusSchema,
    database: databaseRuntimeStatusSchema,
    planner: z
      .object({
        available: z.boolean(),
        id: z.string().min(1),
        version: z.string().min(1),
        architecture: z.string().min(1),
        parameterCount: z.number().int().nonnegative(),
        quantization: z.string().min(1),
        modelBytes: z.number().int().nonnegative(),
        mode: z.literal('confidence-gated-hybrid'),
        teacherUsed: z.boolean(),
        assistantPlanAvailable: z.boolean(),
        nativeCapabilityCount: z.number().int().nonnegative(),
        networkRequired: z.literal(false),
        error: z.string().nullable()
      })
      .strict(),
    speaker: z
      .object({
        available: z.boolean(),
        id: z.string().min(1),
        version: z.string().min(1),
        architecture: z.string().min(1),
        parameterCount: z.number().int().nonnegative(),
        quantization: z.string().min(1),
        modelBytes: z.number().int().nonnegative(),
        workingSetBytes: z.number().int().nonnegative(),
        mode: z.literal('protected-overgenerate-rerank'),
        candidateCount: z.number().int().nonnegative(),
        teacherUsed: z.boolean(),
        networkRequired: z.literal(false),
        error: z.string().nullable()
      })
      .strict(),
    planScan: z
      .object({
        available: z.boolean(),
        id: z.string().min(1),
        version: z.string().min(1),
        architecture: z.string().min(1),
        parameterCount: z.number().int().nonnegative(),
        quantization: z.string().min(1),
        modelBytes: z.number().int().nonnegative(),
        workingSetBytes: z.number().int().nonnegative(),
        mode: z.literal('evidence-gated-spatial-graph'),
        teacherUsed: z.literal(false),
        networkRequired: z.literal(false),
        error: z.string().nullable()
      })
      .strict()
  })
  .strict()

export const preferencesGetRequestSchema = z.object({}).strict()
export const preferencesGetResponseSchema = preferencesEntitySchema
export const preferencesUpdateRequestSchema = preferencesEntitySchema
  .omit({ id: true, updatedAt: true })
  .partial()
export const preferencesUpdateResponseSchema = preferencesEntitySchema

export const historyUndoRequestSchema = calendarSnapshotRequestSchema

export const assistantInterpretRequestSchema = z
  .object({
    requestId: z.string().min(1).max(128),
    text: z.string().min(1).max(50_000),
    locale: z.string().min(2).max(35),
    timezone: z.string().min(1).max(64),
    nowUtc: z.string().datetime({ offset: true })
  })
  .strict()
export const assistantInterpretResponseSchema = calendarIRDraftSchema

export const calendarDryRunRequestSchema = calendarIRResolvedSchema
export const calendarDryRunResponseSchema = z
  .object({
    accepted: z.boolean(),
    mutationCount: z.number().int().nonnegative(),
    summary: z.string().min(1).max(2_000),
    requiresConfirmation: z.boolean()
  })
  .strict()

export const ipcContracts = {
  [ipcChannels.appGetInfo]: {
    request: appInfoRequestSchema,
    response: appInfoResponseSchema
  },
  [ipcChannels.windowGetState]: {
    request: appWindowGetStateRequestSchema,
    response: appWindowStateSchema
  },
  [ipcChannels.windowSetMode]: {
    request: appWindowSetModeRequestSchema,
    response: appWindowStateSchema
  },
  [ipcChannels.windowSetPinned]: {
    request: appWindowSetPinnedRequestSchema,
    response: appWindowStateSchema
  },
  [ipcChannels.preferencesGet]: {
    request: preferencesGetRequestSchema,
    response: preferencesGetResponseSchema
  },
  [ipcChannels.preferencesUpdate]: {
    request: preferencesUpdateRequestSchema,
    response: preferencesUpdateResponseSchema
  },
  [ipcChannels.calendarGetSnapshot]: {
    request: calendarSnapshotRequestSchema,
    response: calendarSnapshotSchema
  },
  [ipcChannels.calendarCheckAvailability]: {
    request: availabilityRequestSchema,
    response: availabilityResultSchema
  },
  [ipcChannels.calendarApplyBatch]: {
    request: calendarBatchApplyRequestSchema,
    response: calendarMutationResultSchema
  },
  [ipcChannels.eventSave]: {
    request: z.object({ form: eventFormSchema, range: calendarSnapshotRequestSchema }).strict(),
    response: calendarMutationResultSchema
  },
  [ipcChannels.eventDelete]: {
    request: z
      .object({ target: entityIdRequestSchema, range: calendarSnapshotRequestSchema })
      .strict(),
    response: calendarMutationResultSchema
  },
  [ipcChannels.reminderSave]: {
    request: z.object({ form: reminderFormSchema, range: calendarSnapshotRequestSchema }).strict(),
    response: calendarMutationResultSchema
  },
  [ipcChannels.reminderComplete]: {
    request: z
      .object({ target: entityIdRequestSchema, range: calendarSnapshotRequestSchema })
      .strict(),
    response: calendarMutationResultSchema
  },
  [ipcChannels.reminderDelete]: {
    request: z
      .object({ target: entityIdRequestSchema, range: calendarSnapshotRequestSchema })
      .strict(),
    response: calendarMutationResultSchema
  },
  [ipcChannels.historyUndo]: {
    request: historyUndoRequestSchema,
    response: calendarMutationResultSchema
  },
  [ipcChannels.dataExport]: {
    request: dataExportRequestSchema,
    response: dataExportResultSchema
  },
  [ipcChannels.dataImport]: {
    request: dataImportRequestSchema,
    response: dataImportResultSchema
  },
  [ipcChannels.dataDeleteAll]: {
    request: dataDeleteAllRequestSchema,
    response: dataDeleteAllResultSchema
  },
  [ipcChannels.documentSelect]: {
    request: documentSelectRequestSchema,
    response: documentSelectResponseSchema
  },
  [ipcChannels.documentCommit]: {
    request: documentCommitRequestSchema,
    response: documentCommitResponseSchema
  },
  [ipcChannels.documentDiscard]: {
    request: documentDiscardRequestSchema,
    response: documentDiscardResponseSchema
  },
  [ipcChannels.assistantGetConversation]: {
    request: assistantConversationRequestSchema,
    response: assistantConversationResponseSchema
  },
  [ipcChannels.assistantSend]: {
    request: assistantSendRequestSchema,
    response: assistantExchangeSchema
  },
  [ipcChannels.assistantConfirm]: {
    request: assistantConfirmRequestSchema,
    response: assistantExchangeSchema
  },
  [ipcChannels.assistantReject]: {
    request: assistantRejectRequestSchema,
    response: assistantExchangeSchema
  },
  [ipcChannels.assistantClear]: {
    request: assistantClearRequestSchema,
    response: assistantConversationResponseSchema
  },
  [ipcChannels.assistantFeedback]: {
    request: assistantFeedbackRequestSchema,
    response: assistantFeedbackResponseSchema
  },
  [ipcChannels.flexModelGetStatus]: {
    request: z.object({}).strict(),
    response: flexModelStatusSchema
  },
  [ipcChannels.flexModelInstall]: {
    request: flexModelInstallRequestSchema,
    response: flexModelStatusSchema
  },
  [ipcChannels.flexModelCancel]: {
    request: flexModelCancelRequestSchema,
    response: flexModelStatusSchema
  },
  [ipcChannels.flexModelRemove]: {
    request: flexModelRemoveRequestSchema,
    response: flexModelStatusSchema
  },
  [ipcChannels.flexModelSetEnabled]: {
    request: flexModelSetEnabledRequestSchema,
    response: flexModelStatusSchema
  },
  [ipcChannels.voiceGetInfo]: {
    request: z.object({}).strict(),
    response: voiceRuntimeInfoSchema
  },
  [ipcChannels.voiceWarm]: {
    request: voiceWarmRequestSchema,
    response: voiceRuntimeInfoSchema
  },
  [ipcChannels.voiceTranscribe]: {
    request: voiceTranscriptionRequestSchema,
    response: voiceTranscriptionResultSchema
  },
  [ipcChannels.voiceStreamStart]: {
    request: voiceStreamStartRequestSchema,
    response: voiceStreamStartResponseSchema
  },
  [ipcChannels.voiceStreamAppend]: {
    request: voiceStreamChunkRequestSchema,
    response: voiceStreamChunkResponseSchema
  },
  [ipcChannels.voiceStreamFinish]: {
    request: voiceStreamFinishRequestSchema,
    response: voiceTranscriptionResultSchema
  },
  [ipcChannels.voiceCancel]: {
    request: voiceCancelRequestSchema,
    response: voiceCancelResponseSchema
  },
  [ipcChannels.assistantInterpret]: {
    request: assistantInterpretRequestSchema,
    response: assistantInterpretResponseSchema
  },
  [ipcChannels.calendarDryRun]: {
    request: calendarDryRunRequestSchema,
    response: calendarDryRunResponseSchema
  }
} as const

export type AppInfo = z.infer<typeof appInfoResponseSchema>
export type PreferencesUpdate = z.infer<typeof preferencesUpdateRequestSchema>

export interface RemindMeBridge {
  getAppInfo: () => Promise<AppInfo>
  getWindowState: () => Promise<z.infer<typeof appWindowStateSchema>>
  setWindowMode: (mode: AppWindowMode) => Promise<z.infer<typeof appWindowStateSchema>>
  setWindowPinned: (pinned: boolean) => Promise<z.infer<typeof appWindowStateSchema>>
  getPreferences: () => Promise<z.infer<typeof preferencesEntitySchema>>
  getCalendarSnapshot: (
    request: z.infer<typeof calendarSnapshotRequestSchema>
  ) => Promise<z.infer<typeof calendarSnapshotSchema>>
  checkAvailability: (
    request: z.infer<typeof availabilityRequestSchema>
  ) => Promise<z.infer<typeof availabilityResultSchema>>
  applyCalendarBatch: (
    items: z.infer<typeof calendarBatchItemSchema>[],
    summary: string,
    range: z.infer<typeof calendarSnapshotRequestSchema>
  ) => Promise<z.infer<typeof calendarMutationResultSchema>>
  saveEvent: (
    form: z.infer<typeof eventFormSchema>,
    range: z.infer<typeof calendarSnapshotRequestSchema>
  ) => Promise<z.infer<typeof calendarMutationResultSchema>>
  deleteEvent: (
    id: string,
    range: z.infer<typeof calendarSnapshotRequestSchema>
  ) => Promise<z.infer<typeof calendarMutationResultSchema>>
  saveReminder: (
    form: z.infer<typeof reminderFormSchema>,
    range: z.infer<typeof calendarSnapshotRequestSchema>
  ) => Promise<z.infer<typeof calendarMutationResultSchema>>
  completeReminder: (
    id: string,
    range: z.infer<typeof calendarSnapshotRequestSchema>
  ) => Promise<z.infer<typeof calendarMutationResultSchema>>
  deleteReminder: (
    id: string,
    range: z.infer<typeof calendarSnapshotRequestSchema>
  ) => Promise<z.infer<typeof calendarMutationResultSchema>>
  undoLastAction: (
    range: z.infer<typeof calendarSnapshotRequestSchema>
  ) => Promise<z.infer<typeof calendarMutationResultSchema>>
  updatePreferences: (
    update: z.infer<typeof preferencesUpdateRequestSchema>
  ) => Promise<z.infer<typeof preferencesEntitySchema>>
  exportData: (
    format: z.infer<typeof dataExportRequestSchema>['format']
  ) => Promise<z.infer<typeof dataExportResultSchema>>
  importData: (
    range: z.infer<typeof calendarSnapshotRequestSchema>
  ) => Promise<z.infer<typeof dataImportResultSchema>>
  deleteAllData: (
    confirmation: 'DELETE',
    range: z.infer<typeof calendarSnapshotRequestSchema>
  ) => Promise<z.infer<typeof dataDeleteAllResultSchema>>
  selectDocumentForPlanning: () => Promise<z.infer<typeof documentSelectResponseSchema>>
  commitDocumentImport: (
    selectionId: string,
    items: ReviewedDocumentItem[],
    range: z.infer<typeof calendarSnapshotRequestSchema>
  ) => Promise<z.infer<typeof documentCommitResponseSchema>>
  discardDocumentSelection: (
    selectionId: string
  ) => Promise<z.infer<typeof documentDiscardResponseSchema>>
  getAssistantConversation: (
    conversationId?: string | null
  ) => Promise<z.infer<typeof assistantConversationResponseSchema>>
  sendAssistantMessage: (
    input: z.infer<typeof assistantSendRequestSchema>
  ) => Promise<z.infer<typeof assistantExchangeSchema>>
  confirmAssistantProposal: (
    input: z.infer<typeof assistantConfirmRequestSchema>
  ) => Promise<z.infer<typeof assistantExchangeSchema>>
  rejectAssistantProposal: (
    input: z.infer<typeof assistantRejectRequestSchema>
  ) => Promise<z.infer<typeof assistantExchangeSchema>>
  clearAssistantConversation: (
    conversationId: string
  ) => Promise<z.infer<typeof assistantConversationResponseSchema>>
  rateAssistantReply: (
    input: z.infer<typeof assistantFeedbackRequestSchema>
  ) => Promise<z.infer<typeof assistantFeedbackResponseSchema>>
  getFlexModelStatus: () => Promise<z.infer<typeof flexModelStatusSchema>>
  installFlexModel: () => Promise<z.infer<typeof flexModelStatusSchema>>
  cancelFlexModelInstall: () => Promise<z.infer<typeof flexModelStatusSchema>>
  removeFlexModel: () => Promise<z.infer<typeof flexModelStatusSchema>>
  setFlexModelEnabled: (enabled: boolean) => Promise<z.infer<typeof flexModelStatusSchema>>
  onFlexModelProgress: (listener: (event: FlexModelProgressEvent) => void) => () => void
  getVoiceInfo: () => Promise<z.infer<typeof voiceRuntimeInfoSchema>>
  warmVoiceModel: (jobId: string) => Promise<z.infer<typeof voiceRuntimeInfoSchema>>
  transcribeVoice: (
    input: z.infer<typeof voiceTranscriptionRequestSchema>
  ) => Promise<z.infer<typeof voiceTranscriptionResultSchema>>
  startVoiceStream: (
    input: z.infer<typeof voiceStreamStartRequestSchema>
  ) => Promise<z.infer<typeof voiceStreamStartResponseSchema>>
  appendVoiceStream: (
    input: z.infer<typeof voiceStreamChunkRequestSchema>
  ) => Promise<z.infer<typeof voiceStreamChunkResponseSchema>>
  finishVoiceStream: (jobId: string) => Promise<z.infer<typeof voiceTranscriptionResultSchema>>
  cancelVoiceTranscription: (jobId: string) => Promise<z.infer<typeof voiceCancelResponseSchema>>
  onVoiceProgress: (listener: (event: VoiceProgressEvent) => void) => () => void
}
