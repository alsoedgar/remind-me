# ADR 0006: RemindCore ships as a confidence-gated hybrid

- Status: accepted for the Phase 5 prototype
- Date: 2026-08-24
- Updated by: ADR 0010 for the v0.2 Qwen-assisted training curriculum

## Context

The deterministic parser is auditable and safe, but it cannot recognize every natural paraphrase. A general-purpose local LLM would improve language coverage at the cost of substantially more storage, memory, latency, factual freedom, and third-party model provenance. A scratch model can be genuinely project-owned and tiny, but the first generated-data prototype is not accurate enough to own calendar execution.

## Decision

RemindCore v0.1 is a 4,456,448-parameter joint semantic planner trained from zero initialization. It predicts operation, BIO copy spans, ambiguity, out-of-domain status, and risk from hashed word, character n-gram, shape, replicated semantic-cue, and local-context features. Three deterministic training orders for the operation head are averaged into one table, improving development accuracy and INT8 stability without adding runtime parameters. Its release artifact uses per-output-channel symmetric INT8 tables and a dependency-free TypeScript inference kernel. A matching quantized ONNX graph is bundled for portability and parity experiments.

The model is an advisory parser, not an agent:

1. The established rules parser runs first.
2. A recognized rules result wins, except for the rules parser's generic “dated text means event” fallback.
3. RemindCore may hint only `event.create`, `reminder.create`, `calendar.list`, `calendar.search`, `calendar.availability`, or `calendar.conflicts`.
4. The hint must pass calibrated operation, ambiguity, and OOD thresholds and any required title/target must be copied from the request.
5. The deterministic parser recompiles the original source text with the hint. Zod validates the resulting `CalendarIR.Draft`.
6. Existing resolution, dry-run, review, confirmation, transaction, receipt, and undo boundaries remain unchanged.
7. Destructive, medium-risk, recurring-series, and unsupported operations cannot be introduced by RemindCore.

If weights are missing, corrupt, or incompatible, startup records the error and the assistant continues in rules-only mode.

## Consequences

- The installed app needs no account, network, Python, Ollama, or model download.
- Runtime planner storage is 5.7 MiB; the auditable ONNX parity graph adds 4.3 MiB.
- The model improves a conservative subset of paraphrases without expanding database authority.
- Phase 5's 96% clear in-domain and human blind-test research targets are not claimed. The prototype remains confidence-gated until independently authored data supports a wider gate.
- Phase 6 response generation is separate. RemindCore understands requests; it does not generate conversational prose.

## Rejected alternatives

- A small pretrained LLM as the default parser: larger and less constrained, with third-party weights and weaker exact factual guarantees.
- Replacing rules outright: the current generated-only evaluation does not justify that authority.
- Model-assisted destructive edits: confidence cannot replace explicit targeting and confirmation.
- Shipping Python or ONNX Runtime solely for this small linear model: unnecessary cross-platform storage and dependency cost. The ONNX graph remains available for parity and future runtime selection.
