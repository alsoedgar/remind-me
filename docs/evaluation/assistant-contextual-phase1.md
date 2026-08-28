# Contextual assistant Phase 1

Phase 1 replaces lossy ID-only dialogue focus with persisted ordered query frames and adds a typed contextual resolver ahead of generic routing.

## Implemented

- Dialogue payload version 2 with backward-compatible version 1 migration.
- Up to 12 persisted frames with exact mixed event/reminder order and recurring occurrence identity.
- Per-frame selected items, requested fields, result cursor, operation, range, timezone, and creation time.
- Automatic pruning of deleted entities, selected references, and invalid cursors.
- Typed attribute, scope, selection, and intent resolution for read and write follow-ups.
- Deterministic handling for ordinals, number words, subsets, classes, labs, lectures, reminders, titles, whole results, next items, and earlier result frames.
- Exact contextual writes continue through preview, dry run, confirmation, atomic apply, and undo.
- Local recurrence, notes, location, date, duration, start/end, and full-detail answers use verified stored facts.
- Topic switches preserve the active frame; simple encouragement and joke turns no longer erase calendar context.
- Bounded local typo/spacing repair for the frozen noisy-language surfaces.

## Frozen-suite result

The Phase 0 suite remains frozen at 433 scenarios / 902 turns and is still excluded from training. Before Phase 1, its baseline was:

| Mode          | Phase 0 scenario pass | Phase 0 in-domain answered |
| ------------- | --------------------: | -------------------------: |
| rules-only    |                 16.2% |                      51.3% |
| native-hybrid |                 18.2% |                      60.6% |

The final August 28, 2026 Phase 1 run produced:

| Mode          | Phase 1 scenario pass | Phase 1 in-domain answered |     p95 |
| ------------- | --------------------: | -------------------------: | ------: |
| rules-only    |                100.0% |                     100.0% | 62.4 ms |
| native-hybrid |                100.0% |                     100.0% | 81.7 ms |

That is a gain of 83.8 percentage points for rules-only and 81.8 points for native-hybrid without changing or training on the frozen suite. Every family reached 36/36 in both modes: time, location, date, duration, notes, recurrence, ordinal selection, subsets, all-item scope, summaries, typo/spacing/ASR noise, and returning after a topic switch. The exact screenshot regression also passed in both modes.

Targeted tests additionally cover migration, resolver contracts, persistence, restart, repeated occurrences, mixed ordering, earlier frames, and exact single/bulk mutations.

## Boundaries

Phase 1 does not make an LLM authoritative over calendar IDs and does not bypass confirmation. It also does not claim the later rich summary grouping/pagination work. The independent human study remains separate and unchanged at 0/2,000 scenarios from 0/100 participants.
