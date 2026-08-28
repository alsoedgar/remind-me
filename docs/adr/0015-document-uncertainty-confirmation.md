# ADR 0015: Document confirmation is uncertainty-aware

- Status: accepted
- Date: 2026-08-27
- Extends: ADR 0008 and ADR 0014

## Context

An evidence-gated parser can still produce a review experience that hides important uncertainty. A weekday-only preview collapses unrelated one-off dates, a 440-pixel thumbnail cannot support dense schedule inspection, one item-wide confidence score conceals a weak location, and a prose warning does not let a user inspect an asynchronous row that was intentionally skipped. Users also need a safe way to repair over-grouped or misclassified proposals before commit.

## Decision

The document worker returns two bounded, in-memory page representations: a 440-pixel navigation thumbnail and a size-gated review image rendered at up to 2,200 pixels / 4.5 megapixels. The source viewer provides page navigation, zoom, drag-to-pan, and evidence overlays against the same oriented canvas used for extraction.

Each draft carries confidence for title, time/date, location, and description based only on linked source blocks; absent optional evidence remains `null`. Identifiable no-fixed-time and incomplete schedule rows become typed, evidence-backed skipped records. They are visible in review but have no commit representation.

Confirmation provides weekly, chronological, monthly, grouped-detail, and source views. It reports series, weekly meetings, courses, and skipped rows independently. Course components are grouped for comparison but never collapsed.

Review may split multi-weekday recurrences, merge explicitly selected compatible weekly rows, or reclassify non-course events/reminders. Merge compatibility includes kind, title, time, timezone, location or notes, recurrence boundary, course/section/CRN/component, and term. Structural edits receive deterministic reviewed source-row identities and are re-reconciled against the live calendar. The existing validated, digest-bound, atomic commit remains the only persistence path.

## Consequences

- Dense PDFs and images can be inspected without retaining a filesystem path or opening an external viewer.
- Weak fields and intentional skips are visible at the point of confirmation.
- One-off plans retain real dates, while monthly recurrence expansion makes series cardinality understandable.
- Different CRNs, sections, and components cannot be merged through the convenience control.
- High-resolution images increase temporary renderer memory, so dimensions, encoded size, page count, and worker lifetime remain bounded.
- Split or merge decisions are explicit review edits; reimports reconcile semantically even when the reviewed source-row identity differs from the original extracted grouping.
- No source pixels, extracted text, skipped-row record, or confidence value is persisted.
