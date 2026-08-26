# Local data inventory

## Privacy contract

Remind Me is local-only by default. It requires no account, telemetry, remote model endpoint, or calendar provider. The core application must remain useful with networking disabled.

## Data classes

| Data                           | Local purpose                       | Retention/control                                       |
| ------------------------------ | ----------------------------------- | ------------------------------------------------------- |
| Calendars, events, reminders   | Scheduling and free/busy            | SQLite on device; edit/delete/JSON/ICS export           |
| Recurrence exceptions          | Correct occurrence behavior         | Follows parent calendar data                            |
| Conversations                  | Dialogue continuity and references  | User-configurable history; clearable                    |
| Pending assistant proposals    | Safe review before calendar writes  | Cascades when its conversation is cleared               |
| Voice recordings               | Transcription input                 | Memory only; discarded after ASR, cancel, or exit       |
| Voice transcripts              | Editable input and optional history | Stored only if sent; then follows conversation data     |
| RemindCore features/logits     | Semantic routing                    | Process memory for one request; never transmitted       |
| RemindSpeak scores/candidates  | Grounded response phrasing          | Process memory for one reply; never transmitted         |
| Response phrase preferences    | Optional local wording reranking    | 64 fact-free fingerprints; disable/reset in Settings    |
| Image/PDF source bytes         | Temporary local planning input      | Memory only; discarded on close/cancel/error/commit     |
| Safe document metadata         | Tie review to selected source       | Main-process memory; 30-minute/four-item cap            |
| OCR/PDF words, boxes, preview  | Visible review evidence             | Worker/renderer memory only; never stored in SQLite     |
| PlanScan features/predictions  | Link visible document fields        | Worker/renderer memory only; discarded with review      |
| Preferences/style profile      | Personalization                     | SQLite on device; updated from Settings                 |
| Action history                 | Atomic undo                         | SQLite on device; future retention controls planned     |
| Provider benchmark cache       | Reuse verified CPU runtime choice   | Local JSON keyed by model-manifest hash; replaceable    |
| Corrupt-database recovery copy | Preserve data for manual recovery   | Timestamped beside local database; purged by Delete all |
| Model assets and checksums     | Offline inference                   | Installed application resources                         |
| Optional Qwen3 1.7B Q4 pack    | Broad local chat/fallback language  | Per-user model folder; disable/remove in Settings       |
| Optional model enabled state   | Remember explicit local choice      | One local boolean beside the removable model            |

## Explicit exclusions

- Hidden telemetry or analytics.
- Uploading prompts, audio, files, calendars, or responses.
- Storing hidden model reasoning.
- Granting a model direct database or filesystem access.
- Executing remote code or downloading required models after installation. The optional fixed model-data download contains no executable instructions and is never required.

## File access

The renderer cannot read an arbitrary path. Import and export use operating-system file pickers in the main process, and imports are capped at 25 MiB and schema-validated before a transaction. Image/PDF selection returns an opaque ID, safe base filename, digest, and in-memory bytes; the filesystem path never crosses the preload bridge. The transferred bytes run in a sandboxed, terminable document worker with bundled assets. PlanScan hashes positioned text and layout into temporary features, predicts candidate roles and links, and projects every accepted value back to exact visible text. Extracted thumbnails, features, predictions, and evidence are temporary review state, and document imports remain drafts until the user confirms a selected batch.

## Backup, erasure, and recovery

Settings offers JSON backup before destructive erasure. Delete-all-data requires the user to type `DELETE`; it then removes calendars, events, reminders, recurrence exceptions, notification deliveries, attachments, conversations, pending proposals, action history, and preferences in one transaction. SQLite secure-delete is enabled, the file is checkpointed and vacuumed, known timestamped recovery database/WAL/SHM copies are removed, and only a fresh default calendar and default preferences are recreated. The operation deliberately creates no undo record, so a prior exported backup is the recovery route.

On startup, migrations run transactionally and `PRAGMA quick_check` must return `ok`. If SQLite identifies a malformed, encrypted, or corrupt database, Remind Me moves the database plus present WAL/SHM sidecars to timestamped `.recovery-*` files and opens a clean store. Those recovery copies can still contain the former private data; the app never uploads them, keeps them for manual recovery during ordinary use, and removes them when the user completes Delete all local data. Unknown failures and databases from a newer schema are not treated as corruption and fail closed instead of being moved.

The erase is best-effort at the application/SQLite layer. Filesystem snapshots, cloud-synced version history, OS backups, and flash-storage wear leveling are outside the application's control and may retain older blocks; users with a stronger threat model must also manage those systems.

The provider cache contains only schema version, model-manifest SHA-256, selected local implementation labels, and bounded benchmark timing. It contains no prompts, model output, calendar facts, device identifier, or telemetry and is invalidated when the installed manifest changes.

Installing the optional flexible pack contacts only the pinned official Hugging Face model URL and necessarily exposes ordinary connection metadata such as IP address to that host. No prompt, calendar fact, document, account identifier, or telemetry is included. The downloaded bytes are length-limited and SHA-256 verified before use. Prompts sent to the isolated model process remain on the device and are not separately retained. Delete-all intentionally preserves installed application/model choices; Settings provides the separate model-removal control.

## Future optional integrations

Calendar-provider sync, cloud backups, or larger model packs must be separate, explicit, revocable features. Enabling one must not weaken the offline core or silently change the local retention policy.
