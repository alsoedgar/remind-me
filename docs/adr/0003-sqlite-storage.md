# ADR 0003: Transactional SQLite storage

- Status: Accepted
- Date: 2026-08-23

## Context

The product needs reliable offline persistence, range queries, recurrence metadata, atomic mutations, migrations, and undo history on all desktop platforms.

## Decision

Use SQLite owned by the Electron main process through Electron's bundled `node:sqlite` `DatabaseSync` API. Keep that API behind `SqliteCalendarRepository` so the storage implementation can be replaced without changing IPC or domain contracts. Pin and smoke-test the Electron runtime that supplies SQLite; the API is still marked release-candidate in the [Node.js documentation](https://nodejs.org/api/sqlite.html).

Instants are stored in UTC together with their original IANA timezone. Recurrence rules and exceptions remain explicit JSON/domain objects. File databases enable WAL, foreign keys, a busy timeout, and defensive mode. Every calendar mutation and its complete before/after undo state commit in one `BEGIN IMMEDIATE` transaction.

## Consequences

- There is no third-party native addon or Electron ABI rebuild in the application package.
- Runtime support is coupled to the pinned Electron/Node version and must be verified on every target platform.
- The renderer cannot query storage directly.
- Every mutation can share one database transaction with its action-history record.
- Migrations, backup, restore, integrity checks, and corrupt-database recovery require packaged tests.
