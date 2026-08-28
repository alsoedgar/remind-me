import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { CalendarSnapshotRequest, EventForm, ReminderForm } from '@remind-me/contracts'
import { PersistentCalendarService } from './calendar-service'
import { deleteCalendarRecoveryCopies, openCalendarDatabase } from './database-runtime'
import { SqliteCalendarRepository } from './sqlite-repository'
import { databaseSchemaVersion, initialMigrationSql } from './schema'

const range: CalendarSnapshotRequest = {
  rangeStartUtc: '2026-03-01T00:00:00.000Z',
  rangeEndUtc: '2026-04-01T00:00:00.000Z'
}

const eventForm: EventForm = {
  id: null,
  calendarId: null,
  title: 'Tea with Mina',
  description: 'Bring the sketchbook',
  location: 'Sunroom',
  startDate: '2026-03-08',
  startTime: '09:00',
  endDate: '2026-03-08',
  endTime: '10:00',
  timezone: 'America/Chicago',
  allDay: false,
  recurrence: null
}

const reminderForm: ReminderForm = {
  id: null,
  calendarId: null,
  title: 'Water the herbs',
  notes: 'The basil looks thirsty',
  dueDate: '2026-03-09',
  dueTime: '08:15',
  timezone: 'America/Chicago',
  recurrence: null
}

const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

describe('SqliteCalendarRepository', () => {
  it('stores, updates, and atomically undoes calendar mutations', () => {
    const repository = new SqliteCalendarRepository(':memory:')
    const service = new PersistentCalendarService(repository)
    try {
      const created = service.saveEvent(eventForm, range)
      const event = created.snapshot.events[0]
      expect(event?.title).toBe('Tea with Mina')
      expect(event?.startUtc).toBe('2026-03-08T14:00:00.000Z')

      service.saveEvent({ ...eventForm, id: event?.id ?? null, title: 'Tea with Ren' }, range)
      expect(service.getSnapshot(range).events[0]?.title).toBe('Tea with Ren')

      const undone = service.undoLastAction(range)
      expect(undone.snapshot.events[0]?.title).toBe('Tea with Mina')
      expect(undone.receipt.summary).toContain('Undid')
    } finally {
      repository.close()
    }
  })

  it('survives a database close and reopen', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'remind-me-storage-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'calendar.sqlite3')

    const firstRepository = new SqliteCalendarRepository(databasePath)
    new PersistentCalendarService(firstRepository).saveReminder(reminderForm, range)
    firstRepository.close()

    const reopenedRepository = new SqliteCalendarRepository(databasePath)
    try {
      const reminders = reopenedRepository.listReminders()
      expect(reminders).toHaveLength(1)
      expect(reminders[0]?.title).toBe('Water the herbs')
      expect(reopenedRepository.getPreferences().privacyMode).toBe('local-only')
    } finally {
      reopenedRepository.close()
    }
  })

  it('securely clears personal data and reseeds only local defaults', () => {
    const repository = new SqliteCalendarRepository(':memory:')
    const service = new PersistentCalendarService(repository)
    try {
      service.saveEvent(eventForm, range)
      service.saveReminder(reminderForm, range)
      repository.ensureAssistantConversation()

      const deleted = service.deleteAllData(range)
      expect(deleted).toMatchObject({
        eventCount: 1,
        reminderCount: 1,
        conversationCount: 1,
        actionCount: 2,
        recoveryCopiesDeleted: 0
      })
      expect(deleted.snapshot.events).toEqual([])
      expect(deleted.snapshot.reminders).toEqual([])
      expect(deleted.snapshot.canUndo).toBe(false)
      expect(deleted.snapshot.calendars).toHaveLength(1)
      expect(deleted.snapshot.preferences.themeId).toBe('morning-lo-fi')
      expect(deleted.snapshot.preferences).toMatchObject({
        backgroundColor: '#f7f0e3',
        surfaceColor: '#fdfaf3',
        cardColor: '#ebd9c5',
        surfaceStyle: 'paper',
        glassOpacity: 78,
        glassBlur: 26,
        glassSaturation: 122,
        savedThemes: [],
        responseAdaptation: { enabled: true, feedbackCount: 0, entries: [] }
      })
      expect(repository.quickCheck()).toBe('ok')
    } finally {
      repository.close()
    }
  })

  it('preserves a corrupt database and opens a clean recovered store', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'remind-me-recovery-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'calendar.sqlite3')
    await writeFile(databasePath, 'this is not a SQLite database', 'utf8')

    const opened = await openCalendarDatabase(databasePath)
    try {
      expect(opened.status).toMatchObject({
        status: 'recovered',
        schemaVersion: databaseSchemaVersion,
        quickCheck: 'ok',
        recoveryCopyCreated: true
      })
      expect(opened.status.error).toContain('preserved')
      expect(opened.repository.listCalendars()).toHaveLength(1)
      expect(opened.repository.listEvents()).toEqual([])
      const files = await readdir(directory)
      expect(files.some((file) => file.startsWith('calendar.sqlite3.recovery-'))).toBe(true)
    } finally {
      opened.repository.close()
    }
  })

  it('removes only app-owned database recovery files after explicit data erasure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'remind-me-recovery-delete-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'calendar.sqlite3')
    await Promise.all([
      writeFile(`${databasePath}.recovery-2026-03-01`, 'private database bytes'),
      writeFile(`${databasePath}.recovery-2026-03-01-wal`, 'private WAL bytes'),
      writeFile(join(directory, 'another.sqlite3.recovery-2026-03-01'), 'unrelated')
    ])

    expect(await deleteCalendarRecoveryCopies(databasePath)).toBe(2)
    expect(await readdir(directory)).toEqual(['another.sqlite3.recovery-2026-03-01'])
  })

  it('migrates a Phase 1 database without losing its conversation history', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'remind-me-migration-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'calendar.sqlite3')
    const legacySql = initialMigrationSql.replace(
      /CREATE TABLE assistant_proposals \([\s\S]*?CREATE INDEX proposals_conversation_status\s+ON assistant_proposals\(conversation_id, status, created_at\);\s*/u,
      ''
    )
    expect(legacySql).not.toContain('CREATE TABLE assistant_proposals')
    const legacyDatabase = new DatabaseSync(databasePath)
    legacyDatabase.exec(legacySql)
    legacyDatabase.exec('PRAGMA user_version = 1')
    legacyDatabase
      .prepare(
        `INSERT INTO conversations (id, title, created_at, updated_at)
         VALUES ('conversation:legacy', 'Earlier chat', '2026-03-01T12:00:00.000Z', '2026-03-01T12:00:00.000Z')`
      )
      .run()
    legacyDatabase
      .prepare(
        `INSERT INTO conversation_turns
          (id, conversation_id, role, input_kind, text, request_id, created_at)
         VALUES (
           'turn:legacy', 'conversation:legacy', 'user', 'text', 'Earlier message', NULL,
           '2026-03-01T12:00:00.000Z'
         )`
      )
      .run()
    legacyDatabase.close()

    const migratedRepository = new SqliteCalendarRepository(databasePath)
    try {
      const conversation = migratedRepository.getAssistantConversation('conversation:legacy')
      expect(conversation.turns[0]?.text).toBe('Earlier message')
      expect(conversation.activeProposal).toBeNull()
    } finally {
      migratedRepository.close()
    }

    const verificationDatabase = new DatabaseSync(databasePath, { readOnly: true })
    try {
      const version = verificationDatabase.prepare('PRAGMA user_version').get() as {
        user_version: number
      }
      const proposalTable = verificationDatabase
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'assistant_proposals'"
        )
        .get()
      expect(version.user_version).toBe(databaseSchemaVersion)
      expect(proposalTable).toBeTruthy()
    } finally {
      verificationDatabase.close()
    }
  })

  it('migrates a version 2 database to durable dialogue state without changing user data', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'remind-me-dialogue-migration-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'calendar.sqlite3')
    const legacyDatabase = new DatabaseSync(databasePath)
    legacyDatabase.exec(initialMigrationSql)
    legacyDatabase.exec('DROP TABLE assistant_dialogue_state')
    legacyDatabase.exec('PRAGMA user_version = 2')
    legacyDatabase
      .prepare(
        `INSERT INTO conversations (id, title, created_at, updated_at)
         VALUES ('conversation:v2', 'Version two chat', ?, ?)`
      )
      .run('2026-03-01T12:00:00.000Z', '2026-03-01T12:00:00.000Z')
    legacyDatabase.close()

    const migratedRepository = new SqliteCalendarRepository(databasePath)
    try {
      const conversation = migratedRepository.getAssistantConversation('conversation:v2')
      expect(conversation.title).toBe('Version two chat')
      expect(conversation.dialogueState).toMatchObject({
        version: 2,
        focusedEventIds: [],
        focusedReminderIds: [],
        lastQuery: null,
        pendingClarification: null,
        queryFrames: [],
        activeQueryFrameId: null
      })
      expect(migratedRepository.getSchemaVersion()).toBe(databaseSchemaVersion)
    } finally {
      migratedRepository.close()
    }
  })

  it('upgrades a persisted v1 dialogue payload in place without losing focus', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'remind-me-dialogue-payload-upgrade-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'calendar.sqlite3')
    const firstRepository = new SqliteCalendarRepository(databasePath)
    const saved = new PersistentCalendarService(firstRepository).saveEvent(eventForm, range)
    const eventId = saved.snapshot.events[0]?.id
    if (!eventId) throw new Error('Expected a saved event')
    firstRepository.ensureAssistantConversation('conversation:v1-payload')
    firstRepository.close()

    const legacyDatabase = new DatabaseSync(databasePath)
    legacyDatabase
      .prepare(
        `UPDATE assistant_dialogue_state SET payload_json = ?, updated_at = ?
         WHERE conversation_id = 'conversation:v1-payload'`
      )
      .run(
        JSON.stringify({
          version: 1,
          focusedEventIds: [eventId],
          focusedReminderIds: [],
          lastResultEventIds: [eventId],
          lastResultReminderIds: [],
          lastQuery: {
            requestId: 'request:v1-payload',
            operation: 'calendar.list',
            sourceText: 'What do I have on March 8?',
            rangeStartUtc: '2026-03-08T00:00:00.000Z',
            rangeEndUtc: '2026-03-09T00:00:00.000Z',
            queryText: null,
            answeredAt: '2026-03-01T12:00:00.000Z'
          },
          activeRange: {
            rangeStartUtc: '2026-03-08T00:00:00.000Z',
            rangeEndUtc: '2026-03-09T00:00:00.000Z',
            timezone: 'America/Chicago'
          },
          pendingClarification: null,
          updatedAt: '2026-03-01T12:00:00.000Z'
        }),
        '2026-03-01T12:00:00.000Z'
      )
    legacyDatabase.close()

    const reopenedRepository = new SqliteCalendarRepository(databasePath)
    try {
      const state = reopenedRepository.getAssistantDialogueState('conversation:v1-payload')
      expect(state).toMatchObject({
        version: 2,
        focusedEventIds: [eventId],
        activeQueryFrameId: 'frame:request:v1-payload'
      })
      expect(state.queryFrames[0]).toMatchObject({
        orderedItems: [{ kind: 'event', id: eventId, occurrenceStart: null }],
        selectedItems: [{ kind: 'event', id: eventId, occurrenceStart: null }]
      })
    } finally {
      reopenedRepository.close()
    }

    const verificationDatabase = new DatabaseSync(databasePath, { readOnly: true })
    try {
      const row = verificationDatabase
        .prepare(
          `SELECT payload_json FROM assistant_dialogue_state
           WHERE conversation_id = 'conversation:v1-payload'`
        )
        .get() as { payload_json: string }
      expect(JSON.parse(row.payload_json)).toMatchObject({ version: 2 })
    } finally {
      verificationDatabase.close()
    }
  })

  it('migrates a version 3 database to document identities without changing events', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'remind-me-document-identity-migration-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'calendar.sqlite3')
    const legacyDatabase = new DatabaseSync(databasePath)
    legacyDatabase.exec(initialMigrationSql)
    legacyDatabase.exec('DROP TABLE document_import_identities')
    legacyDatabase.exec('PRAGMA user_version = 3')
    legacyDatabase
      .prepare(
        `INSERT INTO calendars (
          id, name, color, timezone, is_default, created_at, updated_at
        ) VALUES ('calendar:legacy', 'Legacy', '#abc123', 'America/Chicago', 1, ?, ?)`
      )
      .run('2026-03-01T12:00:00.000Z', '2026-03-01T12:00:00.000Z')
    legacyDatabase
      .prepare(
        `INSERT INTO events (
          id, calendar_id, title, description, location, start_utc, end_utc, timezone,
          all_day, recurrence_json, status, provenance, created_at, updated_at
        ) VALUES (
          'event:legacy', 'calendar:legacy', 'Legacy class', '', 'SES 130',
          '2026-03-08T14:00:00.000Z', '2026-03-08T15:00:00.000Z',
          'America/Chicago', 0, NULL, 'active', 'import', ?, ?
        )`
      )
      .run('2026-03-01T12:00:00.000Z', '2026-03-01T12:00:00.000Z')
    legacyDatabase.close()

    const migratedRepository = new SqliteCalendarRepository(databasePath)
    try {
      expect(migratedRepository.getSchemaVersion()).toBe(databaseSchemaVersion)
      expect(migratedRepository.getEvent('event:legacy')).toMatchObject({
        title: 'Legacy class',
        importIdentity: null
      })
    } finally {
      migratedRepository.close()
    }

    const verificationDatabase = new DatabaseSync(databasePath, { readOnly: true })
    try {
      const identityTable = verificationDatabase
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'document_import_identities'"
        )
        .get()
      expect(identityTable).toBeTruthy()
    } finally {
      verificationDatabase.close()
    }
  })

  it('records one notification delivery per reminder due time', () => {
    const repository = new SqliteCalendarRepository(':memory:')
    const service = new PersistentCalendarService(repository)
    try {
      const saved = service.saveReminder(reminderForm, range)
      const reminder = saved.snapshot.reminders[0]
      expect(repository.listPendingReminderNotifications()).toHaveLength(1)
      if (!reminder) throw new Error('Expected a reminder')
      repository.recordReminderNotification(
        reminder.id,
        reminder.dueAtUtc,
        '2026-03-09T14:16:00.000Z'
      )
      repository.recordReminderNotification(
        reminder.id,
        reminder.dueAtUtc,
        '2026-03-09T14:17:00.000Z'
      )
      expect(repository.listPendingReminderNotifications()).toHaveLength(0)

      service.saveEvent(eventForm, range)
      service.undoLastAction(range)
      expect(repository.listPendingReminderNotifications()).toHaveLength(0)

      service.deleteReminder(reminder.id, range)
      service.undoLastAction(range)
      expect(repository.listPendingReminderNotifications()).toHaveLength(0)
    } finally {
      repository.close()
    }
  })

  it('checks conflicts while allowing an edited event to exclude itself', () => {
    const repository = new SqliteCalendarRepository(':memory:')
    const service = new PersistentCalendarService(repository)
    try {
      const saved = service.saveEvent(eventForm, range)
      const event = saved.snapshot.events[0]
      if (!event) throw new Error('Expected an event')
      const query = {
        rangeStartUtc: '2026-03-08T14:15:00.000Z',
        rangeEndUtc: '2026-03-08T14:45:00.000Z'
      }
      expect(service.checkAvailability({ ...query, excludeEventId: null }).free).toBe(false)
      expect(service.checkAvailability({ ...query, excludeEventId: event.id }).free).toBe(true)
    } finally {
      repository.close()
    }
  })

  it('advances a recurring reminder in wall time and completes its final count', () => {
    const repository = new SqliteCalendarRepository(':memory:')
    const service = new PersistentCalendarService(repository)
    try {
      const created = service.saveReminder(
        {
          ...reminderForm,
          dueDate: '2026-03-07',
          dueTime: '09:00',
          recurrence: {
            frequency: 'daily',
            interval: 1,
            byWeekday: [],
            byMonthDay: [],
            end: { kind: 'count', count: 2 }
          }
        },
        range
      )
      const reminder = created.snapshot.reminders[0]
      if (!reminder) throw new Error('Expected a recurring reminder')

      const advanced = service.completeReminder(reminder.id, range).snapshot.reminders[0]
      expect(advanced).toMatchObject({
        status: 'active',
        dueAtUtc: '2026-03-08T14:00:00.000Z',
        recurrence: { end: { kind: 'count', count: 1 } }
      })

      const completed = service.completeReminder(reminder.id, range).snapshot.reminders[0]
      expect(completed?.status).toBe('completed')
      expect(completed?.completedAt).not.toBeNull()
    } finally {
      repository.close()
    }
  })

  it('creates and restores a portable backup without replacing local data', () => {
    const sourceRepository = new SqliteCalendarRepository(':memory:')
    const targetRepository = new SqliteCalendarRepository(':memory:')
    try {
      const sourceService = new PersistentCalendarService(sourceRepository)
      const savedEvent = sourceService.saveEvent(eventForm, range).snapshot.events[0]
      if (!savedEvent) throw new Error('Expected a source event')
      sourceRepository.saveRecurrenceException(
        {
          id: 'exception:backup',
          parentEventId: savedEvent.id,
          originalDate: '2026-03-15',
          kind: 'cancelled',
          replacementEventId: null,
          createdAt: '2026-03-01T12:00:00.000Z'
        },
        'Skipped one occurrence.'
      )
      sourceService.saveReminder(reminderForm, range)
      sourceService.updatePreferences({ themeId: 'soft-sunset' })
      const backup = sourceService.createBackup()

      const imported = new PersistentCalendarService(targetRepository).importBackup(backup, range)
      expect(imported.snapshot.events.map((event) => event.title)).toEqual(['Tea with Mina'])
      expect(imported.snapshot.reminders.map((reminder) => reminder.title)).toEqual([
        'Water the herbs'
      ])
      expect(imported.snapshot.events[0]?.id).not.toBe(backup.events[0]?.id)
      expect(targetRepository.listRecurrenceExceptions()).toMatchObject([
        {
          originalDate: '2026-03-15',
          kind: 'cancelled',
          parentEventId: imported.snapshot.events[0]?.id
        }
      ])
      expect(targetRepository.getPreferences().themeId).toBe('soft-sunset')
      expect(imported.receipt.undoable).toBe(true)
      const undone = new PersistentCalendarService(targetRepository).undoLastAction(range)
      expect(undone.snapshot.events).toEqual([])
      expect(undone.snapshot.reminders).toEqual([])
      expect(targetRepository.getPreferences().themeId).toBe('morning-lo-fi')
    } finally {
      sourceRepository.close()
      targetRepository.close()
    }
  })
})
