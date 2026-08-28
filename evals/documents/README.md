# Document import evaluation

This directory is the Phase 0 measurement boundary for local PDF and image planning. It measures the complete developer-side path from PDF text or bundled English OCR through positioned blocks, PlanScan, deterministic calendar compilation, and evidence-backed proposals. It never opens the user's calendar database and never commits an event.

The frozen `v0.1/corpus.jsonl` suite contains 12 sanitized fixtures across six source groups. Equivalent native PDF, raster PDF, direct image, rotated, and hybrid variants share a `sourceGroupId`; they must remain together when a future corpus is divided into calibration or evaluation splits. The corpus currently contains 38 expected proposals and one intentional no-fixed-time skip across:

- born-digital, raster-only, hybrid, rotated, screenshot, direct-image, and phone-photo inputs;
- vertical lists, row tables, a multi-page syllabus, a month grid, itinerary cards, and a flyer;
- single and multiple events, reminders, locations, date ranges, weekly recurrence, and unsupported asynchronous content.

Every record is `trainingExcluded: true`. The frozen manifest pins both the JSONL bytes and every source fixture digest. Regenerating a PDF or changing an annotation therefore fails the check until the change is reviewed and explicitly frozen.

## Commands

Verify schemas, signatures, page counts, dimensions, corpus bytes, and fixture hashes:

```powershell
pnpm eval:documents:check
```

Run the complete offline baseline and write JSON, Markdown, and observation reports:

```powershell
pnpm eval:documents:baseline
```

Build the current platform directory package, then drive the real packaged Electron worker and
review UI through the release gate:

```powershell
pnpm package:dir
pnpm documents:release:package
```

The packaged gate imports born-digital PDF, raster PDF, direct-image, and multi-page recurrence
fixtures with networking disabled. For every case it verifies exact proposals and same-row field
placement, opens the rendered source and checks every evidence highlight against its page image,
round-trips selection and editing, proves that the calendar remains untouched before confirmation,
commits the reviewed batch atomically, blocks a same-source re-import, and removes the entire batch
with one undo. A separate storage identity probe requires lecture/lab rows with different CRNs and
components to remain distinct. The resulting platform report is written to
`reports/document-release.<platform>-<arch>.json` and is intentionally ignored by Git; CI uploads it
as release evidence.

Run one case without changing reports:

```powershell
pnpm --filter @remind-me/desktop exec tsx scripts/evaluate-document-corpus.ts --case=row-table.hybrid --no-write
```

After intentionally changing reviewed fixtures or annotations, freeze the new hashes:

```powershell
pnpm eval:documents:freeze
```

Raster-PDF baseline evaluation uses Poppler's `pdftoppm` as a development-only rendering oracle. The shipped Electron app continues to use its packaged PDF.js worker and does not require Poppler. OCR uses the exact packaged English Tesseract data, the production coverage-aware native-text gate, adaptive compact/calendar segmentation, confidence-gated manual orientation recovery, the real PlanScan weights, and the production deterministic planner.

The frozen baseline detects all 38 expected proposals with no extras. Exact-item precision and recall are both 100%, all 12 documents are perfect, evidence coverage is 100%, and the aggregate intentional-skip count is exact. Every accepted candidate passes through a typed, evidence-linked semantic record, receives a stable source-row identity plus a class/event/reminder semantic identity, and carries per-field confidence into review. Identifiable no-fixed-time content also retains a read-only skipped-row record with its own evidence. The multi-page syllabus still carries its course identity and component into a term-bounded weekday recurrence while keeping its explicit no-fixed-time item out of the calendar. These results use the unchanged frozen annotations and project-generated regression fixtures; the independent human-blind count remains zero.

## Phase 7 release policy

`v0.1/release-gates.json` is the machine-readable release contract. A build cannot pass the document
gate unless proposal precision is at least 99%, born-digital recall is at least 97%, scanned/image
recall is at least 94%, exact recurrence accuracy is at least 99%, and source-evidence coverage is
100%. Exact row-table scoring forbids cross-row time or location borrowing. The packaged probes must
also pass every review, reconciliation, commit, and undo assertion with no exceptions.

CI runs the same packaged command on Windows x64, Linux x64, macOS arm64, and macOS x64. Platform
reports are uploaded independently, so a passing Windows run is never presented as proof of a macOS
or Linux run.

## Metrics

The scorer reports proposal-cardinality precision/recall, exact-item precision/recall, perfect-document rate, required evidence coverage, aggregate skip-count accuracy, and independent field accuracy for:

- kind, title, start/end date, start/end time, timezone, all-day state, and location;
- recurrence;
- course code, section, CRN, and class component.

Matching uses CRN and course/section identity before title/date similarity, so lecture and laboratory rows with the same visible title and time are not accidentally cross-scored. Missing and unexpected proposals remain separate from field errors.

The latest report is a baseline, not a release claim. Generated regression fixtures are useful for preventing known failures but do not substitute for independently collected documents.

## Independent human-blind collection

The committed human-blind count is deliberately zero. To increase it honestly:

1. Obtain explicit permission to use a sanitized or synthetic-content document for evaluation.
2. Have an annotator who did not create the parser record every expected proposal and intentional skip using `v0.1/human-blind-intake.schema.json`.
3. Keep raw files and annotations under `evals/documents/local-private/` or `human-blind.local.jsonl`; both are ignored by Git.
4. Remove names, student IDs, addresses, QR codes, account links, and unrelated document text before considering a fixture for a public frozen suite.
5. Group alternate exports or photos of the same source under one `sourceGroupId` and keep that group out of training, prompt examples, model selection, and threshold tuning.
6. Freeze only after collection closes. Report the independently annotated document count separately from project-generated regressions.

Personal schedules must never be copied into this repository merely to improve a score. A private local observation may be used to diagnose the app, but only a separately sanitized derivative with invented identities and reviewed gold labels may become a committed fixture.
