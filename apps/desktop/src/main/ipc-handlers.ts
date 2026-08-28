import {
  BrowserWindow,
  dialog,
  ipcMain,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
  type SaveDialogOptions
} from 'electron'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { basename, extname } from 'node:path'
import {
  appInfoRequestSchema,
  appInfoResponseSchema,
  assistantStreamEventSchema,
  calendarBackupSchema,
  ipcChannels,
  ipcContracts,
  preferencesGetRequestSchema,
  preferencesGetResponseSchema,
  maximumDocumentBytes,
  documentSourceSchema,
  type DocumentSource,
  type AppInfo,
  type AppWindowMode,
  type AppWindowState,
  type PreferencesEntity
} from '@remind-me/contracts'
import { exportIcs, importIcs } from '@remind-me/importers'
import { validateDocumentBytes } from '@remind-me/importers/document'
import type {
  PersistentAssistantService,
  PersistentCalendarService,
  SqliteCalendarRepository
} from '@remind-me/storage'
import type { ReminderNotificationScheduler } from './notification-scheduler'
import type { OfflineVoiceRuntime } from './voice-runtime'
import type { OptionalFlexModelRuntime } from './flex-model-runtime'

const maximumImportBytes = 25 * 1024 * 1024
const documentSelectionLifetimeMs = 30 * 60 * 1_000

interface PendingDocumentSelection {
  source: DocumentSource
  selectedAt: number
}

const pendingDocumentSelections = new Map<string, PendingDocumentSelection>()

function pruneDocumentSelections(now = Date.now()): void {
  for (const [selectionId, selection] of pendingDocumentSelections) {
    if (now - selection.selectedAt > documentSelectionLifetimeMs) {
      pendingDocumentSelections.delete(selectionId)
    }
  }
  while (pendingDocumentSelections.size > 4) {
    const oldest = [...pendingDocumentSelections.entries()].sort(
      (left, right) => left[1].selectedAt - right[1].selectedAt
    )[0]
    if (!oldest) break
    pendingDocumentSelections.delete(oldest[0])
  }
}

interface IpcHandlerDependencies {
  service: PersistentCalendarService
  assistantService: PersistentAssistantService
  repository: SqliteCalendarRepository
  scheduler: ReminderNotificationScheduler
  voiceRuntime: OfflineVoiceRuntime
  flexModelRuntime: OptionalFlexModelRuntime
  deleteRecoveryCopies: () => Promise<number>
  validateSender: (event: IpcMainInvokeEvent) => void
  appInfo: () => AppInfo
  windowControl: {
    getState: () => AppWindowState
    setMode: (mode: AppWindowMode) => AppWindowState
    setPinned: (pinned: boolean) => AppWindowState
    syncLaunchAtLogin: (preferences: PreferencesEntity) => void
    syncAppearance: (preferences: PreferencesEntity) => void
  }
}

function parentWindow(event: IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender)
}

async function chooseExportPath(
  event: IpcMainInvokeEvent,
  format: 'json' | 'ics'
): Promise<string | null> {
  const options: SaveDialogOptions = {
    title: `Export Remind Me ${format.toUpperCase()}`,
    defaultPath: `remind-me-backup.${format}`,
    filters:
      format === 'json'
        ? [{ name: 'Remind Me backup', extensions: ['json'] }]
        : [{ name: 'Calendar file', extensions: ['ics'] }]
  }
  const parent = parentWindow(event)
  const result = parent
    ? await dialog.showSaveDialog(parent, options)
    : await dialog.showSaveDialog(options)
  return result.canceled ? null : (result.filePath ?? null)
}

async function chooseImportPath(event: IpcMainInvokeEvent): Promise<string | null> {
  const options: OpenDialogOptions = {
    title: 'Import calendar data',
    properties: ['openFile'],
    filters: [
      { name: 'Calendar data', extensions: ['json', 'ics'] },
      { name: 'Remind Me backup', extensions: ['json'] },
      { name: 'Calendar file', extensions: ['ics'] }
    ]
  }
  const parent = parentWindow(event)
  const result = parent
    ? await dialog.showOpenDialog(parent, options)
    : await dialog.showOpenDialog(options)
  return result.canceled ? null : (result.filePaths[0] ?? null)
}

async function chooseDocumentPath(event: IpcMainInvokeEvent): Promise<string | null> {
  const smokeDocumentPath =
    process.argv.includes('--smoke-test') || process.argv.includes('--document-release-gate')
      ? process.env.REMIND_ME_SMOKE_DOCUMENT
      : undefined
  if (smokeDocumentPath) return smokeDocumentPath

  const options: OpenDialogOptions = {
    title: 'Create plans from an image or PDF',
    properties: ['openFile'],
    filters: [
      { name: 'Plans and schedules', extensions: ['pdf', 'png', 'jpg', 'jpeg', 'webp'] },
      { name: 'PDF document', extensions: ['pdf'] },
      { name: 'Image', extensions: ['png', 'jpg', 'jpeg', 'webp'] }
    ]
  }
  const parent = parentWindow(event)
  const result = parent
    ? await dialog.showOpenDialog(parent, options)
    : await dialog.showOpenDialog(options)
  return result.canceled ? null : (result.filePaths[0] ?? null)
}

export function registerCalendarIpcHandlers(dependencies: IpcHandlerDependencies): void {
  const {
    service,
    assistantService,
    repository,
    scheduler,
    voiceRuntime,
    flexModelRuntime,
    validateSender,
    appInfo,
    windowControl
  } = dependencies
  const validate = (event: IpcMainInvokeEvent): void => validateSender(event)
  const afterMutation = (): void => scheduler.reschedule()

  ipcMain.handle(ipcChannels.appGetInfo, (event, payload: unknown) => {
    validate(event)
    appInfoRequestSchema.parse(payload)
    return appInfoResponseSchema.parse(appInfo())
  })

  ipcMain.handle(ipcChannels.windowGetState, (event, payload: unknown) => {
    validate(event)
    ipcContracts[ipcChannels.windowGetState].request.parse(payload)
    return ipcContracts[ipcChannels.windowGetState].response.parse(windowControl.getState())
  })

  ipcMain.handle(ipcChannels.windowSetMode, (event, payload: unknown) => {
    validate(event)
    const request = ipcContracts[ipcChannels.windowSetMode].request.parse(payload)
    return ipcContracts[ipcChannels.windowSetMode].response.parse(
      windowControl.setMode(request.mode)
    )
  })

  ipcMain.handle(ipcChannels.windowSetPinned, (event, payload: unknown) => {
    validate(event)
    const request = ipcContracts[ipcChannels.windowSetPinned].request.parse(payload)
    return ipcContracts[ipcChannels.windowSetPinned].response.parse(
      windowControl.setPinned(request.pinned)
    )
  })

  ipcMain.handle(ipcChannels.preferencesGet, (event, payload: unknown) => {
    validate(event)
    preferencesGetRequestSchema.parse(payload)
    return preferencesGetResponseSchema.parse(repository.getPreferences())
  })

  ipcMain.handle(ipcChannels.preferencesUpdate, (event, payload: unknown) => {
    validate(event)
    const request = ipcContracts[ipcChannels.preferencesUpdate].request.parse(payload)
    const response = service.updatePreferences(request)
    windowControl.syncLaunchAtLogin(response)
    windowControl.syncAppearance(response)
    afterMutation()
    return ipcContracts[ipcChannels.preferencesUpdate].response.parse(response)
  })

  ipcMain.handle(ipcChannels.calendarGetSnapshot, (event, payload: unknown) => {
    validate(event)
    const request = ipcContracts[ipcChannels.calendarGetSnapshot].request.parse(payload)
    return ipcContracts[ipcChannels.calendarGetSnapshot].response.parse(
      service.getSnapshot(request)
    )
  })

  ipcMain.handle(ipcChannels.calendarCheckAvailability, (event, payload: unknown) => {
    validate(event)
    const request = ipcContracts[ipcChannels.calendarCheckAvailability].request.parse(payload)
    return ipcContracts[ipcChannels.calendarCheckAvailability].response.parse(
      service.checkAvailability(request)
    )
  })

  ipcMain.handle(ipcChannels.calendarApplyBatch, (event, payload: unknown) => {
    validate(event)
    const request = ipcContracts[ipcChannels.calendarApplyBatch].request.parse(payload)
    const response = service.applyBatch(request.items, request.summary, request.range)
    afterMutation()
    return ipcContracts[ipcChannels.calendarApplyBatch].response.parse(response)
  })

  ipcMain.handle(ipcChannels.eventSave, (event, payload: unknown) => {
    validate(event)
    const request = ipcContracts[ipcChannels.eventSave].request.parse(payload)
    const response = service.saveEvent(request.form, request.range)
    afterMutation()
    return ipcContracts[ipcChannels.eventSave].response.parse(response)
  })

  ipcMain.handle(ipcChannels.eventDelete, (event, payload: unknown) => {
    validate(event)
    const request = ipcContracts[ipcChannels.eventDelete].request.parse(payload)
    const response = service.deleteEvent(request.target.id, request.range)
    afterMutation()
    return ipcContracts[ipcChannels.eventDelete].response.parse(response)
  })

  ipcMain.handle(ipcChannels.reminderSave, (event, payload: unknown) => {
    validate(event)
    const request = ipcContracts[ipcChannels.reminderSave].request.parse(payload)
    const response = service.saveReminder(request.form, request.range)
    afterMutation()
    return ipcContracts[ipcChannels.reminderSave].response.parse(response)
  })

  ipcMain.handle(ipcChannels.reminderComplete, (event, payload: unknown) => {
    validate(event)
    const request = ipcContracts[ipcChannels.reminderComplete].request.parse(payload)
    const response = service.completeReminder(request.target.id, request.range)
    afterMutation()
    return ipcContracts[ipcChannels.reminderComplete].response.parse(response)
  })

  ipcMain.handle(ipcChannels.reminderDelete, (event, payload: unknown) => {
    validate(event)
    const request = ipcContracts[ipcChannels.reminderDelete].request.parse(payload)
    const response = service.deleteReminder(request.target.id, request.range)
    afterMutation()
    return ipcContracts[ipcChannels.reminderDelete].response.parse(response)
  })

  ipcMain.handle(ipcChannels.historyUndo, (event, payload: unknown) => {
    validate(event)
    const request = ipcContracts[ipcChannels.historyUndo].request.parse(payload)
    const response = service.undoLastAction(request)
    afterMutation()
    return ipcContracts[ipcChannels.historyUndo].response.parse(response)
  })

  ipcMain.handle(ipcChannels.assistantGetConversation, (event, payload: unknown) => {
    validate(event)
    const request = ipcContracts[ipcChannels.assistantGetConversation].request.parse(payload)
    return ipcContracts[ipcChannels.assistantGetConversation].response.parse(
      assistantService.getConversation(request.conversationId)
    )
  })

  ipcMain.handle(ipcChannels.assistantSend, async (event, payload: unknown) => {
    validate(event)
    const request = ipcContracts[ipcChannels.assistantSend].request.parse(payload)
    const response = await assistantService.send(
      request,
      request.streamId
        ? {
            onFlexibleChatChunk: (text) => {
              const chunk = assistantStreamEventSchema.safeParse({
                type: 'chunk',
                streamId: request.streamId,
                text
              })
              if (chunk.success && !event.sender.isDestroyed()) {
                event.sender.send(ipcChannels.assistantStream, chunk.data)
              }
            },
            onFlexibleModelStatus: (status) => {
              const update = assistantStreamEventSchema.safeParse({
                type: 'status',
                streamId: request.streamId,
                status
              })
              if (update.success && !event.sender.isDestroyed()) {
                event.sender.send(ipcChannels.assistantStream, update.data)
              }
            }
          }
        : {}
    )
    afterMutation()
    return ipcContracts[ipcChannels.assistantSend].response.parse(response)
  })

  ipcMain.handle(ipcChannels.assistantCancel, (event, payload: unknown) => {
    validate(event)
    const request = ipcContracts[ipcChannels.assistantCancel].request.parse(payload)
    return ipcContracts[ipcChannels.assistantCancel].response.parse({
      cancelled: flexModelRuntime.cancelInference(request.streamId)
    })
  })

  ipcMain.handle(ipcChannels.assistantConfirm, (event, payload: unknown) => {
    validate(event)
    const request = ipcContracts[ipcChannels.assistantConfirm].request.parse(payload)
    const response = assistantService.confirm(request)
    afterMutation()
    return ipcContracts[ipcChannels.assistantConfirm].response.parse(response)
  })

  ipcMain.handle(ipcChannels.assistantReject, (event, payload: unknown) => {
    validate(event)
    const request = ipcContracts[ipcChannels.assistantReject].request.parse(payload)
    return ipcContracts[ipcChannels.assistantReject].response.parse(
      assistantService.reject(request)
    )
  })

  ipcMain.handle(ipcChannels.assistantClear, (event, payload: unknown) => {
    validate(event)
    const request = ipcContracts[ipcChannels.assistantClear].request.parse(payload)
    return ipcContracts[ipcChannels.assistantClear].response.parse(
      assistantService.clearConversation(request.conversationId)
    )
  })

  ipcMain.handle(ipcChannels.assistantFeedback, (event, payload: unknown) => {
    validate(event)
    const request = ipcContracts[ipcChannels.assistantFeedback].request.parse(payload)
    return ipcContracts[ipcChannels.assistantFeedback].response.parse(
      assistantService.rateReply(request)
    )
  })

  ipcMain.handle(ipcChannels.flexModelGetStatus, async (event, payload: unknown) => {
    validate(event)
    ipcContracts[ipcChannels.flexModelGetStatus].request.parse(payload)
    return ipcContracts[ipcChannels.flexModelGetStatus].response.parse(
      await flexModelRuntime.getStatus()
    )
  })

  ipcMain.handle(ipcChannels.flexModelInstall, async (event, payload: unknown) => {
    validate(event)
    ipcContracts[ipcChannels.flexModelInstall].request.parse(payload)
    const status = await flexModelRuntime.install((progress) => {
      if (!event.sender.isDestroyed()) event.sender.send(ipcChannels.flexModelProgress, progress)
    })
    return ipcContracts[ipcChannels.flexModelInstall].response.parse(status)
  })

  ipcMain.handle(ipcChannels.flexModelCancel, async (event, payload: unknown) => {
    validate(event)
    ipcContracts[ipcChannels.flexModelCancel].request.parse(payload)
    return ipcContracts[ipcChannels.flexModelCancel].response.parse(
      await flexModelRuntime.cancelInstall()
    )
  })

  ipcMain.handle(ipcChannels.flexModelRemove, async (event, payload: unknown) => {
    validate(event)
    ipcContracts[ipcChannels.flexModelRemove].request.parse(payload)
    return ipcContracts[ipcChannels.flexModelRemove].response.parse(await flexModelRuntime.remove())
  })

  ipcMain.handle(ipcChannels.flexModelSetEnabled, async (event, payload: unknown) => {
    validate(event)
    const request = ipcContracts[ipcChannels.flexModelSetEnabled].request.parse(payload)
    return ipcContracts[ipcChannels.flexModelSetEnabled].response.parse(
      await flexModelRuntime.setEnabled(request.enabled)
    )
  })

  ipcMain.handle(ipcChannels.flexModelConfigure, async (event, payload: unknown) => {
    validate(event)
    const request = ipcContracts[ipcChannels.flexModelConfigure].request.parse(payload)
    return ipcContracts[ipcChannels.flexModelConfigure].response.parse(
      await flexModelRuntime.configure(request)
    )
  })

  ipcMain.handle(ipcChannels.voiceGetInfo, async (event, payload: unknown) => {
    validate(event)
    ipcContracts[ipcChannels.voiceGetInfo].request.parse(payload)
    return ipcContracts[ipcChannels.voiceGetInfo].response.parse(await voiceRuntime.getInfo())
  })

  ipcMain.handle(ipcChannels.voiceWarm, async (event, payload: unknown) => {
    validate(event)
    const request = ipcContracts[ipcChannels.voiceWarm].request.parse(payload)
    const response = await voiceRuntime.warm(request.jobId, (progress) => {
      if (!event.sender.isDestroyed()) event.sender.send(ipcChannels.voiceProgress, progress)
    })
    return ipcContracts[ipcChannels.voiceWarm].response.parse(response)
  })

  ipcMain.handle(ipcChannels.voiceTranscribe, async (event, payload: unknown) => {
    validate(event)
    const request = ipcContracts[ipcChannels.voiceTranscribe].request.parse(payload)
    const response = await voiceRuntime.transcribe(request, (progress) => {
      if (!event.sender.isDestroyed()) event.sender.send(ipcChannels.voiceProgress, progress)
    })
    return ipcContracts[ipcChannels.voiceTranscribe].response.parse(response)
  })

  ipcMain.handle(ipcChannels.voiceStreamStart, async (event, payload: unknown) => {
    validate(event)
    const request = ipcContracts[ipcChannels.voiceStreamStart].request.parse(payload)
    const response = await voiceRuntime.startStream(request, (progress) => {
      if (!event.sender.isDestroyed()) event.sender.send(ipcChannels.voiceProgress, progress)
    })
    return ipcContracts[ipcChannels.voiceStreamStart].response.parse(response)
  })

  ipcMain.handle(ipcChannels.voiceStreamAppend, (event, payload: unknown) => {
    validate(event)
    const request = ipcContracts[ipcChannels.voiceStreamAppend].request.parse(payload)
    return ipcContracts[ipcChannels.voiceStreamAppend].response.parse(
      voiceRuntime.appendStream(request)
    )
  })

  ipcMain.handle(ipcChannels.voiceStreamFinish, async (event, payload: unknown) => {
    validate(event)
    const request = ipcContracts[ipcChannels.voiceStreamFinish].request.parse(payload)
    return ipcContracts[ipcChannels.voiceStreamFinish].response.parse(
      await voiceRuntime.finishStream(request.jobId)
    )
  })

  ipcMain.handle(ipcChannels.voiceCancel, (event, payload: unknown) => {
    validate(event)
    const request = ipcContracts[ipcChannels.voiceCancel].request.parse(payload)
    return ipcContracts[ipcChannels.voiceCancel].response.parse({
      jobId: request.jobId,
      cancelled: voiceRuntime.cancel(request.jobId)
    })
  })

  ipcMain.handle(ipcChannels.documentSelect, async (event, payload: unknown) => {
    validate(event)
    ipcContracts[ipcChannels.documentSelect].request.parse(payload)
    const filePath = await chooseDocumentPath(event)
    if (!filePath) {
      return ipcContracts[ipcChannels.documentSelect].response.parse({
        cancelled: true,
        selection: null
      })
    }
    const fileStats = await stat(filePath)
    if (!fileStats.isFile()) throw new Error('Choose a regular image or PDF file')
    if (fileStats.size <= 0) throw new Error('The selected file is empty')
    if (fileStats.size > maximumDocumentBytes) {
      throw new Error('Images and PDFs must be 25 MB or smaller')
    }
    const fileBuffer = await readFile(filePath)
    const validation = validateDocumentBytes(fileBuffer)
    const selectionId = `document:${randomUUID()}`
    const source = documentSourceSchema.parse({
      id: selectionId,
      kind: validation.kind,
      displayName: basename(filePath),
      mediaType: validation.mediaType,
      byteLength: fileBuffer.byteLength,
      sha256: createHash('sha256').update(fileBuffer).digest('hex')
    })
    pruneDocumentSelections()
    pendingDocumentSelections.set(selectionId, { source, selectedAt: Date.now() })
    pruneDocumentSelections()
    const bytes = fileBuffer.buffer.slice(
      fileBuffer.byteOffset,
      fileBuffer.byteOffset + fileBuffer.byteLength
    ) as ArrayBuffer
    return ipcContracts[ipcChannels.documentSelect].response.parse({
      cancelled: false,
      selection: { source, bytes }
    })
  })

  ipcMain.handle(ipcChannels.documentCommit, (event, payload: unknown) => {
    validate(event)
    const request = ipcContracts[ipcChannels.documentCommit].request.parse(payload)
    pruneDocumentSelections()
    const pending = pendingDocumentSelections.get(request.selectionId)
    if (!pending) throw new Error('This document review expired. Choose the file again.')
    if (request.items.some((item) => item.sourceIdentity.sourceSha256 !== pending.source.sha256)) {
      throw new Error('The reviewed items do not belong to the selected document.')
    }
    const mutation = service.importReviewedDocumentItems(
      request.items,
      pending.source.displayName,
      request.range
    )
    pendingDocumentSelections.delete(request.selectionId)
    afterMutation()
    return ipcContracts[ipcChannels.documentCommit].response.parse(mutation)
  })

  ipcMain.handle(ipcChannels.documentDiscard, (event, payload: unknown) => {
    validate(event)
    const request = ipcContracts[ipcChannels.documentDiscard].request.parse(payload)
    return ipcContracts[ipcChannels.documentDiscard].response.parse({
      discarded: pendingDocumentSelections.delete(request.selectionId)
    })
  })

  ipcMain.handle(ipcChannels.documentRepair, async (event, payload: unknown) => {
    validate(event)
    const request = ipcContracts[ipcChannels.documentRepair].request.parse(payload)
    pruneDocumentSelections()
    const pending = pendingDocumentSelections.get(request.selectionId)
    if (!pending || pending.source.sha256 !== request.sourceSha256) {
      throw new Error('This document repair no longer belongs to an active local review.')
    }
    const response = await flexModelRuntime.repairDocument(request)
    return ipcContracts[ipcChannels.documentRepair].response.parse(response)
  })

  ipcMain.handle(ipcChannels.documentFallback, async (event, payload: unknown) => {
    validate(event)
    const request = ipcContracts[ipcChannels.documentFallback].request.parse(payload)
    pruneDocumentSelections()
    const pending = pendingDocumentSelections.get(request.selectionId)
    if (!pending || pending.source.sha256 !== request.sourceSha256) {
      throw new Error('This document fallback no longer belongs to an active local review.')
    }
    const response = await flexModelRuntime.groupDocumentFallback(request)
    return ipcContracts[ipcChannels.documentFallback].response.parse(response)
  })

  ipcMain.handle(ipcChannels.dataExport, async (event, payload: unknown) => {
    validate(event)
    const request = ipcContracts[ipcChannels.dataExport].request.parse(payload)
    const filePath = await chooseExportPath(event, request.format)
    const backup = service.createBackup()
    if (!filePath) {
      return ipcContracts[ipcChannels.dataExport].response.parse({
        cancelled: true,
        filePath: null,
        eventCount: backup.events.length,
        reminderCount: backup.reminders.length
      })
    }
    const contents =
      request.format === 'json'
        ? `${JSON.stringify(backup, null, 2)}\n`
        : exportIcs(backup.events, backup.reminders)
    await writeFile(filePath, contents, { encoding: 'utf8', flag: 'wx' }).catch(async (error) => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      await writeFile(filePath, contents, { encoding: 'utf8' })
    })
    return ipcContracts[ipcChannels.dataExport].response.parse({
      cancelled: false,
      filePath,
      eventCount: backup.events.length,
      reminderCount: backup.reminders.length
    })
  })

  ipcMain.handle(ipcChannels.dataImport, async (event, payload: unknown) => {
    validate(event)
    const range = ipcContracts[ipcChannels.dataImport].request.parse(payload)
    const filePath = await chooseImportPath(event)
    if (!filePath) {
      return ipcContracts[ipcChannels.dataImport].response.parse({
        cancelled: true,
        filePath: null,
        format: null,
        eventCount: 0,
        reminderCount: 0,
        skippedCount: 0,
        snapshot: null
      })
    }

    const buffer = await readFile(filePath)
    if (buffer.byteLength > maximumImportBytes) {
      throw new Error('Import files must be 25 MB or smaller')
    }
    const text = buffer.toString('utf8')
    if (extname(filePath).toLowerCase() === '.ics') {
      const preferences = repository.getPreferences()
      const defaultCalendar = repository.listCalendars()[0]
      if (!defaultCalendar) throw new Error('No local calendar is available')
      const imported = importIcs(text, {
        defaultCalendarId: defaultCalendar.id,
        defaultTimezone: preferences.timezone
      })
      const mutation = service.importEntities(imported.events, imported.reminders, range)
      afterMutation()
      return ipcContracts[ipcChannels.dataImport].response.parse({
        cancelled: false,
        filePath,
        format: 'ics',
        eventCount: imported.events.length,
        reminderCount: imported.reminders.length,
        skippedCount: imported.skippedCount,
        snapshot: mutation.snapshot
      })
    }

    const backup = calendarBackupSchema.parse(JSON.parse(text) as unknown)
    const mutation = service.importBackup(backup, range)
    afterMutation()
    return ipcContracts[ipcChannels.dataImport].response.parse({
      cancelled: false,
      filePath,
      format: 'json',
      eventCount: backup.events.length,
      reminderCount: backup.reminders.length,
      skippedCount: 0,
      snapshot: mutation.snapshot
    })
  })

  ipcMain.handle(ipcChannels.dataDeleteAll, async (event, payload: unknown) => {
    validate(event)
    const request = ipcContracts[ipcChannels.dataDeleteAll].request.parse(payload)
    pendingDocumentSelections.clear()
    const response = service.deleteAllData(request.range)
    const recoveryCopiesDeleted = await dependencies.deleteRecoveryCopies()
    afterMutation()
    return ipcContracts[ipcChannels.dataDeleteAll].response.parse({
      ...response,
      recoveryCopiesDeleted
    })
  })
}
