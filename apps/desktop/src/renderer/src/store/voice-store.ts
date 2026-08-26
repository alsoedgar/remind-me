import { create } from 'zustand'
import type {
  VoiceProgressEvent,
  VoiceRuntimeInfo,
  VoiceTranscriptionResult
} from '@remind-me/contracts'
import { VoiceRecorder } from '../voice-recorder'
import { useAssistantStore } from './assistant-store'

export type VoiceState = 'idle' | 'requesting' | 'recording' | 'transcribing' | 'ready' | 'error'

interface VoiceStore {
  state: VoiceState
  runtime: VoiceRuntimeInfo | null
  progress: VoiceProgressEvent | null
  level: number
  durationMs: number
  liveTranscript: string
  result: VoiceTranscriptionResult | null
  error: string | null
  warming: boolean
  initialize: () => Promise<void>
  start: () => Promise<void>
  stop: () => Promise<void>
  cancel: () => Promise<void>
  warm: () => Promise<void>
  clearReady: () => void
}

let recorder: VoiceRecorder | null = null
let activeJobId: string | null = null
let requestGeneration = 0
let appendChain: Promise<void> = Promise.resolve()
let appendError: unknown = null

function friendlyVoiceError(error: unknown): string {
  if (!(error instanceof Error)) return 'Voice input ran into a local problem.'
  if (error.name === 'NotAllowedError' || /permission|denied/iu.test(error.message)) {
    return 'Microphone access was not allowed. Enable it for Remind Me in system privacy settings, then try again.'
  }
  if (error.name === 'NotFoundError' || /not found|no device/iu.test(error.message)) {
    return 'No microphone was found. Connect one and try again.'
  }
  return error.message.replace(/^Error invoking remote method '[^']+': Error: /u, '')
}

function makeJobId(): string {
  return `voice:${crypto.randomUUID()}`
}

export const useVoiceStore = create<VoiceStore>((set, get) => ({
  state: 'idle',
  runtime: null,
  progress: null,
  level: 0,
  durationMs: 0,
  liveTranscript: '',
  result: null,
  error: null,
  warming: false,

  initialize: async () => {
    if (get().runtime) return
    try {
      set({ runtime: await window.remindMe.getVoiceInfo() })
    } catch (error) {
      set({ error: friendlyVoiceError(error) })
    }
  },

  start: async () => {
    if (['requesting', 'recording', 'transcribing'].includes(get().state)) return
    requestGeneration += 1
    const generation = requestGeneration
    activeJobId = makeJobId()
    const nextRecorder = new VoiceRecorder()
    recorder = nextRecorder
    set({
      state: 'requesting',
      progress: null,
      level: 0,
      durationMs: 0,
      result: null,
      liveTranscript: '',
      error: null
    })
    try {
      await window.remindMe.startVoiceStream({ jobId: activeJobId, sampleRate: 16_000 })
      appendChain = Promise.resolve()
      appendError = null
      await nextRecorder.start({
        onLevel: (level) => set({ level }),
        onDuration: (durationMs) => set({ durationMs }),
        onMaximumDuration: () => void get().stop(),
        onChunk: (samples) => {
          const jobId = activeJobId
          if (!jobId || generation !== requestGeneration) return
          const buffer = samples.buffer.slice(
            samples.byteOffset,
            samples.byteOffset + samples.byteLength
          ) as ArrayBuffer
          appendChain = appendChain
            .then(async () => {
              await window.remindMe.appendVoiceStream({ jobId, samples: buffer })
            })
            .catch((error) => {
              appendError = error
            })
        }
      })
      if (generation !== requestGeneration) {
        nextRecorder.cancel()
        if (recorder === nextRecorder) recorder = null
        return
      }
      set({ state: 'recording' })
    } catch (error) {
      nextRecorder.cancel()
      if (recorder === nextRecorder) recorder = null
      if (generation !== requestGeneration) return
      if (activeJobId)
        void window.remindMe.cancelVoiceTranscription(activeJobId).catch(() => undefined)
      activeJobId = null
      set({ state: 'error', error: friendlyVoiceError(error), level: 0 })
    }
  },

  stop: async () => {
    if (get().state !== 'recording' || !recorder || !activeJobId) return
    const jobId = activeJobId
    const currentRecorder = recorder
    try {
      const recording = await currentRecorder.stop()
      if (recorder === currentRecorder) recorder = null
      if (activeJobId !== jobId) return
      if (recording.samples.length < 4_000) {
        throw new Error('That recording was too short. Hold for a moment and speak naturally.')
      }
      set({ state: 'transcribing', level: 0, durationMs: recording.durationMs })
      await appendChain
      if (appendError) {
        await window.remindMe.cancelVoiceTranscription(jobId).catch(() => undefined)
      } else {
        await window.remindMe.finishVoiceStream(jobId).catch(() => null)
      }
      // The live stream favors low latency. Re-run the complete, cleaned recording for the
      // editable final transcript so punctuation and calendar terms get the full context.
      const result = await window.remindMe.transcribeVoice({
        jobId,
        sampleRate: 16_000,
        samples: recording.samples.buffer as ArrayBuffer
      })
      if (activeJobId !== jobId) return
      useAssistantStore.getState().setComposer(result.text)
      const runtime = await window.remindMe.getVoiceInfo()
      activeJobId = null
      set({
        state: 'ready',
        result,
        runtime,
        progress: null,
        liveTranscript: result.text,
        error: null
      })
    } catch (error) {
      if (activeJobId !== jobId) return
      await window.remindMe.cancelVoiceTranscription(jobId).catch(() => undefined)
      activeJobId = null
      set({ state: 'error', error: friendlyVoiceError(error), progress: null, level: 0 })
    }
  },

  cancel: async () => {
    requestGeneration += 1
    const jobId = activeJobId
    activeJobId = null
    recorder?.cancel()
    recorder = null
    appendChain = Promise.resolve()
    appendError = null
    set({
      state: 'idle',
      progress: null,
      level: 0,
      durationMs: 0,
      liveTranscript: '',
      result: null,
      error: null
    })
    if (jobId) {
      try {
        await window.remindMe.cancelVoiceTranscription(jobId)
      } catch {
        // The worker may already have finished between the click and this cancellation request.
      }
    }
  },

  warm: async () => {
    if (
      get().warming ||
      activeJobId ||
      ['requesting', 'recording', 'transcribing'].includes(get().state)
    )
      return
    const jobId = makeJobId()
    activeJobId = jobId
    set({ warming: true, error: null })
    try {
      const runtime = await window.remindMe.warmVoiceModel(jobId)
      if (activeJobId === jobId) activeJobId = null
      set({ runtime, warming: false })
    } catch (error) {
      if (activeJobId === jobId) activeJobId = null
      set({ warming: false, error: friendlyVoiceError(error) })
    }
  },

  clearReady: () => {
    if (get().state === 'ready' || get().state === 'error') {
      set({
        state: 'idle',
        progress: null,
        result: null,
        liveTranscript: '',
        error: null,
        durationMs: 0
      })
    }
  }
}))

window.remindMe.onVoiceProgress((progress) => {
  if (progress.jobId !== activeJobId) return
  if (progress.partialText) {
    useAssistantStore.getState().setComposer(progress.partialText)
    useVoiceStore.setState({ progress, liveTranscript: progress.partialText })
  } else {
    useVoiceStore.setState({ progress })
  }
})
