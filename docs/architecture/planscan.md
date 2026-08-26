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

## Packaging and failure

`scripts/prepare-document-assets.ts` copies PlanScan configuration and compressed weights beside PDF.js and Tesseract assets. `models/manifest.json` independently pins their byte length and SHA-256 for release verification. Settings reports model availability, scratch provenance, installed bytes, and working memory.

If fetch, decompression, digest, configuration, or inference fails, the worker records a review warning and returns the extracted page with `planScan: null`. Deterministic rules remain usable. No failure path changes the calendar.

## Evaluation

`pnpm planscan:check` validates 96 held-out positioned pages through the real TypeScript runtime. It reports born-digital and OCR-like execution separately, checks exact evidence, runs groups through the deterministic document compiler, measures warm p95, verifies the full offline manifest, and writes `ml/planscan/reports/runtime-metrics.json`.

The real fixture pair `phase7-table-plan.pdf` and `phase7-scanned-table-plan.pdf` contains the same visually reviewed row schedule. The native PDF has a text layer; the scan has none and therefore exercises OCR fallback. Generated evaluation remains insufficient for a real-world accuracy claim; see the model card for limitations.
