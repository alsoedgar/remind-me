# ADR 0014: Document semantic reconciliation

## Status

Accepted.

## Context

Literal event fingerprints are too brittle for document import. Equivalent building names, harmless title formatting, or edited notes can hide a real duplicate, while matching only course title and time can collapse a lecture, laboratory, discussion, or separate CRN that must remain distinct. Silently dropping a proposal also prevents the user from seeing what the local reader found.

Repeat imports need a stronger invariant than display text. The application already hashes selected file bytes in main, but the resulting calendar entity did not retain which evidence row created it. Reconciliation must remain local, auditable, undoable, and unable to grant the document model a storage handle.

## Decision

Assign every accepted document draft:

1. a source identity made from the main-process SHA-256 digest and a deterministic hash of the normalized positioned source row; and
2. a semantic identity specialized for a class series, general event, or reminder.

Class identity includes course code, section, CRN, component, weekday set, meeting time, term bounds, and timezone. General events use canonical title, local start/end, timezone, and normalized location. Reminders use canonical title and due date/time/timezone.

Reconciliation is advisory in planning and explicit in review:

- the same source row is visible and non-selectable;
- a semantic or high-similarity match is visible and initially unselected;
- a class conflict in CRN, section, or component is labelled protected-distinct and initially selected;
- a user may explicitly select a likely duplicate from another source.

The reviewed contract repeats the source digest/row. Main binds the digest to the pending opaque selection. SQLite schema version 4 stores the validated identity in `document_import_identities` and uniquely constrains `(source_sha256, source_row_id)` across event and reminder entities. Entity edits refresh the semantic key without changing source identity. Undo snapshots include identities; deletion removes them.

## Consequences

- Equivalent imported items can be compared without relying on notes or exact location spelling.
- Separate CRNs and components cannot be silently merged by a similarity heuristic.
- Users see ambiguous duplicates and make the final choice.
- The database constraint remains authoritative if UI state is stale or two commits race.
- Legacy imported entities can participate in best-effort class comparison through their existing bounded course description, but only new imports have exact source-row identity.
- The identity table stores no file path, source bytes, thumbnail, extracted prose, or evidence geometry.

## Rejected alternatives

- Literal title/location/description fingerprints: unstable under harmless formatting and edits.
- Title and time only: unsafe for labs, discussions, linked sections, and separate CRNs.
- Automatically merge every semantic match: removes an explicit user decision and can erase legitimate duplicate plans.
- Store the original path or full extracted row: unnecessary for reconciliation and expands the local privacy footprint.
