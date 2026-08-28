import { app, BrowserWindow, net, protocol, session, type WebFrameMain } from 'electron'
import { writeFile } from 'node:fs/promises'
import { join, normalize, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { PreferencesEntity } from '@remind-me/contracts'
import {
  deleteCalendarRecoveryCopies,
  openCalendarDatabase,
  PersistentAssistantService,
  PersistentCalendarService
} from '@remind-me/storage'
import type { SqliteCalendarRepository } from '@remind-me/storage'
import { registerCalendarIpcHandlers } from './ipc-handlers'
import { loadAndAttestLocalRelease } from './release-runtime'
import { ReminderNotificationScheduler } from './notification-scheduler'
import { OfflineVoiceRuntime, type VoiceRuntimePaths } from './voice-runtime'
import { WindowModeController } from './window-mode'
import { OptionalFlexModelRuntime, type FlexModelRuntimePaths } from './flex-model-runtime'
import { applyLaunchAtLogin, startupModeFromArguments } from './startup-settings'
import {
  applyWindowAppearance,
  getAppearanceSupport,
  windowAppearanceOptions
} from './appearance-runtime'
import { scheduleDocumentReleaseGate } from './document-release-gate'

const applicationScheme = 'remind-me'
const applicationHost = 'app'
const applicationName = 'Remind Me'
const windowsAppUserModelId = 'com.remindme.desktop'
const isSmokeTest = process.argv.includes('--smoke-test')
const isDocumentReleaseGate = process.argv.includes('--document-release-gate')
const isTestRun = isSmokeTest || isDocumentReleaseGate
const isOfflineSmokeTest = process.argv.includes('--offline-smoke')

if (isDocumentReleaseGate && process.env.REMIND_ME_DOCUMENT_GATE_USER_DATA) {
  app.setPath('userData', process.env.REMIND_ME_DOCUMENT_GATE_USER_DATA)
}

app.setName(applicationName)
if (process.platform === 'win32') app.setAppUserModelId(windowsAppUserModelId)

protocol.registerSchemesAsPrivileged([
  {
    scheme: applicationScheme,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: false,
      codeCache: true
    }
  }
])

app.enableSandbox()

function isTrustedRendererUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl)
    const developmentUrl = process.env.ELECTRON_RENDERER_URL
    if (developmentUrl) return url.origin === new URL(developmentUrl).origin
    return url.protocol === `${applicationScheme}:` && url.hostname === applicationHost
  } catch {
    return false
  }
}

function validateIpcSender(frame: WebFrameMain | null): void {
  if (!frame || !isTrustedRendererUrl(frame.url)) {
    throw new Error('Rejected IPC request from an untrusted renderer')
  }
}

async function registerApplicationProtocol(): Promise<void> {
  const rendererRoot = resolve(import.meta.dirname, '../renderer')
  const rendererRootPrefix = `${rendererRoot}${sep}`

  await protocol.handle(applicationScheme, (request) => {
    const url = new URL(request.url)
    if (
      url.hostname !== applicationHost ||
      (request.method !== 'GET' && request.method !== 'HEAD')
    ) {
      return new Response('Not found', { status: 404 })
    }

    let decodedPath: string
    try {
      decodedPath = decodeURIComponent(url.pathname)
    } catch {
      return new Response('Bad request', { status: 400 })
    }

    const relativePath = decodedPath === '/' ? 'index.html' : decodedPath.replace(/^\/+/, '')
    const normalizedPath = normalize(relativePath)
    const filePath = resolve(rendererRoot, normalizedPath)
    if (filePath !== rendererRoot && !filePath.startsWith(rendererRootPrefix)) {
      return new Response('Forbidden', { status: 403 })
    }

    return net.fetch(pathToFileURL(filePath).toString())
  })
}

function configureSessionSecurity(): void {
  if (isOfflineSmokeTest) session.defaultSession.enableNetworkEmulation({ offline: true })
  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    if (permission !== 'media') return false
    const trusted = webContents
      ? isTrustedRendererUrl(webContents.getURL())
      : isTrustedRendererUrl(requestingOrigin)
    return trusted
  })
  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      const mediaTypes = 'mediaTypes' in details ? (details.mediaTypes ?? []) : []
      const audioOnly = mediaTypes.includes('audio') && !mediaTypes.includes('video')
      callback(permission === 'media' && isTrustedRendererUrl(webContents.getURL()) && audioOnly)
    }
  )
}

function configureWindowSecurity(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, navigationUrl) => {
    if (!isTrustedRendererUrl(navigationUrl)) event.preventDefault()
  })
}

function scheduleSmokeResult(window: BrowserWindow): void {
  const timeout = setTimeout(() => {
    console.error('Smoke test timed out before the renderer bridge became ready.')
    app.exit(1)
  }, 60_000)
  window.webContents.once('did-finish-load', async () => {
    try {
      const bridgeReady = await window.webContents.executeJavaScript(`
        (async () => {
          const range = {
            rangeStartUtc: '2026-01-01T00:00:00.000Z',
            rangeEndUtc: '2027-01-01T00:00:00.000Z'
          }
          const [info, snapshot] = await Promise.all([
            window.remindMe?.getAppInfo(),
            window.remindMe?.getCalendarSnapshot(range)
          ])
          const initialWindow = await window.remindMe.getWindowState()
          const compactWindow = await window.remindMe.setWindowMode('widget')
          const unpinnedWindow = await window.remindMe.setWindowPinned(false)
          const repinnedWindow = await window.remindMe.setWindowPinned(true)
          const glanceWindow = await window.remindMe.setWindowMode('glance')
          const restoredWindow = await window.remindMe.setWindowMode('full')
          const [
            documentRuntime,
            pdfWorkerResponse,
            ocrModelResponse,
            planScanConfigurationResponse,
            planScanWeightsResponse
          ] = await Promise.all([
            fetch('/document/runtime-manifest.json').then((response) => {
              if (!response.ok) throw new Error('Document runtime manifest is unavailable')
              return response.json()
            }),
            fetch('/document/pdf.worker.min.mjs'),
            fetch('/ocr/lang/eng.traineddata.gz'),
            fetch('/planscan/planscan-v0.1-int8.json'),
            fetch('/planscan/planscan-v0.1-int8.bin.gz')
          ])
          const created = await window.remindMe.saveEvent({
            id: null,
            calendarId: null,
            title: 'Smoke test event',
            description: '',
            location: '',
            startDate: '2026-08-24',
            startTime: '09:00',
            endDate: '2026-08-24',
            endTime: '10:00',
            timezone: 'UTC',
            allDay: false,
            recurrence: null
          }, range)
          const availability = await window.remindMe.checkAvailability({
            rangeStartUtc: '2026-08-24T09:30:00.000Z',
            rangeEndUtc: '2026-08-24T09:45:00.000Z',
            excludeEventId: null
          })
          const undone = await window.remindMe.undoLastAction(range)
          const preview = await window.remindMe.sendAssistantMessage({
            conversationId: null,
            text: 'Remind me to run the smoke check on August 25, 2026 at 6 PM',
            range
          })
          const proposal = preview.conversation.activeProposal
          const applied = proposal
            ? await window.remindMe.confirmAssistantProposal({ proposalId: proposal.id, range })
            : null
          const answer = await window.remindMe.sendAssistantMessage({
            conversationId: preview.conversation.id,
            text: 'What do I have on August 25, 2026?',
            range
          })
          const answerRepeat = await window.remindMe.sendAssistantMessage({
            conversationId: preview.conversation.id,
            text: 'What do I have on August 25, 2026?',
            range
          })
          const assistantUndone = await window.remindMe.sendAssistantMessage({
            conversationId: preview.conversation.id,
            text: 'undo that',
            range
          })
          const restoredConversation = await window.remindMe.getAssistantConversation(
            preview.conversation.id
          )
          const remindCorePreview = await window.remindMe.sendAssistantMessage({
            conversationId: preview.conversation.id,
            text: 'Give me a nudge to feed Juniper tomorrow at 4 PM',
            range
          })
          const remindCoreProposal = remindCorePreview.conversation.activeProposal
          if (remindCoreProposal) {
            await window.remindMe.rejectAssistantProposal({
              proposalId: remindCoreProposal.id,
              mode: 'cancel',
              range
            })
          }
          const waveBuffer = await fetch('/voice-smoke.wav').then((response) => response.arrayBuffer())
          const waveView = new DataView(waveBuffer)
          let waveOffset = 12
          let sampleRate = 0
          let channelCount = 0
          let bitsPerSample = 0
          let dataOffset = 0
          let dataLength = 0
          while (waveOffset + 8 <= waveView.byteLength) {
            const chunkId = String.fromCharCode(
              waveView.getUint8(waveOffset),
              waveView.getUint8(waveOffset + 1),
              waveView.getUint8(waveOffset + 2),
              waveView.getUint8(waveOffset + 3)
            )
            const chunkLength = waveView.getUint32(waveOffset + 4, true)
            if (chunkId === 'fmt ') {
              channelCount = waveView.getUint16(waveOffset + 10, true)
              sampleRate = waveView.getUint32(waveOffset + 12, true)
              bitsPerSample = waveView.getUint16(waveOffset + 22, true)
            } else if (chunkId === 'data') {
              dataOffset = waveOffset + 8
              dataLength = chunkLength
              break
            }
            waveOffset += 8 + chunkLength + (chunkLength % 2)
          }
          if (sampleRate !== 16000 || channelCount !== 1 || bitsPerSample !== 16 || !dataOffset) {
            throw new Error('Smoke voice fixture has an unsupported WAV format')
          }
          const voiceSamples = new Float32Array(dataLength / 2)
          for (let index = 0; index < voiceSamples.length; index += 1) {
            voiceSamples[index] = waveView.getInt16(dataOffset + index * 2, true) / 32768
          }
          const livePartials = []
          const stopLiveProgress = window.remindMe.onVoiceProgress((event) => {
            if (event.jobId === 'voice:live-smoke' && event.partialText) {
              livePartials.push(event.partialText)
            }
          })
          await window.remindMe.startVoiceStream({
            jobId: 'voice:live-smoke',
            sampleRate: 16000
          })
          for (let offset = 0; offset < voiceSamples.length; offset += 6400) {
            const chunk = voiceSamples.slice(offset, Math.min(voiceSamples.length, offset + 6400))
            await window.remindMe.appendVoiceStream({
              jobId: 'voice:live-smoke',
              samples: chunk.buffer
            })
          }
          const liveVoice = await window.remindMe.finishVoiceStream('voice:live-smoke')
          stopLiveProgress()
          let resolveCancellation
          const cancellationStarted = new Promise((resolve) => {
            resolveCancellation = resolve
          })
          const stopCancellationProgress = window.remindMe.onVoiceProgress((event) => {
            if (event.jobId === 'voice:cancel-smoke' && event.stage === 'queued') {
              void window.remindMe
                .cancelVoiceTranscription('voice:cancel-smoke')
                .then(resolveCancellation)
            }
          })
          const cancelledTranscription = window.remindMe
            .transcribeVoice({
              jobId: 'voice:cancel-smoke',
              sampleRate: 16000,
              samples: voiceSamples.buffer.slice(0)
            })
            .then(() => false, () => true)
          const cancellation = await Promise.race([
            cancellationStarted,
            new Promise((_, rejectCancellation) =>
              setTimeout(
                () => rejectCancellation(new Error('Voice cancellation did not start in time')),
                2500
              )
            )
          ])
          stopCancellationProgress()
          const cancellationRejected = await cancelledTranscription
          const voice = await window.remindMe.transcribeVoice({
            jobId: 'voice:smoke',
            sampleRate: 16000,
            samples: voiceSamples.buffer
          })
          await new Promise((resolveIdle) => setTimeout(resolveIdle, 450))
          const voiceAfterIdle = await window.remindMe.getVoiceInfo()
          const waitFor = async (predicate, timeoutMs = 2500) => {
            const deadline = Date.now() + timeoutMs
            while (Date.now() < deadline) {
              const value = predicate()
              if (value) return value
              await new Promise((resolvePoll) => setTimeout(resolvePoll, 25))
            }
            return null
          }
          const assistantToggle = document.querySelector('[data-testid="assistant-toggle"]')
          assistantToggle?.click()
          const firstComposer = await waitFor(() =>
            document.querySelector('[data-testid="assistant-composer-input"]')
          )
          const clearButton = await waitFor(() =>
            [...document.querySelectorAll('.assistant-footnote button')].find((candidate) =>
              candidate.textContent?.includes('Clear conversation')
            )
           )
           firstComposer?.click()
           const focusOnOpen = Boolean(await waitFor(() =>
             document.activeElement === firstComposer ? firstComposer : null
           ))
          clearButton?.click()
          await new Promise((resolveArm) => setTimeout(resolveArm, 35))
          const armedClearButton = document.querySelector(
            '.assistant-footnote button[data-armed="true"]'
          )
          armedClearButton?.click()
          await waitFor(() => {
            const input = document.querySelector('[data-testid="assistant-composer-input"]')
            const button = document.querySelector('.assistant-footnote button')
            return input && button && !button.disabled && document.activeElement === input
              ? input
              : null
          })
          const composerAfterClear = document.querySelector(
            '[data-testid="assistant-composer-input"]'
          )
          const focusAfterClear = document.activeElement === composerAfterClear
          const closeAssistant = document.querySelector(
            '[aria-label="Close assistant sidebar"]'
          )
          closeAssistant?.click()
          const assistantClosingMotion = Boolean(await waitFor(() =>
            document.querySelector('.assistant-sidebar[data-state="closing"]')
          ))
          await waitFor(() => document.querySelector('.assistant-rail-button'))
          document.querySelector('.assistant-rail-button')?.click()
          const composerAfterReopen = await waitFor(() => {
            const input = document.querySelector('[data-testid="assistant-composer-input"]')
            return input && document.activeElement === input ? input : null
          })
          const nativeValueSetter = Object.getOwnPropertyDescriptor(
            HTMLTextAreaElement.prototype,
            'value'
          )?.set
          if (composerAfterReopen && nativeValueSetter) {
            nativeValueSetter.call(composerAfterReopen, 'typing works after reopening')
            composerAfterReopen.dispatchEvent(new Event('input', { bubbles: true }))
          }
          const typingAfterReopen = Boolean(await waitFor(() =>
            document.activeElement === composerAfterReopen &&
            composerAfterReopen?.value === 'typing works after reopening'
              ? composerAfterReopen
              : null
          ))
          const assistantComposerRecovery =
            focusOnOpen &&
            focusAfterClear &&
            typingAfterReopen
          document.querySelector('[aria-label="Close assistant sidebar"]')?.click()
          await window.remindMe.saveReminder({
            id: null,
            calendarId: null,
            title: 'Erase with smoke data',
            notes: '',
            dueDate: '2026-08-26',
            dueTime: '08:00',
            timezone: 'UTC',
            recurrence: null
          }, range)
          const deleted = await window.remindMe.deleteAllData('DELETE', range)
          const checks = {
            appInfo:
              info.offlineReady === true &&
              info.name.length > 0 &&
              info.planner.available === true &&
              info.planner.teacherUsed === true &&
              info.planner.networkRequired === false &&
              info.speaker.available === true &&
              info.speaker.teacherUsed === true &&
              info.speaker.networkRequired === false &&
              info.speaker.candidateCount === 5 &&
              info.planScan.available === true &&
              info.planScan.parameterCount === 5242880 &&
              info.planScan.teacherUsed === false &&
              info.planScan.networkRequired === false &&
              info.release.status === 'verified' &&
              info.release.goldenProbes.planner === true &&
              info.release.goldenProbes.speaker === true &&
              info.release.goldenProbes.document === true &&
              info.release.customModelBytes < info.release.customModelBudgetBytes &&
              info.release.providers.cpuFallback === true &&
              info.database.status === 'memory' &&
              info.database.quickCheck === 'ok',
            documentRuntime:
              documentRuntime.pdfjsVersion === '6.2.108' &&
              documentRuntime.tesseractVersion === '7.0.0' &&
              documentRuntime.planScanVersion === '0.1.0' &&
              documentRuntime.copiedBytes > 15_000_000 &&
              pdfWorkerResponse.ok &&
              ocrModelResponse.ok &&
              planScanConfigurationResponse.ok &&
              planScanWeightsResponse.ok,
            initialSnapshot:
              snapshot.calendars.length > 0 &&
              snapshot.preferences.privacyMode === 'local-only',
            windowModes:
              initialWindow.mode === 'full' &&
              compactWindow.mode === 'widget' &&
              compactWindow.pinned === true &&
              compactWindow.width <= 420 &&
              compactWindow.height <= 680 &&
              unpinnedWindow.mode === 'widget' &&
              unpinnedWindow.pinned === false &&
              repinnedWindow.pinned === true &&
              glanceWindow.mode === 'glance' &&
              glanceWindow.pinned === true &&
              glanceWindow.width <= 306 &&
              glanceWindow.height <= 270 &&
              restoredWindow.mode === 'full' &&
              restoredWindow.pinned === false &&
              restoredWindow.width >= 920 &&
              restoredWindow.height >= 640,
            manualCreate: created.snapshot.events.some(
              (event) => event.title === 'Smoke test event'
            ),
            availability: availability.free === false && availability.conflicts.length === 1,
            manualUndo: undone.snapshot.events.length === snapshot.events.length,
            assistantPreview: preview.response.kind === 'preview' && proposal !== null,
            assistantApply: Boolean(
              applied?.snapshot.reminders.some(
                (reminder) =>
                  reminder.title === 'run the smoke check' &&
                  reminder.provenance === 'assistant'
              )
            ),
            groundedAnswer:
              answer.response.kind === 'answer' &&
              answer.response.text.includes('run the smoke check'),
            conciseCalendarAnswer:
              answer.response.text === 'run the smoke check.' &&
              answerRepeat.response.kind === 'answer' &&
              answerRepeat.response.text === answer.response.text,
            assistantUndo:
              assistantUndone.snapshot.reminders.length === snapshot.reminders.length,
            conversationPersistence:
              restoredConversation.turns.length >= 7 &&
              restoredConversation.activeProposal === null,
            remindCoreHybrid:
              remindCorePreview.response.kind === 'preview' &&
              remindCoreProposal?.operation === 'reminder.create' &&
              remindCoreProposal.payload.kind === 'reminder-save' &&
              remindCoreProposal.payload.form.title === 'feed Juniper',
            voiceCancellation:
              cancellation.cancelled === true && cancellationRejected === true,
            voiceTranscription: voice.text
              .toLowerCase()
              .includes('yellow lamps would light up'),
            voiceLiveTranscription:
              liveVoice.text.toLowerCase().includes('yellow lamps would light up') &&
              livePartials.length > 0,
            voiceIdleUnload:
              voiceAfterIdle.available === true &&
              voiceAfterIdle.loaded === false &&
              voiceAfterIdle.unloadsWhenIdle === true,
            assistantClosingMotion,
            assistantComposerRecovery,
            secureDelete:
              deleted.reminderCount >= 1 &&
              deleted.conversationCount >= 1 &&
              deleted.recoveryCopiesDeleted === 0 &&
              deleted.snapshot.events.length === 0 &&
              deleted.snapshot.reminders.length === 0 &&
              deleted.snapshot.canUndo === false
          }
          const failures = Object.entries(checks)
            .filter(([, passed]) => !passed)
            .map(([name]) => name)
          if (failures.length > 0) {
            throw new Error(
              'Smoke assertions failed: ' + failures.join(', ') +
              '; windows=' + JSON.stringify({ initialWindow, compactWindow, unpinnedWindow, repinnedWindow, glanceWindow, restoredWindow }) +
              '; voice=' + voice.text
            )
          }
          return true
        })()
        `)
      const capturePath = process.env.REMIND_ME_SMOKE_CAPTURE
      if (bridgeReady === true && capturePath) {
        if (process.env.REMIND_ME_SMOKE_SHOWCASE === '1') {
          await window.webContents.executeJavaScript(`
            (async () => {
              const isoDate = (offset) => {
                const date = new Date()
                date.setHours(12, 0, 0, 0)
                date.setDate(date.getDate() + offset)
                const year = String(date.getFullYear())
                const month = String(date.getMonth() + 1).padStart(2, '0')
                const day = String(date.getDate()).padStart(2, '0')
                return year + '-' + month + '-' + day
              }
              const today = isoDate(0)
              const tomorrow = isoDate(1)
              const twoDaysOut = isoDate(2)
              const year = new Date().getFullYear()
              const range = {
                rangeStartUtc: (year - 1) + '-01-01T00:00:00.000Z',
                rangeEndUtc: (year + 2) + '-01-01T00:00:00.000Z'
              }
              const event = (title, date, startTime, endTime, location, description = '') => ({
                id: null,
                calendarId: null,
                title,
                description,
                location,
                startDate: date,
                startTime,
                endDate: date,
                endTime,
                timezone: 'America/Chicago',
                allDay: false,
                recurrence: null
              })
              await window.remindMe.saveEvent(
                event('Design review', today, '09:30', '10:15', 'Studio A', 'Walk through the calendar assistant prototype.'),
                range
              )
              await window.remindMe.saveEvent(
                event('Lunch with Maya', today, '12:30', '13:30', 'River Room'),
                range
              )
              await window.remindMe.saveEvent(
                event('Prototype focus block', today, '15:00', '16:30', 'Home studio'),
                range
              )
              await window.remindMe.saveEvent(
                event('Research sync', tomorrow, '10:00', '10:45', 'Video call'),
                range
              )
              await window.remindMe.saveEvent(
                event('Portfolio review', twoDaysOut, '14:00', '15:00', 'Reading Room'),
                range
              )
              await window.remindMe.saveReminder({
                id: null,
                calendarId: null,
                title: 'Send project notes',
                notes: 'Share the decisions from today’s review.',
                dueDate: today,
                dueTime: '17:30',
                timezone: 'America/Chicago',
                recurrence: null
              }, range)
              await window.remindMe.saveReminder({
                id: null,
                calendarId: null,
                title: 'Prepare portfolio screenshots',
                notes: '',
                dueDate: tomorrow,
                dueTime: '18:00',
                timezone: 'America/Chicago',
                recurrence: null
              }, range)
              await window.remindMe.sendAssistantMessage({
                conversationId: null,
                text: 'What do I have today?',
                range
              })
              return true
            })()
          `)
          const reloaded = new Promise<void>((resolveReload) => {
            window.webContents.once('did-finish-load', () => resolveReload())
          })
          window.webContents.reload()
          await reloaded
          await new Promise((resolveReady) => setTimeout(resolveReady, 700))
        }
        window.showInactive()
        await new Promise((resolveReady) => setTimeout(resolveReady, 250))
        const captureView = process.env.REMIND_ME_SMOKE_VIEW
        if (
          captureView &&
          [
            'calendar',
            'reminders',
            'settings',
            'settings-glass',
            'editor',
            'assistant',
            'widget',
            'widget-assistant',
            'glance',
            'glance-reminders',
            'glance-assistant',
            'calendar-day',
            'document'
          ].includes(captureView)
        ) {
          const viewControlFound = await window.webContents.executeJavaScript(`
            (async () => {
              const captureView = ${JSON.stringify(captureView)}
              const pause = (duration = 350) => new Promise((resolve) => setTimeout(resolve, duration))
              const findButton = (selector, text) => [...document.querySelectorAll(selector)]
                .find((candidate) => candidate.textContent?.includes(text))
              if (captureView === 'editor') {
                const button = document.querySelector('.quick-add')
                button?.click()
                return Boolean(button)
              }
              if (captureView === 'assistant') {
                const button = document.querySelector('[data-testid="assistant-toggle"]')
                button?.click()
                return Boolean(button)
              }
              if (captureView === 'calendar-day') {
                const button = findButton('.nav-button', 'Calendar')
                button?.click()
                await pause()
                const day = document.querySelector('.calendar-day[data-today="true"] .calendar-day-open')
                day?.click()
                await pause()
                return Boolean(button && day)
              }
              if (['widget', 'widget-assistant', 'glance', 'glance-reminders', 'glance-assistant'].includes(captureView)) {
                const button = document.querySelector('[data-testid="widget-mode-button"]')
                button?.click()
                if (!button) return false
                await pause(500)
                if (captureView === 'widget-assistant') {
                  const assistant = findButton('.widget-tabs button', 'Assistant')
                  assistant?.click()
                  await pause()
                  return Boolean(assistant)
                }
                if (captureView.startsWith('glance')) {
                  const tiny = findButton('.widget-window-actions button', 'Tiny')
                  tiny?.click()
                  if (!tiny) return false
                  await pause(500)
                  if (captureView === 'glance-reminders') {
                    const reminders = findButton('.glance-tabs button', 'Reminders')
                    reminders?.click()
                    await pause()
                    return Boolean(reminders)
                  }
                  if (captureView === 'glance-assistant') {
                    const assistant = findButton('.glance-tabs button', 'Ask')
                    assistant?.click()
                    await pause()
                    return Boolean(assistant)
                  }
                }
                return true
              }
               if (captureView === 'document') {
                 const button = [...document.querySelectorAll('button')]
                   .find((candidate) => candidate.textContent?.includes('Import plan'))
                 button?.click()
                 return Boolean(button)
               }
              const route = captureView === 'settings-glass' ? 'settings' : captureView
              const label = route[0].toUpperCase() + route.slice(1)
              const button = [...document.querySelectorAll('.nav-button')]
                .find((candidate) => candidate.textContent?.includes(label))
              button?.click()
              return Boolean(button)
            })()
          `)
          if (!viewControlFound)
            console.error(`Smoke capture control was not found: ${captureView}`)
          await new Promise((resolveReady) =>
            setTimeout(
              resolveReady,
              [
                'widget',
                'widget-assistant',
                'glance',
                'glance-reminders',
                'glance-assistant'
              ].includes(captureView)
                ? 700
                : 350
            )
          )
          if (captureView === 'document') {
            const documentDeadline = Date.now() + 30_000
            let documentReady = false
            while (Date.now() < documentDeadline && !documentReady) {
              documentReady = await window.webContents.executeJavaScript(
                `Boolean(document.querySelector('.document-review'))`
              )
              if (!documentReady) await new Promise((resolveReady) => setTimeout(resolveReady, 150))
            }
            if (!documentReady)
              console.error('Document showcase did not finish processing in time.')
            const documentTab = process.env.REMIND_ME_SMOKE_DOCUMENT_TAB
            if (
              documentReady &&
              documentTab &&
              ['week', 'timeline', 'month', 'details', 'source'].includes(documentTab)
            ) {
              await window.webContents.executeJavaScript(`
                (() => {
                  const tab = ${JSON.stringify(documentTab)}
                  const labels = {
                    week: 'Week preview',
                    timeline: 'Chronological',
                    month: 'Month',
                    details: 'Edit details',
                    source: 'Source'
                  }
                  const button = [...document.querySelectorAll('.document-review-tabs button')]
                    .find((candidate) => candidate.textContent?.includes(labels[tab]))
                  button?.click()
                  return Boolean(button)
                })()
              `)
            }
            await new Promise((resolveReady) => setTimeout(resolveReady, 350))
          }
          if (captureView === 'settings-glass') {
            await window.webContents.executeJavaScript(`
              document.querySelector('[data-surface-preview="liquid"]')?.click()
            `)
            await new Promise((resolveReady) => setTimeout(resolveReady, 350))
          }
        }
        const captureScroll = Number(process.env.REMIND_ME_SMOKE_SCROLL ?? '0')
        if (Number.isFinite(captureScroll) && captureScroll > 0) {
          await window.webContents.executeJavaScript(`
            document.querySelector('.main-content')?.scrollTo(0, ${captureScroll})
          `)
          await new Promise((resolveReady) => setTimeout(resolveReady, 200))
        }
        const captureHoldMs = Math.min(
          15_000,
          Math.max(0, Number(process.env.REMIND_ME_SMOKE_HOLD_MS ?? '0'))
        )
        if (captureHoldMs > 0) {
          console.log(`Smoke capture ready; holding the live window for ${captureHoldMs} ms.`)
          await new Promise((resolveReady) => setTimeout(resolveReady, captureHoldMs))
        }
        const image = await window.webContents.capturePage()
        await writeFile(capturePath, image.toPNG())
      }
      clearTimeout(timeout)
      if (bridgeReady !== true)
        console.error('Smoke test loaded, but the preload bridge was not ready.')
      app.exit(bridgeReady === true ? 0 : 1)
    } catch (error) {
      clearTimeout(timeout)
      console.error('Smoke test bridge check failed.', error)
      app.exit(1)
    }
  })
  window.webContents.once('did-fail-load', (_event, errorCode, errorDescription, validatedUrl) => {
    clearTimeout(timeout)
    console.error(`Smoke test failed to load ${validatedUrl}: ${errorCode} ${errorDescription}`)
    app.exit(1)
  })
}

function createMainWindow(preferences: PreferencesEntity): BrowserWindow {
  const appearanceSupport = getAppearanceSupport()
  const window = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 920,
    minHeight: 640,
    show: false,
    title: applicationName,
    icon: app.isPackaged
      ? join(process.resourcesPath, process.platform === 'win32' ? 'app-icon.ico' : 'app-icon.png')
      : resolve(
          app.getAppPath(),
          'resources',
          process.platform === 'win32' ? 'icon.ico' : 'icon.png'
        ),
    autoHideMenuBar: appearanceSupport.windowControlsOverlay,
    ...windowAppearanceOptions(preferences, appearanceSupport),
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: true
    }
  })

  if (appearanceSupport.windowControlsOverlay) window.setMenuBarVisibility(false)
  applyWindowAppearance(window, preferences, appearanceSupport)
  configureWindowSecurity(window)
  if (isDocumentReleaseGate) scheduleDocumentReleaseGate(window)
  else if (isSmokeTest) scheduleSmokeResult(window)
  else window.once('ready-to-show', () => window.show())

  const developmentUrl = process.env.ELECTRON_RENDERER_URL
  if (developmentUrl) void window.loadURL(developmentUrl)
  else void window.loadURL(`${applicationScheme}://${applicationHost}/`)

  return window
}

const hasSingleInstanceLock = isTestRun || app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  let mainWindow: BrowserWindow | null = null
  let repository: SqliteCalendarRepository | null = null
  let notificationScheduler: ReminderNotificationScheduler | null = null
  let voiceRuntime: OfflineVoiceRuntime | null = null
  let flexModelRuntime: OptionalFlexModelRuntime | null = null
  let windowModeController: WindowModeController | null = null

  function requireWindowModeController(): WindowModeController {
    if (!windowModeController) throw new Error('The application window is not ready')
    return windowModeController
  }

  function voiceRuntimePaths(): VoiceRuntimePaths {
    if (app.isPackaged) {
      return {
        workerEntry: join(process.resourcesPath, 'workers', 'asr-worker.cjs'),
        runtimeEntry: join(process.resourcesPath, 'asr-runtime', 'sherpa-onnx', 'index.js'),
        modelRoot: join(process.resourcesPath, 'models')
      }
    }
    const applicationRoot = app.getAppPath()
    return {
      workerEntry: resolve(applicationRoot, 'resources/workers/asr-worker.cjs'),
      runtimeEntry: resolve(
        applicationRoot,
        '../../packages/model-runtime/node_modules/sherpa-onnx/index.js'
      ),
      modelRoot: resolve(applicationRoot, '../../models')
    }
  }

  function flexModelRuntimePaths(): FlexModelRuntimePaths {
    if (app.isPackaged) {
      return {
        workerEntry: join(process.resourcesPath, 'workers', 'flex-model-worker.cjs'),
        runtimeEntry: join(
          process.resourcesPath,
          'app.asar',
          'node_modules',
          'node-llama-cpp',
          'dist',
          'index.js'
        ),
        backendManifest: join(process.resourcesPath, 'llama-backends.json')
      }
    }
    const applicationRoot = app.getAppPath()
    return {
      workerEntry: resolve(applicationRoot, 'resources/workers/flex-model-worker.cjs'),
      runtimeEntry: resolve(applicationRoot, 'node_modules/node-llama-cpp/dist/index.js')
    }
  }

  function localModelRoot(): string {
    return app.isPackaged
      ? join(process.resourcesPath, 'models')
      : resolve(app.getAppPath(), '../../models')
  }

  app.on('second-instance', () => {
    if (!mainWindow) return
    windowModeController?.setMode('full')
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app
    .whenReady()
    .then(async () => {
      await registerApplicationProtocol()
      configureSessionSecurity()
      const databasePath = isTestRun
        ? ':memory:'
        : join(app.getPath('userData'), 'remind-me.sqlite3')
      const openedDatabase = await openCalendarDatabase(databasePath)
      repository = openedDatabase.repository
      const preferences = repository.getPreferences()
      applyLaunchAtLogin(app, preferences)
      const explicitStartupMode = startupModeFromArguments(process.argv)
      const openedAtLogin =
        process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin === true
      const startupMode =
        explicitStartupMode ??
        (openedAtLogin && preferences.launchAtLogin ? preferences.startupWindowMode : null)
      const service = new PersistentCalendarService(repository)
      const localRelease = await loadAndAttestLocalRelease({
        modelRoot: localModelRoot(),
        providerCachePath: isTestRun
          ? null
          : join(app.getPath('userData'), 'release-provider-cache-v1.json')
      })
      flexModelRuntime = new OptionalFlexModelRuntime(
        app.getPath('userData'),
        flexModelRuntimePaths()
      )
      const assistantService = new PersistentAssistantService(
        repository,
        localRelease.planner,
        localRelease.plannerInfo,
        localRelease.speaker,
        localRelease.speakerInfo,
        {
          calendarPlanner: flexModelRuntime,
          generalResponder: flexModelRuntime
        }
      )
      voiceRuntime = new OfflineVoiceRuntime(voiceRuntimePaths(), isTestRun ? 300 : undefined)
      notificationScheduler = new ReminderNotificationScheduler(
        repository,
        () => {
          if (!mainWindow) return
          if (mainWindow.isMinimized()) mainWindow.restore()
          mainWindow.show()
          mainWindow.focus()
        },
        !isTestRun
      )
      registerCalendarIpcHandlers({
        service,
        assistantService,
        repository,
        scheduler: notificationScheduler,
        voiceRuntime,
        flexModelRuntime,
        deleteRecoveryCopies: () => deleteCalendarRecoveryCopies(databasePath),
        validateSender: (event) => validateIpcSender(event.senderFrame),
        appInfo: () => ({
          name: app.getName(),
          version: app.getVersion(),
          platform: process.platform,
          arch: process.arch,
          offlineReady: true,
          appearance: getAppearanceSupport(),
          release: localRelease.release,
          database: openedDatabase.status,
          planner: assistantService.getPlannerInfo(),
          speaker: assistantService.getSpeakerInfo(),
          planScan: localRelease.planScanInfo
        }),
        windowControl: {
          getState: () => requireWindowModeController().getState(),
          setMode: (mode) => requireWindowModeController().setMode(mode),
          setPinned: (pinned) => requireWindowModeController().setPinned(pinned),
          syncLaunchAtLogin: (nextPreferences) => {
            applyLaunchAtLogin(app, nextPreferences)
          },
          syncAppearance: (nextPreferences) => {
            if (mainWindow && !mainWindow.isDestroyed())
              applyWindowAppearance(mainWindow, nextPreferences)
          }
        }
      })
      mainWindow = createMainWindow(preferences)
      windowModeController = new WindowModeController(mainWindow)
      if (startupMode && startupMode !== 'full') windowModeController.setMode(startupMode)
      notificationScheduler.reschedule()

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0 && voiceRuntime) {
          mainWindow = createMainWindow(repository?.getPreferences() ?? preferences)
          windowModeController = new WindowModeController(mainWindow)
        }
      })
    })
    .catch((error: unknown) => {
      console.error('Application startup failed.', error)
      app.exit(1)
    })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    notificationScheduler?.stop()
    voiceRuntime?.dispose()
    void flexModelRuntime?.unload()
    repository?.close()
    notificationScheduler = null
    voiceRuntime = null
    flexModelRuntime = null
    windowModeController = null
    repository = null
  })
}
