import type {
  ActionHistoryEntity,
  CalendarEntity,
  EventEntity,
  PreferencesEntity,
  RecurrenceExceptionEntity,
  ReminderEntity
} from '@remind-me/contracts'

export const databaseSchemaVersion = 4

export const databaseTables = [
  'calendars',
  'events',
  'reminders',
  'recurrence_exceptions',
  'attachments',
  'conversations',
  'conversation_turns',
  'assistant_proposals',
  'assistant_dialogue_state',
  'document_import_identities',
  'preferences',
  'action_history',
  'notification_deliveries'
] as const

export interface StorageTransaction {
  calendars: CalendarEntity[]
  events: EventEntity[]
  reminders: ReminderEntity[]
  recurrenceExceptions: RecurrenceExceptionEntity[]
  preferences: PreferencesEntity
  actionHistory: ActionHistoryEntity[]
}

export interface StoragePort {
  readSnapshot: () => Promise<StorageTransaction>
  runTransaction: <Result>(
    work: (transaction: StorageTransaction) => Promise<Result>
  ) => Promise<Result>
}

export const initialMigrationSql = `
PRAGMA foreign_keys = ON;

CREATE TABLE calendars (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  timezone TEXT NOT NULL,
  is_default INTEGER NOT NULL CHECK (is_default IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  calendar_id TEXT NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  start_utc TEXT NOT NULL,
  end_utc TEXT NOT NULL,
  timezone TEXT NOT NULL,
  all_day INTEGER NOT NULL CHECK (all_day IN (0, 1)),
  recurrence_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'cancelled')),
  provenance TEXT NOT NULL CHECK (provenance IN ('manual', 'assistant', 'import')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX events_calendar_time ON events(calendar_id, start_utc, end_utc);

CREATE TABLE reminders (
  id TEXT PRIMARY KEY,
  calendar_id TEXT NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  due_at_utc TEXT NOT NULL,
  timezone TEXT NOT NULL,
  recurrence_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'cancelled')),
  completed_at TEXT,
  provenance TEXT NOT NULL CHECK (provenance IN ('manual', 'assistant', 'import')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX reminders_due ON reminders(status, due_at_utc);

CREATE TABLE document_import_identities (
  entity_kind TEXT NOT NULL CHECK (entity_kind IN ('event', 'reminder')),
  entity_id TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  source_row_id TEXT NOT NULL,
  semantic_key TEXT NOT NULL,
  identity_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (entity_kind, entity_id),
  UNIQUE (source_sha256, source_row_id)
);

CREATE INDEX document_import_semantic_key
  ON document_import_identities(semantic_key, entity_kind);

CREATE TABLE recurrence_exceptions (
  id TEXT PRIMARY KEY,
  parent_event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  original_date TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('cancelled', 'modified')),
  replacement_event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  UNIQUE(parent_event_id, original_date)
);

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  owner_kind TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  media_type TEXT NOT NULL,
  display_name TEXT NOT NULL,
  local_path_token TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE conversation_turns (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  input_kind TEXT NOT NULL,
  text TEXT NOT NULL,
  request_id TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX turns_conversation_time ON conversation_turns(conversation_id, created_at);

CREATE TABLE assistant_proposals (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  risk TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'rejected', 'failed')),
  payload_json TEXT NOT NULL,
  resolved_command_json TEXT NOT NULL,
  summary TEXT NOT NULL,
  requires_confirmation INTEGER NOT NULL CHECK (requires_confirmation IN (0, 1)),
  source_text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX proposals_conversation_status
  ON assistant_proposals(conversation_id, status, created_at);

CREATE TABLE assistant_dialogue_state (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE preferences (
  id TEXT PRIMARY KEY CHECK (id = 'local'),
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE action_history (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  transaction_id TEXT,
  actor TEXT NOT NULL CHECK (actor IN ('manual', 'assistant', 'import')),
  operation TEXT NOT NULL,
  risk TEXT NOT NULL,
  status TEXT NOT NULL,
  before_state_json TEXT NOT NULL,
  after_state_json TEXT NOT NULL,
  reversible INTEGER NOT NULL CHECK (reversible IN (0, 1)),
  created_at TEXT NOT NULL,
  applied_at TEXT,
  undone_at TEXT
);

CREATE INDEX history_request ON action_history(request_id, created_at);

CREATE TABLE notification_deliveries (
  reminder_id TEXT NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
  due_at_utc TEXT NOT NULL,
  delivered_at TEXT NOT NULL,
  PRIMARY KEY (reminder_id, due_at_utc)
);
`

export const secondMigrationSql = `
CREATE TABLE assistant_proposals (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  risk TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'rejected', 'failed')),
  payload_json TEXT NOT NULL,
  resolved_command_json TEXT NOT NULL,
  summary TEXT NOT NULL,
  requires_confirmation INTEGER NOT NULL CHECK (requires_confirmation IN (0, 1)),
  source_text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX proposals_conversation_status
  ON assistant_proposals(conversation_id, status, created_at);
`

export const thirdMigrationSql = `
CREATE TABLE IF NOT EXISTS assistant_dialogue_state (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`

export const fourthMigrationSql = `
CREATE TABLE IF NOT EXISTS document_import_identities (
  entity_kind TEXT NOT NULL CHECK (entity_kind IN ('event', 'reminder')),
  entity_id TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  source_row_id TEXT NOT NULL,
  semantic_key TEXT NOT NULL,
  identity_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (entity_kind, entity_id),
  UNIQUE (source_sha256, source_row_id)
);

CREATE INDEX IF NOT EXISTS document_import_semantic_key
  ON document_import_identities(semantic_key, entity_kind);
`
