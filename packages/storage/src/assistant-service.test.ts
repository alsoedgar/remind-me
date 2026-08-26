import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  CalendarSnapshotRequest,
  EventForm,
  FlexModelChatRequest,
  FlexModelPlan,
  FlexModelPlanContext
} from '@remind-me/contracts'
import { RemindSpeakPlanner } from '@remind-me/model-runtime'
import {
  groundFlexiblePlan,
  PersistentAssistantService,
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

afterEach(async () => {
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
  })

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

      const secondRoom = await assistant.send({
        conversationId: second.conversation.id,
        text: 'where is that one?',
        range
      })
      expect(secondRoom.response.text).toBe('Calculus III — SES 130.')
    } finally {
      repository.close()
      vi.useRealTimers()
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
        text: 'Delete them',
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
        'Could you add guitar practice for the ninth day of September at half past two on M, W, and F?'
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
                whenText: '9/9 at 2:30 PM',
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

  it('uses normalized fallback language to move an existing event while preserving duration', async () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const calendar = new PersistentCalendarService(repository)
      calendar.saveEvent(overlappingEvent('Design review', '14:00', '15:30'), range)
      const text =
        'Can you reschedule Design review for the ninth day of September at half past two?'
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
              whenText: 'the ninth day of September at half past two',
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
  })

  it('grounds only constrained fallback translations and rebuilds semantic spans', () => {
    const source = 'Add study group on the ninth day of September at half past two on M, W, and F'
    const grounded = groundFlexiblePlan(source, {
      actions: [
        {
          sourceText: source,
          operation: 'event.create',
          titleText: 'study group',
          targetText: null,
          whenText: 'the ninth day of September at half past two',
          normalizedWhenText: '2026-09-09 at 2:30 PM',
          recurrenceText: 'M, W, and F',
          normalizedRecurrenceText: 'weekly on Mon, Wed, Fri'
        }
      ]
    })

    expect(grounded).toHaveLength(1)
    expect(grounded?.[0]).toMatchObject({
      sourceText: source,
      parserText: 'study group 2026-09-09 at 2:30 PM weekly on Mon, Wed, Fri',
      translated: true
    })
    const titleSpan = grounded?.[0]?.prediction.spans.find((span) => span.kind === 'TITLE')
    expect(titleSpan).toEqual({ kind: 'TITLE', start: 0, end: 'study group'.length })
    const repairedRecurrence = groundFlexiblePlan(source, {
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
    })
    expect(repairedRecurrence?.[0]?.parserText).toBe('study group weekly on Mon, Wed, Fri')
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
