# ADR 0008: Evidence-gated PlanScan spatial graph

## Status

Accepted for the first PlanScan release.

## Context

The Phase 4 rules planner is safe and useful for vertically ordered schedules, but reading-order heuristics can confuse fields in tables, columns, and irregular cards. Shipping a pretrained document transformer would add substantial storage, memory, third-party provenance, and runtime complexity. An original compact model can learn the narrow grouping task, but probabilistic output must not gain authority to invent document text or write calendar data.

## Decision

Train a 5.24M-parameter `SpatialHashGraph` from zero initialization over project-generated positioned blocks. Use separate heads for block role, entity role, relation, group link, document type, and confidence. Run the INT8 table in the existing sandboxed document Web Worker after PDF/OCR extraction.

PlanScan is evidence gated:

1. Model roles may only project to exact character ranges and word IDs from a source block.
2. Relations and groups may only reference known same-page spans.
3. The graph decoder withholds low-confidence groups and cannot invent missing text.
4. The deterministic document planner converts accepted evidence to `CalendarIR`, resolves calendar time, and keeps review mandatory.
5. Rules supplement only date/time anchors not already claimed by an accepted model group.
6. Missing, corrupt, or incompatible artifacts fall back to the rules-only path.

## Consequences

- The application gains learned table/column grouping with roughly 30 KiB installed model cost and 5 MiB bounded working memory.
- Model provenance is fully project-owned and reproducible without shipping Python.
- Exact evidence and review are structural contracts, not evaluation-only aspirations.
- OCR correction is intentionally conservative; corrupted source text may lower scanned execution accuracy.
- Synthetic results are a checkpoint. Real reviewed documents and an independent human blind set remain future work.

## Alternatives considered

- Bundled LayoutLM/Donut-class model: stronger general representation, but far beyond the storage/runtime budget and not original scratch weights.
- Raw-pixel vision model: duplicates OCR work and needs a much larger, more varied visual corpus.
- Rules only: reliable fallback, but brittle across row/column layouts.
- Direct model-to-calendar JSON: rejected because it loses exact evidence and crosses the deterministic command boundary.
