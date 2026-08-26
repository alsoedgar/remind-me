# Local document planning

Phase 4 turns user-selected PDFs and images into editable calendar proposals without uploading the source or giving probabilistic code a storage handle.

## User path

```text
native file picker
  -> main-process byte and signature validation
  -> opaque source metadata + in-memory ArrayBuffer
  -> terminable sandboxed document worker
  -> native PDF text, or OCR only when native text is sparse
  -> positioned words and evidence-linked ImportDraft items
  -> editable batch review
  -> one validated SQLite transaction after explicit confirmation
  -> one undo receipt
```

The attachment button lives beside the assistant text and microphone controls. The review sheet keeps the source thumbnail, extraction method, page, confidence, and evidence snippets visible beside editable event and reminder fields. Users may deselect individual proposals, discard the whole staged review, or commit the selected batch.

## Trust boundaries

1. The Electron main process owns the operating-system picker and is the only layer that sees the selected path.
2. Main accepts only regular PDF, PNG, JPEG, or WebP files. It checks the byte signature, declared image dimensions, byte limit, and SHA-256 digest before returning data.
3. The preload bridge returns an opaque selection ID, safe display name, media type, size, digest, and a bounded `ArrayBuffer`. It never returns the filesystem path.
4. The renderer transfers that buffer into a dedicated module Web Worker. Transfer detaches the renderer's copy; closing or cancelling terminates the worker.
5. The worker has no Node.js, filesystem, SQLite, preload bridge, or calendar mutation API. The application CSP limits scripts, workers, fonts, images, and fetches to packaged application resources.
6. Extracted words, boxes, thumbnails, and drafts remain in memory. The main process retains only opaque source metadata for at most 30 minutes and four concurrent reviews.
7. The main process accepts only schema-validated reviewed forms tied to a live selection ID. Storage validates every item before opening one transaction and records the batch as one undoable action.

## Extraction pipeline

### Born-digital PDFs

PDF.js first reads embedded text. Each word is normalized into page-relative coordinates and grouped into visible lines. A shared layout pass measures ordinary word spacing and line height, then splits only table-sized horizontal gaps into separate evidence blocks. This preserves natural phrases while preventing a complete schedule row from collapsing into one title. It also normalizes fragmented punctuation such as `02 : 00 PM` before time parsing. A low-resolution page render supplies the review thumbnail. This is the fast path and does not load the OCR language model.

### Scanned PDFs and images

A page with fewer than 24 embedded characters is rendered to an `OffscreenCanvas` and sent to the bundled Tesseract.js English LSTM model. Direct PNG, JPEG, and WebP imports use the same OCR path. OCR words retain confidence and normalized boxes, then pass through the same column-aware layout reconstruction as native PDF words, so the evidence overlay and planning behavior use one contract.

PDF rendering uses a small `OffscreenCanvas` factory because the worker intentionally has no DOM. Rendering and OCR are capped before allocation, and thumbnails are downscaled before crossing back to React.

### Planning

PlanScan runs over the positioned blocks before proposal creation. Its project-trained INT8 heads classify fields and score spatial links across vertical cards, columns, and table rows. Contract validation requires every learned character span, word ID, relationship, and group to resolve to same-page source evidence. The deterministic document planner then compiles accepted groups through the existing calendar-language parser and resolver.

The deterministic planner also recognizes aligned semester schedule rows. It keeps the row title, course code and section, term date range, weekday list, one or more meeting-time ranges, and location tied to their exact evidence blocks. Each scheduled meeting pattern becomes a weekly recurring event whose first occurrence is aligned to the first listed weekday and whose recurrence ends at the supplied term boundary. Multiple meeting patterns on one row become separate editable proposals. `ARR`, online, or incomplete rows without a fixed meeting time are counted and surfaced in a warning rather than converted into fabricated events.

Rules remain active for less structured documents. They supplement date/time anchors not claimed by a learned group, remove browser print headers and footers from candidate titles, deduplicate candidates, and create at most 50 editable drafts. On a confidently reconstructed schedule row, explicit layout facts take precedence while PlanScan supplies corroborating evidence; if PlanScan cannot load or withholds an uncertain group, rules remain the fallback. Neither path writes to SQLite or invents facts absent from the extracted evidence. See [PlanScan](planscan.md) for the model boundary and metrics.

## Limits and failure behavior

| Limit                        |                                  Value |
| ---------------------------- | -------------------------------------: |
| Source bytes                 |                                 25 MiB |
| PDF pages                    |                                     20 |
| Decoded image area           |                          25 megapixels |
| OCR working area             | 4.5 megapixels / 2,200 px longest side |
| Extracted words              |                                 12,000 |
| Extracted characters         |                                200,000 |
| Proposed items               |                                     50 |
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

Run the current complete gate with `pnpm verify`; use `pnpm planscan:check` for the model/runtime fixture alone. For a privacy-preserving developer inspection of a born-digital PDF, run `pnpm document:inspect <path-to-native-pdf>`; it prints extracted proposal metadata without copying the source into the repository or contacting a service.

## Upstream runtime references

- [Mozilla PDF.js examples](https://mozilla.github.io/pdf.js/examples/)
- [Tesseract.js README](https://github.com/naptha/tesseract.js/blob/master/README.md)
- [Tesseract.js local installation guide](https://github.com/naptha/tesseract.js/blob/master/docs/local-installation.md)
