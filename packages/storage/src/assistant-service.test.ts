import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CalendarSnapshotRequest,
  EventForm,
  FlexModelChatRequest,
  FlexModelPlan,
  FlexModelPlanContext,
  FlexModelStatus
} from '@remind-me/contracts'
import { RemindSpeakPlanner } from '@remind-me/model-runtime'
import {
  groundFlexiblePlan,
  PersistentAssistantService,
  type AssistantFallbackServices,
  type FlexibleCalendarPlanner
} from './assistant-service'
import { PersistentCalendarService } from './calendar-service'
import { SqliteCalendarRepository } from './sqlite-repository'

const range: CalendarSnapshotRequest = {
  rangeStartUtc: '2026-01-01T00:00:00.000Z',
  rangeEndUtc: '2027-01-01T00:00:00.000Z'
}

const modelRoot = fileURLToPath(new URL('../../../models/', import.meta.url))

const temporaryDirectories: string[] = []

// These scenarios use September 2026 fixtures; "next" must not depend on the date tests run.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-08-23T17:00:00.000Z'))
})

afterEach(async () => {
  vi.useRealTimers()
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

function overlappingEvent(title: string, startTime: string, endTime: string): EventForm {
  return {
    id: null,
    calendarId: null,
    title,
    description: '',
    location: '',
    startDate: '2026-09-02',
    startTime,
    endDate: '2026-09-02',
    endTime,
    timezone: 'America/Chicago',
    allDay: false,
    recurrence: null
  }
}

function flexiblePlanner(plan: FlexModelPlan): FlexibleCalendarPlanner {
  return { plan: async () => plan }
}

function conversationalPlanner(
  answer: string,
  onChat?: (input: FlexModelChatRequest) => void
): FlexibleCalendarPlanner {
  return {
    plan: async () => null,
    chat: async (input) => {
      onChat?.(input)
      return answer
    }
  }
}

describe('PersistentAssistantService', () => {
  it('creates, confirms, lists and undoes a reminder with no due date', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const assistant = new PersistentAssistantService(repository)
      const exchange = await assistant.send({
        conversationId: null,
        text: 'Remind me to buy oat milk, no due date',
        range
      })
      const proposal = exchange.conversation.activeProposal
      expect(proposal?.payload).toMatchObject({
        kind: 'reminder-save',
        form: { title: 'buy oat milk', dueDate: null, dueTime: null, recurrence: null }
      })
      expect(repository.listReminders()).toHaveLength(0)
      const applied = assistant.confirm({ proposalId: proposal!.id, range })
      expect(applied.snapshot.reminders[0]).toMatchObject({ title: 'buy oat milk', dueAtUtc: null })
      expect(repository.listPendingReminderNotifications()).toHaveLength(0)
      const listed = await assistant.send({
        conversationId: exchange.conversation.id,
        text: 'Show my reminders without due dates',
        range
      })
      expect(listed.response.text).toContain('buy oat milk')
      expect(listed.response.relatedReminderIds).toEqual([applied.snapshot.reminders[0]?.id])
      new PersistentCalendarService(repository).undoLastAction(range)
      expect(repository.listReminders()).toHaveLength(0)
    } finally {
      repository.close()
    }
  })

  it('accepts no due date as the answer to a missing reminder time without asking again', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const assistant = new PersistentAssistantService(repository)
      const first = await assistant.send({
        conversationId: null,
        text: 'Remind me to call Mom tomorrow',
        range
      })
      expect(first.response.kind).toBe('clarification')
      const next = await assistant.send({
        conversationId: first.conversation.id,
        text: 'no due date',
        range
      })
      expect(next.conversation.activeProposal?.payload).toMatchObject({
        kind: 'reminder-save',
        form: { title: 'call Mom', dueDate: null, dueTime: null }
      })
      expect(repository.listReminders()).toHaveLength(0)
    } finally {
      repository.close()
    }
  })
  it('uses grounded RemindSpeak candidates without repeating an equivalent recent answer', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const speaker = await RemindSpeakPlanner.load(modelRoot)
      const assistant = new PersistentAssistantService(
        repository,
        null,
        null,
        speaker,
        speaker.info
      )
      const first = await assistant.send({
        conversationId: null,
        text: 'What do I have on September 8, 2026?',
        range
      })
      const second = await assistant.send({
        conversationId: first.conversation.id,
        text: 'What do I have on September 8, 2026?',
        range
      })
      const emptyScheduleLanguage =
        /(?:nothing|no (?:plans|events|calendar items)|clear|open|quiet|breathing room|time is yours)/iu
      expect(first.response.text).toMatch(emptyScheduleLanguage)
      expect(second.response.text).toMatch(emptyScheduleLanguage)
      expect(second.response.text).not.toBe(first.response.text)
    } finally {
      repository.close()
    }
  })

  it('learns bounded phrase preferences locally without storing reply facts', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const speaker = await RemindSpeakPlanner.load(modelRoot)
      const assistant = new PersistentAssistantService(
        repository,
        null,
        null,
        speaker,
        speaker.info
      )
      const exchange = await assistant.send({ conversationId: null, text: 'Hello', range })
      const reply = [...exchange.conversation.turns]
        .reverse()
        .find((turn) => turn.role === 'assistant' && turn.requestId !== null)
      expect(exchange.response.feedbackEligible).toBe(true)
      expect(reply?.requestId).toBeTruthy()

      const helpful = assistant.rateReply({
        conversationId: exchange.conversation.id,
        requestId: reply?.requestId ?? '',
        rating: 'helpful'
      })
      expect(helpful).toMatchObject({ accepted: true, learnedPreferences: 1 })
      const learned = repository.getPreferences().responseAdaptation
      expect(learned.feedbackCount).toBe(1)
      expect(learned.entries).toHaveLength(1)
      expect(learned.entries[0]).toMatchObject({ speechAct: 'conversation-answer', score: 1 })
      expect(Object.keys(learned.entries[0] ?? {}).sort()).toEqual([
        'score',
        'speechAct',
        'templateFingerprint',
        'updatedAt'
      ])

      assistant.rateReply({
        conversationId: exchange.conversation.id,
        requestId: reply?.requestId ?? '',
        rating: 'unhelpful'
      })
      expect(repository.getPreferences().responseAdaptation).toMatchObject({
        feedbackCount: 1,
        entries: [{ speechAct: 'conversation-answer', score: -1 }]
      })

      assistant.clearConversation(exchange.conversation.id)
      expect(
        assistant.rateReply({
          conversationId: exchange.conversation.id,
          requestId: reply?.requestId ?? '',
          rating: 'helpful'
        }).accepted
      ).toBe(false)
    } finally {
      repository.close()
    }
  })

  it('persists a proposal, applies it only after review, answers, and undoes it', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      let assistant = new PersistentAssistantService(repository)
      const preview = await assistant.send({
        conversationId: null,
        text: 'Remind me to call Mom on September 2, 2026 at 6 PM',
        range
      })
      expect(preview.response.kind).toBe('preview')
      expect(preview.snapshot.reminders).toEqual([])
      expect(preview.conversation.activeProposal?.payload).toMatchObject({
        kind: 'reminder-save',
        form: { title: 'call Mom', dueDate: '2026-09-02', dueTime: '18:00' }
      })

      assistant = new PersistentAssistantService(repository)
      const restored = assistant.getConversation(preview.conversation.id)
      expect(restored.activeProposal?.id).toBe(preview.conversation.activeProposal?.id)
      expect(restored.turns.some((turn) => turn.text.includes('call Mom'))).toBe(true)

      const proposal = restored.activeProposal
      if (!proposal) throw new Error('Expected a persisted proposal')
      const applied = assistant.confirm({ proposalId: proposal.id, range })
      expect(applied.response.kind).toBe('receipt')
      expect(applied.conversation.activeProposal).toBeNull()
      expect(applied.snapshot.reminders).toMatchObject([
        { title: 'call Mom', provenance: 'assistant', status: 'active' }
      ])

      const answer = await assistant.send({
        conversationId: applied.conversation.id,
        text: 'What do I have on September 2, 2026?',
        range
      })
      expect(answer.response.kind).toBe('answer')
      expect(answer.response.text).toContain('call Mom')

      const undone = await assistant.send({
        conversationId: applied.conversation.id,
        text: 'undo that',
        range
      })
      expect(undone.response.kind).toBe('receipt')
      expect(undone.snapshot.reminders).toEqual([])
      expect(undone.conversation.turns.at(-1)?.text).toMatch(/Undid/u)
    } finally {
      repository.close()
    }
  })

  it('keeps conversation turns and pending review across a database restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'remind-me-assistant-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'calendar.sqlite3')

    const firstRepository = new SqliteCalendarRepository(databasePath)
    const preview = await new PersistentAssistantService(firstRepository).send({
      conversationId: null,
      text: 'Schedule dentist on September 2, 2026 at 10 AM',
      range
    })
    const proposalId = preview.conversation.activeProposal?.id
    firstRepository.close()

    const reopenedRepository = new SqliteCalendarRepository(databasePath)
    try {
      const assistant = new PersistentAssistantService(reopenedRepository)
      const restored = assistant.getConversation(preview.conversation.id)
      expect(restored.activeProposal?.id).toBe(proposalId)
      expect(restored.turns.map((turn) => turn.role)).toEqual(['assistant', 'user', 'assistant'])
      if (!proposalId) throw new Error('Expected a proposal id')
      expect(assistant.confirm({ proposalId, range }).snapshot.events[0]?.title).toBe('dentist')
    } finally {
      reopenedRepository.close()
    }
  }, 15_000)

  it('answers availability and conflict questions from expanded calendar facts', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const calendar = new PersistentCalendarService(repository)
      calendar.saveEvent(overlappingEvent('Design review', '14:00', '15:30'), range)
      calendar.saveEvent(overlappingEvent('Project sync', '15:00', '16:00'), range)
      const assistant = new PersistentAssistantService(repository)

      const availability = await assistant.send({
        conversationId: null,
        text: 'Am I free on September 2, 2026 from 2 PM to 4 PM?',
        range
      })
      expect(availability.response.kind).toBe('answer')
      expect(availability.response.text).toContain('Design review')
      expect(availability.response.relatedEventIds).toHaveLength(2)

      const followUp = await assistant.send({
        conversationId: availability.conversation.id,
        text: 'How about September 3, 2026?',
        range
      })
      expect(followUp.response.kind).toBe('answer')
      expect(followUp.response.text).toMatch(/free|open|available|clear/iu)

      const conflicts = await assistant.send({
        conversationId: followUp.conversation.id,
        text: 'Any conflicts on September 2, 2026?',
        range
      })
      expect(conflicts.response.kind).toBe('answer')
      expect(conflicts.response.text).toContain('Design review')
      expect(conflicts.response.text).toContain('Project sync')
    } finally {
      repository.close()
    }
  })

  it('summarizes a day with time ranges, locations, notes, and focused event details', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const calendar = new PersistentCalendarService(repository)
      calendar.saveEvent(
        {
          ...overlappingEvent('Design review', '14:00', '15:30'),
          location: 'Studio B',
          description: 'Bring the accessibility prototype and research notes.'
        },
        range
      )
      calendar.saveEvent(overlappingEvent('Project sync', '16:00', '17:00'), range)
      const assistant = new PersistentAssistantService(repository)

      const summary = await assistant.send({
        conversationId: null,
        text: 'Summarize September 2, 2026 with details',
        range
      })
      expect(summary.response.kind).toBe('answer')
      expect(summary.response.text).toContain('Design review')
      expect(summary.response.text).toContain('Studio B')
      expect(summary.response.text).toContain('accessibility prototype')
      expect(summary.response.text).toMatch(/2:00\s*PM.*3:30\s*PM/iu)

      const location = await assistant.send({
        conversationId: summary.conversation.id,
        text: 'Where is Design review?',
        range
      })
      expect(location.response.kind).toBe('answer')
      expect(location.response.text).toContain('Studio B')

      const placeSearch = await assistant.send({
        conversationId: location.conversation.id,
        text: 'Find Studio B',
        range
      })
      expect(placeSearch.response.kind).toBe('answer')
      expect(placeSearch.response.text).toContain('Design review')

      const wholeDay = await assistant.send({
        conversationId: placeSearch.conversation.id,
        text: 'Am I free on September 2, 2026?',
        range
      })
      expect(wholeDay.response.text).toContain('Design review')
      expect(wholeDay.response.text).toContain('Studio B')
      expect(wholeDay.response.text).not.toMatch(/12:00\s*AM to 12:00\s*AM/iu)
    } finally {
      repository.close()
    }
  })

  it('answers ordinary schedule questions with names only and expands on request', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const calendar = new PersistentCalendarService(repository)
      calendar.saveEvent(
        {
          ...overlappingEvent('Design review', '14:00', '15:30'),
          location: 'Studio B',
          description: 'Bring the accessibility prototype.'
        },
        range
      )
      calendar.saveEvent(overlappingEvent('Project sync', '16:00', '17:00'), range)
      calendar.saveEvent(overlappingEvent('Data Structures', '18:00', '19:00'), range)
      calendar.saveEvent(overlappingEvent('Programming Practicum', '20:00', '21:00'), range)
      const assistant = new PersistentAssistantService(repository)

      const compact = await assistant.send({
        conversationId: null,
        text: 'What do I have on September 2, 2026?',
        range
      })
      expect(compact.response.text).toBe(
        'Design review, Project sync, Data Structures, and Programming Practicum.'
      )
      expect(compact.response.text).not.toMatch(/PM|Studio B|item|scheduled day/iu)

      const details = await assistant.send({
        conversationId: compact.conversation.id,
        text: 'more',
        range
      })
      expect(details.response.text).toContain('Studio B')
      expect(details.response.text).toContain('accessibility prototype')
      expect(details.response.text).toMatch(/2:00\s*PM.*3:30\s*PM/iu)

      const next = await assistant.send({
        conversationId: details.conversation.id,
        text: "What's next?",
        range
      })
      expect(next.response.text).toBe('Design review.')
      expect(next.response.relatedEventIds).toHaveLength(1)
    } finally {
      repository.close()
    }
  })

  it('keeps a typed item focus for singular read and mutation follow-ups', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const calendar = new PersistentCalendarService(repository)
      calendar.saveEvent(
        {
          ...overlappingEvent('Design review', '14:00', '15:30'),
          location: 'Studio B',
          description: 'Bring the prototype.'
        },
        range
      )
      const assistant = new PersistentAssistantService(repository)
      const next = await assistant.send({
        conversationId: null,
        text: "What's my next event?",
        range
      })
      const focusedId = next.response.relatedEventIds[0]
      expect(focusedId).toBeTruthy()
      expect(next.conversation.dialogueState.focusedEventIds).toEqual([focusedId])

      const location = await assistant.send({
        conversationId: next.conversation.id,
        text: 'Where is it?',
        range
      })
      expect(location.response.kind).toBe('answer')
      expect(location.response.text).toContain('Studio B')
      expect(location.response.text).toContain('Design review')

      const move = await assistant.send({
        conversationId: location.conversation.id,
        text: 'Move that one to September 4, 2026 at 3 PM',
        range
      })
      expect(move.conversation.activeProposal).toMatchObject({
        operation: 'event.move',
        payload: {
          kind: 'event-save',
          form: {
            id: focusedId,
            title: 'Design review',
            startDate: '2026-09-04',
            startTime: '15:00'
          }
        }
      })
    } finally {
      repository.close()
    }
  })

  it('answers ordinal class questions and concise contextual detail follow-ups', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-02T12:00:00.000Z'))
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const calendar = new PersistentCalendarService(repository)
      calendar.saveEvent(overlappingEvent('Breakfast with Maya', '08:00', '08:30'), range)
      calendar.saveEvent(
        {
          ...overlappingEvent('CS 251 lecture', '09:00', '09:50'),
          location: 'SEO 1000',
          description: 'Bring the lab worksheet.'
        },
        range
      )
      calendar.saveEvent(
        {
          ...overlappingEvent('Calculus III', '11:00', '11:50'),
          location: 'SES 130'
        },
        range
      )
      const assistant = new PersistentAssistantService(repository)

      const first = await assistant.send({
        conversationId: null,
        text: '  whats my frist claas today? ',
        range
      })
      expect(first.response.kind).toBe('answer')
      expect(first.response.text).toBe('CS 251 lecture.')
      expect(first.response.relatedEventIds).toHaveLength(1)
      const firstState = repository.getAssistantDialogueState(first.conversation.id)
      const firstFrame = firstState.queryFrames.find(
        (frame) => frame.frameId === firstState.activeQueryFrameId
      )
      expect(firstFrame?.orderedItems).toHaveLength(2)
      expect(firstFrame?.selectedItems).toHaveLength(1)
      expect(firstFrame?.resultCursor).toBe(0)

      const room = await assistant.send({
        conversationId: first.conversation.id,
        text: 'in what room?',
        range
      })
      expect(room.response.text).toBe('CS 251 lecture — SEO 1000.')
      expect(room.response.relatedEventIds).toEqual(first.response.relatedEventIds)

      const start = await assistant.send({
        conversationId: room.conversation.id,
        text: 'when does it start?',
        range
      })
      expect(start.response.text).toMatch(/^CS 251 lecture — 9:00\s*AM\.$/iu)

      const duration = await assistant.send({
        conversationId: start.conversation.id,
        text: 'how long does it last?',
        range
      })
      expect(duration.response.text).toBe('CS 251 lecture — 50 minutes.')

      const notes = await assistant.send({
        conversationId: duration.conversation.id,
        text: 'what should I bring?',
        range
      })
      expect(notes.response.text).toBe('CS 251 lecture — Bring the lab worksheet.')

      const second = await assistant.send({
        conversationId: notes.conversation.id,
        text: "what's my second class today?",
        range
      })
      expect(second.response.text).toBe('Calculus III.')
      const secondState = repository.getAssistantDialogueState(second.conversation.id)
      const secondFrame = secondState.queryFrames.find(
        (frame) => frame.frameId === secondState.activeQueryFrameId
      )
      expect(secondFrame?.orderedItems).toHaveLength(2)
      expect(secondFrame?.selectedItems).toHaveLength(1)
      expect(secondFrame?.resultCursor).toBe(1)

      const secondRoom = await assistant.send({
        conversationId: second.conversation.id,
        text: 'where is that one?',
        range
      })
      expect(secondRoom.response.text).toBe('Calculus III — SES 130.')

      const secondDetails = await assistant.send({
        conversationId: secondRoom.conversation.id,
        text: 'tell me more about the second one',
        range
      })
      expect(secondDetails.response.text).toContain('Calculus III')
      expect(secondDetails.response.text).toContain('SES 130')
      expect(secondDetails.response.text).toMatch(/11:00\s*AM–11:50\s*AM/iu)
    } finally {
      repository.close()
      vi.useRealTimers()
    }
  })

  it('answers plural class-time follow-ups from the exact prior calendar results', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-02T12:00:00.000Z'))
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const calendar = new PersistentCalendarService(repository)
      calendar.saveEvent(overlappingEvent('Applied Linear Algebra', '12:00', '12:50'), range)
      calendar.saveEvent(overlappingEvent('Calculus III', '13:00', '13:50'), range)
      calendar.saveEvent(overlappingEvent('Data Structures', '14:00', '14:50'), range)
      calendar.saveEvent(overlappingEvent('Programming Practicum', '15:00', '15:50'), range)
      let flexibleChatCalls = 0
      const assistant = new PersistentAssistantService(
        repository,
        null,
        null,
        null,
        null,
        conversationalPlanner('Some times were not specified.', () => {
          flexibleChatCalls += 1
        })
      )

      let exchange = await assistant.send({
        conversationId: null,
        text: 'What do I have today?',
        range
      })
      expect(exchange.response.relatedEventIds).toHaveLength(4)

      for (const text of [
        'At what times do i have these classes?',
        'What are their times?',
        'Can you give me the times for those classes?',
        'When are they?'
      ]) {
        exchange = await assistant.send({
          conversationId: exchange.conversation.id,
          text,
          range
        })
        expect(exchange.response.kind).toBe('answer')
        expect(exchange.response.relatedEventIds).toHaveLength(4)
        expect(exchange.response.text).toMatch(/“Applied Linear Algebra” — 12:00\s*PM–12:50\s*PM/iu)
        expect(exchange.response.text).toMatch(/“Calculus III” — 1:00\s*PM–1:50\s*PM/iu)
        expect(exchange.response.text).toMatch(/“Data Structures” — 2:00\s*PM–2:50\s*PM/iu)
        expect(exchange.response.text).toMatch(/“Programming Practicum” — 3:00\s*PM–3:50\s*PM/iu)
        expect(exchange.response.text).not.toMatch(/not specified/iu)
      }
      expect(flexibleChatCalls).toBe(0)
    } finally {
      repository.close()
      vi.useRealTimers()
    }
  })

  it('keeps ordered occurrence frames across topic switches and earlier result sets', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const calendar = new PersistentCalendarService(repository)
      calendar.saveEvent(overlappingEvent('Design review', '14:00', '15:00'), range)
      calendar.saveEvent(
        {
          ...overlappingEvent('Project sync', '10:00', '11:00'),
          startDate: '2026-09-03',
          endDate: '2026-09-03'
        },
        range
      )
      const assistant = new PersistentAssistantService(repository)
      let exchange = await assistant.send({
        conversationId: null,
        text: 'What do I have on September 2, 2026?',
        range
      })
      const firstFrameId = exchange.conversation.dialogueState.activeQueryFrameId
      expect(exchange.conversation.dialogueState.queryFrames).toHaveLength(1)
      expect(exchange.conversation.dialogueState.queryFrames[0]?.orderedItems).toEqual([
        {
          kind: 'event',
          id: exchange.response.relatedEventIds[0],
          occurrenceStart: '2026-09-02T19:00:00.000Z'
        }
      ])

      exchange = await assistant.send({
        conversationId: exchange.conversation.id,
        text: 'hello',
        range
      })
      expect(exchange.conversation.dialogueState.activeQueryFrameId).toBe(firstFrameId)
      exchange = await assistant.send({
        conversationId: exchange.conversation.id,
        text: 'what times?',
        range
      })
      expect(exchange.response.text).toMatch(/Design review — 2:00\s*PM–3:00\s*PM/iu)

      exchange = await assistant.send({
        conversationId: exchange.conversation.id,
        text: 'What do I have on September 3, 2026?',
        range
      })
      expect(exchange.conversation.dialogueState.queryFrames).toHaveLength(2)
      expect(exchange.response.text).toBe('Project sync.')
      exchange = await assistant.send({
        conversationId: exchange.conversation.id,
        text: 'what times for the previous results?',
        range
      })
      expect(exchange.response.text).toMatch(/Design review — 2:00\s*PM–3:00\s*PM/iu)
      expect(exchange.conversation.dialogueState.activeQueryFrameId).toBe(firstFrameId)
    } finally {
      repository.close()
    }
  })

  it('retains repeated occurrences and mixed item ordering in a query frame', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-02T12:00:00.000Z'))
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const calendar = new PersistentCalendarService(repository)
      calendar.saveEvent(
        {
          ...overlappingEvent('CS 251 lecture', '09:00', '09:50'),
          recurrence: {
            frequency: 'weekly',
            interval: 1,
            byWeekday: ['wednesday', 'friday'],
            byMonthDay: [],
            end: { kind: 'until', date: '2026-09-05' }
          }
        },
        range
      )
      calendar.saveReminder(
        {
          id: null,
          calendarId: null,
          title: 'Submit worksheet',
          notes: '',
          dueDate: '2026-09-03',
          dueTime: '12:00',
          timezone: 'America/Chicago',
          recurrence: null
        },
        range
      )
      const assistant = new PersistentAssistantService(repository)
      let exchange = await assistant.send({
        conversationId: null,
        text: 'What do I have this week?',
        range
      })
      const frame = exchange.conversation.dialogueState.queryFrames[0]
      expect(frame?.orderedItems.map((item) => item.kind)).toEqual(['event', 'reminder', 'event'])
      expect(frame?.orderedItems[0]?.id).toBe(frame?.orderedItems[2]?.id)
      expect(frame?.orderedItems[0]?.occurrenceStart).not.toBe(
        frame?.orderedItems[2]?.occurrenceStart
      )

      exchange = await assistant.send({
        conversationId: exchange.conversation.id,
        text: 'what times?',
        range
      })
      expect(exchange.response.text.match(/CS 251 lecture/gu)).toHaveLength(2)
      expect(exchange.response.text).toContain('Submit worksheet')
      expect(exchange.conversation.dialogueState.queryFrames[0]?.selectedItems).toHaveLength(3)
    } finally {
      repository.close()
      vi.useRealTimers()
    }
  })

  it('answers assignment, exam, and due-date questions from local calendar data', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-02T12:00:00.000Z'))
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const calendar = new PersistentCalendarService(repository)
      calendar.saveReminder(
        {
          id: null,
          calendarId: null,
          title: 'Section 13.3',
          notes: 'Canvas assignment · Calculus III',
          dueDate: '2026-09-03',
          dueTime: '12:00',
          timezone: 'America/Chicago',
          recurrence: null
        },
        range
      )
      calendar.saveReminder(
        {
          id: null,
          calendarId: null,
          title: 'CS 251 Exam 1',
          notes: 'Canvas assignment · Data Structures',
          dueDate: '2026-09-07',
          dueTime: '15:00',
          timezone: 'America/Chicago',
          recurrence: null
        },
        range
      )
      calendar.saveReminder(
        {
          id: null,
          calendarId: null,
          title: 'Pick up groceries',
          notes: '',
          dueDate: '2026-09-03',
          dueTime: '11:00',
          timezone: 'America/Chicago',
          recurrence: null
        },
        range
      )
      calendar.saveEvent(
        {
          ...overlappingEvent('Concert review', '09:00', '10:00'),
          description: 'Canvas assignment · MUS 114',
          startDate: '2026-09-04',
          endDate: '2026-09-04'
        },
        range
      )
      const assistant = new PersistentAssistantService(repository)

      let exchange = await assistant.send({
        conversationId: null,
        text: 'What assignments are coming up?',
        range
      })
      expect(exchange.response.text).toContain('Section 13.3')
      expect(exchange.response.text).toContain('CS 251 Exam 1')
      expect(exchange.response.text).toContain('Concert review')
      expect(exchange.response.text).not.toContain('Pick up groceries')

      exchange = await assistant.send({
        conversationId: exchange.conversation.id,
        text: 'What exams are coming up?',
        range
      })
      expect(exchange.response.text).toContain('CS 251 Exam 1')
      expect(exchange.response.text).not.toContain('Section 13.3')
      expect(exchange.response.text).not.toContain('Concert review')

      exchange = await assistant.send({
        conversationId: exchange.conversation.id,
        text: 'Do I have anything due tomorrow?',
        range
      })
      expect(exchange.response.text).toContain('Section 13.3')
      expect(exchange.response.text).toContain('Pick up groceries')
      expect(exchange.response.text).not.toContain('CS 251 Exam 1')
    } finally {
      repository.close()
      vi.useRealTimers()
    }
  })

  it('paginates a large mixed schedule with a persisted continuation cursor', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-02T12:00:00.000Z'))
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const calendar = new PersistentCalendarService(repository)
      for (let index = 0; index < 9; index += 1) {
        const hour = 8 + (index % 6)
        const date = index < 6 ? '2026-09-02' : '2026-09-03'
        calendar.saveEvent(
          {
            ...overlappingEvent(
              `Course ${index + 1}`,
              `${String(hour).padStart(2, '0')}:00`,
              `${String(hour).padStart(2, '0')}:50`
            ),
            startDate: date,
            endDate: date
          },
          range
        )
      }
      for (let index = 0; index < 2; index += 1) {
        calendar.saveReminder(
          {
            id: null,
            calendarId: null,
            title: `Reminder ${index + 1}`,
            notes: '',
            dueDate: '2026-09-03',
            dueTime: `${14 + index}:00`,
            timezone: 'America/Chicago',
            recurrence: null
          },
          range
        )
      }
      const assistant = new PersistentAssistantService(repository)
      let exchange = await assistant.send({
        conversationId: null,
        text: 'What do I have this week?',
        range
      })
      expect(exchange.response.text).toContain('Showing 1–8 of 11.')
      expect(exchange.response.text).toContain('Say “continue” for the next 3.')
      expect(exchange.response.text).toContain('Wednesday, September 2:')
      expect(exchange.response.text).toContain('Thursday, September 3:')
      expect(exchange.conversation.dialogueState.queryFrames[0]?.continuationCursor).toBe(8)

      exchange = await assistant.send({
        conversationId: exchange.conversation.id,
        text: 'continue',
        range
      })
      expect(exchange.response.text).toContain('Showing 9–11 of 11.')
      expect(exchange.response.text).toContain('Reminder 1')
      expect(exchange.response.text).toContain('Reminder 2')
      expect(exchange.response.text).not.toContain('Course 1;')
      expect(exchange.conversation.dialogueState.queryFrames[0]?.continuationCursor).toBeNull()

      exchange = await assistant.send({
        conversationId: exchange.conversation.id,
        text: 'next page',
        range
      })
      expect(exchange.response.kind).toBe('clarification')
      expect(exchange.response.text).toBe('That result is already fully shown.')
    } finally {
      repository.close()
      vi.useRealTimers()
    }
  })

  it('resumes a grounded result page after a database restart', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-02T12:00:00.000Z'))
    const directory = await mkdtemp(join(tmpdir(), 'remind-me-answer-page-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'calendar.sqlite3')
    const firstRepository = new SqliteCalendarRepository(databasePath)
    const calendar = new PersistentCalendarService(firstRepository)
    for (let index = 0; index < 9; index += 1) {
      const hour = 8 + index
      calendar.saveEvent(
        overlappingEvent(
          `Restart item ${index + 1}`,
          `${String(hour).padStart(2, '0')}:00`,
          `${String(hour).padStart(2, '0')}:30`
        ),
        range
      )
    }
    const first = await new PersistentAssistantService(firstRepository).send({
      conversationId: null,
      text: 'What do I have today?',
      range
    })
    expect(first.conversation.dialogueState.queryFrames[0]?.continuationCursor).toBe(8)
    firstRepository.close()

    const reopenedRepository = new SqliteCalendarRepository(databasePath)
    try {
      const continued = await new PersistentAssistantService(reopenedRepository).send({
        conversationId: first.conversation.id,
        text: 'continue',
        range
      })
      expect(continued.response.text).toContain('Restart item 9')
      expect(continued.response.text).toContain('Showing 9–9 of 9.')
      expect(continued.conversation.dialogueState.queryFrames[0]?.continuationCursor).toBeNull()
    } finally {
      reopenedRepository.close()
      vi.useRealTimers()
    }
  })

  it('distinguishes duplicate titles and cleanly reports all-day and missing-location facts', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-02T12:00:00.000Z'))
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const calendar = new PersistentCalendarService(repository)
      calendar.saveEvent(overlappingEvent('Studio', '09:00', '10:00'), range)
      calendar.saveEvent(overlappingEvent('Studio', '13:00', '14:00'), range)
      calendar.saveEvent(
        {
          ...overlappingEvent('Department holiday', '09:00', '10:00'),
          startTime: null,
          endTime: null,
          allDay: true
        },
        range
      )
      const assistant = new PersistentAssistantService(repository)
      let exchange = await assistant.send({
        conversationId: null,
        text: 'What do I have today?',
        range
      })
      expect(exchange.response.text.match(/Studio/gu)).toHaveLength(2)
      expect(exchange.response.text).toMatch(/Studio \(.+9:00\s*AM\)/u)
      expect(exchange.response.text).toMatch(/Studio \(.+1:00\s*PM\)/u)

      exchange = await assistant.send({
        conversationId: exchange.conversation.id,
        text: 'what times are all of them?',
        range
      })
      expect(exchange.response.text).toContain('“Department holiday” — all day')

      exchange = await assistant.send({
        conversationId: exchange.conversation.id,
        text: 'where are all of them?',
        range
      })
      expect(exchange.response.text.match(/no room or location saved/gu)).toHaveLength(3)
    } finally {
      repository.close()
      vi.useRealTimers()
    }
  })

  it('answers for the others, restores all results, and groups class summaries', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-02T12:00:00.000Z'))
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const calendar = new PersistentCalendarService(repository)
      calendar.saveEvent(overlappingEvent('CS 251 lecture', '09:00', '09:50'), range)
      calendar.saveEvent(overlappingEvent('Calculus III', '11:00', '11:50'), range)
      calendar.saveEvent(overlappingEvent('Doctor appointment', '15:00', '16:00'), range)
      const assistant = new PersistentAssistantService(repository)
      let exchange = await assistant.send({
        conversationId: null,
        text: 'What is my first event today?',
        range
      })
      expect(exchange.response.text).toBe('CS 251 lecture.')

      exchange = await assistant.send({
        conversationId: exchange.conversation.id,
        text: 'what about the others?',
        range
      })
      expect(exchange.response.text).toContain('Calculus III')
      expect(exchange.response.text).toContain('Doctor appointment')
      expect(exchange.response.text).not.toContain('CS 251 lecture')

      exchange = await assistant.send({
        conversationId: exchange.conversation.id,
        text: 'show all of them',
        range
      })
      expect(exchange.response.relatedEventIds).toHaveLength(3)
      expect(exchange.response.text).toContain('CS 251 lecture')

      exchange = await assistant.send({
        conversationId: exchange.conversation.id,
        text: 'summarize my classes',
        range
      })
      expect(exchange.response.text).toContain('Wednesday, September 2:')
      expect(exchange.response.text).toContain('CS 251 lecture')
      expect(exchange.response.text).toContain('Calculus III')
      expect(exchange.response.text).not.toContain('Doctor appointment')
    } finally {
      repository.close()
      vi.useRealTimers()
    }
  })

  it('prunes a deleted focused item while answering the remaining verified facts', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-02T12:00:00.000Z'))
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const calendar = new PersistentCalendarService(repository)
      calendar.saveEvent(overlappingEvent('Design review', '09:00', '10:00'), range)
      calendar.saveEvent(overlappingEvent('Project sync', '11:00', '12:00'), range)
      const assistant = new PersistentAssistantService(repository)
      let exchange = await assistant.send({
        conversationId: null,
        text: 'What do I have today?',
        range
      })
      const deletedId = repository.listEvents().find((event) => event.title === 'Design review')?.id
      if (!deletedId) throw new Error('Expected Design review')
      calendar.deleteEvent(deletedId, range)

      exchange = await assistant.send({
        conversationId: exchange.conversation.id,
        text: 'where are all of them?',
        range
      })
      expect(exchange.response.kind).toBe('answer')
      expect(exchange.response.text).toContain('Project sync — no room or location saved')
      expect(exchange.response.text).not.toContain('Design review')
      expect(exchange.response.relatedEventIds).toHaveLength(1)
      expect(exchange.conversation.dialogueState.queryFrames[0]?.selectedItems).toHaveLength(1)
    } finally {
      repository.close()
      vi.useRealTimers()
    }
  })

  it('keeps the exact anything-tomorrow to what-times regression on the native path', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-02T12:00:00.000Z'))
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const calendar = new PersistentCalendarService(repository)
      const tomorrow = (title: string, startTime: string, endTime: string): EventForm => ({
        ...overlappingEvent(title, startTime, endTime),
        startDate: '2026-09-03',
        endDate: '2026-09-03'
      })
      calendar.saveEvent(tomorrow('Linear Algebra', '09:00', '09:50'), range)
      calendar.saveEvent(tomorrow('Data Structures', '11:00', '11:50'), range)
      let flexibleChatCalls = 0
      const assistant = new PersistentAssistantService(
        repository,
        null,
        null,
        null,
        null,
        conversationalPlanner('This should stay on the native path.', () => {
          flexibleChatCalls += 1
        })
      )

      const tomorrowAnswer = await assistant.send({
        conversationId: null,
        text: 'do I have anything tomorrow?',
        range
      })
      const timesAnswer = await assistant.send({
        conversationId: tomorrowAnswer.conversation.id,
        text: 'what times?',
        range
      })

      expect(tomorrowAnswer.response.relatedEventIds).toHaveLength(2)
      expect(timesAnswer.response.kind).toBe('answer')
      expect(timesAnswer.response.text).toMatch(/“Linear Algebra” — 9:00\s*AM–9:50\s*AM/iu)
      expect(timesAnswer.response.text).toMatch(/“Data Structures” — 11:00\s*AM–11:50\s*AM/iu)
      expect(assistant.getExecutionTraces().at(-1)).toMatchObject({
        route: 'calendar',
        contextFrame: 'last-query',
        fallbackWorkload: 'none',
        fallbackReason: 'not-needed',
        truncated: false
      })
      expect(flexibleChatCalls).toBe(0)
    } finally {
      repository.close()
      vi.useRealTimers()
    }
  })

  it.each([
    {
      label: 'installed',
      status: { state: 'ready', enabled: true, error: null, lastRequest: null },
      chat: async () => 'A small break can make the next study block easier.',
      expected: 'answered'
    },
    {
      label: 'disabled',
      status: { state: 'installed', enabled: false, error: null, lastRequest: null },
      chat: async () => null,
      expected: 'disabled'
    },
    {
      label: 'missing',
      status: { state: 'not-installed', enabled: false, error: null, lastRequest: null },
      chat: async () => null,
      expected: 'missing'
    },
    {
      label: 'timed out',
      status: { state: 'ready', enabled: true, error: null, lastRequest: null },
      chat: async () => {
        throw new Error('Local model inference timed out.')
      },
      expected: 'timeout'
    },
    {
      label: 'invalid output',
      status: { state: 'ready', enabled: true, error: null, lastRequest: null },
      chat: async () => '   ',
      expected: 'invalid-output'
    }
  ])(
    'records the $label fallback state without prompt contents',
    async ({ status, chat, expected }) => {
      const repository = new SqliteCalendarRepository(':memory:')
      try {
        const planner: FlexibleCalendarPlanner = {
          plan: async () => null,
          chat,
          getStatus: async () =>
            status as Pick<FlexModelStatus, 'state' | 'enabled' | 'error' | 'lastRequest'>
        }
        const assistant = new PersistentAssistantService(
          repository,
          null,
          null,
          null,
          null,
          planner
        )
        const privatePrompt = 'Write a friendly thought about learning watercolor'

        await assistant.send({ conversationId: null, text: privatePrompt, range })
        const trace = assistant.getLastExecutionTrace()

        expect(trace).toMatchObject({
          schemaVersion: 1,
          route: 'broad-chat',
          contextFrame: 'none',
          fallbackWorkload: 'chat',
          fallbackReason: expected,
          truncated: false
        })
        expect(trace?.latencyMs).toBeGreaterThanOrEqual(0)
        expect(JSON.stringify(trace)).not.toContain(privatePrompt)
      } finally {
        repository.close()
      }
    }
  )

  it('keeps general conversation on the responder side of the fallback boundary', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const planCalendar = vi.fn(async () => ({ kind: 'not-calendar' as const }))
      const respondGeneral = vi.fn(async () => ({
        kind: 'answer' as const,
        text: 'Start with one small study win and let momentum build from there.',
        factRefs: [],
        writeClaim: false
      }))
      const fallbacks: AssistantFallbackServices = {
        calendarPlanner: { planCalendar },
        generalResponder: { respondGeneral }
      }
      const assistant = new PersistentAssistantService(
        repository,
        null,
        null,
        null,
        null,
        fallbacks
      )

      const result = await assistant.send({
        conversationId: null,
        text: 'Write one warm sentence about studying',
        range
      })

      expect(result.response).toMatchObject({
        kind: 'answer',
        text: 'Start with one small study win and let momentum build from there.'
      })
      expect(respondGeneral).toHaveBeenCalledTimes(1)
      expect(planCalendar).not.toHaveBeenCalled()
      expect(assistant.getLastExecutionTrace()).toMatchObject({
        route: 'broad-chat',
        fallbackWorkload: 'chat',
        fallbackReason: 'answered'
      })
    } finally {
      repository.close()
    }
  })

  it('returns a useful answer envelope for an explicit offline limitation', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const fallbacks: AssistantFallbackServices = {
        calendarPlanner: { planCalendar: async () => ({ kind: 'not-calendar' }) },
        generalResponder: {
          respondGeneral: async () => ({
            kind: 'offline-limit',
            text: 'I cannot verify live weather while offline. Please check a current source.',
            factRefs: [],
            writeClaim: false
          })
        }
      }
      const assistant = new PersistentAssistantService(
        repository,
        null,
        null,
        null,
        null,
        fallbacks
      )

      const result = await assistant.send({
        conversationId: null,
        text: 'What is the live weather right now?',
        range
      })

      expect(result.response).toMatchObject({
        kind: 'answer',
        text: 'I cannot verify live weather while offline. Please check a current source.'
      })
      expect(assistant.getLastExecutionTrace()).toMatchObject({
        fallbackWorkload: 'chat',
        fallbackReason: 'offline-limit'
      })
    } finally {
      repository.close()
    }
  })

  it('resolves at least 99 percent of a broad benign installed-fallback matrix', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const respondGeneral = vi.fn(async () => ({
        kind: 'answer' as const,
        text: 'Start with one small step, then adjust the plan to what feels useful.',
        factRefs: [],
        writeClaim: false
      }))
      const assistant = new PersistentAssistantService(repository, null, null, null, null, {
        calendarPlanner: { planCalendar: async () => ({ kind: 'not-calendar' }) },
        generalResponder: { respondGeneral }
      })
      const openings = [
        'Help me think through',
        'Give me a practical thought about',
        'How should I approach',
        'Can we talk about'
      ]
      const topics = [
        'starting a difficult assignment',
        'keeping a calm morning routine',
        'breaking a large goal into steps',
        'staying focused during a long week',
        'preparing for a thoughtful conversation',
        'making an unfamiliar task less intimidating',
        'balancing rest with steady progress',
        'reflecting on what worked today'
      ]
      const tones = [
        'briefly',
        'in a warm way',
        'with one useful suggestion',
        'without overexplaining'
      ]
      const requests = openings.flatMap((opening) =>
        topics.flatMap((topic) => tones.map((tone) => `${opening} ${topic}, ${tone}.`))
      )
      let resolved = 0
      for (const text of requests) {
        const result = await assistant.send({ conversationId: null, text, range })
        if (!['unsupported', 'error'].includes(result.response.kind)) resolved += 1
        expect(result.snapshot.events).toHaveLength(0)
        expect(result.snapshot.reminders).toHaveLength(0)
      }

      expect(requests).toHaveLength(128)
      expect(resolved / requests.length).toBeGreaterThanOrEqual(0.99)
      expect(respondGeneral).toHaveBeenCalledTimes(requests.length)
    } finally {
      repository.close()
    }
  })

  it('accepts calendar mutations only from a grounded structured fallback plan', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const text = 'Give me a nudge to call Mom on September 7, 2026 at 6 PM'
      const planCalendar = vi.fn(async () => ({
        kind: 'plan' as const,
        plan: {
          actions: [
            {
              sourceText: text,
              operation: 'reminder.create' as const,
              titleText: 'call Mom',
              targetText: null
            }
          ]
        }
      }))
      const respondGeneral = vi.fn(async () => ({
        kind: 'answer' as const,
        text: 'Done, I added that reminder.',
        factRefs: [],
        writeClaim: true
      }))
      const fallbacks: AssistantFallbackServices = {
        calendarPlanner: { planCalendar },
        generalResponder: { respondGeneral }
      }
      const assistant = new PersistentAssistantService(
        repository,
        null,
        null,
        null,
        null,
        fallbacks
      )

      const result = await assistant.send({ conversationId: null, text, range })

      expect(result.response.kind).toBe('preview')
      expect(result.conversation.activeProposal?.payload).toMatchObject({
        kind: 'reminder-save',
        form: { title: 'call Mom', dueDate: '2026-09-07', dueTime: '18:00' }
      })
      expect(planCalendar).toHaveBeenCalledTimes(1)
      expect(respondGeneral).not.toHaveBeenCalled()
      expect(result.snapshot.reminders).toEqual([])
    } finally {
      repository.close()
    }
  })

  it.each([
    'not-calendar',
    'missing',
    'disabled',
    'timeout',
    'unavailable',
    'invalid-output'
  ] as const)(
    'does not substitute free-form chat when calendar planning returns %s',
    async (kind) => {
      const repository = new SqliteCalendarRepository(':memory:')
      try {
        const text =
          'Could you add guitar practice for the ninth day of September at half past two in the afternoon?'
        const planCalendar = vi.fn(async () => ({ kind }))
        const respondGeneral = vi.fn(async () => ({
          kind: 'answer' as const,
          text: 'Done, I added that reminder.',
          factRefs: [],
          writeClaim: true
        }))
        const fallbacks: AssistantFallbackServices = {
          calendarPlanner: { planCalendar },
          generalResponder: { respondGeneral }
        }
        const assistant = new PersistentAssistantService(
          repository,
          null,
          null,
          null,
          null,
          fallbacks
        )

        const result = await assistant.send({ conversationId: null, text, range })

        expect(result.response.kind).toBe('clarification')
        expect(result.response.text).not.toMatch(/done, i added/iu)
        expect(result.conversation.activeProposal).toBeNull()
        expect(result.snapshot.events).toEqual([])
        expect(result.snapshot.reminders).toEqual([])
        expect(respondGeneral).not.toHaveBeenCalled()
        expect(assistant.getLastExecutionTrace()).toMatchObject({
          route: 'calendar',
          fallbackWorkload: 'plan',
          fallbackReason: kind
        })
      } finally {
        repository.close()
      }
    }
  )

  it('returns the typed general-runtime limitation without entering calendar planning', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const planCalendar = vi.fn(async () => ({ kind: 'not-calendar' as const }))
      const respondGeneral = vi.fn(async () => ({ kind: 'disabled' as const }))
      const assistant = new PersistentAssistantService(repository, null, null, null, null, {
        calendarPlanner: { planCalendar },
        generalResponder: { respondGeneral }
      })

      const result = await assistant.send({
        conversationId: null,
        text: 'Explain a simple way to stay motivated',
        range
      })

      expect(result.response.kind).toBe('unsupported')
      expect(result.response.text).toMatch(/language pack is disabled/iu)
      expect(respondGeneral).toHaveBeenCalledTimes(1)
      expect(planCalendar).not.toHaveBeenCalled()
      expect(assistant.getLastExecutionTrace()?.fallbackReason).toBe('disabled')
    } finally {
      repository.close()
    }
  })

  it('restores dialogue focus across an application restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'remind-me-dialogue-state-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'calendar.sqlite3')
    const firstRepository = new SqliteCalendarRepository(databasePath)
    const calendar = new PersistentCalendarService(firstRepository)
    calendar.saveEvent(
      { ...overlappingEvent('Design review', '14:00', '15:30'), location: 'Studio B' },
      range
    )
    const firstAssistant = new PersistentAssistantService(firstRepository)
    const next = await firstAssistant.send({ conversationId: null, text: "What's next?", range })
    const focusedId = next.response.relatedEventIds[0]
    firstRepository.close()

    const reopenedRepository = new SqliteCalendarRepository(databasePath)
    try {
      const assistant = new PersistentAssistantService(reopenedRepository)
      const restored = assistant.getConversation(next.conversation.id)
      expect(restored.dialogueState.focusedEventIds).toEqual([focusedId])
      const location = await assistant.send({
        conversationId: restored.id,
        text: 'Where is that one?',
        range
      })
      expect(location.response.kind).toBe('answer')
      expect(location.response.text).toContain('Studio B')
    } finally {
      reopenedRepository.close()
    }
  })

  it('expands a plural dialogue focus into one atomic reviewed batch', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const calendar = new PersistentCalendarService(repository)
      calendar.saveEvent(overlappingEvent('Design review', '14:00', '15:30'), range)
      calendar.saveEvent(overlappingEvent('Project sync', '16:00', '17:00'), range)
      const assistant = new PersistentAssistantService(repository)
      const day = await assistant.send({
        conversationId: null,
        text: 'What do I have on September 2, 2026?',
        range
      })
      expect(day.conversation.dialogueState.focusedEventIds).toHaveLength(2)

      const deletion = await assistant.send({
        conversationId: day.conversation.id,
        text: 'Delete both of those',
        range
      })
      expect(deletion.response.kind).toBe('preview')
      expect(deletion.conversation.activeProposal).toMatchObject({
        risk: 'destructive',
        payload: {
          kind: 'batch',
          items: [{ kind: 'event-delete' }, { kind: 'event-delete' }]
        }
      })
      expect(deletion.snapshot.events).toHaveLength(2)
    } finally {
      repository.close()
    }
  })

  it('uses an ordinal follow-up to target one exact duplicate-titled event', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const calendar = new PersistentCalendarService(repository)
      calendar.saveEvent(overlappingEvent('Office hours', '10:00', '11:00'), range)
      calendar.saveEvent(overlappingEvent('Office hours', '15:00', '16:00'), range)
      const assistant = new PersistentAssistantService(repository)
      const day = await assistant.send({
        conversationId: null,
        text: 'What do I have on September 2, 2026?',
        range
      })
      const focusedIds = day.conversation.dialogueState.focusedEventIds
      expect(focusedIds).toHaveLength(2)

      const deletion = await assistant.send({
        conversationId: day.conversation.id,
        text: 'Delete the second one',
        range
      })

      expect(deletion.response.kind).toBe('preview')
      expect(deletion.conversation.activeProposal?.payload).toEqual({
        kind: 'event-delete',
        id: focusedIds[1]
      })
      expect(deletion.snapshot.events).toHaveLength(2)
    } finally {
      repository.close()
    }
  })

  it('expands an ordinal subset into one exact atomic mutation batch', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const calendar = new PersistentCalendarService(repository)
      calendar.saveEvent(overlappingEvent('Morning class', '09:00', '10:00'), range)
      calendar.saveEvent(overlappingEvent('Lunch', '12:00', '13:00'), range)
      calendar.saveEvent(overlappingEvent('Evening class', '16:00', '17:00'), range)
      const assistant = new PersistentAssistantService(repository)
      const day = await assistant.send({
        conversationId: null,
        text: 'What do I have on September 2, 2026?',
        range
      })
      const focusedIds = day.conversation.dialogueState.focusedEventIds
      expect(focusedIds).toHaveLength(3)

      const deletion = await assistant.send({
        conversationId: day.conversation.id,
        text: 'Delete the first and third ones',
        range
      })

      expect(deletion.response.kind).toBe('preview')
      expect(deletion.conversation.activeProposal?.payload).toMatchObject({
        kind: 'batch',
        items: [
          { kind: 'event-delete', id: focusedIds[0] },
          { kind: 'event-delete', id: focusedIds[2] }
        ]
      })
      expect(deletion.snapshot.events).toHaveLength(3)
    } finally {
      repository.close()
    }
  })

  it('uses a descriptive time follow-up to move the exact focused event', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const calendar = new PersistentCalendarService(repository)
      calendar.saveEvent(overlappingEvent('Office hours', '09:00', '10:00'), range)
      calendar.saveEvent(overlappingEvent('Office hours', '15:00', '16:00'), range)
      const assistant = new PersistentAssistantService(repository)
      const day = await assistant.send({
        conversationId: null,
        text: 'What do I have on September 2, 2026?',
        range
      })
      const focusedIds = day.conversation.dialogueState.focusedEventIds
      expect(focusedIds).toHaveLength(2)

      const moved = await assistant.send({
        conversationId: day.conversation.id,
        text: 'Move the 3 PM one to September 4, 2026 at 4 PM',
        range
      })

      expect(moved.response.kind).toBe('preview')
      expect(moved.conversation.activeProposal?.payload).toMatchObject({
        kind: 'event-save',
        form: {
          id: focusedIds[1],
          title: 'Office hours',
          startDate: '2026-09-04',
          startTime: '16:00',
          endTime: '17:00'
        }
      })
      expect(moved.snapshot.events).toHaveLength(2)

      const deletion = await assistant.send({
        conversationId: moved.conversation.id,
        text: 'Delete the 3 PM one',
        range
      })
      expect(deletion.response.kind).toBe('preview')
      expect(deletion.conversation.activeProposal?.payload).toEqual({
        kind: 'event-delete',
        id: focusedIds[1]
      })
      expect(deletion.snapshot.events).toHaveLength(2)
    } finally {
      repository.close()
    }
  })

  it('expands descriptive focused subsets into exact atomic bulk changes', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const calendar = new PersistentCalendarService(repository)
      calendar.saveEvent(
        { ...overlappingEvent('Study block', '09:00', '10:00'), location: 'Studio B' },
        range
      )
      calendar.saveEvent(
        { ...overlappingEvent('Standup', '10:00', '10:30'), location: 'Studio B' },
        range
      )
      calendar.saveEvent(overlappingEvent('Lunch', '12:00', '13:00'), range)
      let fallbackPlanCalls = 0
      const assistant = new PersistentAssistantService(repository, null, null, null, null, {
        plan: async () => {
          fallbackPlanCalls += 1
          return null
        }
      })
      const day = await assistant.send({
        conversationId: null,
        text: 'What do I have on September 2, 2026?',
        range
      })
      const focusedIds = day.conversation.dialogueState.focusedEventIds
      expect(focusedIds).toHaveLength(3)

      const moved = await assistant.send({
        conversationId: day.conversation.id,
        text: 'Move the morning ones to September 4, 2026',
        range
      })
      expect(moved.response.kind).toBe('preview')
      expect(moved.conversation.activeProposal?.payload).toMatchObject({
        kind: 'batch',
        items: [
          {
            kind: 'event-save',
            form: { id: focusedIds[0], startDate: '2026-09-04', startTime: '09:00' }
          },
          {
            kind: 'event-save',
            form: { id: focusedIds[1], startDate: '2026-09-04', startTime: '10:00' }
          }
        ]
      })
      expect(moved.snapshot.events).toHaveLength(3)

      const deleted = await assistant.send({
        conversationId: moved.conversation.id,
        text: 'Delete the ones in Studio B',
        range
      })
      expect(deleted.response.kind).toBe('preview')
      expect(deleted.conversation.activeProposal?.payload).toMatchObject({
        kind: 'batch',
        items: [
          { kind: 'event-delete', id: focusedIds[0] },
          { kind: 'event-delete', id: focusedIds[1] }
        ]
      })
      expect(deleted.snapshot.events).toHaveLength(3)
      expect(fallbackPlanCalls).toBe(0)
    } finally {
      repository.close()
    }
  })

  it('persists and completes a focused clarification instead of restarting the request', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const assistant = new PersistentAssistantService(repository)
      const missingTime = await assistant.send({
        conversationId: null,
        text: 'Schedule dentist on September 2, 2026',
        range
      })
      expect(missingTime.response.kind).toBe('clarification')
      expect(missingTime.conversation.dialogueState.pendingClarification).toMatchObject({
        code: 'missing-time',
        sourceText: 'schedule dentist on september 2, 2026'
      })

      const completed = await assistant.send({
        conversationId: missingTime.conversation.id,
        text: '3 PM',
        range
      })
      expect(completed.response.kind).toBe('preview')
      expect(completed.conversation.dialogueState.pendingClarification).toBeNull()
      expect(completed.conversation.activeProposal?.payload).toMatchObject({
        kind: 'event-save',
        form: { title: 'dentist', startDate: '2026-09-02', startTime: '15:00' }
      })
    } finally {
      repository.close()
    }
  })

  it('turns an affirmed reminder time range into a reviewable calendar event', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const planCalendar = vi.fn(async () => ({ kind: 'not-calendar' as const }))
      const assistant = new PersistentAssistantService(repository, null, null, null, null, {
        calendarPlanner: { planCalendar },
        generalResponder: null
      })
      const ambiguous = await assistant.send({
        conversationId: null,
        text: 'add a reminder for my calc III exam on oct 1st at 6:30-7:30pm',
        range
      })
      expect(ambiguous.response.kind).toBe('clarification')
      expect(ambiguous.conversation.dialogueState.pendingClarification).toMatchObject({
        code: 'unsupported-expression',
        options: ['Create calendar events']
      })

      const converted = await assistant.send({
        conversationId: ambiguous.conversation.id,
        text: 'yes',
        range
      })
      expect(converted.response.kind).toBe('preview')
      expect(converted.response.text).not.toMatch(/cannot create calendar events/iu)
      expect(converted.conversation.dialogueState.pendingClarification).toBeNull()
      expect(converted.conversation.activeProposal?.payload).toMatchObject({
        kind: 'event-save',
        form: {
          title: 'calc III exam',
          startDate: '2026-10-01',
          startTime: '18:30',
          endTime: '19:30'
        }
      })
      expect(converted.snapshot.events).toHaveLength(0)
      expect(planCalendar).not.toHaveBeenCalled()
    } finally {
      repository.close()
    }
  })

  it('lets a user decline a pending clarification without handing it to broad chat', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const assistant = new PersistentAssistantService(repository)
      const ambiguous = await assistant.send({
        conversationId: null,
        text: 'remind me about office hours on October 1 from 2-3pm',
        range
      })
      expect(ambiguous.response.kind).toBe('clarification')

      const declined = await assistant.send({
        conversationId: ambiguous.conversation.id,
        text: 'no thanks',
        range
      })
      expect(declined.response.kind).toBe('answer')
      expect(declined.response.text).toContain('nothing was saved')
      expect(declined.conversation.dialogueState.pendingClarification).toBeNull()
      expect(declined.conversation.activeProposal).toBeNull()
    } finally {
      repository.close()
    }
  })

  it('uses a clarification choice to resolve an ambiguous destructive target', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const calendar = new PersistentCalendarService(repository)
      calendar.saveEvent(overlappingEvent('Project review east', '14:00', '15:00'), range)
      calendar.saveEvent(overlappingEvent('Project review west', '16:00', '17:00'), range)
      const assistant = new PersistentAssistantService(repository)
      const ambiguous = await assistant.send({
        conversationId: null,
        text: 'Delete project review',
        range
      })
      expect(ambiguous.response.kind).toBe('clarification')
      expect(ambiguous.conversation.dialogueState.pendingClarification).toMatchObject({
        code: 'multiple-targets',
        options: ['Project review east', 'Project review west']
      })

      const selected = await assistant.send({
        conversationId: ambiguous.conversation.id,
        text: 'the second one',
        range
      })
      expect(selected.response.kind).toBe('preview')
      expect(selected.conversation.activeProposal?.payload).toMatchObject({
        kind: 'event-delete'
      })
      expect(selected.response.text).toContain('Project review west')
      expect(selected.snapshot.events).toHaveLength(2)
    } finally {
      repository.close()
    }
  })

  it('clears focused entities with the dialogue and refuses a stale pronoun', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      new PersistentCalendarService(repository).saveEvent(
        overlappingEvent('Design review', '14:00', '15:30'),
        range
      )
      const assistant = new PersistentAssistantService(repository)
      const next = await assistant.send({ conversationId: null, text: "What's next?", range })
      expect(next.conversation.dialogueState.focusedEventIds).toHaveLength(1)

      const cleared = assistant.clearConversation(next.conversation.id)
      expect(cleared.dialogueState.focusedEventIds).toEqual([])
      expect(cleared.dialogueState.lastQuery).toBeNull()
      const stale = await assistant.send({
        conversationId: cleared.id,
        text: 'Where is it?',
        range
      })
      expect(stale.response.kind).toBe('clarification')
      expect(stale.response.text).toMatch(/couldn't find|which/iu)
      expect(stale.conversation.activeProposal).toBeNull()
    } finally {
      repository.close()
    }
  })

  it('repairs typing mistakes and spacing without changing free-form titles', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const calendar = new PersistentCalendarService(repository)
      calendar.saveEvent(
        {
          ...overlappingEvent('Design review', '14:00', '15:30'),
          location: 'Studio B'
        },
        range
      )
      const assistant = new PersistentAssistantService(repository)

      const greeting = await assistant.send({ conversationId: null, text: 'helo', range })
      expect(greeting.response.kind).toBe('answer')
      expect(greeting.response.text).toMatch(/hello|hi|hey|ready|help with your time/iu)

      const search = await assistant.send({
        conversationId: greeting.conversation.id,
        text: '  wher   is   Desgin   reveiw ? ',
        range
      })
      expect(search.response.kind).toBe('answer')
      expect(search.response.text).toContain('Design review')
      expect(search.response.text).toContain('Studio B')

      const move = await assistant.send({
        conversationId: search.conversation.id,
        text: 'mvoe Desgin reveiw to Wednsday at 3 p m',
        range
      })
      expect(move.conversation.activeProposal).toMatchObject({
        operation: 'event.move',
        payload: {
          kind: 'event-save',
          form: { title: 'Design review', startTime: '15:00' }
        }
      })
      const moveProposal = move.conversation.activeProposal
      if (!moveProposal) throw new Error('Expected a typo-tolerant move proposal')
      const moved = await assistant.send({
        conversationId: move.conversation.id,
        text: 'confim',
        range
      })
      expect(moved.response.kind).toBe('receipt')

      const create = await assistant.send({
        conversationId: moved.conversation.id,
        text: 'can yuo ad Teh Helo Meetup to morrow at 2 p m',
        range
      })
      expect(create.conversation.activeProposal?.payload).toMatchObject({
        kind: 'event-save',
        form: { title: 'Teh Helo Meetup', startTime: '14:00' }
      })
    } finally {
      repository.close()
    }
  })

  it('keeps typo-tolerant whole-calendar deletion behind an exact counted review', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const calendar = new PersistentCalendarService(repository)
      calendar.saveEvent(overlappingEvent('Design review', '14:00', '15:30'), range)
      calendar.saveReminder(
        {
          id: null,
          calendarId: null,
          title: 'Water plants',
          notes: '',
          dueDate: '2026-09-02',
          dueTime: '18:00',
          timezone: 'America/Chicago',
          recurrence: null
        },
        range
      )
      const preview = await new PersistentAssistantService(repository).send({
        conversationId: null,
        text: 'cler all evnts and remidners',
        range
      })
      expect(preview.conversation.activeProposal?.payload).toMatchObject({
        kind: 'bulk-delete',
        scope: 'both',
        eventIds: [expect.any(String)],
        reminderIds: [expect.any(String)]
      })
      expect(preview.snapshot.events).toHaveLength(1)
      expect(preview.snapshot.reminders).toHaveLength(1)
    } finally {
      repository.close()
    }
  })

  it('stages coordinated conversational event requests as one atomic review', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const preview = await new PersistentAssistantService(repository).send({
        conversationId: null,
        text: 'can you add my CS 251 lab for tmr at 1pm, and my Calc III discussion at 2pm?',
        range
      })
      expect(preview.response.kind).toBe('preview')
      expect(preview.conversation.activeProposal?.payload).toMatchObject({
        kind: 'batch',
        items: [
          { kind: 'event-save', form: { title: 'CS 251 lab', startTime: '13:00' } },
          { kind: 'event-save', form: { title: 'Calc III discussion', startTime: '14:00' } }
        ]
      })
      expect(preview.snapshot.events).toEqual([])
    } finally {
      repository.close()
    }
  })

  it('routes shared-date and structured-list requests into complete atomic batches', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const assistant = new PersistentAssistantService(repository)
      const sharedDate = await assistant.send({
        conversationId: null,
        text: 'schedule tutoring tomorrow at 4 pm and dinner at 7 pm',
        range
      })
      expect(sharedDate.conversation.activeProposal?.payload).toMatchObject({
        kind: 'batch',
        items: [
          { kind: 'event-save', form: { title: 'tutoring', startTime: '16:00' } },
          { kind: 'event-save', form: { title: 'dinner', startTime: '19:00' } }
        ]
      })

      const structured = await assistant.send({
        conversationId: sharedDate.conversation.id,
        text: 'Add these:\n- gym tomorrow at 7 am\n- advising tomorrow at 1 pm\n- study group tomorrow at 6 pm',
        range
      })
      expect(structured.conversation.activeProposal?.payload).toMatchObject({
        kind: 'batch',
        items: [
          { kind: 'event-save', form: { title: 'gym', startTime: '07:00' } },
          { kind: 'event-save', form: { title: 'advising', startTime: '13:00' } },
          { kind: 'event-save', form: { title: 'study group', startTime: '18:00' } }
        ]
      })
    } finally {
      repository.close()
    }
  })

  it('routes bounded colloquial move and delete language through normal review', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const calendar = new PersistentCalendarService(repository)
      calendar.saveEvent(overlappingEvent('Project sync', '10:00', '11:00'), range)
      calendar.saveEvent(overlappingEvent('Old appointment', '12:00', '13:00'), range)
      const assistant = new PersistentAssistantService(repository)

      const move = await assistant.send({
        conversationId: null,
        text: 'push Project sync tomorrow to 3 pm',
        range
      })
      expect(move.conversation.activeProposal).toMatchObject({
        operation: 'event.move',
        payload: {
          kind: 'event-save',
          form: { title: 'Project sync', startTime: '15:00' }
        }
      })
      await assistant.send({ conversationId: move.conversation.id, text: 'no', range })

      const deletion = await assistant.send({
        conversationId: move.conversation.id,
        text: 'get rid of Old appointment',
        range
      })
      expect(deletion.conversation.activeProposal).toMatchObject({
        operation: 'event.delete',
        payload: { kind: 'event-delete' }
      })
      expect(deletion.snapshot.events).toHaveLength(2)
    } finally {
      repository.close()
    }
  })

  it('keeps broad talk useful and date-scoped clearing out of global deletion', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-24T17:00:00.000Z'))
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      new PersistentCalendarService(repository).saveEvent(
        overlappingEvent('Final exam', '13:00', '15:00'),
        range
      )
      const assistant = new PersistentAssistantService(repository)
      const greeting = await assistant.send({ conversationId: null, text: 'hey there', range })
      expect(greeting.response).toMatchObject({ kind: 'answer' })
      expect(greeting.response.text).toMatch(/help|ready|here/iu)

      const encouragement = await assistant.send({
        conversationId: greeting.conversation.id,
        text: 'Give me a quick motivational thought for studying',
        range
      })
      expect(encouragement.response.kind).toBe('answer')
      expect(encouragement.response.text.split(/\s+/u).length).toBeLessThanOrEqual(45)

      const reflection = await assistant.send({
        conversationId: greeting.conversation.id,
        text: 'What should I focus on next week based on my calendar?',
        range
      })
      expect(reflection.response.kind).toBe('answer')
      expect(reflection.response.text).toContain('Final exam')

      const scopedClear = await assistant.send({
        conversationId: greeting.conversation.id,
        text: 'clear everything tomorrow',
        range
      })
      expect(scopedClear.response.kind).toBe('clarification')
      expect(scopedClear.conversation.activeProposal).toBeNull()
      expect(scopedClear.snapshot.events).toHaveLength(1)
      expect(scopedClear.conversation.dialogueState.pendingClarification?.code).toBe(
        'unclear-scope'
      )
    } finally {
      repository.close()
      vi.useRealTimers()
    }
  })

  it('stages exact named groups for move, completion, and removal as atomic batches', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const calendar = new PersistentCalendarService(repository)
      calendar.saveEvent(overlappingEvent('Design review', '14:00', '15:30'), range)
      calendar.saveEvent(overlappingEvent('Project sync', '16:00', '17:00'), range)
      for (const [title, dueTime] of [
        ['Water plants', '18:00'],
        ['Submit report', '19:00']
      ] as const) {
        calendar.saveReminder(
          {
            id: null,
            calendarId: null,
            title,
            notes: '',
            dueDate: '2026-09-02',
            dueTime,
            timezone: 'America/Chicago',
            recurrence: null
          },
          range
        )
      }
      const assistant = new PersistentAssistantService(repository)

      const move = await assistant.send({
        conversationId: null,
        text: 'Move Design review and Project sync to September 4, 2026 at 1 PM',
        range
      })
      expect(move.conversation.activeProposal?.payload).toMatchObject({
        kind: 'batch',
        items: [
          { kind: 'event-save', form: { title: 'Design review', startDate: '2026-09-04' } },
          { kind: 'event-save', form: { title: 'Project sync', startDate: '2026-09-04' } }
        ]
      })
      const moveProposal = move.conversation.activeProposal
      if (!moveProposal) throw new Error('Expected a grouped move proposal')
      const moved = assistant.confirm({ proposalId: moveProposal.id, range })

      const complete = await assistant.send({
        conversationId: moved.conversation.id,
        text: 'Mark Water plants and Submit report done',
        range
      })
      expect(complete.conversation.activeProposal?.payload).toMatchObject({
        kind: 'batch',
        items: [{ kind: 'reminder-complete' }, { kind: 'reminder-complete' }]
      })
      const completeProposal = complete.conversation.activeProposal
      if (!completeProposal) throw new Error('Expected a grouped completion proposal')
      const completed = assistant.confirm({ proposalId: completeProposal.id, range })
      expect(
        completed.snapshot.reminders.every((reminder) => reminder.status === 'completed')
      ).toBe(true)

      const remove = await assistant.send({
        conversationId: completed.conversation.id,
        text: 'Delete Design review and Project sync',
        range
      })
      expect(remove.conversation.activeProposal?.payload).toMatchObject({
        kind: 'batch',
        items: [{ kind: 'event-delete' }, { kind: 'event-delete' }]
      })
      const removeProposal = remove.conversation.activeProposal
      if (!removeProposal) throw new Error('Expected a grouped removal proposal')
      expect(assistant.confirm({ proposalId: removeProposal.id, range }).snapshot.events).toEqual(
        []
      )
    } finally {
      repository.close()
    }
  })

  it('repairs misspelled titles before staging a selected destructive group', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const calendar = new PersistentCalendarService(repository)
      calendar.saveEvent(overlappingEvent('Design review', '14:00', '15:30'), range)
      calendar.saveEvent(overlappingEvent('Project sync', '16:00', '17:00'), range)
      const preview = await new PersistentAssistantService(repository).send({
        conversationId: null,
        text: 'de lete Desgin reveiw and Projet sycn',
        range
      })
      expect(preview.conversation.activeProposal?.payload).toMatchObject({
        kind: 'batch',
        items: [{ kind: 'event-delete' }, { kind: 'event-delete' }]
      })
      expect(preview.snapshot.events).toHaveLength(2)
    } finally {
      repository.close()
    }
  })

  it('clarifies ambiguous writes and never stages or applies them', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const assistant = new PersistentAssistantService(repository)
      const ambiguousTime = await assistant.send({
        conversationId: null,
        text: 'Book dinner tomorrow at 6',
        range
      })
      expect(ambiguousTime.response.kind).toBe('clarification')
      expect(ambiguousTime.conversation.activeProposal).toBeNull()
      expect(ambiguousTime.snapshot.events).toEqual([])

      const unknownTarget = await assistant.send({
        conversationId: ambiguousTime.conversation.id,
        text: 'Delete quarterly review',
        range
      })
      expect(unknownTarget.response.kind).toBe('clarification')
      expect(unknownTarget.snapshot.events).toEqual([])
    } finally {
      repository.close()
    }
  })

  it('stages an inclusive multi-day event with the correct review dates', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const preview = await new PersistentAssistantService(repository).send({
        conversationId: null,
        text: 'Add conference from September 2 through September 4, 2026',
        range
      })
      expect(preview.conversation.activeProposal?.payload).toMatchObject({
        kind: 'event-save',
        form: {
          title: 'conference',
          startDate: '2026-09-02',
          endDate: '2026-09-04',
          allDay: true
        }
      })
      expect(preview.snapshot.events).toEqual([])
    } finally {
      repository.close()
    }
  })

  it('supports typed confirmation and edit commands through the same proposal engine', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const assistant = new PersistentAssistantService(repository)
      const preview = await assistant.send({
        conversationId: null,
        text: 'Schedule team sync on September 2, 2026 at 9 AM',
        range
      })
      const applied = await assistant.send({
        conversationId: preview.conversation.id,
        text: 'looks good',
        range
      })
      expect(applied.snapshot.events[0]?.title).toBe('team sync')

      const renamePreview = await assistant.send({
        conversationId: applied.conversation.id,
        text: 'Rename team sync to planning session',
        range
      })
      expect(renamePreview.conversation.activeProposal?.operation).toBe('event.update')
      const renameProposal = renamePreview.conversation.activeProposal
      if (!renameProposal) throw new Error('Expected rename proposal')
      const renamed = assistant.confirm({ proposalId: renameProposal.id, range })
      expect(renamed.snapshot.events[0]?.title).toBe('planning session')
    } finally {
      repository.close()
    }
  })

  it('reviews and applies multiple events and reminders as one atomic undoable batch', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const assistant = new PersistentAssistantService(repository)
      const preview = await assistant.send({
        conversationId: null,
        text: 'Schedule dentist on September 2, 2026 at 10 AM; remind me to call Mom on September 3, 2026 at 6 PM',
        range
      })
      expect(preview.response.kind).toBe('preview')
      expect(preview.conversation.activeProposal?.payload).toMatchObject({
        kind: 'batch',
        items: [
          { kind: 'event-save', form: { title: 'dentist' } },
          { kind: 'reminder-save', form: { title: 'call Mom' } }
        ]
      })
      expect(preview.snapshot.events).toEqual([])
      expect(preview.snapshot.reminders).toEqual([])

      const proposal = preview.conversation.activeProposal
      if (!proposal) throw new Error('Expected a batch proposal')
      const applied = assistant.confirm({ proposalId: proposal.id, range })
      expect(applied.snapshot.events.map((event) => event.title)).toEqual(['dentist'])
      expect(applied.snapshot.reminders.map((reminder) => reminder.title)).toEqual(['call Mom'])

      const undone = await assistant.send({
        conversationId: applied.conversation.id,
        text: 'undo that',
        range
      })
      expect(undone.snapshot.events).toEqual([])
      expect(undone.snapshot.reminders).toEqual([])
    } finally {
      repository.close()
    }
  })

  it('replaces a pending batch when the user corrects one reviewed item', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const fallbackPlan = vi.fn(async () => null)
      const assistant = new PersistentAssistantService(repository, null, null, null, null, {
        plan: fallbackPlan
      })
      const preview = await assistant.send({
        conversationId: null,
        text: 'Schedule CS 251 lab on September 2, 2026 at 1 PM; schedule Calculus III discussion on September 2, 2026 at 2 PM; schedule study group on September 2, 2026 at 3 PM',
        range
      })
      const original = preview.conversation.activeProposal
      if (!original) throw new Error('Expected an original batch proposal')
      fallbackPlan.mockClear()

      const revised = await assistant.send({
        conversationId: preview.conversation.id,
        text: 'Actually, make the secnd one 4 PM',
        range
      })

      expect(revised.response.kind).toBe('preview')
      expect(revised.conversation.activeProposal?.id).not.toBe(original.id)
      expect(revised.conversation.activeProposal?.sourceText).toContain(
        'Review correction: Actually, make the secnd one 4 PM'
      )
      expect(revised.conversation.activeProposal?.sourceText).toContain(
        'Schedule CS 251 lab on September 2, 2026 at 1 PM'
      )
      expect(revised.conversation.activeProposal?.payload).toMatchObject({
        kind: 'batch',
        items: [
          { kind: 'event-save', form: { title: 'CS 251 lab', startTime: '13:00' } },
          {
            kind: 'event-save',
            form: { title: 'Calculus III discussion', startTime: '16:00', endTime: '17:00' }
          },
          { kind: 'event-save', form: { title: 'study group', startTime: '15:00' } }
        ]
      })
      expect(repository.getAssistantProposal(original.id)?.status).toBe('rejected')
      expect(() => assistant.confirm({ proposalId: original.id, range })).toThrow(
        'already been handled'
      )
      expect(revised.snapshot.events).toEqual([])
      expect(fallbackPlan).not.toHaveBeenCalled()

      const replacement = revised.conversation.activeProposal
      if (!replacement) throw new Error('Expected a replacement proposal')
      const applied = assistant.confirm({ proposalId: replacement.id, range })
      expect(applied.snapshot.events.map((event) => event.title)).toEqual([
        'CS 251 lab',
        'study group',
        'Calculus III discussion'
      ])
      expect(
        applied.snapshot.events.find((event) => event.title === 'Calculus III discussion')?.startUtc
      ).toBe('2026-09-02T21:00:00.000Z')

      const undone = await assistant.send({
        conversationId: applied.conversation.id,
        text: 'undo that',
        range
      })
      expect(undone.snapshot.events).toEqual([])
    } finally {
      repository.close()
    }
  })

  it('edits mixed event/reminder reviews by visible position', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const assistant = new PersistentAssistantService(repository)
      const preview = await assistant.send({
        conversationId: null,
        text: 'Schedule dentist on September 2, 2026 at 10 AM; remind me to call Mom on September 3, 2026 at 6 PM',
        range
      })
      const revised = await assistant.send({
        conversationId: preview.conversation.id,
        text: 'the second one should be 8 PM',
        range
      })

      expect(revised.conversation.activeProposal?.payload).toMatchObject({
        kind: 'batch',
        items: [
          { kind: 'event-save', form: { title: 'dentist', startTime: '10:00' } },
          { kind: 'reminder-save', form: { title: 'call Mom', dueTime: '20:00' } }
        ]
      })
      expect(revised.snapshot.events).toEqual([])
      expect(revised.snapshot.reminders).toEqual([])
    } finally {
      repository.close()
    }
  })

  it('revises a single pending event across time, location, title, and recurrence', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const assistant = new PersistentAssistantService(repository)
      const original = await assistant.send({
        conversationId: null,
        text: 'Schedule dentist on September 2, 2026 at 10 AM',
        range
      })
      const retimed = await assistant.send({
        conversationId: original.conversation.id,
        text: 'actually make it 5 PM',
        range
      })
      const relocated = await assistant.send({
        conversationId: original.conversation.id,
        text: 'change it to location Clinic 4',
        range
      })
      const renamed = await assistant.send({
        conversationId: original.conversation.id,
        text: 'rename it to Dental checkup',
        range
      })
      const repeated = await assistant.send({
        conversationId: original.conversation.id,
        text: 'make it repeat every Tuesday',
        range
      })

      expect(retimed.conversation.activeProposal?.payload).toMatchObject({
        kind: 'event-save',
        form: { startTime: '17:00', endTime: '18:00' }
      })
      expect(relocated.conversation.activeProposal?.payload).toMatchObject({
        kind: 'event-save',
        form: { startTime: '17:00', location: 'Clinic 4' }
      })
      expect(renamed.conversation.activeProposal?.payload).toMatchObject({
        kind: 'event-save',
        form: { title: 'Dental checkup', location: 'Clinic 4' }
      })
      expect(repeated.conversation.activeProposal?.payload).toMatchObject({
        kind: 'event-save',
        form: {
          title: 'Dental checkup',
          recurrence: { frequency: 'weekly', byWeekday: ['tuesday'] }
        }
      })
      expect(repeated.snapshot.events).toEqual([])
    } finally {
      repository.close()
    }
  })

  it('can keep or remove reviewed rows and collapse the replacement to one item', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const assistant = new PersistentAssistantService(repository)
      const preview = await assistant.send({
        conversationId: null,
        text: 'Schedule Alpha on September 2, 2026 at 10 AM; schedule Beta on September 2, 2026 at 11 AM; schedule Gamma on September 2, 2026 at 12 PM',
        range
      })
      const kept = await assistant.send({
        conversationId: preview.conversation.id,
        text: 'keep only the first and third ones',
        range
      })
      expect(kept.conversation.activeProposal?.payload).toMatchObject({
        kind: 'batch',
        items: [
          { kind: 'event-save', form: { title: 'Alpha' } },
          { kind: 'event-save', form: { title: 'Gamma' } }
        ]
      })

      const narrowed = await assistant.send({
        conversationId: kept.conversation.id,
        text: 'remove the first one from that review',
        range
      })
      expect(narrowed.conversation.activeProposal?.payload).toMatchObject({
        kind: 'event-save',
        form: { title: 'Gamma' }
      })
      expect(narrowed.snapshot.events).toEqual([])
    } finally {
      repository.close()
    }
  })

  it('leaves the current proposal pending when a correction is ambiguous or out of range', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const assistant = new PersistentAssistantService(repository)
      const preview = await assistant.send({
        conversationId: null,
        text: 'Schedule Office hours on September 2, 2026 at 10 AM; schedule Office hours on September 2, 2026 at 2 PM',
        range
      })
      const proposalId = preview.conversation.activeProposal?.id

      const duplicateTitle = await assistant.send({
        conversationId: preview.conversation.id,
        text: 'actually change Office hours to 5 PM',
        range
      })
      expect(duplicateTitle.response.kind).toBe('clarification')
      expect(duplicateTitle.conversation.activeProposal?.id).toBe(proposalId)

      const outOfRange = await assistant.send({
        conversationId: preview.conversation.id,
        text: 'make the third one 5 PM',
        range
      })
      expect(outOfRange.response.kind).toBe('clarification')
      expect(outOfRange.conversation.activeProposal?.id).toBe(proposalId)
      expect(outOfRange.snapshot.events).toEqual([])
    } finally {
      repository.close()
    }
  })

  it('answers grounded questions about the current review without saving or calling fallback', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const fallbackPlan = vi.fn(async () => null)
      const assistant = new PersistentAssistantService(repository, null, null, null, null, {
        plan: fallbackPlan
      })
      const preview = await assistant.send({
        conversationId: null,
        text: 'Schedule dentist on September 2, 2026 at 10 AM; remind me to call Mom on September 3, 2026 at 6 PM',
        range
      })
      const proposalId = preview.conversation.activeProposal?.id
      fallbackPlan.mockClear()

      const overview = await assistant.send({
        conversationId: preview.conversation.id,
        text: "What's in the review?",
        range
      })
      expect(overview.response.kind).toBe('answer')
      expect(overview.response.text).toContain('dentist')
      expect(overview.response.text).toContain('call Mom')
      expect(overview.conversation.activeProposal?.id).toBe(proposalId)

      const count = await assistant.send({
        conversationId: preview.conversation.id,
        text: 'How many changes are in the preview?',
        range
      })
      expect(count.response.text).toContain('2 changes')

      const detail = await assistant.send({
        conversationId: preview.conversation.id,
        text: 'What time is the second one?',
        range
      })
      expect(detail.response.text).toContain('call Mom')
      expect(detail.response.text).toContain('6:00 PM')
      expect(detail.conversation.activeProposal?.id).toBe(proposalId)
      expect(detail.snapshot.events).toEqual([])
      expect(detail.snapshot.reminders).toEqual([])
      expect(fallbackPlan).not.toHaveBeenCalled()
    } finally {
      repository.close()
    }
  })

  it('uses visible positions for review details and clarifies duplicate titles', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const assistant = new PersistentAssistantService(repository)
      const preview = await assistant.send({
        conversationId: null,
        text: 'Schedule Office hours on September 2, 2026 at 10 AM; schedule Office hours on September 2, 2026 at 2 PM',
        range
      })
      const proposalId = preview.conversation.activeProposal?.id

      const positioned = await assistant.send({
        conversationId: preview.conversation.id,
        text: 'What time is the second one?',
        range
      })
      expect(positioned.response.kind).toBe('answer')
      expect(positioned.response.text).toContain('2:00 PM')
      expect(positioned.response.text).not.toContain('10:00 AM')

      const ambiguous = await assistant.send({
        conversationId: preview.conversation.id,
        text: 'What time is Office hours?',
        range
      })
      expect(ambiguous.response.kind).toBe('clarification')
      expect(ambiguous.response.text).toMatch(/more than one|which/iu)
      expect(ambiguous.conversation.activeProposal?.id).toBe(proposalId)
      expect(ambiguous.snapshot.events).toEqual([])
    } finally {
      repository.close()
    }
  })

  it('checks pending events against saved and reviewed events before confirmation', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const calendar = new PersistentCalendarService(repository)
      calendar.saveEvent(overlappingEvent('Team sync', '14:00', '15:00'), range)
      const assistant = new PersistentAssistantService(repository)
      const preview = await assistant.send({
        conversationId: null,
        text: 'Schedule Design review on September 2, 2026 at 2:30 PM',
        range
      })

      const conflict = await assistant.send({
        conversationId: preview.conversation.id,
        text: 'Will this conflict with my calendar?',
        range
      })
      expect(conflict.response.kind).toBe('answer')
      expect(conflict.response.text).toContain('Design review')
      expect(conflict.response.text).toContain('Team sync')
      expect(conflict.conversation.activeProposal?.id).toBe(preview.conversation.activeProposal?.id)

      const revised = await assistant.send({
        conversationId: preview.conversation.id,
        text: 'Actually make it 4 PM',
        range
      })
      const clear = await assistant.send({
        conversationId: preview.conversation.id,
        text: 'Does this overlap anything?',
        range
      })
      expect(clear.response.kind).toBe('answer')
      expect(clear.response.text).toMatch(/no overlap|clear/iu)
      expect(clear.conversation.activeProposal?.id).toBe(revised.conversation.activeProposal?.id)
      expect(clear.snapshot.events.map((event) => event.title)).toEqual(['Team sync'])
    } finally {
      repository.close()
    }
  })

  it('detects collisions between reviewed rows and preserves edge-touching availability', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const assistant = new PersistentAssistantService(repository)
      const preview = await assistant.send({
        conversationId: null,
        text: 'Schedule Alpha on September 2, 2026 from 10 AM to 11 AM; schedule Beta on September 2, 2026 from 10:30 AM to 11:30 AM',
        range
      })

      const conflict = await assistant.send({
        conversationId: preview.conversation.id,
        text: 'Do these changes overlap?',
        range
      })
      expect(conflict.response.text).toContain('Alpha')
      expect(conflict.response.text).toContain('Beta')

      await assistant.send({
        conversationId: preview.conversation.id,
        text: 'Actually make the second one 11 AM',
        range
      })
      const clear = await assistant.send({
        conversationId: preview.conversation.id,
        text: 'Do these changes overlap now?',
        range
      })
      expect(clear.response.text).toMatch(/no overlap|clear/iu)
      expect(clear.snapshot.events).toEqual([])
    } finally {
      repository.close()
    }
  })

  it('keeps a review pending while answering an ordinary saved-calendar question', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const calendar = new PersistentCalendarService(repository)
      calendar.saveEvent(overlappingEvent('Team sync', '14:00', '15:00'), range)
      const assistant = new PersistentAssistantService(repository)
      const preview = await assistant.send({
        conversationId: null,
        text: 'Schedule Design review on September 3, 2026 at 4 PM',
        range
      })
      const proposalId = preview.conversation.activeProposal?.id

      const answer = await assistant.send({
        conversationId: preview.conversation.id,
        text: 'What do I have on September 2, 2026?',
        range
      })
      expect(answer.response.kind).toBe('answer')
      expect(answer.response.text).toContain('Team sync')
      expect(answer.response.text).not.toContain('Design review')
      expect(answer.conversation.activeProposal?.id).toBe(proposalId)
      expect(answer.snapshot.events.map((event) => event.title)).toEqual(['Team sync'])
    } finally {
      repository.close()
    }
  })

  it('duplicates an existing event through the reviewed assistant path', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const calendar = new PersistentCalendarService(repository)
      calendar.saveEvent(overlappingEvent('Design review', '14:00', '15:30'), range)
      const assistant = new PersistentAssistantService(repository)
      const preview = await assistant.send({
        conversationId: null,
        text: 'Duplicate design review to September 4, 2026',
        range
      })
      expect(preview.conversation.activeProposal).toMatchObject({
        operation: 'event.duplicate',
        payload: {
          kind: 'event-save',
          form: { id: null, title: 'Design review', startDate: '2026-09-04', startTime: '14:00' }
        }
      })
      const proposal = preview.conversation.activeProposal
      if (!proposal) throw new Error('Expected a duplicate proposal')
      const applied = assistant.confirm({ proposalId: proposal.id, range })
      expect(applied.snapshot.events).toHaveLength(2)
      expect(applied.snapshot.events.map((event) => event.title)).toEqual([
        'Design review',
        'Design review'
      ])
      expect(applied.response.receipt).toMatchObject({
        operation: 'event.duplicate',
        summary: 'Duplicated “Design review”.'
      })
    } finally {
      repository.close()
    }
  })

  it('copies every event on a source day into one reviewed recurring schedule', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const calendar = new PersistentCalendarService(repository)
      calendar.saveEvent(overlappingEvent('Studio block', '09:00', '10:15'), range)
      calendar.saveEvent(overlappingEvent('Evening walk', '18:30', '19:00'), range)
      const assistant = new PersistentAssistantService(repository)

      const preview = await assistant.send({
        conversationId: null,
        text: 'Mirror the agenda from September 2, 2026 onto Mondays, Thursdays, and Saturdays through October 15, 2026',
        range
      })

      expect(preview.response.kind).toBe('preview')
      expect(preview.snapshot.events).toHaveLength(2)
      expect(preview.conversation.activeProposal).toMatchObject({
        operation: 'event.duplicate',
        payload: {
          kind: 'batch',
          items: [
            {
              kind: 'event-save',
              form: {
                id: null,
                title: 'Studio block',
                startDate: '2026-09-03',
                recurrence: {
                  frequency: 'weekly',
                  interval: 1,
                  byWeekday: ['monday', 'thursday', 'saturday'],
                  end: { kind: 'until', date: '2026-10-15' }
                }
              }
            },
            {
              kind: 'event-save',
              form: {
                id: null,
                title: 'Evening walk',
                startDate: '2026-09-03',
                recurrence: {
                  frequency: 'weekly',
                  interval: 1,
                  byWeekday: ['monday', 'thursday', 'saturday'],
                  end: { kind: 'until', date: '2026-10-15' }
                }
              }
            }
          ]
        }
      })

      const proposal = preview.conversation.activeProposal
      if (!proposal) throw new Error('Expected a whole-day schedule proposal')
      const applied = assistant.confirm({ proposalId: proposal.id, range })
      expect(applied.response.receipt?.operation).toBe('event.duplicate')
      expect(applied.snapshot.events).toHaveLength(4)
      expect(
        applied.snapshot.occurrences.filter(
          (occurrence) =>
            occurrence.originalDate === '2026-09-07' &&
            (occurrence.title === 'Studio block' || occurrence.title === 'Evening walk')
        )
      ).toHaveLength(2)

      const undone = await assistant.send({
        conversationId: applied.conversation.id,
        text: 'undo that',
        range
      })
      expect(undone.snapshot.events).toHaveLength(2)
      expect(undone.snapshot.events.every((event) => event.recurrence === null)).toBe(true)
    } finally {
      repository.close()
    }
  })

  it('uses a normal single-change proposal when the source day has one event', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const calendar = new PersistentCalendarService(repository)
      calendar.saveEvent(overlappingEvent('Language practice', '16:00', '16:45'), range)
      const assistant = new PersistentAssistantService(repository)

      const preview = await assistant.send({
        conversationId: null,
        text: "Repeat September 2, 2026's schedule on Tuesdays and Fridays for 3 weeks",
        range
      })

      expect(preview.response.kind).toBe('preview')
      expect(preview.conversation.activeProposal).toMatchObject({
        operation: 'event.duplicate',
        payload: {
          kind: 'event-save',
          form: {
            id: null,
            title: 'Language practice',
            startDate: '2026-09-04',
            recurrence: {
              byWeekday: ['tuesday', 'friday'],
              end: { kind: 'until', date: '2026-09-23' }
            }
          }
        }
      })
      const proposal = preview.conversation.activeProposal
      if (!proposal) throw new Error('Expected a single schedule proposal')
      const applied = assistant.confirm({ proposalId: proposal.id, range })
      expect(applied.response.receipt?.operation).toBe('event.duplicate')
      expect(applied.snapshot.events).toHaveLength(2)
    } finally {
      repository.close()
    }
  })

  it('asks for clarification without staging anything when a source day is empty', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const assistant = new PersistentAssistantService(repository)
      const result = await assistant.send({
        conversationId: null,
        text: 'Copy the schedule from September 10, 2026 across weekdays',
        range
      })

      expect(result.response.kind).toBe('clarification')
      expect(result.response.text).toMatch(/no events/iu)
      expect(result.conversation.activeProposal).toBeNull()
      expect(result.snapshot.events).toEqual([])
    } finally {
      repository.close()
    }
  })

  it('uses the optional model only as a source-grounded fallback for broader phrasing', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const text = 'Give me a nudge to call Mom on September 7, 2026 at 6 PM'
      const assistant = new PersistentAssistantService(
        repository,
        null,
        null,
        null,
        null,
        flexiblePlanner({
          actions: [
            {
              sourceText: text,
              operation: 'reminder.create',
              titleText: 'call Mom',
              targetText: null
            }
          ]
        })
      )
      const preview = await assistant.send({ conversationId: null, text, range })
      expect(preview.response.kind).toBe('preview')
      expect(preview.conversation.activeProposal?.payload).toMatchObject({
        kind: 'reminder-save',
        form: { title: 'call Mom', dueDate: '2026-09-07', dueTime: '18:00' }
      })
      expect(preview.snapshot.events).toEqual([])
      expect(preview.snapshot.reminders).toEqual([])
    } finally {
      repository.close()
    }
  })

  it('lets the fallback normalize colloquial time language into a reviewed local action', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const text =
        'Could you add guitar practice for the ninth day of September at half past two in the afternoon on M, W, and F?'
      const capturedContexts: FlexModelPlanContext[] = []
      const planner: FlexibleCalendarPlanner = {
        plan: async (_source, context) => {
          capturedContexts.push(context)
          return {
            actions: [
              {
                sourceText: text.slice(0, -1),
                operation: 'event.create',
                titleText: 'guitar practice',
                targetText: 'calendar',
                descriptionText: 'guitar practice',
                locationText: 'calendar',
                whenText: 'the ninth day of September at half past two in the afternoon',
                normalizedWhenText: '2026-09-09 at 2:30 PM',
                recurrenceText: 'every weekday',
                normalizedRecurrenceText: 'weekly on abbreviated weekday names'
              }
            ]
          }
        }
      }
      const assistant = new PersistentAssistantService(repository, null, null, null, null, planner)

      const preview = await assistant.send({ conversationId: null, text, range })

      expect(preview.response.kind).toBe('preview')
      expect(preview.response.text).toMatch(/read|understood|translated/iu)
      expect(preview.conversation.activeProposal).toMatchObject({
        operation: 'event.create',
        sourceText: text,
        payload: {
          kind: 'event-save',
          form: {
            title: 'guitar practice',
            startDate: '2026-09-09',
            startTime: '14:30',
            recurrence: {
              frequency: 'weekly',
              byWeekday: ['monday', 'wednesday', 'friday']
            }
          }
        }
      })
      expect(capturedContexts[0]).toMatchObject({
        timezone: 'America/Chicago',
        locale: 'en-US'
      })
      expect(capturedContexts[0]?.currentLocalDateTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u)
      expect(preview.snapshot.events).toEqual([])
    } finally {
      repository.close()
    }
  })

  it('repairs a precise spoken clock phrase instead of staging an afternoon block', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const text = 'Add dentist on September 9 at half past two in the afternoon'
      const plan = vi.fn(async (): Promise<FlexModelPlan> => ({
        actions: [
          {
            sourceText: text,
            operation: 'event.create',
            titleText: 'dentist',
            whenText: 'September 9 at half past two in the afternoon',
            normalizedWhenText: '2026-09-09 at 2:30 PM'
          }
        ]
      }))
      const assistant = new PersistentAssistantService(repository, null, null, null, null, {
        plan
      })

      const preview = await assistant.send({ conversationId: null, text, range })

      expect(plan).toHaveBeenCalledTimes(1)
      expect(preview.response.kind).toBe('preview')
      expect(preview.conversation.activeProposal?.payload).toMatchObject({
        kind: 'event-save',
        form: {
          title: 'dentist',
          startDate: '2026-09-09',
          startTime: '14:30',
          endTime: '15:30'
        }
      })
    } finally {
      repository.close()
    }
  })

  it('asks for a precise clock restatement when no temporal fallback is available', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const assistant = new PersistentAssistantService(repository)
      const result = await assistant.send({
        conversationId: null,
        text: 'Add dentist on September 9 at half past two in the afternoon',
        range
      })

      expect(result.response.kind).toBe('clarification')
      expect(result.response.text).toMatch(/precise time phrase|restate that time/iu)
      expect(result.conversation.activeProposal).toBeNull()
      expect(result.snapshot.events).toEqual([])
    } finally {
      repository.close()
    }
  })

  it('uses normalized fallback language to move an existing event while preserving duration', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const calendar = new PersistentCalendarService(repository)
      calendar.saveEvent(overlappingEvent('Design review', '14:00', '15:30'), range)
      const text =
        'Can you reschedule Design review for the ninth day of September at half past two in the afternoon?'
      const assistant = new PersistentAssistantService(
        repository,
        null,
        null,
        null,
        null,
        flexiblePlanner({
          actions: [
            {
              sourceText: text,
              operation: 'event.move',
              titleText: null,
              targetText: 'Design review',
              whenText: 'the ninth day of September at half past two in the afternoon',
              normalizedWhenText: '2026-09-09 at 2:30 PM',
              recurrenceText: null,
              normalizedRecurrenceText: null
            }
          ]
        })
      )

      const preview = await assistant.send({ conversationId: null, text, range })

      expect(preview.conversation.activeProposal).toMatchObject({
        operation: 'event.move',
        payload: {
          kind: 'event-save',
          form: {
            title: 'Design review',
            startDate: '2026-09-09',
            startTime: '14:30',
            endTime: '16:00'
          }
        }
      })
      expect(preview.snapshot.events[0]).toMatchObject({ title: 'Design review' })
    } finally {
      repository.close()
    }
  })

  it('answers greetings and capability questions without staging calendar work', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const assistant = new PersistentAssistantService(repository)
      const greeting = await assistant.send({ conversationId: null, text: 'Hello!', range })
      const secondGreeting = await assistant.send({
        conversationId: greeting.conversation.id,
        text: 'Hey there',
        range
      })
      const capabilities = await assistant.send({
        conversationId: greeting.conversation.id,
        text: 'What do you do?',
        range
      })
      const architecture = await assistant.send({
        conversationId: greeting.conversation.id,
        text: 'What models do you use?',
        range
      })

      expect(greeting.response.kind).toBe('answer')
      expect(greeting.response.text).toMatch(/ready|here|help/iu)
      expect(secondGreeting.response.text).not.toBe(greeting.response.text)
      expect(capabilities.response.kind).toBe('answer')
      expect(capabilities.response.text).toMatch(/create.*move.*delete/isu)
      expect(capabilities.response.text).toMatch(/images or PDFs/iu)
      expect(architecture.response.text).toMatch(/RemindCore.*RemindSpeak/isu)
      expect(architecture.response.text).toMatch(/Qwen3 1\.7B/iu)
      expect(capabilities.conversation.activeProposal).toBeNull()
      expect(capabilities.snapshot.events).toEqual([])
    } finally {
      repository.close()
    }
  })

  it('stores only explicit local memories and keeps them separate from cleared dialogue', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const assistant = new PersistentAssistantService(repository)
      const named = await assistant.send({ conversationId: null, text: 'Call me Edgar', range })
      const remembered = await assistant.send({
        conversationId: named.conversation.id,
        text: 'Remember that I prefer morning meetings',
        range
      })
      const recalled = await assistant.send({
        conversationId: named.conversation.id,
        text: 'What do you remember about me?',
        range
      })

      expect(repository.getPreferences().assistantProfile).toMatchObject({
        preferredName: 'Edgar',
        memories: ['I prefer morning meetings']
      })
      expect(remembered.response.text).toMatch(/stored locally|remember/iu)
      expect(recalled.response.text).toMatch(/Edgar/iu)
      expect(recalled.response.text).toMatch(/morning meetings/iu)

      assistant.clearConversation(named.conversation.id)
      expect(repository.getPreferences().assistantProfile.preferredName).toBe('Edgar')

      await assistant.send({
        conversationId: named.conversation.id,
        text: 'Forget everything you know about me',
        range
      })
      expect(repository.getPreferences().assistantProfile).toMatchObject({
        preferredName: '',
        customInstructions: '',
        memories: []
      })
    } finally {
      repository.close()
    }
  })

  it('uses bounded recent turns, approved memory, and verified calendar data for broad local chat', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const calendar = new PersistentCalendarService(repository)
      calendar.saveEvent(overlappingEvent('Design review', '14:00', '15:30'), range)
      repository.updatePreferences({
        ...repository.getPreferences(),
        assistantProfile: {
          preferredName: 'Edgar',
          customInstructions: 'Be encouraging.',
          memoryEnabled: true,
          memories: ['I prefer morning meetings']
        },
        updatedAt: new Date().toISOString()
      })
      const captured: FlexModelChatRequest[] = []
      const assistant = new PersistentAssistantService(
        repository,
        null,
        null,
        null,
        null,
        conversationalPlanner('A calmer semester starts with a little breathing room.', (input) => {
          captured.push(input)
        })
      )
      const greeting = await assistant.send({ conversationId: null, text: 'Hello', range })
      const response = await assistant.send({
        conversationId: greeting.conversation.id,
        text: 'How would you help me plan a calmer semester?',
        range
      })

      expect(response.response).toMatchObject({
        kind: 'answer',
        text: 'A calmer semester starts with a little breathing room.'
      })
      const chatRequest = captured[0]
      expect(chatRequest).toBeDefined()
      expect(chatRequest?.turns.some((turn) => turn.text === 'Hello')).toBe(true)
      expect(chatRequest?.profile).toMatchObject({
        preferredName: 'Edgar',
        memories: ['I prefer morning meetings']
      })
      expect(chatRequest?.calendarContext).toContain('Design review')
    } finally {
      repository.close()
    }
  })

  it('gives broad local chat bounded facts about an open review', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const captured: FlexModelChatRequest[] = []
      const assistant = new PersistentAssistantService(
        repository,
        null,
        null,
        null,
        null,
        conversationalPlanner(
          'It keeps the appointment visible before anything is saved.',
          (input) => {
            captured.push(input)
          }
        )
      )
      const preview = await assistant.send({
        conversationId: null,
        text: 'Schedule dentist on September 2, 2026 at 10 AM',
        range
      })
      const proposalId = preview.conversation.activeProposal?.id

      const response = await assistant.send({
        conversationId: preview.conversation.id,
        text: 'Why does that plan make sense?',
        range
      })

      expect(response.response.text).toBe(
        'It keeps the appointment visible before anything is saved.'
      )
      expect(response.conversation.activeProposal?.id).toBe(proposalId)
      expect(captured).toHaveLength(1)
      const factPacket = JSON.parse(captured[0]!.calendarContext) as {
        facts: Array<{
          ref: string
          kind: string
          priority: string
          provenance: string
          fields: { title: string; time: string }
        }>
      }
      expect(factPacket.facts[0]).toMatchObject({
        ref: 'F1',
        kind: 'review',
        priority: 'review',
        provenance: 'review',
        fields: { title: 'dentist', time: null }
      })
      expect(captured[0]?.calendarContext.length).toBeLessThanOrEqual(8_000)
      expect(response.snapshot.events).toEqual([])
    } finally {
      repository.close()
    }
  })

  it('orders focused results and their requested range ahead of nearby background facts', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-28T18:00:00.000Z'))
    try {
      const calendar = new PersistentCalendarService(repository)
      calendar.saveEvent(overlappingEvent('Calculus III', '10:00', '10:50'), range)
      calendar.saveEvent(overlappingEvent('Data Structures', '14:00', '14:50'), range)
      calendar.saveEvent(
        {
          ...overlappingEvent('Nearby appointment', '09:00', '09:30'),
          startDate: '2026-08-28',
          endDate: '2026-08-28'
        },
        range
      )
      const captured: FlexModelChatRequest[] = []
      const assistant = new PersistentAssistantService(
        repository,
        null,
        null,
        null,
        null,
        conversationalPlanner('A short break would give that day some breathing room.', (input) => {
          captured.push(input)
        })
      )
      const queried = await assistant.send({
        conversationId: null,
        text: 'What is my first class on September 2, 2026?',
        range
      })
      const response = await assistant.send({
        conversationId: queried.conversation.id,
        text: 'How would you help me plan a calmer semester?',
        range
      })

      expect(response.response.text).toBe('A short break would give that day some breathing room.')
      expect(captured).toHaveLength(1)
      const factPacket = JSON.parse(captured[0]!.calendarContext) as {
        facts: Array<{ priority: string; fields: { title: string } }>
      }
      expect(factPacket.facts.slice(0, 2)).toMatchObject([
        { priority: 'focused', fields: { title: 'Calculus III' } },
        { priority: 'range', fields: { title: 'Data Structures' } }
      ])
      expect(
        factPacket.facts.find((fact) => fact.fields.title === 'Nearby appointment')
      ).toMatchObject({ priority: 'nearby' })
    } finally {
      vi.useRealTimers()
      repository.close()
    }
  })

  it('keeps an extractive bounded conversation summary separate from approved profile memory', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      repository.updatePreferences({
        ...repository.getPreferences(),
        assistantProfile: {
          preferredName: 'Edgar',
          customInstructions: 'Keep answers calm.',
          memoryEnabled: true,
          memories: ['I prefer morning meetings']
        },
        updatedAt: new Date().toISOString()
      })
      const captured: FlexModelChatRequest[] = []
      const assistant = new PersistentAssistantService(
        repository,
        null,
        null,
        null,
        null,
        conversationalPlanner('One small step is enough.', (input) => captured.push(input))
      )
      let conversationId: string | null = null
      for (let index = 1; index <= 7; index += 1) {
        const exchange = await assistant.send({
          conversationId,
          text: `Write a short focus thought number ${index}`,
          range
        })
        conversationId = exchange.conversation.id
      }
      const request = captured.at(-1)!

      expect(request.turns).toHaveLength(8)
      expect(request.turns.at(-1)?.text).toBe('One small step is enough.')
      expect(request.conversationSummary).toContain('focus thought number 1')
      expect(request.conversationSummary.length).toBeLessThanOrEqual(2_000)
      expect(request.profile.memories).toEqual(['I prefer morning meetings'])
      expect(request.profile.memories).not.toContain(request.conversationSummary)
    } finally {
      repository.close()
    }
  })

  it('grounds a structured fallback answer before revealing it as cumulative live text', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      let workerChunkWasForwarded = false
      const assistant = new PersistentAssistantService(repository, null, null, null, null, {
        calendarPlanner: { planCalendar: async () => ({ kind: 'not-calendar' }) },
        generalResponder: {
          respondGeneral: async (input, onChunk) => {
            workerChunkWasForwarded = onChunk !== undefined
            const packet = JSON.parse(input.calendarContext) as {
              facts: Array<{ ref: string; factId: string }>
            }
            const fact = packet.facts[0]!
            return {
              kind: 'answer',
              text: 'The plan is for {{F1.title}} at {{F1.time}}.',
              factRefs: [{ ref: fact.ref, factId: fact.factId, fields: ['title', 'time'] }],
              writeClaim: false
            }
          }
        }
      })
      const preview = await assistant.send({
        conversationId: null,
        text: 'Schedule dentist on September 2, 2026 at 10 AM',
        range
      })
      const visibleChunks: string[] = []
      const response = await assistant.send(
        {
          conversationId: preview.conversation.id,
          text: 'Why does that timing make sense?',
          range
        },
        { onFlexibleChatChunk: (text) => visibleChunks.push(text) }
      )

      expect(workerChunkWasForwarded).toBe(false)
      expect(response.response).toMatchObject({
        kind: 'answer',
        text: 'The plan is for dentist at 10:00 AM–11:00 AM.'
      })
      expect(visibleChunks.length).toBeGreaterThan(1)
      expect(visibleChunks.at(-1)).toBe(response.response.text)
      expect(
        visibleChunks.every(
          (chunk, index) => index === 0 || chunk.startsWith(visibleChunks[index - 1]!)
        )
      ).toBe(true)
      expect(response.snapshot.events).toEqual([])
    } finally {
      repository.close()
    }
  })

  it('forwards safe broad-chat generation incrementally before the final envelope arrives', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      let workerStreamConnected = false
      const assistant = new PersistentAssistantService(repository, null, null, null, null, {
        calendarPlanner: { planCalendar: async () => ({ kind: 'not-calendar' }) },
        generalResponder: {
          respondGeneral: async (_input, onChunk) => {
            workerStreamConnected = onChunk !== undefined
            onChunk?.('A small step can')
            onChunk?.('A small step can make today feel lighter')
            return {
              kind: 'answer',
              text: 'A small step can make today feel lighter.',
              factRefs: [],
              writeClaim: false
            }
          }
        }
      })
      const visibleChunks: string[] = []
      const result = await assistant.send(
        {
          conversationId: null,
          text: 'Write something encouraging for me',
          range
        },
        { onFlexibleChatChunk: (text) => visibleChunks.push(text) }
      )

      expect(workerStreamConnected).toBe(true)
      expect(visibleChunks.length).toBeGreaterThan(1)
      expect(visibleChunks[0]).toBe('A small')
      expect(visibleChunks.at(-1)).toBe(result.response.text)
      expect(result.response.text).toBe('A small step can make today feel lighter.')
    } finally {
      repository.close()
    }
  })

  it.each([
    {
      label: 'an unreferenced copied fact',
      response: {
        kind: 'answer' as const,
        text: 'The plan is for dentist at 10:00 AM.',
        factRefs: [],
        writeClaim: false
      },
      expectedReason: 'fact-rejected'
    },
    {
      label: 'a claimed calendar write',
      response: {
        kind: 'answer' as const,
        text: 'Done, I added the appointment.',
        factRefs: [],
        writeClaim: true
      },
      expectedReason: 'write-claim-rejected'
    }
  ])('never streams or applies $label', async ({ response: modelResponse, expectedReason }) => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const assistant = new PersistentAssistantService(repository, null, null, null, null, {
        calendarPlanner: { planCalendar: async () => ({ kind: 'not-calendar' }) },
        generalResponder: { respondGeneral: async () => modelResponse }
      })
      const preview = await assistant.send({
        conversationId: null,
        text: 'Schedule dentist on September 2, 2026 at 10 AM',
        range
      })
      const visibleChunks: string[] = []
      const result = await assistant.send(
        {
          conversationId: preview.conversation.id,
          text: 'Why does that timing make sense?',
          range
        },
        { onFlexibleChatChunk: (text) => visibleChunks.push(text) }
      )

      expect(visibleChunks).toEqual([])
      expect(result.response.kind).toBe('unsupported')
      expect(result.response.text).not.toContain(modelResponse.text)
      expect(result.conversation.activeProposal).not.toBeNull()
      expect(result.snapshot.events).toEqual([])
      expect(assistant.getLastExecutionTrace()?.fallbackReason).toBe(expectedReason)
    } finally {
      repository.close()
    }
  })

  it('routes ordinary advice containing “busy” or “make” directly to broad chat', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      let planCalls = 0
      let chatCalls = 0
      const assistant = new PersistentAssistantService(repository, null, null, null, null, {
        plan: async () => {
          planCalls += 1
          return null
        },
        chat: async () => {
          chatCalls += 1
          return 'Start with one small priority and leave a little margin between tasks.'
        }
      })

      const response = await assistant.send({
        conversationId: null,
        text: 'In one friendly sentence, how can I make a busy morning feel smoother?',
        range
      })

      expect(response.response.text).toBe(
        'Start with one small priority and leave a little margin between tasks.'
      )
      expect(chatCalls).toBe(1)
      expect(planCalls).toBe(0)
    } finally {
      repository.close()
    }
  })

  it('does not feed a failed flexible response or its triggering prompt back into the model', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const captured: FlexModelChatRequest[] = []
      let attempt = 0
      const assistant = new PersistentAssistantService(repository, null, null, null, null, {
        plan: async () => null,
        chat: async (input) => {
          captured.push(input)
          attempt += 1
          return attempt === 1 ? null : 'Start with one small, quiet win.'
        }
      })
      const failed = await assistant.send({
        conversationId: null,
        text: 'Write something warm about studying',
        range
      })
      expect(failed.response.text).toMatch(/could not finish that response/iu)

      await assistant.send({
        conversationId: failed.conversation.id,
        text: 'Try a shorter answer',
        range
      })

      expect(captured).toHaveLength(2)
      expect(captured[1]?.turns).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ text: 'Write something warm about studying' })
        ])
      )
      expect(
        captured[1]?.turns.some((turn) => /could not finish that response/iu.test(turn.text))
      ).toBe(false)
      expect(captured[1]?.calendarContext).toBe('')
    } finally {
      repository.close()
    }
  })

  it.each([
    {
      label: 'create',
      text: "I'd love a Focus reset on September 4, 2026 from 1 PM to 2 PM",
      operation: 'event.create' as const,
      titleText: 'Focus reset',
      targetText: null,
      descriptionText: null,
      locationText: null,
      expected: {
        operation: 'event.create',
        payload: { kind: 'event-save', form: { title: 'Focus reset', startTime: '13:00' } }
      }
    },
    {
      label: 'move while preserving time and duration',
      text: "Hey, I'd rather have Design review on September 4, 2026",
      operation: 'event.move' as const,
      titleText: null,
      targetText: 'Design review',
      descriptionText: null,
      locationText: null,
      expected: {
        operation: 'event.move',
        payload: {
          kind: 'event-save',
          form: {
            title: 'Design review',
            startDate: '2026-09-04',
            startTime: '14:00',
            endTime: '15:30'
          }
        }
      }
    },
    {
      label: 'rename',
      text: "Let's call Design review Final critique going forward",
      operation: 'event.update' as const,
      titleText: 'Final critique',
      targetText: 'Design review',
      descriptionText: null,
      locationText: null,
      expected: {
        operation: 'event.update',
        payload: { kind: 'event-save', form: { title: 'Final critique' } }
      }
    },
    {
      label: 'duplicate',
      text: "I'd like another Design review on September 5, 2026",
      operation: 'event.duplicate' as const,
      titleText: null,
      targetText: 'Design review',
      descriptionText: null,
      locationText: null,
      expected: {
        operation: 'event.duplicate',
        payload: {
          kind: 'event-save',
          form: { id: null, title: 'Design review', startDate: '2026-09-05' }
        }
      }
    },
    {
      label: 'delete',
      text: "I won't need Design review anymore",
      operation: 'event.delete' as const,
      titleText: null,
      targetText: 'Design review',
      descriptionText: null,
      locationText: null,
      expected: { operation: 'event.delete', payload: { kind: 'event-delete' } }
    },
    {
      label: 'location and notes update',
      text: 'Keep Design review in Studio B and note bring sketches',
      operation: 'event.update' as const,
      titleText: null,
      targetText: 'Design review',
      descriptionText: 'bring sketches',
      locationText: 'Studio B',
      expected: {
        operation: 'event.update',
        payload: {
          kind: 'event-save',
          form: {
            title: 'Design review',
            description: 'bring sketches',
            location: 'Studio B'
          }
        }
      }
    }
  ])('routes a colloquial $label request into the reviewed action path', async (testCase) => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const calendar = new PersistentCalendarService(repository)
      calendar.saveEvent(overlappingEvent('Design review', '14:00', '15:30'), range)
      const assistant = new PersistentAssistantService(
        repository,
        null,
        null,
        null,
        null,
        flexiblePlanner({
          actions: [
            {
              sourceText: testCase.text,
              operation: testCase.operation,
              titleText: testCase.titleText,
              targetText: testCase.targetText,
              descriptionText: testCase.descriptionText,
              locationText: testCase.locationText
            }
          ]
        })
      )
      const preview = await assistant.send({
        conversationId: null,
        text: testCase.text,
        range
      })

      expect(preview.response.kind).toBe('preview')
      expect(preview.conversation.activeProposal).toMatchObject(testCase.expected)
      expect(preview.snapshot.events).toHaveLength(1)
    } finally {
      repository.close()
    }
  })

  it('uses a colloquial reminder update while preserving its existing due day', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const calendar = new PersistentCalendarService(repository)
      calendar.saveReminder(
        {
          id: null,
          calendarId: null,
          title: 'Water plants',
          notes: '',
          dueDate: '2026-09-02',
          dueTime: '18:00',
          timezone: 'America/Chicago',
          recurrence: null
        },
        range
      )
      const text = 'Water plants can wait until 8 PM'
      const assistant = new PersistentAssistantService(
        repository,
        null,
        null,
        null,
        null,
        flexiblePlanner({
          actions: [
            {
              sourceText: text,
              operation: 'reminder.update',
              titleText: null,
              targetText: 'Water plants'
            }
          ]
        })
      )

      const preview = await assistant.send({ conversationId: null, text, range })
      expect(preview.conversation.activeProposal).toMatchObject({
        operation: 'reminder.update',
        payload: {
          kind: 'reminder-save',
          form: { title: 'Water plants', dueDate: '2026-09-02', dueTime: '20:00' }
        }
      })
      expect(preview.snapshot.reminders[0]).toMatchObject({
        title: 'Water plants',
        dueAtUtc: '2026-09-02T23:00:00.000Z'
      })
    } finally {
      repository.close()
    }
  })

  it('turns a flexible multi-intent paraphrase into one reviewed atomic batch', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const first = "I'd like dentist on September 8, 2026 at 10 AM"
      const second = 'give me a nudge to call Mom on September 9, 2026 at 6 PM'
      const text = `${first} plus ${second}`
      const assistant = new PersistentAssistantService(
        repository,
        null,
        null,
        null,
        null,
        flexiblePlanner({
          actions: [
            {
              sourceText: first,
              operation: 'event.create',
              titleText: 'dentist',
              targetText: null
            },
            {
              sourceText: second,
              operation: 'reminder.create',
              titleText: 'call Mom',
              targetText: null
            }
          ]
        })
      )
      const preview = await assistant.send({ conversationId: null, text, range })
      expect(preview.conversation.activeProposal?.payload).toMatchObject({
        kind: 'batch',
        items: [
          { kind: 'event-save', form: { title: 'dentist' } },
          { kind: 'reminder-save', form: { title: 'call Mom' } }
        ]
      })
      expect(preview.snapshot.events).toEqual([])
      expect(preview.snapshot.reminders).toEqual([])
    } finally {
      repository.close()
    }
  })

  it('uses one message-scoped fallback call for a split multi-item request', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const text =
        'Please add dentist on September 9 at half past two in the afternoon and guitar practice on September 10 at quarter past four in the afternoon'
      const first = 'Please add dentist on september 9 at half past two in the afternoon'
      const second = 'add guitar practice on september 10 at quarter past four in the afternoon'
      const plan = vi.fn(async (source: string): Promise<FlexModelPlan> => {
        expect(source).toBe(`${first}; ${second}`)
        return {
          actions: [
            {
              sourceText: 'dentist on September 9 at half past two in the afternoon',
              operation: 'event.create',
              titleText: 'dentist',
              whenText: 'September 9 at half past two in the afternoon',
              normalizedWhenText: '2026-09-09 at 2:30 PM'
            },
            {
              sourceText: 'guitar practice on September 10 at quarter past four in the afternoon',
              operation: 'event.create',
              titleText: 'guitar practice',
              whenText: 'September 10 at quarter past four in the afternoon',
              normalizedWhenText: '2026-09-10 at 4:15 PM'
            }
          ]
        }
      })
      const assistant = new PersistentAssistantService(repository, null, null, null, null, {
        plan
      })

      const preview = await assistant.send({ conversationId: null, text, range })

      expect(plan).toHaveBeenCalledTimes(1)
      expect(preview.response.kind).toBe('preview')
      expect(preview.conversation.activeProposal?.payload).toMatchObject({
        kind: 'batch',
        items: [
          {
            kind: 'event-save',
            form: { title: 'dentist', startDate: '2026-09-09', startTime: '14:30' }
          },
          {
            kind: 'event-save',
            form: {
              title: 'guitar practice',
              startDate: '2026-09-10',
              startTime: '16:15'
            }
          }
        ]
      })
      expect(preview.snapshot.events).toEqual([])
    } finally {
      repository.close()
    }
  })

  it('rejects incomplete message-scoped fallback output without retrying each item', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const text =
        'Please add dentist on September 9 at half past two in the afternoon and guitar practice on September 10 at quarter past four in the afternoon'
      const plan = vi.fn(async (source: string): Promise<FlexModelPlan> => ({
        actions: [
          {
            sourceText: source.split(';')[0] ?? source,
            operation: 'event.create',
            titleText: 'dentist',
            whenText: 'September 9 at half past two in the afternoon',
            normalizedWhenText: '2026-09-09 at 2:30 PM'
          }
        ]
      }))
      const assistant = new PersistentAssistantService(repository, null, null, null, null, {
        plan
      })

      const result = await assistant.send({ conversationId: null, text, range })

      expect(plan).toHaveBeenCalledTimes(1)
      expect(result.response.kind).toBe('clarification')
      expect(result.response.text).toMatch(/returned 1 of 2 requested items/iu)
      expect(result.conversation.activeProposal).toBeNull()
      expect(result.snapshot.events).toEqual([])
    } finally {
      repository.close()
    }
  })

  it('rejects model-invented and overlapping excerpts before parsing them', () => {
    const source = 'Put lunch on September 8 at noon and dinner on September 9 at 7 PM'
    expect(
      groundFlexiblePlan(source, {
        actions: [
          {
            sourceText: 'Put lunch on September 8 at noon',
            operation: 'event.create',
            titleText: 'a lavish lunch',
            targetText: null
          }
        ]
      })
    ).toBeNull()
    expect(
      groundFlexiblePlan(source, {
        actions: [
          {
            sourceText: source,
            operation: 'event.create',
            titleText: 'lunch',
            targetText: null
          },
          {
            sourceText: 'dinner on September 9 at 7 PM',
            operation: 'event.create',
            titleText: 'dinner',
            targetText: null
          }
        ]
      })
    ).toBeNull()
    expect(
      groundFlexiblePlan(source, {
        actions: [
          {
            sourceText: source,
            operation: 'event.update',
            titleText: 'lunch',
            targetText: 'lunch',
            locationText: null,
            descriptionText: null
          }
        ]
      })
    ).toBeNull()
    const ignoredInventedWhen = groundFlexiblePlan(source, {
      actions: [
        {
          sourceText: 'Put lunch on September 8 at noon',
          operation: 'event.create',
          titleText: 'lunch',
          targetText: null,
          whenText: 'next Friday at noon',
          normalizedWhenText: '2026-09-11 at 12:00 PM'
        }
      ]
    })
    expect(ignoredInventedWhen?.[0]).toMatchObject({ translated: false })
    const ignoredUnpairedWhen = groundFlexiblePlan(source, {
      actions: [
        {
          sourceText: 'Put lunch on September 8 at noon',
          operation: 'event.create',
          titleText: 'lunch',
          targetText: null,
          whenText: null,
          normalizedWhenText: '2026-09-08 at 12:00 PM'
        }
      ]
    })
    expect(ignoredUnpairedWhen?.[0]).toMatchObject({ translated: false })

    const rejectedTranslatedWhen = groundFlexiblePlan(
      'Add Calc III exam on October 31 from 6-7:30',
      {
        actions: [
          {
            sourceText: 'Add Calc III exam on October 31 from 6-7:30',
            operation: 'event.create',
            titleText: 'Calc III exam',
            targetText: null,
            whenText: 'October 31 from 6-7:30',
            normalizedWhenText: '2027-12-25 from 9:00 AM to 10:00 AM'
          }
        ]
      },
      {
        currentLocalDateTime: '2026-08-27T10:00',
        timezone: 'America/Chicago',
        locale: 'en-US'
      }
    )
    expect(rejectedTranslatedWhen?.[0]).toMatchObject({ translated: false })

    const rejectedBorrowedRange = groundFlexiblePlan(
      'Add Calc exam on October 31, 2026 at 6 PM and Physics exam on November 1, 2026 at 7:30 PM',
      {
        actions: [
          {
            sourceText: 'Calc exam on October 31, 2026 at 6 PM',
            operation: 'event.create',
            titleText: 'Calc exam',
            whenText: 'October 31, 2026',
            normalizedWhenText: '2026-10-31 from 6:00 PM to 7:30 PM'
          }
        ]
      },
      {
        currentLocalDateTime: '2026-08-27T10:00',
        timezone: 'America/Chicago',
        locale: 'en-US'
      }
    )
    expect(rejectedBorrowedRange?.[0]).toMatchObject({ translated: false })
  })

  it('grounds only constrained fallback translations and rebuilds semantic spans', () => {
    const source =
      'Add study group on the ninth day of September at half past two in the afternoon on M, W, and F'
    const groundingContext = {
      currentLocalDateTime: '2026-08-27T10:00',
      timezone: 'America/Chicago',
      locale: 'en-US'
    }
    const grounded = groundFlexiblePlan(
      source,
      {
        actions: [
          {
            sourceText: source,
            operation: 'event.create',
            titleText: 'study group',
            targetText: null,
            whenText: 'the ninth day of September at half past two in the afternoon',
            normalizedWhenText: '2026-09-09 at 2:30 PM',
            recurrenceText: 'M, W, and F',
            normalizedRecurrenceText: 'weekly on Mon, Wed, Fri'
          }
        ]
      },
      groundingContext
    )

    expect(grounded).toHaveLength(1)
    expect(grounded?.[0]).toMatchObject({
      sourceText: source,
      parserText: 'study group 2026-09-09 at 2:30 PM weekly on Mon, Wed, Fri',
      translated: true
    })
    const titleSpan = grounded?.[0]?.prediction.spans.find((span) => span.kind === 'TITLE')
    expect(titleSpan).toEqual({ kind: 'TITLE', start: 0, end: 'study group'.length })
    const repairedRecurrence = groundFlexiblePlan(
      source,
      {
        actions: [
          {
            sourceText: source,
            operation: 'event.create',
            titleText: 'study group',
            targetText: null,
            recurrenceText: 'M, W, and F',
            normalizedRecurrenceText: 'weekly on Mon, Mon'
          }
        ]
      },
      groundingContext
    )
    expect(repairedRecurrence?.[0]?.parserText).toBe('study group weekly on Mon, Wed, Fri')
  })

  it('repairs exact single spoken clocks after noisy fallback normalization', () => {
    const source =
      'Please add dentist on september 9 at half past two in the afternoon; add guitar practice on september 10 at quarter past four in the afternoon'
    const groundingContext = {
      currentLocalDateTime: '2026-08-27T10:00',
      timezone: 'America/Chicago',
      locale: 'en-US'
    }
    const grounded = groundFlexiblePlan(
      source,
      {
        actions: [
          {
            sourceText: 'dentist on september 9',
            operation: 'event.create',
            titleText: 'dentist',
            targetText: 'dentist',
            whenText: '2026-09-09 at 2:00 PM',
            normalizedWhenText: '2026-09-09 at 2:00 PM'
          },
          {
            sourceText: 'guitar practice on september 10',
            operation: 'event.create',
            titleText: 'guitar practice',
            targetText: 'guitar practice',
            whenText: '2026-09-10 at 4:15 PM',
            normalizedWhenText: '2026-09-10 at 4:15 PM'
          }
        ]
      },
      groundingContext
    )

    expect(grounded?.map((action) => action.parserText)).toEqual([
      'dentist 2026-09-09 at 2:30 PM',
      'guitar practice 2026-09-10 at 4:15 PM'
    ])
    expect(grounded?.every((action) => action.translated)).toBe(true)

    const ambiguous = groundFlexiblePlan(
      'Add dentist on September 9 at 2 PM or 3 PM',
      {
        actions: [
          {
            sourceText: 'Add dentist on September 9 at 2 PM or 3 PM',
            operation: 'event.create',
            titleText: 'dentist',
            whenText: 'September 9 at 2 PM or 3 PM',
            normalizedWhenText: '2026-09-09 at 2:00 PM'
          }
        ]
      },
      groundingContext
    )
    expect(ambiguous?.[0]).toMatchObject({ translated: false })
  })

  it('keeps a noisy multi-reminder request together through clarification', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const assistant = new PersistentAssistantService(repository)
      const text =
        'can you add a reminder for my calc III exam on october 31st from 6-7:30 and also my calc III 2nd exam at nov. 1 6:7-30'

      const typeQuestion = await assistant.send({ conversationId: null, text, range })
      expect(typeQuestion.response.kind).toBe('clarification')
      expect(typeQuestion.response.text).toMatch(/2 requested items/iu)
      expect(typeQuestion.response.text).toMatch(/calendar event/iu)
      expect(typeQuestion.conversation.activeProposal).toBeNull()

      const timeQuestion = await assistant.send({
        conversationId: typeQuestion.conversation.id,
        text: 'Create calendar events',
        range
      })
      expect(timeQuestion.response.kind).toBe('clarification')
      expect(timeQuestion.response.text).toMatch(/2 requested items/iu)
      expect(timeQuestion.response.text).toMatch(/morning|afternoon/iu)

      const preview = await assistant.send({
        conversationId: timeQuestion.conversation.id,
        text: 'PM',
        range
      })
      expect(preview.response.kind).toBe('preview')
      expect(preview.conversation.activeProposal?.payload).toMatchObject({
        kind: 'batch',
        items: [
          {
            kind: 'event-save',
            form: {
              title: 'calc III exam',
              startDate: '2026-10-31',
              startTime: '18:00',
              endTime: '19:30'
            }
          },
          {
            kind: 'event-save',
            form: {
              title: 'calc III 2nd exam',
              startDate: '2026-11-01',
              startTime: '18:00',
              endTime: '19:30'
            }
          }
        ]
      })
      expect(preview.snapshot.events).toEqual([])
      expect(preview.snapshot.reminders).toEqual([])
    } finally {
      repository.close()
    }
  })

  it('does not mistake one recurring weekday list for a multi-item request', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const assistant = new PersistentAssistantService(repository)
      const preview = await assistant.send({
        conversationId: null,
        text: 'add Discrete Math every Monday, Wednesday, and Friday at 11 am starting next Monday',
        range
      })

      expect(preview.response.kind).toBe('preview')
      expect(preview.conversation.activeProposal?.payload).toMatchObject({
        kind: 'event-save',
        form: {
          title: 'Discrete Math',
          startTime: '11:00',
          recurrence: {
            frequency: 'weekly',
            byWeekday: ['monday', 'wednesday', 'friday']
          }
        }
      })
    } finally {
      repository.close()
    }
  })

  it('turns broad event and reminder idioms into one complete reviewed batch', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const assistant = new PersistentAssistantService(repository)
      const preview = await assistant.send({
        conversationId: null,
        text: 'pencil in yoga on October 3, 2026 at 7 AM; block off focus time on October 4, 2026 from 1-3 PM; do not let me forget to call Mom on October 5, 2026 at 6 PM',
        range
      })

      expect(preview.response.kind).toBe('preview')
      expect(preview.conversation.activeProposal?.payload).toMatchObject({
        kind: 'batch',
        items: [
          {
            kind: 'event-save',
            form: { title: 'yoga', startDate: '2026-10-03', startTime: '07:00' }
          },
          {
            kind: 'event-save',
            form: {
              title: 'focus time',
              startDate: '2026-10-04',
              startTime: '13:00',
              endTime: '15:00'
            }
          },
          {
            kind: 'reminder-save',
            form: { title: 'call Mom', dueDate: '2026-10-05', dueTime: '18:00' }
          }
        ]
      })
      expect(preview.snapshot.events).toEqual([])
      expect(preview.snapshot.reminders).toEqual([])
    } finally {
      repository.close()
    }
  })

  it('supports natural selected-item delete, move, duplicate, and completion idioms', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const calendar = new PersistentCalendarService(repository)
      calendar.saveEvent(overlappingEvent('Design review', '14:00', '15:30'), range)
      calendar.saveReminder(
        {
          id: null,
          calendarId: null,
          title: 'Water plants',
          notes: '',
          dueDate: '2026-09-02',
          dueTime: '18:00',
          timezone: 'America/Chicago',
          recurrence: null
        },
        range
      )
      const assistant = new PersistentAssistantService(repository)

      const moved = await assistant.send({
        conversationId: null,
        text: 'bump Design review to October 8, 2026 at 3 PM',
        range
      })
      expect(moved.conversation.activeProposal?.payload).toMatchObject({
        kind: 'event-save',
        form: {
          title: 'Design review',
          startDate: '2026-10-08',
          startTime: '15:00',
          endTime: '16:30'
        }
      })

      const copied = await assistant.send({
        conversationId: moved.conversation.id,
        text: 'make a copy of Design review on October 10, 2026',
        range
      })
      expect(copied.conversation.activeProposal?.payload).toMatchObject({
        kind: 'event-save',
        form: { id: null, title: 'Design review', startDate: '2026-10-10', startTime: '14:00' }
      })

      const removed = await assistant.send({
        conversationId: copied.conversation.id,
        text: 'take Desgin reveiw off my calendar',
        range
      })
      expect(removed.conversation.activeProposal?.payload).toMatchObject({ kind: 'event-delete' })

      const completed = await assistant.send({
        conversationId: removed.conversation.id,
        text: 'cross Water plants off',
        range
      })
      expect(completed.conversation.activeProposal?.payload).toMatchObject({
        kind: 'reminder-complete'
      })
      expect(completed.snapshot.events).toHaveLength(1)
      expect(completed.snapshot.reminders[0]?.status).toBe('active')
    } finally {
      repository.close()
    }
  })

  it('creates dated items with one explicit shared time range without using fallback', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const assistant = new PersistentAssistantService(repository)
      const preview = await assistant.send({
        conversationId: null,
        text: 'Please add Calc exam on October 31, 2026 and Physics exam on November 1, 2026, both from 6 PM to 7:30 PM',
        range
      })

      expect(preview.response.kind).toBe('preview')
      expect(preview.conversation.activeProposal?.payload).toMatchObject({
        kind: 'batch',
        items: [
          {
            kind: 'event-save',
            form: {
              title: 'Calc exam',
              startDate: '2026-10-31',
              startTime: '18:00',
              endTime: '19:30'
            }
          },
          {
            kind: 'event-save',
            form: {
              title: 'Physics exam',
              startDate: '2026-11-01',
              startTime: '18:00',
              endTime: '19:30'
            }
          }
        ]
      })
    } finally {
      repository.close()
    }
  })

  it('grounds one explicit shared time range across separate fallback actions', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const text =
        'Please add Calc exam on October 31, 2026 and Physics exam on November 1, 2026, both from 6 PM to 7:30 PM'
      const plan: FlexModelPlan = {
        actions: [
          {
            sourceText: 'Calc exam on October 31, 2026',
            operation: 'event.create',
            titleText: 'Calc exam',
            whenText: 'October 31, 2026',
            normalizedWhenText: '2026-10-31 from 6:00 PM to 7:30 PM'
          },
          {
            sourceText: 'Physics exam on November 1, 2026',
            operation: 'event.create',
            titleText: 'Physics exam',
            whenText: 'November 1, 2026',
            normalizedWhenText: '2026-11-01 from 6:00 PM to 7:30 PM'
          }
        ]
      }
      const assistant = new PersistentAssistantService(
        repository,
        null,
        null,
        null,
        null,
        flexiblePlanner(plan)
      )

      const preview = await assistant.send({ conversationId: null, text, range })

      expect(preview.response.kind).toBe('preview')
      expect(preview.conversation.activeProposal?.payload).toMatchObject({
        kind: 'batch',
        items: [
          {
            kind: 'event-save',
            form: {
              title: 'Calc exam',
              startDate: '2026-10-31',
              startTime: '18:00',
              endTime: '19:30'
            }
          },
          {
            kind: 'event-save',
            form: {
              title: 'Physics exam',
              startDate: '2026-11-01',
              startTime: '18:00',
              endTime: '19:30'
            }
          }
        ]
      })
      expect(preview.snapshot.events).toEqual([])
    } finally {
      repository.close()
    }
  })

  it('lets the grounded fallback translate location and notes updates', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const calendar = new PersistentCalendarService(repository)
      calendar.saveEvent(overlappingEvent('Design review', '14:00', '15:30'), range)
      calendar.saveReminder(
        {
          id: null,
          calendarId: null,
          title: 'Water plants',
          notes: '',
          dueDate: '2026-09-02',
          dueTime: '18:00',
          timezone: 'America/Chicago',
          recurrence: null
        },
        range
      )
      const planner: FlexibleCalendarPlanner = {
        plan: async (source) =>
          /Design review/iu.test(source)
            ? {
                actions: [
                  {
                    sourceText: "change Design review's location to room 204",
                    operation: 'event.update',
                    targetText: 'Design review',
                    locationText: 'room 204'
                  }
                ]
              }
            : {
                actions: [
                  {
                    sourceText: 'change Water plants notes to use filtered water',
                    operation: 'reminder.update',
                    targetText: 'Water plants',
                    descriptionText: 'use filtered water'
                  }
                ]
              }
      }
      const assistant = new PersistentAssistantService(repository, null, null, null, null, planner)

      const location = await assistant.send({
        conversationId: null,
        text: "change Design review's location to Room 204",
        range
      })
      expect(location.conversation.activeProposal?.payload).toMatchObject({
        kind: 'event-save',
        form: { title: 'Design review', location: 'room 204' }
      })

      const notes = await assistant.send({
        conversationId: location.conversation.id,
        text: 'change Water plants notes to use filtered water',
        range
      })
      expect(notes.conversation.activeProposal?.payload).toMatchObject({
        kind: 'reminder-save',
        form: { title: 'Water plants', notes: 'use filtered water' }
      })
      expect(notes.snapshot.events[0]?.location).toBe('')
      expect(notes.snapshot.reminders[0]?.notes).toBe('')
    } finally {
      repository.close()
    }
  })

  it('repairs a noisy real-model multi-action plan without trusting invented details', () => {
    const source = 'Add my CS 251 lab tomorrow at 1pm, and my calculus discussion at 2pm.'
    const grounded = groundFlexiblePlan(
      source,
      {
        actions: [
          {
            sourceText: 'Add my CS 251 lab tomorrow at 1pm',
            operation: 'event.create',
            titleText: 'CS 251 lab',
            targetText: 'CS 251 lab',
            descriptionText: 'Add my CS 251 lab tomorrow at 1pm',
            locationText: 'University of Chicago',
            whenText: 'tomorrow at 1pm',
            normalizedWhenText: '2026-08-26 at 1:00 PM',
            recurrenceText: 'every day',
            normalizedRecurrenceText: 'weekly on abbreviated weekday names'
          },
          {
            sourceText: 'Add my calculus discussion at 2pm',
            operation: 'event.create',
            titleText: 'calculus discussion',
            targetText: 'calculus discussion',
            descriptionText: 'Add my calculus discussion at 2pm',
            locationText: 'University of Chicago',
            whenText: 'tomorrow at 2pm',
            normalizedWhenText: '2026-08-26 at 2:00 PM',
            recurrenceText: 'every day',
            normalizedRecurrenceText: 'weekly on abbreviated weekday names'
          }
        ]
      },
      {
        currentLocalDateTime: '2026-08-25T12:00',
        timezone: 'America/Chicago',
        locale: 'en-US'
      }
    )

    expect(grounded?.map((action) => action.parserText)).toEqual([
      'CS 251 lab 2026-08-26 at 1:00 PM',
      'calculus discussion 2026-08-26 at 2:00 PM'
    ])
    expect(grounded?.flatMap((action) => action.prediction.spans.map((span) => span.kind))).toEqual(
      ['TITLE', 'TITLE']
    )
    expect(grounded?.[1]?.sourceText).toBe('my calculus discussion at 2pm')
  })

  it('reviews, clears, and restores an entire schedule larger than the ordinary batch limit', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const calendar = new PersistentCalendarService(repository)
      for (let index = 0; index < 60; index += 1) {
        calendar.saveEvent(overlappingEvent(`Schedule item ${index + 1}`, '09:00', '10:00'), range)
      }
      calendar.saveReminder(
        {
          id: null,
          calendarId: null,
          title: 'Keep this reminder',
          notes: '',
          dueDate: '2026-09-03',
          dueTime: '08:00',
          timezone: 'America/Chicago',
          recurrence: null
        },
        range
      )
      const assistant = new PersistentAssistantService(repository)
      const preview = await assistant.send({
        conversationId: null,
        text: 'Can you clear my entire schedule?',
        range
      })

      expect(preview.response.kind).toBe('preview')
      expect(preview.snapshot.events).toHaveLength(60)
      expect(preview.snapshot.reminders).toHaveLength(1)
      const proposal = preview.conversation.activeProposal
      expect(proposal).toMatchObject({
        risk: 'destructive',
        requiresConfirmation: true,
        payload: { kind: 'bulk-delete', scope: 'events', reminderIds: [] }
      })
      if (proposal?.payload.kind !== 'bulk-delete') {
        throw new Error('Expected a bulk-delete proposal')
      }
      expect(proposal.payload.eventIds).toHaveLength(60)

      const applied = assistant.confirm({ proposalId: proposal.id, range })
      expect(applied.response.kind).toBe('receipt')
      expect(applied.response.receipt?.undoable).toBe(true)
      expect(applied.snapshot.events).toEqual([])
      expect(applied.snapshot.reminders[0]?.title).toBe('Keep this reminder')

      const undone = await assistant.send({
        conversationId: applied.conversation.id,
        text: 'undo that',
        range
      })
      expect(undone.snapshot.events).toHaveLength(60)
      expect(undone.snapshot.reminders).toHaveLength(1)
    } finally {
      repository.close()
    }
  })

  it('can clear events and reminders together while refusing a stale bulk review', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const calendar = new PersistentCalendarService(repository)
      calendar.saveEvent(overlappingEvent('Original event', '09:00', '10:00'), range)
      calendar.saveReminder(
        {
          id: null,
          calendarId: null,
          title: 'Original reminder',
          notes: '',
          dueDate: '2026-09-03',
          dueTime: '08:00',
          timezone: 'America/Chicago',
          recurrence: null
        },
        range
      )
      const assistant = new PersistentAssistantService(repository)
      const stalePreview = await assistant.send({
        conversationId: null,
        text: 'Delete all events and reminders',
        range
      })
      const staleProposal = stalePreview.conversation.activeProposal
      if (!staleProposal) throw new Error('Expected a bulk clear proposal')

      calendar.saveEvent(overlappingEvent('Added after review', '11:00', '12:00'), range)
      const stopped = assistant.confirm({ proposalId: staleProposal.id, range })
      expect(stopped.response.kind).toBe('error')
      expect(stopped.response.text).toContain('calendar changed')
      expect(stopped.snapshot.events).toHaveLength(2)
      expect(stopped.snapshot.reminders).toHaveLength(1)

      const currentPreview = await assistant.send({
        conversationId: stopped.conversation.id,
        text: 'Remove everything from my calendar',
        range
      })
      const currentProposal = currentPreview.conversation.activeProposal
      expect(currentProposal?.payload).toMatchObject({ kind: 'bulk-delete', scope: 'both' })
      if (!currentProposal) throw new Error('Expected a current bulk clear proposal')
      const applied = assistant.confirm({ proposalId: currentProposal.id, range })
      expect(applied.snapshot.events).toEqual([])
      expect(applied.snapshot.reminders).toEqual([])
    } finally {
      repository.close()
    }
  })

  it('answers without staging when the requested clear scope is already empty', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const calendar = new PersistentCalendarService(repository)
      calendar.saveReminder(
        {
          id: null,
          calendarId: null,
          title: 'Reminder stays',
          notes: '',
          dueDate: '2026-09-03',
          dueTime: '08:00',
          timezone: 'America/Chicago',
          recurrence: null
        },
        range
      )
      const assistant = new PersistentAssistantService(repository)
      const response = await assistant.send({
        conversationId: null,
        text: 'Reset my calendar and schedule',
        range
      })

      expect(response.response.kind).toBe('answer')
      expect(response.conversation.activeProposal).toBeNull()
      expect(response.snapshot.reminders[0]?.title).toBe('Reminder stays')
    } finally {
      repository.close()
    }
  })

  it('lets the user clear local dialogue and pending proposals without touching calendar data', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const calendar = new PersistentCalendarService(repository)
      calendar.saveEvent(overlappingEvent('Keep this event', '09:00', '10:00'), range)
      const assistant = new PersistentAssistantService(repository)
      const preview = await assistant.send({
        conversationId: null,
        text: 'Remind me to call Alex on September 2, 2026 at 6 PM',
        range
      })
      expect(preview.conversation.activeProposal).not.toBeNull()

      const cleared = assistant.clearConversation(preview.conversation.id)
      expect(cleared.activeProposal).toBeNull()
      expect(cleared.turns).toHaveLength(1)
      expect(cleared.turns[0]?.role).toBe('assistant')
      expect(calendar.getSnapshot(range).events[0]?.title).toBe('Keep this event')
    } finally {
      repository.close()
    }
  })
})
