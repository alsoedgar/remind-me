# PlanScan document model

## Runtime path

```text
bounded PDF/image bytes
  -> PDF.js text or local Tesseract OCR
  -> words + normalized boxes + line blocks
  -> PlanScan INT8 block/entity heads
  -> pairwise spatial graph + confidence gate
  -> exact source spans, links, and groups
  -> deterministic rules supplement unclaimed anchors
  -> CalendarIR parse/resolve
  -> optional candidate-only repair when parsers disagree
  -> exact-citation validation
  -> editable batch review with highlighted evidence
  -> explicit one-transaction commit + one undo receipt
```

PlanScan runs after extraction in the existing terminable, sandboxed module Web Worker. It fetches only packaged same-origin configuration and gzip weights, verifies decompressed size and SHA-256, and expands a 5 MiB `Int8Array`. The worker has no Node APIs, path, preload bridge, storage handle, mutation IPC, or network dependency.

## Learned outputs

- Seven block roles.
- Eight entity roles with exact character/word evidence projection.
- Six relation types.
- Four group-link classes.
- Eight document types.
- Seven confidence/quality classes.

The pairwise graph is narrow by design. It associates source fields; it is not a generative document LLM. A bounded decoder prevents evidence reuse across accepted groups, combines learned relation probabilities with geometry, and requires a date, title, and time (or explicit all-day marker).

## Deterministic boundary

Zod cross-validates PlanScan output against the source pages. A span's text must equal `block.text.slice(start, end)`, its word IDs must belong to the block, and all group references must resolve on one page. The document planner then copies the exact title evidence, uses the existing parser for semantic time, and passes the draft through the existing resolver. No model-produced instant or database instruction is accepted.

Model groups claim their date/time anchors. The Phase 4 rules planner still examines the page, but it only supplements unclaimed anchors; this prevents table reading order from adding a second false proposal after a correct learned row group.

Phase 6 adds a narrow disagreement path. When PlanScan and rules compile different valid records for the same exact date/time anchor, the planner retains both already validated drafts and their exact title/date/time citations. The optional Qwen pack may select one candidate ID or withhold. It cannot synthesize a third candidate or emit a calendar action. The importer revalidates every returned citation and candidate against the in-memory analysis, marks any alternate choice for evidence review, and leaves the ordinary confirmation-only commit boundary unchanged. No parser disagreement means no fallback request.

## Packaging and failure

`scripts/prepare-document-assets.ts` copies PlanScan configuration and compressed weights beside PDF.js and Tesseract assets. `models/manifest.json` independently pins their byte length and SHA-256 for release verification. Settings reports model availability, scratch provenance, installed bytes, and working memory.

If fetch, decompression, digest, configuration, or inference fails, the worker records a review warning and returns the extracted page with `planScan: null`. Deterministic rules remain usable. No failure path changes the calendar.

## Evaluation

`pnpm planscan:check` validates 120 held-out positioned pages through the real TypeScript runtime. Ten native-text and ten OCR pages cover each of six slices: baseline, OCR corruption, neighboring-row negatives, repeated titles, unfamiliar column order, and header/footer distractions. It gates each slice at 98% observed-source group micro F1 and 95% exact-page agreement, checks exact evidence and all training promotion gates, measures warm p95, verifies the full offline manifest, and writes `ml/planscan/reports/runtime-metrics.json`. Pristine pre-corruption fidelity and deterministic compiler output are reported separately rather than being mislabeled as layout-grouping accuracy.

The real fixture pair `phase7-table-plan.pdf` and `phase7-scanned-table-plan.pdf` contains the same visually reviewed row schedule. The native PDF has a text layer; the scan has none and therefore exercises OCR fallback. Generated evaluation remains insufficient for a real-world accuracy claim; see the model card for limitations.
