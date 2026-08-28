# ADR 0016: PlanScan repairs remain evidence-gated and advisory

- Status: accepted
- Date: 2026-08-27
- Extends: ADR 0004, ADR 0005, ADR 0008, and ADR 0015

## Context

PlanScan and the deterministic document parser can occasionally associate the same printed date/time anchor with different source-backed fields. Silently preferring either parser can turn a nearby heading, repeated course title, or neighboring row into a plausible but wrong proposal. Letting a general language model rewrite the extraction would be more dangerous: it could invent text, erase provenance, or blur the confirmation boundary.

The learned layout model also needed explicit coverage for OCR corruption, dense neighboring rows, repeated titles, unfamiliar column orders, and browser-print headers and footers. Aggregate accuracy alone does not expose regressions in those cases.

## Decision

PlanScan 0.2 is retrained from zero initialization on a deterministic 21,000-page corpus: 16,000 train, 2,500 development, and 2,500 test pages. Every split is balanced across native-text and OCR-like evidence and records six challenge slices. Pair training mines nearby cross-row and page-chrome negatives; the tracked 120-page runtime fixture contains ten native and ten OCR pages per slice.

The model remains a source association model. Exact source projection, same-page links, the deterministic semantic compiler, editable review, and explicit confirmation are required by the artifact schema and runtime checks.

When PlanScan and rules produce different valid records for the same exact source anchor, the planner may create a bounded `DocumentRepairSession`. Its candidates are complete, already validated local drafts with exact title/date/time source citations. If the separately installed Qwen pack is enabled, it may choose one supplied candidate or withhold. It cannot combine candidates, rewrite a field, emit a calendar action, or access storage. Main validates the active selection digest; the importer validates candidate identity and exact citations again before replacing a review draft. The response declares `hasMutationAuthority: false`.

No disagreement means no repair request. A missing, disabled, timed-out, or ungrounded fallback leaves deterministic proposals unchanged. Every result remains unsaved until the user reviews and confirms the ordinary document batch.

## Consequences

- Challenge-specific failures block model promotion instead of disappearing inside an aggregate score.
- Neighboring rows and repeated titles receive explicit negative supervision without using personal files, downloaded weights, or teacher data.
- The optional compact model can arbitrate parser disagreement without becoming an OCR corrector or calendar agent.
- Source text reaches the fallback only for an active local review and is neither uploaded nor persisted.
- Repair can improve candidate selection but cannot recover a field that neither parser extracted; users must still inspect evidence and edit proposals.
- General real-document accuracy remains unclaimed until a licensed, independently reviewed benchmark exists.
