# Local document planning

Phase 7 locks the evidence-backed PDF/image planner behind installed-application acceptance gates without uploading the source or giving probabilistic code a storage handle. The pipeline retains Phase 6's challenge-trained PlanScan linking and optional candidate-only parser-disagreement check, while packaged probes now verify the complete review, persistence, reconciliation, and undo path on every supported desktop platform.

## User path

```text
native file picker
  -> main-process byte and signature validation
  -> opaque source metadata + in-memory ArrayBuffer
  -> terminable sandboxed document worker
  -> native PDF text, or OCR only when native text is sparse
  -> positioned words and evidence-linked typed plan records
  -> CalendarIR + editable ImportDraft items
  -> optional exact-citation repair selection when PlanScan and rules disagree
  -> optional exact-block grouping for uncovered source windows
  -> editable batch review
  -> one validated SQLite transaction after explicit confirmation
  -> one undo receipt
```

The attachment button lives beside the assistant text and microphone controls. The review sheet provides weekly, chronological, monthly, detail, and source views. It keeps per-field source confidence, exact evidence snippets, high-resolution page review, skipped rows, and reconciliation status visible beside editable event and reminder fields. Users may split multi-weekday series, merge only explicitly selected compatible weekly rows, reclassify non-course plans, deselect individual proposals, discard the whole staged review, or commit the selected batch.

## Trust boundaries

1. The Electron main process owns the operating-system picker and is the only layer that sees the selected path.
2. Main accepts only regular PDF, PNG, JPEG, or WebP files. It checks the byte signature, declared image dimensions, byte limit, and SHA-256 digest before returning data.
3. The preload bridge returns an opaque selection ID, safe display name, media type, size, digest, and a bounded `ArrayBuffer`. It never returns the filesystem path.
4. The renderer transfers that buffer into a dedicated module Web Worker. Transfer detaches the renderer's copy; closing or cancelling terminates the worker.
5. The worker has no Node.js, filesystem, SQLite, preload bridge, or calendar mutation API. The application CSP limits scripts, workers, fonts, images, and fetches to packaged application resources.
6. Extracted words, boxes, thumbnails, bounded high-resolution review images, skipped-row evidence, and drafts remain in memory. The main process retains only opaque source metadata for at most 30 minutes and four concurrent reviews.
7. The main process accepts only schema-validated reviewed forms tied to a live selection ID and verifies that every selected source-row identity carries the pending file's digest. Storage validates every item before opening one transaction and records the batch as one undoable action.
8. The optional repair IPC accepts only a live selection/digest pair and candidate-only parser disagreements. Qwen receives no source bytes, filesystem path, storage handle, or mutation channel. Its exact citations and selected candidate are revalidated against registered in-memory alternatives before review changes.
9. Coverage fallback is a separate IPC and grammar. It runs only when deterministic planning leaves an unclaimed date/time window, and Qwen can return only supplied block IDs grouped by field role. Main revalidates every ID, renderer projects it back to the exact extraction, and deterministic code still parses dates, times, recurrence, timezone, identity, and duplicates. A disabled, missing, timed-out, empty, unknown-ID, or semantically invalid result leaves the original analysis unchanged.

## Extraction pipeline

### Born-digital PDFs

PDF.js first reads embedded text. Each word is normalized into page-relative coordinates and grouped into visible lines. A shared layout pass measures ordinary word spacing and line height, then splits only table-sized horizontal gaps into separate evidence blocks. This preserves natural phrases while preventing a complete schedule row from collapsing into one title. It also normalizes fragmented punctuation such as `02 : 00 PM` before time parsing. A 2,200-pixel, 4.5-megapixel-capped page render supplies the zoomable review image; a separate 440-pixel thumbnail keeps navigation cheap. JPEG quality steps down only when necessary to stay inside the bounded in-memory contract. This path does not load the OCR language model.

### Scanned PDFs and images

Each page receives a coverage-aware native-text assessment before OCR. The gate still catches sparse text, but it also detects an isolated footer, URL, or accessibility label that would otherwise hide a raster schedule. When OCR is required, the page is rendered to an `OffscreenCanvas` and sent to the bundled Tesseract.js English LSTM model. Direct PNG, JPEG, and WebP imports use the same OCR path. OCR words retain confidence and normalized boxes, then pass through the same column-aware layout reconstruction as native PDF words, so the evidence overlay and planning behavior use one contract.

Compact block segmentation remains the default for dense tables, cards, and ordinary documents. An automatic-layout retry now also covers sparse, weak and calendar-free OCR; a candidate must improve text quality or calendar-grid recovery before replacing the first pass. Low-confidence or sparse OCR, including empty sideways output, receives bounded 90, 270, and 180 degree retries. PDF point dimensions are upscaled to the bounded render target to preserve small print. OCR output without word geometry stays empty and triggers retries; the reader never fabricates evidence boxes. The selected upright canvas supplies the review image and navigation thumbnail so evidence stays aligned.

Optional [OpenAI assistance](online-assistance.md) adds an explicit online coverage check from review. It sends the displayed page images and source windows only after the user chooses that action; the default pipeline and packaged acceptance tests remain offline.

PDF rendering uses a bounded `OffscreenCanvas` factory because the worker intentionally has no DOM. Rendering and OCR are capped before allocation, high-resolution review images are size-gated, and navigation thumbnails are downscaled before crossing back to React.

### Planning

PlanScan runs over the positioned blocks before proposal creation. Its project-trained INT8 heads classify fields and score spatial links across vertical cards, columns, and table rows. Contract validation requires every learned character span, word ID, relationship, and group to resolve to same-page source evidence. The deterministic document planner compiles each accepted candidate into a strict `DocumentPlanRecord` before CalendarIR resolution. That typed intermediate record carries item kind, title, description, absolute dates, start/end times, time basis, timezone and its origin, location, recurrence, course/section/CRN/component metadata, term bounds, weekdays, and field-level evidence IDs. Document imports no longer round-trip through synthetic assistant text, so conversational defaults cannot alter a fact extracted from a page.

The semantic compiler fails closed on impossible source dates, reversed same-day times, end dates before starts, schedule occurrences outside printed term bounds, recurrence without its own source evidence, weekday/term recurrence mismatches, and learned fields that cross another date/time row. Relative dates are accepted only when the document explicitly prints a bounded phrase such as “tomorrow” or “next Tuesday”; an unparseable date can never fall back to the current day. Document timezones must be printed and evidence-linked, otherwise the user’s calendar timezone is recorded explicitly as the default. A learned candidate that fails this gate cannot claim its anchors, leaving deterministic layout fallback eligible to recover a valid row.

The deterministic planner also recognizes aligned semester schedule rows. It keeps the row title, course code and section, term date range, weekday list, one or more meeting-time ranges, and location tied to their exact evidence blocks. Each scheduled meeting pattern becomes a weekly recurring event whose first occurrence is aligned to the first listed weekday and whose recurrence ends at the supplied term boundary. Multiple meeting patterns on one row become separate editable proposals. `ARR`, online, or incomplete rows without a fixed meeting time are counted and surfaced in a warning rather than converted into fabricated events.

Course syllabi receive a separate semantic reconstruction pass. A syllabus or course-outline heading establishes document-level course identity, optional labelled section/CRN/credit metadata, and evidence that can be carried to meeting patterns on later pages. A nearby title, term range, weekday phrase, time, and location must all remain source-backed before the planner emits a recurring class series. Component words such as lecture or laboratory remain distinct metadata, recurrence is bounded by the printed term end, and an internal neutral parser title prevents schedule words in the visible title from changing intent. Explicit `ARR`, “time TBA,” or “no fixed meeting time” entries with nearby item/date context are counted as intentional skips; explanatory prose, fixed-time meetings whose location contains `ARR`, and asynchronous content without that evidence are not turned into extra events or skips.

Rules remain active for less structured documents. They supplement date/time anchors not claimed by a learned group, remove browser print headers and footers from candidate titles, deduplicate candidates, and create at most 50 editable drafts. On a confidently reconstructed schedule row, explicit layout facts take precedence while PlanScan supplies corroborating evidence; if PlanScan cannot load or withholds an uncertain group, rules remain the fallback. Neither path writes to SQLite or invents facts absent from the extracted evidence. See [PlanScan](planscan.md) for the model boundary and metrics.

If those paths still leave a coverage gap and the optional Qwen pack is installed, the renderer builds bounded, overlapping one-page windows around unclaimed date/time anchors. Browser chrome and evidence-backed `ARR`, asynchronous, TBA, or no-fixed-time rows are excluded before inference. The grammar has no title, date, time, location, recurrence-value, prose-answer, or calendar-action fields: it can only assign exact supplied block IDs to roles. Each returned group is checked for known same-page IDs, unclaimed core anchors, explicit date and fixed-time/all-day evidence, recurrence cues, duplicate groupings, and source projection. The ordinary semantic compiler then performs calendar parsing and reconciliation; recovered cards are always marked `check evidence` and remain staged until confirmation. A dedicated compact document prompt avoids loading the larger conversational prefix, and the isolated worker reuses the installed model context while the pack is warm.

Month-calendar screenshots use their month/year heading, weekday column geometry, visible day cells, and within-cell ordering to reconstruct timed events and reminders. Adjacent-month cells are distinguished when the visible day sequence supplies that boundary. Unlabelled venues such as hotels, terminals, museums, studios, clinics, and pavilions are accepted only when they are spatially adjacent to the matching time; labelled locations remain preferred. Closely stacked, similarly sized title lines can be joined for flyers while field evidence retains every contributing block.

### Reconciliation and repeat imports

Every accepted draft receives two independent local identities. A stable source identity combines the selected file's SHA-256 digest with a hash of the normalized source row's page, geometry, and text. A semantic identity describes what the row means:

- class series use course code, section, CRN, component, weekdays, meeting time, term bounds, and timezone;
- general events use a canonical title, local start/end, timezone, and normalized location;
- reminders use a canonical title, due date/time, and timezone.

The review compares those identities with live calendar entities and shows one of four states. New items are selected. An exact source row imported earlier remains visible but cannot be selected again. A likely semantic duplicate remains visible and unselected so the user can explicitly keep both. Minor punctuation, spacing, and edit-distance title variation plus contained location aliases may produce this review-only match. A similar class with a different CRN, section, or component is labelled as distinct and stays selected; those identifiers are never silently merged. Common building aliases such as `Science & Engineering South` and `SES` normalize only for comparison, not for display or storage.

Editing a draft recomputes its semantic key and reconciliation in the renderer while preserving its source-row identity. The final commit repeats both the source digest and row ID, and the main process binds the digest to the still-live opaque selection. SQLite schema version 4 stores the validated identity in a separate local table with a unique source-digest/row constraint across events and reminders. That constraint is the final race-safe reimport guard. Ordinary event/reminder edits refresh the semantic key, undo restores the identity with the entity, and explicit deletion removes it so a deleted row may be imported again. No file path, source bytes, thumbnail, extracted prose, or evidence box enters this table.

### Confirmation and uncertainty

Confirmation presents the same staged items through complementary views instead of treating one weekly grid as complete:

- the weekly view explains series-versus-occurrence cardinality (`M/W/F` is one series and three weekly meetings);
- the chronological view keeps one-off plans on their actual dates and shows recurrence ranges without collapsing different weeks;
- the monthly view expands selected recurrences into occurrence-level calendar cells for the chosen month;
- the detail view groups lecture, laboratory, discussion, and other components by course while keeping sections and CRNs on separate cards;
- the source view uses the bounded high-resolution render with zoom, drag-to-pan, page buttons, thumbnails, and exact normalized evidence overlays.

Every editable field has a conservative source-confidence value computed only from its linked native-text or OCR blocks, and learned-link confidence can lower that value. Empty optional fields report no confidence rather than inheriting the item score. `ARR`, asynchronous, and incomplete schedule rows that can be identified safely become read-only skipped cards with their own page, reason, confidence, and evidence; they never become saveable drafts.

Structural controls are explicit user review actions. Splitting produces one stable reviewed source identity per weekday. Merging accepts only selected weekly rows with matching kind, title, time, timezone, location/notes, term boundary, and course identity; different CRNs, sections, or components are refused. Reclassification is available only for non-course plans. The commit boundary still validates every resulting event/reminder form and source digest, and no review image, source text, confidence value, or skipped card is persisted.

## Limits and failure behavior

| Limit                        |                                  Value |
| ---------------------------- | -------------------------------------: |
| Source bytes                 |                                 25 MiB |
| PDF pages                    |                                     20 |
| Decoded image area           |                          25 megapixels |
| OCR working area             | 4.5 megapixels / 2,200 px longest side |
| Review image                 |     2,200 px / 6.5M encoded characters |
| Extracted words              |                                 12,000 |
| Extracted characters         |                                200,000 |
| Proposed items               |                                     50 |
| Optional fallback blocks     |                     18 per page window |
| Optional fallback groups     |                     8 per model result |
| Worker timeout               |                              5 minutes |
| Staged selection lifetime    |                             30 minutes |
| Concurrent staged selections |                                      4 |

Encrypted, malformed, oversized, or unsupported files fail closed with a recoverable message. An error, timeout, close, or cancel terminates the worker and leaves the calendar unchanged. Committing validates the complete selected batch before the transaction begins, so partial document imports are not possible.

## Bundled, cross-platform runtime

Builds copy pinned PDF.js 6.2.108, Tesseract.js 7.0.0, the Tesseract WebAssembly cores, English trained data, and the roughly 30 KiB PlanScan artifacts into the application bundle. The document stack requires no Python or native OCR installation and makes no first-run download. The same browser/WASM/TypeScript assets run under Electron on Windows, macOS, and Linux.

`pnpm document-assets:prepare` creates the ignored `apps/desktop/.generated-public` directory from installed, lockfile-pinned packages and writes a runtime manifest. Production renderer output contains those assets, and `electron-builder` includes that output in each platform package.

PDF.js, Tesseract.js, and the trained-data package are build-time dependencies rather than production Node dependencies. This prevents their npm source trees from being duplicated beside the compiled worker and copied runtime assets. The verified Windows x64 directory package is 406.8 MiB, only 20.1 MiB larger than Phase 3.

## Verification

- Contract tests reject path leakage, byte-length changes, invalid progress, and out-of-page evidence boxes.
- Geometry tests cover PDF/PNG/JPEG/WebP signatures, dimensions, and normalized boxes.
- Planner tests verify native and OCR evidence produce the expected editable event/reminder drafts.
- Schedule-table regressions cover fragmented time punctuation, browser-print chrome, term-bounded weekday recurrence, multiple meeting patterns, and unscheduled `ARR` rows for both native and OCR evidence.
- PlanScan tests verify artifact integrity, exact span projection, block/entity roles, graph groups, deterministic output, and fallback behavior.
- Storage tests prove a mixed event/reminder batch is atomic and has one undo receipt.
- Processor tests prove cancel and dialog disposal terminate the active worker and reject the pending job.
- Born-digital and raster-only PDF fixtures are rendered and visually inspected in both vertical and row/table layouts; the Electron walkthrough exercises native extraction, OCR fallback, evidence review, one-transaction commit, and one-action undo.
- The network-offline Electron smoke fetches the packaged runtime manifest, PDF worker, and English OCR data before exercising the existing calendar, assistant, voice, and undo boundaries.
- The frozen Phase 0 corpus adds hybrid, rotated, multi-page, month-grid, phone-photo, flyer, and direct-image slices. `pnpm eval:documents:check` pins annotations and fixture hashes; `pnpm eval:documents:baseline` runs the real local extraction, PlanScan, and deterministic compiler path and reports proposal/cardinality, field, evidence, skip, and per-layout metrics. Project-generated fixtures remain explicitly separate from the independent human-blind count.
- Phase 1 regressions cover isolated hybrid text layers, bounded orientation recovery, adaptive calendar segmentation, month-cell reconstruction, stacked flyer titles, proximity-gated unlabelled locations, and unchanged exact duplicate handling. The frozen baseline improves from 73.7% to 100% proposal recall and from 3/12 to 11/12 perfect documents without changing corpus annotations.
- Phase 2 regressions cover term-bounded syllabus recurrence, document-level course metadata across pages, lecture/laboratory component preservation, neutral compilation of schedule-like titles, and evidence-gated no-fixed-time skips. The unchanged frozen corpus now scores 38/38 exact proposals, exact aggregate skip count, and 12/12 perfect documents; the independent human-blind count remains zero and is reported separately.
- Phase 3 regressions cover impossible dates, reversed times, source-backed timezone selection, recurrence-without-evidence rejection, exact schedule term/weekday invariants, cross-row PlanScan leakage, and deterministic fallback after learned candidates are withheld. The stricter typed compiler preserves the unchanged frozen result: 38/38 exact proposals, exact aggregate skip count, 100% evidence coverage, and 12/12 perfect documents.
- Phase 4 regressions cover stable source-row reimports, semantic matches from different files, normalized location aliases, completed cross-kind imports, identity persistence/migration/undo, and similar class rows with different CRNs or components. Likely duplicates remain explicit review decisions, while SQLite's unique source-row constraint prevents the same imported row from being committed twice.
- Phase 5 regressions cover per-field confidence, evidence-backed skipped rows, exact chronological ordering, monthly recurrence expansion, series/meeting/skip totals, split/merge/reclassification safeguards, distinct-component merge refusal, high-resolution review-image bounds, and commit-schema compatibility after structural edits. The unchanged frozen extraction corpus remains the acceptance gate because review changes must not alter source interpretation or proposal cardinality.
- Phase 6 regressions balance 120 runtime pages across six native/OCR challenge slices, mine nearby cross-row negatives, reject header/footer entities, and require at least 98% observed-source group micro F1, 95% exact-page agreement, and exact evidence on every slice. Pristine-fact fidelity is reported separately so irreversible OCR corruption stays visible. Repair tests prove that only registered parser candidates with exact title/date/time citations are accepted, that invented or partially quoted choices fail closed, and that the fallback response has no mutation authority. The frozen document corpus remains training-excluded and unchanged.
- Phase 7 adds a packaged, network-offline acceptance gate instead of inferring application behavior from developer-side extraction alone. Four representative native PDF, raster PDF, direct-image, and multi-page recurrence cases are imported through the production Electron picker, sandboxed worker, React review, IPC validation, SQLite transaction, reconciliation, and undo path. Each platform report requires exact field placement, visible in-bounds evidence for every draft, edit/selection round trips, no persistence before the explicit confirmation click, one atomic batch, same-source re-import lockout, distinct CRN/component identities, and one-action undo. CI runs and uploads separate reports for Windows x64, Linux x64, macOS arm64, and macOS x64.
- Coverage-fallback regressions recover a term-bounded M/W/F class from both native PDF text and OCR-like image evidence, accept multiple distinct groups, merge repeated groupings, skip fully claimed pages, reject unknown IDs and claimed anchors, and preserve the deterministic analysis on invalid output. The installed Qwen3 1.7B Q4 worker probe verifies exact title/date/time/location/recurrence role assignment with the real grammar and no input truncation.

Run the source/runtime gate with `pnpm verify`, then build a directory package and run `pnpm documents:release:package`; use `pnpm planscan:check` for the model/runtime fixture alone. For a privacy-preserving developer inspection of a born-digital PDF, run `pnpm document:inspect <path-to-native-pdf>`; it prints extracted proposal metadata without copying the source into the repository or contacting a service.

The document baseline is a development evaluation rather than an application dependency. Raster-PDF evaluation uses Poppler as a rendering oracle, while the shipped app continues to use its packaged PDF.js worker. See `evals/documents/README.md` for corpus provenance, collection rules, and commands.

## Upstream runtime references

- [Mozilla PDF.js examples](https://mozilla.github.io/pdf.js/examples/)
- [Tesseract.js README](https://github.com/naptha/tesseract.js/blob/master/README.md)
- [Tesseract.js local installation guide](https://github.com/naptha/tesseract.js/blob/master/docs/local-installation.md)
