# Evaluation fixtures

`golden/calendar-ir.v0.1.jsonl` is generated deterministically by `scripts/generate-golden-fixtures.ts` and committed so changes are reviewable.

Each line contains the utterance, context, initial state, validated draft IR, expected resolved IR, and complete expected dry-run result. The current suite contains 256 cases across every initial operation.

Regenerate and verify it with:

```bash
pnpm fixtures:generate
pnpm fixtures:check
```

The generator uses a fixed January 2026 Chicago context and explicit UTC offset. This is a Phase 0 contract harness, not the final timezone evaluation. Phase 1 adds dedicated DST-transition, locale, leap-year, recurrence-instance, and ICS fixtures.

`golden/voice-equivalence.v0.1.json` contains typed/transcript pairs covering reminders, events, multi-day ranges, availability questions, and American/British-style spoken times. Phase 3 requires each pair to produce the same semantic `CalendarIR` projection after transcript normalization.

`remindspeak/heldout.v0.1.jsonl` is a deterministic 250-example sample of the generated RemindSpeak test split. It covers every `ResponsePlan` speech act, protected-fact signatures, response styles, five-candidate generation, factual validation, and recent-reply novelty without committing the full research corpus.

`audio/` contains two locally generated speaking profiles and one unmodified, attributed Irish-English OpenSLR 83 evaluation clip. The real ASR integration suite runs these, a pinned upstream clean sample, and deterministic broadband noise through the bundled model. See `audio/openslr83/ATTRIBUTION.md` for the third-party fixture license and provenance.

`documents/phase4-schedule.pdf` is a one-page born-digital schedule with embedded text. `documents/phase4-scanned-schedule.pdf` is the same schedule flattened to pixels, and `documents/phase4-schedule.png` exercises direct image OCR. All three contain two events and one reminder with dates, times, and locations so native extraction and OCR can be compared against the same expected proposals.

`planscan/heldout.v0.1.jsonl` is a deterministic 96-page projection of PlanScan's split-disjoint held-out set. It preserves positioned words, exact expected spans, learned group links, document types, and separate born-digital/scanned categories for the TypeScript runtime gate.

`documents/phase7-table-plan.pdf` is a polished born-digital row schedule whose semantic fields depend on two-dimensional alignment. `documents/phase7-scanned-table-plan.pdf` is its raster-only counterpart, and `documents/phase7-table-plan.png` is the source scan. They exercise native extraction and OCR without changing the visible plan.

The Phase 0 document-evaluation expansion adds six deliberately different sources: a hybrid PDF whose raster body is hidden behind enough native footer text to exercise OCR gating, a two-page syllabus with recurrence and an asynchronous skip, a month-grid screenshot, a perspective phone-photo itinerary, a WebP event flyer, and a sideways raster PDF. Together with the earlier native/scan pairs, `evals/documents/v0.1/corpus.jsonl` freezes 12 fixtures across six source groups and scores 38 proposals field by field.

Regenerate the local fixtures with the development-only Python script and verify their signatures, dimensions, and safety bounds with:

```bash
python scripts/generate-document-fixtures.py
pnpm documents:fixtures:check
pnpm eval:documents:check
pnpm eval:documents:baseline
```

Python and ReportLab/Pillow are fixture-development tools only; neither is shipped in the Electron application. The committed Phase 4 and Phase 7 PDF fixtures were rendered to images and visually inspected before their checkpoints were completed.
