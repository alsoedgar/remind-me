import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import {
  actionHistoryEntitySchema,
  assistantConversationSchema,
  assistantDialogueStateSchema,
  assistantProposalSchema,
  calendarEntitySchema,
  conversationTurnEntitySchema,
  documentImportIdentitySchema,
  emptyAssistantDialogueState,
  eventEntitySchema,
  preferencesEntitySchema,
  recurrenceExceptionEntitySchema,
  recurrenceRuleSchema,
  reminderEntitySchema,
  upgradeAssistantDialogueState,
  type ActionHistoryEntity,
  type AssistantConversation,
  type AssistantDialogueState,
  type AssistantProposal,
  type AssistantProposalStatus,
  type CalendarEntity,
  type CalendarOperation,
  type ConversationTurnEntity,
  type DocumentImportIdentity,
  type EventEntity,
  type MutationReceipt,
  type PreferencesEntity,
  type RecurrenceExceptionEntity,
  type ReminderEntity,
  type RiskLevel
} from '@remind-me/contracts'
import {
  databaseSchemaVersion,
  initialMigrationSql,
  fourthMigrationSql,
  secondMigrationSql,
  thirdMigrationSql
} from './schema'

interface DatabaseRow {
  [key: string]: unknown
}

interface UndoState {
  events: EventEntity[]
  reminders: ReminderEntity[]
  recurrenceExceptions: RecurrenceExceptionEntity[]
  preferences?: PreferencesEntity
  notificationDeliveries?: NotificationDelivery[]
}

interface NotificationDelivery {
  reminderId: string
  dueAtUtc: string
  deliveredAt: string
}

interface MutationMetadata {
  operation: CalendarOperation
  risk: RiskLevel
  actor: 'manual' | 'assistant' | 'import'
  summary: string
  assistantProposalId: string | null
}

function stringValue(row: DatabaseRow, key: string): string {
  const value = row[key]
  if (typeof value !== 'string') throw new Error(`Expected ${key} to be a string`)
  return value
}

function nullableString(row: DatabaseRow, key: string): string | null {
  const value = row[key]
  if (value === null) return null
  if (typeof value !== 'string') throw new Error(`Expected ${key} to be a string or null`)
  return value
}

function booleanValue(row: DatabaseRow, key: string): boolean {
  const value = row[key]
  if (value !== 0 && value !== 1) throw new Error(`Expected ${key} to be a SQLite boolean`)
  return value === 1
}

function jsonRecurrence(value: string | null): EventEntity['recurrence'] {
  return recurrenceRuleSchema.nullable().parse(value ? JSON.parse(value) : null)
}

function jsonDocumentImportIdentity(value: unknown): DocumentImportIdentity | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') throw new Error('Expected import_identity_json to be text')
  return documentImportIdentitySchema.parse(JSON.parse(value))
}

function mapCalendar(row: DatabaseRow): CalendarEntity {
  return calendarEntitySchema.parse({
    id: stringValue(row, 'id'),
    name: stringValue(row, 'name'),
    color: stringValue(row, 'color'),
    timezone: stringValue(row, 'timezone'),
    isDefault: booleanValue(row, 'is_default'),
    createdAt: stringValue(row, 'created_at'),
    updatedAt: stringValue(row, 'updated_at')
  })
}

function mapEvent(row: DatabaseRow): EventEntity {
  return eventEntitySchema.parse({
    id: stringValue(row, 'id'),
    calendarId: stringValue(row, 'calendar_id'),
    title: stringValue(row, 'title'),
    description: stringValue(row, 'description'),
    location: stringValue(row, 'location'),
    startUtc: stringValue(row, 'start_utc'),
    endUtc: stringValue(row, 'end_utc'),
    timezone: stringValue(row, 'timezone'),
    allDay: booleanValue(row, 'all_day'),
    recurrence: jsonRecurrence(nullableString(row, 'recurrence_json')),
    status: stringValue(row, 'status'),
    provenance: stringValue(row, 'provenance'),
    importIdentity: jsonDocumentImportIdentity(row.import_identity_json),
    createdAt: stringValue(row, 'created_at'),
    updatedAt: stringValue(row, 'updated_at')
  })
}

function mapReminder(row: DatabaseRow): ReminderEntity {
  return reminderEntitySchema.parse({
    id: stringValue(row, 'id'),
    calendarId: stringValue(row, 'calendar_id'),
    title: stringValue(row, 'title'),
    notes: stringValue(row, 'notes'),
    dueAtUtc: stringValue(row, 'due_at_utc'),
    timezone: stringValue(row, 'timezone'),
    recurrence: jsonRecurrence(nullableString(row, 'recurrence_json')),
    status: stringValue(row, 'status'),
    completedAt: nullableString(row, 'completed_at'),
    provenance: stringValue(row, 'provenance'),
    importIdentity: jsonDocumentImportIdentity(row.import_identity_json),
    createdAt: stringValue(row, 'created_at'),
    updatedAt: stringValue(row, 'updated_at')
  })
}

function mapException(row: DatabaseRow): RecurrenceExceptionEntity {
  return recurrenceExceptionEntitySchema.parse({
    id: stringValue(row, 'id'),
    parentEventId: stringValue(row, 'parent_event_id'),
    originalDate: stringValue(row, 'original_date'),
    kind: stringValue(row, 'kind'),
    replacementEventId: nullableString(row, 'replacement_event_id'),
    createdAt: stringValue(row, 'created_at')
  })
}

function mapAction(row: DatabaseRow): ActionHistoryEntity {
  return actionHistoryEntitySchema.parse({
    id: stringValue(row, 'id'),
    requestId: stringValue(row, 'request_id'),
    transactionId: nullableString(row, 'transaction_id'),
    actor: stringValue(row, 'actor'),
    operation: stringValue(row, 'operation'),
    risk: stringValue(row, 'risk'),
    status: stringValue(row, 'status'),
    beforeStateJson: stringValue(row, 'before_state_json'),
    afterStateJson: stringValue(row, 'after_state_json'),
    reversible: booleanValue(row, 'reversible'),
    createdAt: stringValue(row, 'created_at'),
    appliedAt: nullableString(row, 'applied_at'),
    undoneAt: nullableString(row, 'undone_at')
  })
}

function mapConversationTurn(row: DatabaseRow): ConversationTurnEntity {
  return conversationTurnEntitySchema.parse({
    id: stringValue(row, 'id'),
    conversationId: stringValue(row, 'conversation_id'),
    role: stringValue(row, 'role'),
    inputKind: stringValue(row, 'input_kind'),
    text: stringValue(row, 'text'),
    requestId: nullableString(row, 'request_id'),
    createdAt: stringValue(row, 'created_at')
  })
}

function mapAssistantProposal(row: DatabaseRow): AssistantProposal {
  return assistantProposalSchema.parse({
    id: stringValue(row, 'id'),
    conversationId: stringValue(row, 'conversation_id'),
    requestId: stringValue(row, 'request_id'),
    operation: stringValue(row, 'operation'),
    risk: stringValue(row, 'risk'),
    status: stringValue(row, 'status'),
    payload: JSON.parse(stringValue(row, 'payload_json')),
    resolvedCommand: JSON.parse(stringValue(row, 'resolved_command_json')),
    summary: stringValue(row, 'summary'),
    requiresConfirmation: booleanValue(row, 'requires_confirmation'),
    sourceText: stringValue(row, 'source_text'),
    createdAt: stringValue(row, 'created_at'),
    updatedAt: stringValue(row, 'updated_at')
  })
}

function defaultPreferences(timezone: string, now: string): PreferencesEntity {
  return preferencesEntitySchema.parse({
    id: 'local',
    themeId: 'morning-lo-fi',
    accentColor: '#c08a6e',
    backgroundColor: '#f7f0e3',
    surfaceColor: '#fdfaf3',
    cardColor: '#ebd9c5',
    textColor: '#3c2f2f',
    mutedTextColor: '#6f5b50',
    borderColor: '#3c2f2f',
    surfaceStyle: 'paper',
    glassOpacity: 78,
    glassBlur: 26,
    glassSaturation: 122,
    savedThemes: [],
    density: 'comfortable',
    weekStartsOn: 'monday',
    locale: Intl.DateTimeFormat().resolvedOptions().locale || 'en-US',
    timezone,
    reduceMotion: false,
    notificationsEnabled: true,
    launchAtLogin: false,
    startupWindowMode: 'glance',
    privacyMode: 'local-only',
    responseStyle: {
      warmth: 0.86,
      brevity: 0.58,
      formality: 0.12,
      humor: 0.16,
      emoji: 0,
      contractions: true,
      proactivity: 0.56
    },
    assistantProfile: {
      preferredName: '',
      customInstructions: '',
      memoryEnabled: true,
      memories: []
    },
    responseAdaptation: {
      enabled: true,
      feedbackCount: 0,
      entries: []
    },
    updatedAt: now
  })
}

export class SqliteCalendarRepository {
  readonly databasePath: string
  private readonly database: DatabaseSync

  constructor(databasePath: string) {
    this.databasePath = databasePath
    this.database = new DatabaseSync(databasePath, { timeout: 5_000, defensive: true })
    try {
      this.database.exec(
        'PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA secure_delete = ON; PRAGMA trusted_schema = OFF;'
      )
      if (databasePath !== ':memory:') this.database.exec('PRAGMA journal_mode = WAL;')
      this.migrate()
      this.seedDefaults()
      this.quickCheck()
    } catch (error) {
      if (this.database.isOpen) this.database.close()
      throw error
    }
  }

  close(): void {
    if (this.database.isOpen) this.database.close()
  }

  getSchemaVersion(): number {
    const row = this.database.prepare('PRAGMA user_version').get() as DatabaseRow
    return Number(row.user_version)
  }

  quickCheck(): 'ok' {
    const rows = this.database.prepare('PRAGMA quick_check').all() as DatabaseRow[]
    const results = rows.map((row) => String(row.quick_check ?? 'unknown'))
    if (results.length !== 1 || results[0] !== 'ok') {
      throw new Error(`SQLite quick check failed: ${results.join('; ')}`)
    }
    return 'ok'
  }

  deleteAllData(): {
    deletedAt: string
    eventCount: number
    reminderCount: number
    conversationCount: number
    actionCount: number
  } {
    const count = (table: string): number => {
      const row = this.database
        .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
        .get() as DatabaseRow
      return Number(row.count)
    }
    const result = {
      deletedAt: new Date().toISOString(),
      eventCount: count('events'),
      reminderCount: count('reminders'),
      conversationCount: count('conversations'),
      actionCount: count('action_history')
    }
    this.database.exec('BEGIN IMMEDIATE')
    try {
      this.database.exec(`
        DELETE FROM attachments;
        DELETE FROM conversations;
        DELETE FROM document_import_identities;
        DELETE FROM calendars;
        DELETE FROM action_history;
        DELETE FROM preferences;
      `)
      this.seedDefaults()
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
    if (this.databasePath !== ':memory:') {
      this.database.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM;')
    }
    this.quickCheck()
    return result
  }

  listCalendars(): CalendarEntity[] {
    return (
      this.database
        .prepare('SELECT * FROM calendars ORDER BY is_default DESC, name')
        .all() as DatabaseRow[]
    ).map(mapCalendar)
  }

  listEvents(): EventEntity[] {
    return (
      this.database
        .prepare(
          `SELECT events.*, document_import_identities.identity_json AS import_identity_json
           FROM events
           LEFT JOIN document_import_identities
             ON document_import_identities.entity_kind = 'event'
            AND document_import_identities.entity_id = events.id
           ORDER BY events.start_utc, events.title`
        )
        .all() as DatabaseRow[]
    ).map(mapEvent)
  }

  getEvent(id: string): EventEntity | null {
    const row = this.database
      .prepare(
        `SELECT events.*, document_import_identities.identity_json AS import_identity_json
         FROM events
         LEFT JOIN document_import_identities
           ON document_import_identities.entity_kind = 'event'
          AND document_import_identities.entity_id = events.id
         WHERE events.id = ?`
      )
      .get(id) as DatabaseRow | undefined
    return row ? mapEvent(row) : null
  }

  listReminders(): ReminderEntity[] {
    return (
      this.database
        .prepare(
          `SELECT reminders.*, document_import_identities.identity_json AS import_identity_json
           FROM reminders
           LEFT JOIN document_import_identities
             ON document_import_identities.entity_kind = 'reminder'
            AND document_import_identities.entity_id = reminders.id
           ORDER BY reminders.due_at_utc, reminders.title`
        )
        .all() as DatabaseRow[]
    ).map(mapReminder)
  }

  getReminder(id: string): ReminderEntity | null {
    const row = this.database
      .prepare(
        `SELECT reminders.*, document_import_identities.identity_json AS import_identity_json
         FROM reminders
         LEFT JOIN document_import_identities
           ON document_import_identities.entity_kind = 'reminder'
          AND document_import_identities.entity_id = reminders.id
         WHERE reminders.id = ?`
      )
      .get(id) as DatabaseRow | undefined
    return row ? mapReminder(row) : null
  }

  ensureAssistantConversation(
    id = 'conversation:local',
    title = 'My local assistant'
  ): AssistantConversation {
    const now = new Date().toISOString()
    this.database
      .prepare(
        `INSERT OR IGNORE INTO conversations (id, title, created_at, updated_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(id, title, now, now)
    return this.getAssistantConversation(id)
  }

  getAssistantConversation(id: string): AssistantConversation {
    const row = this.database.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as
      DatabaseRow | undefined
    if (!row) throw new Error(`Conversation ${id} was not found`)
    return assistantConversationSchema.parse({
      id: stringValue(row, 'id'),
      title: stringValue(row, 'title'),
      turns: this.listConversationTurns(id),
      activeProposal: this.getActiveAssistantProposal(id),
      dialogueState: this.getAssistantDialogueState(id),
      createdAt: stringValue(row, 'created_at'),
      updatedAt: stringValue(row, 'updated_at')
    })
  }

  listConversationTurns(conversationId: string, limit = 200): ConversationTurnEntity[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM (
           SELECT *, rowid AS turn_rowid FROM conversation_turns
           WHERE conversation_id = ?
           ORDER BY rowid DESC LIMIT ?
         ) ORDER BY turn_rowid`
      )
      .all(conversationId, limit) as DatabaseRow[]
    return rows.map(mapConversationTurn)
  }

  appendConversationTurn(inputTurn: ConversationTurnEntity): ConversationTurnEntity {
    const turn = conversationTurnEntitySchema.parse(inputTurn)
    this.database
      .prepare(
        `INSERT INTO conversation_turns
          (id, conversation_id, role, input_kind, text, request_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        turn.id,
        turn.conversationId,
        turn.role,
        turn.inputKind,
        turn.text,
        turn.requestId,
        turn.createdAt
      )
    this.database
      .prepare('UPDATE conversations SET updated_at = ? WHERE id = ?')
      .run(turn.createdAt, turn.conversationId)
    return turn
  }

  clearAssistantConversation(id: string): void {
    this.database.prepare('DELETE FROM conversations WHERE id = ?').run(id)
  }

  getAssistantDialogueState(conversationId: string): AssistantDialogueState {
    const now = new Date().toISOString()
    this.database
      .prepare(
        `INSERT OR IGNORE INTO assistant_dialogue_state
          (conversation_id, payload_json, updated_at) VALUES (?, ?, ?)`
      )
      .run(conversationId, JSON.stringify(emptyAssistantDialogueState(now)), now)
    const row = this.database
      .prepare('SELECT payload_json FROM assistant_dialogue_state WHERE conversation_id = ?')
      .get(conversationId) as DatabaseRow | undefined
    if (!row) throw new Error(`Dialogue state for ${conversationId} was not found`)
    const rawPayload: unknown = JSON.parse(stringValue(row, 'payload_json'))
    const stored = upgradeAssistantDialogueState(rawPayload, now)
    const eventIds = new Set(
      (this.database.prepare('SELECT id FROM events').all() as DatabaseRow[]).map((event) =>
        stringValue(event, 'id')
      )
    )
    const reminderIds = new Set(
      (this.database.prepare('SELECT id FROM reminders').all() as DatabaseRow[]).map((reminder) =>
        stringValue(reminder, 'id')
      )
    )
    const queryFrames = stored.queryFrames.map((frame) => {
      const exists = (item: (typeof frame.orderedItems)[number]): boolean =>
        item.kind === 'event' ? eventIds.has(item.id) : reminderIds.has(item.id)
      const orderedItems = frame.orderedItems.filter(exists)
      const retainedKeys = new Set(
        orderedItems.map((item) => `${item.kind}:${item.id}:${item.occurrenceStart ?? ''}`)
      )
      const selectedItems = frame.selectedItems.filter((item) =>
        retainedKeys.has(`${item.kind}:${item.id}:${item.occurrenceStart ?? ''}`)
      )
      const cursorItem =
        frame.resultCursor === null ? null : (frame.orderedItems[frame.resultCursor] ?? null)
      const resultCursor = cursorItem
        ? orderedItems.findIndex(
            (item) =>
              item.kind === cursorItem.kind &&
              item.id === cursorItem.id &&
              item.occurrenceStart === cursorItem.occurrenceStart
          )
        : null
      const continuationItem =
        frame.continuationCursor === null
          ? null
          : (frame.selectedItems.slice(frame.continuationCursor).find(exists) ?? null)
      const continuationCursor = continuationItem
        ? selectedItems.findIndex(
            (item) =>
              item.kind === continuationItem.kind &&
              item.id === continuationItem.id &&
              item.occurrenceStart === continuationItem.occurrenceStart
          )
        : null
      return {
        ...frame,
        orderedItems,
        selectedItems,
        resultCursor: resultCursor === -1 ? null : resultCursor,
        continuationCursor: continuationCursor === -1 ? null : continuationCursor
      }
    })
    const pruned = assistantDialogueStateSchema.parse({
      ...stored,
      focusedEventIds: stored.focusedEventIds.filter((id) => eventIds.has(id)),
      focusedReminderIds: stored.focusedReminderIds.filter((id) => reminderIds.has(id)),
      lastResultEventIds: stored.lastResultEventIds.filter((id) => eventIds.has(id)),
      lastResultReminderIds: stored.lastResultReminderIds.filter((id) => reminderIds.has(id)),
      queryFrames
    })
    if (
      JSON.stringify(pruned) !== JSON.stringify(stored) ||
      JSON.stringify(stored) !== JSON.stringify(rawPayload)
    ) {
      return this.saveAssistantDialogueState(conversationId, { ...pruned, updatedAt: now })
    }
    return pruned
  }

  saveAssistantDialogueState(
    conversationId: string,
    inputState: AssistantDialogueState
  ): AssistantDialogueState {
    const state = assistantDialogueStateSchema.parse(inputState)
    this.database
      .prepare(
        `INSERT INTO assistant_dialogue_state (conversation_id, payload_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(conversation_id) DO UPDATE SET
           payload_json = excluded.payload_json,
           updated_at = excluded.updated_at`
      )
      .run(conversationId, JSON.stringify(state), state.updatedAt)
    return state
  }

  getAssistantProposal(id: string): AssistantProposal | null {
    const row = this.database.prepare('SELECT * FROM assistant_proposals WHERE id = ?').get(id) as
      DatabaseRow | undefined
    return row ? mapAssistantProposal(row) : null
  }

  getActiveAssistantProposal(conversationId: string): AssistantProposal | null {
    const row = this.database
      .prepare(
        `SELECT * FROM assistant_proposals
         WHERE conversation_id = ? AND status = 'pending'
         ORDER BY rowid DESC LIMIT 1`
      )
      .get(conversationId) as DatabaseRow | undefined
    return row ? mapAssistantProposal(row) : null
  }

  saveAssistantProposal(inputProposal: AssistantProposal): AssistantProposal {
    const proposal = assistantProposalSchema.parse(inputProposal)
    this.database.exec('BEGIN IMMEDIATE')
    try {
      this.database
        .prepare(
          `UPDATE assistant_proposals SET status = 'rejected', updated_at = ?
           WHERE conversation_id = ? AND status = 'pending' AND id <> ?`
        )
        .run(proposal.createdAt, proposal.conversationId, proposal.id)
      this.database
        .prepare(
          `INSERT INTO assistant_proposals (
            id, conversation_id, request_id, operation, risk, status, payload_json,
            resolved_command_json, summary, requires_confirmation, source_text, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            status = excluded.status,
            payload_json = excluded.payload_json,
            resolved_command_json = excluded.resolved_command_json,
            summary = excluded.summary,
            requires_confirmation = excluded.requires_confirmation,
            updated_at = excluded.updated_at`
        )
        .run(
          proposal.id,
          proposal.conversationId,
          proposal.requestId,
          proposal.operation,
          proposal.risk,
          proposal.status,
          JSON.stringify(proposal.payload),
          JSON.stringify(proposal.resolvedCommand),
          proposal.summary,
          proposal.requiresConfirmation ? 1 : 0,
          proposal.sourceText,
          proposal.createdAt,
          proposal.updatedAt
        )
      this.database.exec('COMMIT')
      return proposal
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  setAssistantProposalStatus(
    id: string,
    status: AssistantProposalStatus,
    updatedAt = new Date().toISOString()
  ): AssistantProposal {
    const result = this.database
      .prepare('UPDATE assistant_proposals SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, updatedAt, id)
    if (result.changes !== 1) throw new Error(`Assistant proposal ${id} was not found`)
    const proposal = this.getAssistantProposal(id)
    if (!proposal) throw new Error(`Assistant proposal ${id} was not found after update`)
    return proposal
  }

  listRecurrenceExceptions(): RecurrenceExceptionEntity[] {
    return (
      this.database
        .prepare('SELECT * FROM recurrence_exceptions ORDER BY original_date')
        .all() as DatabaseRow[]
    ).map(mapException)
  }

  getPreferences(): PreferencesEntity {
    const row = this.database
      .prepare("SELECT payload_json FROM preferences WHERE id = 'local'")
      .get() as DatabaseRow | undefined
    if (!row) throw new Error('Local preferences are missing')
    return preferencesEntitySchema.parse(JSON.parse(stringValue(row, 'payload_json')))
  }

  updatePreferences(preferences: PreferencesEntity): PreferencesEntity {
    const validated = preferencesEntitySchema.parse(preferences)
    this.writePreferences(validated)
    return validated
  }

  canUndo(): boolean {
    return Boolean(
      this.database
        .prepare(
          "SELECT id FROM action_history WHERE status = 'applied' AND reversible = 1 ORDER BY rowid DESC LIMIT 1"
        )
        .get()
    )
  }

  saveEvent(
    event: EventEntity,
    operation: 'event.create' | 'event.update' | 'event.move' | 'event.duplicate',
    summary: string,
    actor: MutationMetadata['actor'] = 'manual',
    assistantProposalId: string | null = null
  ): MutationReceipt {
    const validated = eventEntitySchema.parse(event)
    return this.applyMutation(
      {
        operation,
        risk: operation === 'event.move' ? 'medium' : 'low',
        actor,
        summary,
        assistantProposalId
      },
      () => this.writeEvent(validated)
    )
  }

  deleteEvent(
    id: string,
    summary: string,
    actor: MutationMetadata['actor'] = 'manual',
    assistantProposalId: string | null = null
  ): MutationReceipt {
    return this.applyMutation(
      {
        operation: 'event.delete',
        risk: 'destructive',
        actor,
        summary,
        assistantProposalId
      },
      () => {
        this.database
          .prepare(
            "DELETE FROM document_import_identities WHERE entity_kind = 'event' AND entity_id = ?"
          )
          .run(id)
        this.database.prepare('DELETE FROM events WHERE id = ?').run(id)
      }
    )
  }

  saveReminder(
    reminder: ReminderEntity,
    operation: 'reminder.create' | 'reminder.update' | 'reminder.complete',
    summary: string,
    actor: MutationMetadata['actor'] = 'manual',
    assistantProposalId: string | null = null
  ): MutationReceipt {
    const validated = reminderEntitySchema.parse(reminder)
    return this.applyMutation({ operation, risk: 'low', actor, summary, assistantProposalId }, () =>
      this.writeReminder(validated)
    )
  }

  deleteReminder(
    id: string,
    summary: string,
    actor: MutationMetadata['actor'] = 'manual',
    assistantProposalId: string | null = null
  ): MutationReceipt {
    return this.applyMutation(
      {
        operation: 'reminder.delete',
        risk: 'destructive',
        actor,
        summary,
        assistantProposalId
      },
      () => {
        this.database
          .prepare(
            "DELETE FROM document_import_identities WHERE entity_kind = 'reminder' AND entity_id = ?"
          )
          .run(id)
        this.database.prepare('DELETE FROM reminders WHERE id = ?').run(id)
      }
    )
  }

  saveRecurrenceException(
    exception: RecurrenceExceptionEntity,
    summary: string,
    actor: MutationMetadata['actor'] = 'manual'
  ): MutationReceipt {
    const validated = recurrenceExceptionEntitySchema.parse(exception)
    return this.applyMutation(
      {
        operation: 'event.update',
        risk: 'medium',
        actor,
        summary,
        assistantProposalId: null
      },
      () => this.writeException(validated)
    )
  }

  importEntities(
    events: readonly EventEntity[],
    reminders: readonly ReminderEntity[],
    summary: string,
    recurrenceExceptions: readonly RecurrenceExceptionEntity[] = [],
    preferences: PreferencesEntity | null = null
  ): MutationReceipt {
    return this.applyMutation(
      {
        operation: 'import.propose',
        risk: 'medium',
        actor: 'import',
        summary,
        assistantProposalId: null
      },
      () => {
        for (const event of events) this.writeEvent(eventEntitySchema.parse(event))
        for (const reminder of reminders) this.writeReminder(reminderEntitySchema.parse(reminder))
        for (const exception of recurrenceExceptions) {
          this.writeException(recurrenceExceptionEntitySchema.parse(exception))
        }
        if (preferences) this.writePreferences(preferencesEntitySchema.parse(preferences))
      }
    )
  }

  applyEntityBatch(
    batch: {
      events: readonly EventEntity[]
      eventIdsToDelete: readonly string[]
      reminders: readonly ReminderEntity[]
      reminderIdsToDelete: readonly string[]
    },
    operation: CalendarOperation,
    risk: RiskLevel,
    summary: string,
    actor: MutationMetadata['actor'] = 'manual',
    assistantProposalId: string | null = null
  ): MutationReceipt {
    const events = batch.events.map((event) => eventEntitySchema.parse(event))
    const reminders = batch.reminders.map((reminder) => reminderEntitySchema.parse(reminder))
    const eventIdsToDelete = [...new Set(batch.eventIdsToDelete)]
    const reminderIdsToDelete = [...new Set(batch.reminderIdsToDelete)]
    return this.applyMutation({ operation, risk, actor, summary, assistantProposalId }, () => {
      for (const event of events) this.writeEvent(event)
      for (const reminder of reminders) this.writeReminder(reminder)
      for (const id of eventIdsToDelete) {
        this.database
          .prepare(
            "DELETE FROM document_import_identities WHERE entity_kind = 'event' AND entity_id = ?"
          )
          .run(id)
        this.database.prepare('DELETE FROM events WHERE id = ?').run(id)
      }
      for (const id of reminderIdsToDelete) {
        this.database
          .prepare(
            "DELETE FROM document_import_identities WHERE entity_kind = 'reminder' AND entity_id = ?"
          )
          .run(id)
        this.database.prepare('DELETE FROM reminders WHERE id = ?').run(id)
      }
    })
  }

  undoLast(now: string): MutationReceipt {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const row = this.database
        .prepare(
          "SELECT * FROM action_history WHERE status = 'applied' AND reversible = 1 ORDER BY rowid DESC LIMIT 1"
        )
        .get() as DatabaseRow | undefined
      if (!row) throw new Error('There is no action to undo')
      const action = mapAction(row)
      const before = JSON.parse(action.beforeStateJson) as UndoState
      this.restoreUndoState(before)
      this.database
        .prepare("UPDATE action_history SET status = 'undone', undone_at = ? WHERE id = ?")
        .run(now, action.id)
      this.database.exec('COMMIT')
      return {
        actionId: action.id,
        operation: action.operation,
        summary: `Undid: ${this.summaryFromAction(action)}`,
        undoable: false,
        createdAt: now
      }
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  listPendingReminderNotifications(): ReminderEntity[] {
    return (
      this.database
        .prepare(
          `SELECT reminders.*, document_import_identities.identity_json AS import_identity_json
           FROM reminders
           LEFT JOIN document_import_identities
             ON document_import_identities.entity_kind = 'reminder'
            AND document_import_identities.entity_id = reminders.id
           WHERE reminders.status = 'active'
             AND NOT EXISTS (
               SELECT 1 FROM notification_deliveries deliveries
               WHERE deliveries.reminder_id = reminders.id
                 AND deliveries.due_at_utc = reminders.due_at_utc
             )
           ORDER BY reminders.due_at_utc`
        )
        .all() as DatabaseRow[]
    ).map(mapReminder)
  }

  recordReminderNotification(reminderId: string, dueAtUtc: string, deliveredAt: string): void {
    this.database
      .prepare(
        'INSERT OR IGNORE INTO notification_deliveries (reminder_id, due_at_utc, delivered_at) VALUES (?, ?, ?)'
      )
      .run(reminderId, dueAtUtc, deliveredAt)
  }

  private migrate(): void {
    const row = this.database.prepare('PRAGMA user_version').get() as DatabaseRow
    const version = Number(row.user_version)
    if (version > databaseSchemaVersion) {
      throw new Error(
        `Database version ${version} is newer than supported version ${databaseSchemaVersion}`
      )
    }
    if (version === 0) {
      this.database.exec('BEGIN IMMEDIATE')
      try {
        this.database.exec(initialMigrationSql)
        this.database.exec(`PRAGMA user_version = ${databaseSchemaVersion}`)
        this.database.exec('COMMIT')
      } catch (error) {
        this.database.exec('ROLLBACK')
        throw error
      }
      return
    }
    if (version < databaseSchemaVersion) {
      this.database.exec('BEGIN IMMEDIATE')
      try {
        let currentVersion = version
        if (currentVersion === 1) {
          this.database.exec(secondMigrationSql)
          currentVersion = 2
        }
        if (currentVersion === 2) {
          this.database.exec(thirdMigrationSql)
          currentVersion = 3
        }
        if (currentVersion === 3) {
          this.database.exec(fourthMigrationSql)
          currentVersion = 4
        }
        this.database.exec(`PRAGMA user_version = ${currentVersion}`)
        this.database.exec('COMMIT')
      } catch (error) {
        this.database.exec('ROLLBACK')
        throw error
      }
    }
  }

  private seedDefaults(): void {
    const now = new Date().toISOString()
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    this.database
      .prepare(
        `INSERT OR IGNORE INTO calendars
          (id, name, color, timezone, is_default, created_at, updated_at)
         VALUES ('calendar:local', 'My Calendar', '#c08a6e', ?, 1, ?, ?)`
      )
      .run(timezone, now, now)
    const preferences = defaultPreferences(timezone, now)
    this.database
      .prepare(
        "INSERT OR IGNORE INTO preferences (id, payload_json, updated_at) VALUES ('local', ?, ?)"
      )
      .run(JSON.stringify(preferences), now)
  }

  private applyMutation(metadata: MutationMetadata, work: () => void): MutationReceipt {
    const now = new Date().toISOString()
    const actionId = `action:${randomUUID()}`
    const proposalRow = metadata.assistantProposalId
      ? (this.database
          .prepare('SELECT request_id FROM assistant_proposals WHERE id = ?')
          .get(metadata.assistantProposalId) as DatabaseRow | undefined)
      : undefined
    const requestId = proposalRow
      ? stringValue(proposalRow, 'request_id')
      : `request:${randomUUID()}`
    const transactionId = `transaction:${randomUUID()}`
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const before = this.readUndoState()
      work()
      const after = this.readUndoState()
      this.database
        .prepare(
          `INSERT INTO action_history (
            id, request_id, transaction_id, actor, operation, risk, status,
            before_state_json, after_state_json, reversible, created_at, applied_at, undone_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'applied', ?, ?, 1, ?, ?, NULL)`
        )
        .run(
          actionId,
          requestId,
          transactionId,
          metadata.actor,
          metadata.operation,
          metadata.risk,
          JSON.stringify(before),
          JSON.stringify(after),
          now,
          now
        )
      if (metadata.assistantProposalId) {
        const updatedProposal = this.database
          .prepare(
            `UPDATE assistant_proposals
             SET status = 'applied', updated_at = ?
             WHERE id = ? AND status = 'pending'`
          )
          .run(now, metadata.assistantProposalId)
        if (updatedProposal.changes !== 1) {
          throw new Error('The assistant proposal is no longer pending')
        }
      }
      this.database.exec('COMMIT')
      return {
        actionId,
        operation: metadata.operation,
        summary: metadata.summary,
        undoable: true,
        createdAt: now
      }
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  private readUndoState(): UndoState {
    return {
      events: this.listEvents(),
      reminders: this.listReminders(),
      recurrenceExceptions: this.listRecurrenceExceptions(),
      preferences: this.getPreferences(),
      notificationDeliveries: this.listNotificationDeliveries()
    }
  }

  private restoreUndoState(state: UndoState): void {
    const deliveries = new Map<string, NotificationDelivery>()
    for (const delivery of [
      ...(state.notificationDeliveries ?? []),
      ...this.listNotificationDeliveries()
    ]) {
      deliveries.set(`${delivery.reminderId}\u0000${delivery.dueAtUtc}`, delivery)
    }
    this.database.exec(
      'DELETE FROM recurrence_exceptions; DELETE FROM document_import_identities; DELETE FROM reminders; DELETE FROM events;'
    )
    for (const event of state.events) this.writeEvent(eventEntitySchema.parse(event))
    for (const reminder of state.reminders) this.writeReminder(reminderEntitySchema.parse(reminder))
    for (const exception of state.recurrenceExceptions)
      this.writeException(recurrenceExceptionEntitySchema.parse(exception))
    if (state.preferences) this.writePreferences(preferencesEntitySchema.parse(state.preferences))
    const reminderIds = new Set(state.reminders.map((reminder) => reminder.id))
    for (const delivery of deliveries.values()) {
      if (reminderIds.has(delivery.reminderId)) {
        this.recordReminderNotification(
          delivery.reminderId,
          delivery.dueAtUtc,
          delivery.deliveredAt
        )
      }
    }
  }

  private listNotificationDeliveries(): NotificationDelivery[] {
    const rows = this.database
      .prepare('SELECT * FROM notification_deliveries ORDER BY delivered_at')
      .all() as DatabaseRow[]
    return rows.map((row) => ({
      reminderId: stringValue(row, 'reminder_id'),
      dueAtUtc: stringValue(row, 'due_at_utc'),
      deliveredAt: stringValue(row, 'delivered_at')
    }))
  }

  private writeEvent(event: EventEntity): void {
    this.database
      .prepare(
        `INSERT INTO events (
          id, calendar_id, title, description, location, start_utc, end_utc, timezone,
          all_day, recurrence_json, status, provenance, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          calendar_id = excluded.calendar_id,
          title = excluded.title,
          description = excluded.description,
          location = excluded.location,
          start_utc = excluded.start_utc,
          end_utc = excluded.end_utc,
          timezone = excluded.timezone,
          all_day = excluded.all_day,
          recurrence_json = excluded.recurrence_json,
          status = excluded.status,
          provenance = excluded.provenance,
          updated_at = excluded.updated_at`
      )
      .run(
        event.id,
        event.calendarId,
        event.title,
        event.description,
        event.location,
        event.startUtc,
        event.endUtc,
        event.timezone,
        event.allDay ? 1 : 0,
        event.recurrence ? JSON.stringify(event.recurrence) : null,
        event.status,
        event.provenance,
        event.createdAt,
        event.updatedAt
      )
    this.writeDocumentImportIdentity('event', event.id, event.importIdentity, event.updatedAt)
  }

  private writeReminder(reminder: ReminderEntity): void {
    this.database
      .prepare(
        `INSERT INTO reminders (
          id, calendar_id, title, notes, due_at_utc, timezone, recurrence_json,
          status, completed_at, provenance, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          calendar_id = excluded.calendar_id,
          title = excluded.title,
          notes = excluded.notes,
          due_at_utc = excluded.due_at_utc,
          timezone = excluded.timezone,
          recurrence_json = excluded.recurrence_json,
          status = excluded.status,
          completed_at = excluded.completed_at,
          provenance = excluded.provenance,
          updated_at = excluded.updated_at`
      )
      .run(
        reminder.id,
        reminder.calendarId,
        reminder.title,
        reminder.notes,
        reminder.dueAtUtc,
        reminder.timezone,
        reminder.recurrence ? JSON.stringify(reminder.recurrence) : null,
        reminder.status,
        reminder.completedAt,
        reminder.provenance,
        reminder.createdAt,
        reminder.updatedAt
      )
    this.writeDocumentImportIdentity(
      'reminder',
      reminder.id,
      reminder.importIdentity,
      reminder.updatedAt
    )
  }

  private writeDocumentImportIdentity(
    entityKind: 'event' | 'reminder',
    entityId: string,
    inputIdentity: DocumentImportIdentity | null | undefined,
    updatedAt: string
  ): void {
    if (!inputIdentity) {
      this.database
        .prepare('DELETE FROM document_import_identities WHERE entity_kind = ? AND entity_id = ?')
        .run(entityKind, entityId)
      return
    }
    const identity = documentImportIdentitySchema.parse(inputIdentity)
    this.database
      .prepare(
        `INSERT INTO document_import_identities (
          entity_kind, entity_id, source_sha256, source_row_id, semantic_key,
          identity_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(entity_kind, entity_id) DO UPDATE SET
          source_sha256 = excluded.source_sha256,
          source_row_id = excluded.source_row_id,
          semantic_key = excluded.semantic_key,
          identity_json = excluded.identity_json,
          updated_at = excluded.updated_at`
      )
      .run(
        entityKind,
        entityId,
        identity.sourceSha256,
        identity.sourceRowId,
        identity.semanticKey,
        JSON.stringify(identity),
        updatedAt,
        updatedAt
      )
  }

  private writeException(exception: RecurrenceExceptionEntity): void {
    this.database
      .prepare(
        `INSERT INTO recurrence_exceptions
          (id, parent_event_id, original_date, kind, replacement_event_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(parent_event_id, original_date) DO UPDATE SET
           kind = excluded.kind,
           replacement_event_id = excluded.replacement_event_id,
           created_at = excluded.created_at`
      )
      .run(
        exception.id,
        exception.parentEventId,
        exception.originalDate,
        exception.kind,
        exception.replacementEventId,
        exception.createdAt
      )
  }

  private writePreferences(preferences: PreferencesEntity): void {
    this.database
      .prepare("UPDATE preferences SET payload_json = ?, updated_at = ? WHERE id = 'local'")
      .run(JSON.stringify(preferences), preferences.updatedAt)
  }

  private summaryFromAction(action: ActionHistoryEntity): string {
    const after = JSON.parse(action.afterStateJson) as UndoState
    const before = JSON.parse(action.beforeStateJson) as UndoState
    const eventDelta = after.events.length - before.events.length
    const reminderDelta = after.reminders.length - before.reminders.length
    if (eventDelta > 0) return 'created an event'
    if (eventDelta < 0) return 'deleted an event'
    if (reminderDelta > 0) return 'created a reminder'
    if (reminderDelta < 0) return 'deleted a reminder'
    return action.operation.replace('.', ' ')
  }
}
