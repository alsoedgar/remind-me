import { contextBridge, ipcRenderer } from 'electron'
import {
  appInfoResponseSchema,
  assistantStreamEventSchema,
  flexModelProgressEventSchema,
  ipcChannels,
  ipcContracts,
  preferencesGetResponseSchema,
  voiceProgressEventSchema,
  type RemindMeBridge
} from '@remind-me/contracts'

const bridge: RemindMeBridge = {
  getOnlineAiStatus: async () => {
    const response: unknown = await ipcRenderer.invoke(ipcChannels.onlineAiGetStatus, {})
    return ipcContracts[ipcChannels.onlineAiGetStatus].response.parse(response)
  },
  connectOnlineAi: async (input) => {
    const request = ipcContracts[ipcChannels.onlineAiConnect].request.parse(input)
    const response: unknown = await ipcRenderer.invoke(ipcChannels.onlineAiConnect, request)
    return ipcContracts[ipcChannels.onlineAiConnect].response.parse(response)
  },
  disconnectOnlineAi: async () => {
    const response: unknown = await ipcRenderer.invoke(ipcChannels.onlineAiDisconnect, {})
    return ipcContracts[ipcChannels.onlineAiDisconnect].response.parse(response)
  },
  configureOnlineAi: async (input) => {
    const request = ipcContracts[ipcChannels.onlineAiConfigure].request.parse(input)
    const response: unknown = await ipcRenderer.invoke(ipcChannels.onlineAiConfigure, request)
    return ipcContracts[ipcChannels.onlineAiConfigure].response.parse(response)
  },
  groupDocumentWithOnlineAi: async (input) => {
    const request = ipcContracts[ipcChannels.onlineAiDocument].request.parse(input)
    const response: unknown = await ipcRenderer.invoke(ipcChannels.onlineAiDocument, request)
    return ipcContracts[ipcChannels.onlineAiDocument].response.parse(response)
  },
  getAppInfo: async () => {
    const response: unknown = await ipcRenderer.invoke(ipcChannels.appGetInfo, {})
    return appInfoResponseSchema.parse(response)
  },
  getWindowState: async () => {
    const request = ipcContracts[ipcChannels.windowGetState].request.parse({})
    const response: unknown = await ipcRenderer.invoke(ipcChannels.windowGetState, request)
    return ipcContracts[ipcChannels.windowGetState].response.parse(response)
  },
  setWindowMode: async (mode) => {
    const request = ipcContracts[ipcChannels.windowSetMode].request.parse({ mode })
    const response: unknown = await ipcRenderer.invoke(ipcChannels.windowSetMode, request)
    return ipcContracts[ipcChannels.windowSetMode].response.parse(response)
  },
  setWindowPinned: async (pinned) => {
    const request = ipcContracts[ipcChannels.windowSetPinned].request.parse({ pinned })
    const response: unknown = await ipcRenderer.invoke(ipcChannels.windowSetPinned, request)
    return ipcContracts[ipcChannels.windowSetPinned].response.parse(response)
  },
  getPreferences: async () => {
    const response: unknown = await ipcRenderer.invoke(ipcChannels.preferencesGet, {})
    return preferencesGetResponseSchema.parse(response)
  },
  getCalendarSnapshot: async (input) => {
    const request = ipcContracts[ipcChannels.calendarGetSnapshot].request.parse(input)
    const response: unknown = await ipcRenderer.invoke(ipcChannels.calendarGetSnapshot, request)
    return ipcContracts[ipcChannels.calendarGetSnapshot].response.parse(response)
  },
  checkAvailability: async (input) => {
    const request = ipcContracts[ipcChannels.calendarCheckAvailability].request.parse(input)
    const response: unknown = await ipcRenderer.invoke(
      ipcChannels.calendarCheckAvailability,
      request
    )
    return ipcContracts[ipcChannels.calendarCheckAvailability].response.parse(response)
  },
  applyCalendarBatch: async (items, summary, range) => {
    const request = ipcContracts[ipcChannels.calendarApplyBatch].request.parse({
      items,
      summary,
      range
    })
    const response: unknown = await ipcRenderer.invoke(ipcChannels.calendarApplyBatch, request)
    return ipcContracts[ipcChannels.calendarApplyBatch].response.parse(response)
  },
  saveEvent: async (form, range) => {
    const request = ipcContracts[ipcChannels.eventSave].request.parse({ form, range })
    const response: unknown = await ipcRenderer.invoke(ipcChannels.eventSave, request)
    return ipcContracts[ipcChannels.eventSave].response.parse(response)
  },
  deleteEvent: async (id, range) => {
    const request = ipcContracts[ipcChannels.eventDelete].request.parse({
      target: { id },
      range
    })
    const response: unknown = await ipcRenderer.invoke(ipcChannels.eventDelete, request)
    return ipcContracts[ipcChannels.eventDelete].response.parse(response)
  },
  saveReminder: async (form, range) => {
    const request = ipcContracts[ipcChannels.reminderSave].request.parse({ form, range })
    const response: unknown = await ipcRenderer.invoke(ipcChannels.reminderSave, request)
    return ipcContracts[ipcChannels.reminderSave].response.parse(response)
  },
  completeReminder: async (id, range) => {
    const request = ipcContracts[ipcChannels.reminderComplete].request.parse({
      target: { id },
      range
    })
    const response: unknown = await ipcRenderer.invoke(ipcChannels.reminderComplete, request)
    return ipcContracts[ipcChannels.reminderComplete].response.parse(response)
  },
  deleteReminder: async (id, range) => {
    const request = ipcContracts[ipcChannels.reminderDelete].request.parse({
      target: { id },
      range
    })
    const response: unknown = await ipcRenderer.invoke(ipcChannels.reminderDelete, request)
    return ipcContracts[ipcChannels.reminderDelete].response.parse(response)
  },
  undoLastAction: async (range) => {
    const request = ipcContracts[ipcChannels.historyUndo].request.parse(range)
    const response: unknown = await ipcRenderer.invoke(ipcChannels.historyUndo, request)
    return ipcContracts[ipcChannels.historyUndo].response.parse(response)
  },
  updatePreferences: async (input) => {
    const request = ipcContracts[ipcChannels.preferencesUpdate].request.parse(input)
    const response: unknown = await ipcRenderer.invoke(ipcChannels.preferencesUpdate, request)
    return ipcContracts[ipcChannels.preferencesUpdate].response.parse(response)
  },
  exportData: async (format) => {
    const request = ipcContracts[ipcChannels.dataExport].request.parse({ format })
    const response: unknown = await ipcRenderer.invoke(ipcChannels.dataExport, request)
    return ipcContracts[ipcChannels.dataExport].response.parse(response)
  },
  importData: async (range) => {
    const request = ipcContracts[ipcChannels.dataImport].request.parse(range)
    const response: unknown = await ipcRenderer.invoke(ipcChannels.dataImport, request)
    return ipcContracts[ipcChannels.dataImport].response.parse(response)
  },
  getCanvasStatus: async () => {
    const request = ipcContracts[ipcChannels.canvasGetStatus].request.parse({})
    const response: unknown = await ipcRenderer.invoke(ipcChannels.canvasGetStatus, request)
    return ipcContracts[ipcChannels.canvasGetStatus].response.parse(response)
  },
  connectCanvas: async (input) => {
    const request = ipcContracts[ipcChannels.canvasConnect].request.parse(input)
    const response: unknown = await ipcRenderer.invoke(ipcChannels.canvasConnect, request)
    return ipcContracts[ipcChannels.canvasConnect].response.parse(response)
  },
  disconnectCanvas: async () => {
    const request = ipcContracts[ipcChannels.canvasDisconnect].request.parse({})
    const response: unknown = await ipcRenderer.invoke(ipcChannels.canvasDisconnect, request)
    return ipcContracts[ipcChannels.canvasDisconnect].response.parse(response)
  },
  listCanvasAssignments: async () => {
    const request = ipcContracts[ipcChannels.canvasListAssignments].request.parse({})
    const response: unknown = await ipcRenderer.invoke(ipcChannels.canvasListAssignments, request)
    return ipcContracts[ipcChannels.canvasListAssignments].response.parse(response)
  },
  importCanvasAssignments: async (input) => {
    const request = ipcContracts[ipcChannels.canvasImportAssignments].request.parse(input)
    const response: unknown = await ipcRenderer.invoke(ipcChannels.canvasImportAssignments, request)
    return ipcContracts[ipcChannels.canvasImportAssignments].response.parse(response)
  },
  deleteAllData: async (confirmation, range) => {
    const request = ipcContracts[ipcChannels.dataDeleteAll].request.parse({
      confirmation,
      range
    })
    const response: unknown = await ipcRenderer.invoke(ipcChannels.dataDeleteAll, request)
    return ipcContracts[ipcChannels.dataDeleteAll].response.parse(response)
  },
  selectDocumentForPlanning: async () => {
    const request = ipcContracts[ipcChannels.documentSelect].request.parse({})
    const response: unknown = await ipcRenderer.invoke(ipcChannels.documentSelect, request)
    return ipcContracts[ipcChannels.documentSelect].response.parse(response)
  },
  commitDocumentImport: async (selectionId, items, range) => {
    const request = ipcContracts[ipcChannels.documentCommit].request.parse({
      selectionId,
      items,
      range
    })
    const response: unknown = await ipcRenderer.invoke(ipcChannels.documentCommit, request)
    return ipcContracts[ipcChannels.documentCommit].response.parse(response)
  },
  discardDocumentSelection: async (selectionId) => {
    const request = ipcContracts[ipcChannels.documentDiscard].request.parse({ selectionId })
    const response: unknown = await ipcRenderer.invoke(ipcChannels.documentDiscard, request)
    return ipcContracts[ipcChannels.documentDiscard].response.parse(response)
  },
  repairDocumentDisagreement: async (input) => {
    const request = ipcContracts[ipcChannels.documentRepair].request.parse(input)
    const response: unknown = await ipcRenderer.invoke(ipcChannels.documentRepair, request)
    return ipcContracts[ipcChannels.documentRepair].response.parse(response)
  },
  groupDocumentCoverageGap: async (input) => {
    const request = ipcContracts[ipcChannels.documentFallback].request.parse(input)
    const response: unknown = await ipcRenderer.invoke(ipcChannels.documentFallback, request)
    return ipcContracts[ipcChannels.documentFallback].response.parse(response)
  },
  getAssistantConversation: async (conversationId = null) => {
    const request = ipcContracts[ipcChannels.assistantGetConversation].request.parse({
      conversationId
    })
    const response: unknown = await ipcRenderer.invoke(
      ipcChannels.assistantGetConversation,
      request
    )
    return ipcContracts[ipcChannels.assistantGetConversation].response.parse(response)
  },
  sendAssistantMessage: async (input) => {
    const request = ipcContracts[ipcChannels.assistantSend].request.parse(input)
    const response: unknown = await ipcRenderer.invoke(ipcChannels.assistantSend, request)
    return ipcContracts[ipcChannels.assistantSend].response.parse(response)
  },
  cancelAssistantMessage: async (streamId) => {
    const request = ipcContracts[ipcChannels.assistantCancel].request.parse({ streamId })
    const response: unknown = await ipcRenderer.invoke(ipcChannels.assistantCancel, request)
    return ipcContracts[ipcChannels.assistantCancel].response.parse(response)
  },
  onAssistantStream: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, value: unknown): void => {
      const chunk = assistantStreamEventSchema.safeParse(value)
      if (chunk.success) listener(chunk.data)
    }
    ipcRenderer.on(ipcChannels.assistantStream, wrapped)
    return () => ipcRenderer.removeListener(ipcChannels.assistantStream, wrapped)
  },
  confirmAssistantProposal: async (input) => {
    const request = ipcContracts[ipcChannels.assistantConfirm].request.parse(input)
    const response: unknown = await ipcRenderer.invoke(ipcChannels.assistantConfirm, request)
    return ipcContracts[ipcChannels.assistantConfirm].response.parse(response)
  },
  rejectAssistantProposal: async (input) => {
    const request = ipcContracts[ipcChannels.assistantReject].request.parse(input)
    const response: unknown = await ipcRenderer.invoke(ipcChannels.assistantReject, request)
    return ipcContracts[ipcChannels.assistantReject].response.parse(response)
  },
  clearAssistantConversation: async (conversationId) => {
    const request = ipcContracts[ipcChannels.assistantClear].request.parse({ conversationId })
    const response: unknown = await ipcRenderer.invoke(ipcChannels.assistantClear, request)
    return ipcContracts[ipcChannels.assistantClear].response.parse(response)
  },
  rateAssistantReply: async (input) => {
    const request = ipcContracts[ipcChannels.assistantFeedback].request.parse(input)
    const response: unknown = await ipcRenderer.invoke(ipcChannels.assistantFeedback, request)
    return ipcContracts[ipcChannels.assistantFeedback].response.parse(response)
  },
  getFlexModelStatus: async () => {
    const request = ipcContracts[ipcChannels.flexModelGetStatus].request.parse({})
    const response: unknown = await ipcRenderer.invoke(ipcChannels.flexModelGetStatus, request)
    return ipcContracts[ipcChannels.flexModelGetStatus].response.parse(response)
  },
  installFlexModel: async () => {
    const request = ipcContracts[ipcChannels.flexModelInstall].request.parse({})
    const response: unknown = await ipcRenderer.invoke(ipcChannels.flexModelInstall, request)
    return ipcContracts[ipcChannels.flexModelInstall].response.parse(response)
  },
  cancelFlexModelInstall: async () => {
    const request = ipcContracts[ipcChannels.flexModelCancel].request.parse({})
    const response: unknown = await ipcRenderer.invoke(ipcChannels.flexModelCancel, request)
    return ipcContracts[ipcChannels.flexModelCancel].response.parse(response)
  },
  removeFlexModel: async () => {
    const request = ipcContracts[ipcChannels.flexModelRemove].request.parse({})
    const response: unknown = await ipcRenderer.invoke(ipcChannels.flexModelRemove, request)
    return ipcContracts[ipcChannels.flexModelRemove].response.parse(response)
  },
  setFlexModelEnabled: async (enabled) => {
    const request = ipcContracts[ipcChannels.flexModelSetEnabled].request.parse({ enabled })
    const response: unknown = await ipcRenderer.invoke(ipcChannels.flexModelSetEnabled, request)
    return ipcContracts[ipcChannels.flexModelSetEnabled].response.parse(response)
  },
  configureFlexModel: async (input) => {
    const request = ipcContracts[ipcChannels.flexModelConfigure].request.parse(input)
    const response: unknown = await ipcRenderer.invoke(ipcChannels.flexModelConfigure, request)
    return ipcContracts[ipcChannels.flexModelConfigure].response.parse(response)
  },
  onFlexModelProgress: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, value: unknown): void => {
      const progress = flexModelProgressEventSchema.safeParse(value)
      if (progress.success) listener(progress.data)
    }
    ipcRenderer.on(ipcChannels.flexModelProgress, wrapped)
    return () => ipcRenderer.removeListener(ipcChannels.flexModelProgress, wrapped)
  },
  getVoiceInfo: async () => {
    const request = ipcContracts[ipcChannels.voiceGetInfo].request.parse({})
    const response: unknown = await ipcRenderer.invoke(ipcChannels.voiceGetInfo, request)
    return ipcContracts[ipcChannels.voiceGetInfo].response.parse(response)
  },
  warmVoiceModel: async (jobId) => {
    const request = ipcContracts[ipcChannels.voiceWarm].request.parse({ jobId })
    const response: unknown = await ipcRenderer.invoke(ipcChannels.voiceWarm, request)
    return ipcContracts[ipcChannels.voiceWarm].response.parse(response)
  },
  transcribeVoice: async (input) => {
    const request = ipcContracts[ipcChannels.voiceTranscribe].request.parse(input)
    const response: unknown = await ipcRenderer.invoke(ipcChannels.voiceTranscribe, request)
    return ipcContracts[ipcChannels.voiceTranscribe].response.parse(response)
  },
  startVoiceStream: async (input) => {
    const request = ipcContracts[ipcChannels.voiceStreamStart].request.parse(input)
    const response: unknown = await ipcRenderer.invoke(ipcChannels.voiceStreamStart, request)
    return ipcContracts[ipcChannels.voiceStreamStart].response.parse(response)
  },
  appendVoiceStream: async (input) => {
    const request = ipcContracts[ipcChannels.voiceStreamAppend].request.parse(input)
    const response: unknown = await ipcRenderer.invoke(ipcChannels.voiceStreamAppend, request)
    return ipcContracts[ipcChannels.voiceStreamAppend].response.parse(response)
  },
  finishVoiceStream: async (jobId) => {
    const request = ipcContracts[ipcChannels.voiceStreamFinish].request.parse({ jobId })
    const response: unknown = await ipcRenderer.invoke(ipcChannels.voiceStreamFinish, request)
    return ipcContracts[ipcChannels.voiceStreamFinish].response.parse(response)
  },
  cancelVoiceTranscription: async (jobId) => {
    const request = ipcContracts[ipcChannels.voiceCancel].request.parse({ jobId })
    const response: unknown = await ipcRenderer.invoke(ipcChannels.voiceCancel, request)
    return ipcContracts[ipcChannels.voiceCancel].response.parse(response)
  },
  onVoiceProgress: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, value: unknown): void => {
      const progress = voiceProgressEventSchema.safeParse(value)
      if (progress.success) listener(progress.data)
    }
    ipcRenderer.on(ipcChannels.voiceProgress, wrapped)
    return () => ipcRenderer.removeListener(ipcChannels.voiceProgress, wrapped)
  }
}

Object.freeze(bridge)

contextBridge.exposeInMainWorld('remindMe', bridge)
