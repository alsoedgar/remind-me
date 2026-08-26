# RemindCore Next advisory understanding

## Purpose

RemindCore Next extends the always-installed scratch planner from thirteen
calendar operations to the application's broader AssistantPlan vocabulary. It
is a compact classifier system, not a generative LLM. The optional Qwen pack is
still useful for open-ended language, but it is not required to run these heads
and none of its weights ship inside RemindCore.

```text
normalized request + bounded typed dialogue context
  -> 6-way route head
  -> 1/2/3 action-count head + conservative clause boundary decoder
  -> shared 42-way capability head for each clause
  -> standalone/context-required head
  -> confidence gate
       -> calendar advisory: enter the existing parser/fallback path
       -> otherwise: keep the deterministic router's decision
```

The four heads use the same 8,192-bucket FNV-1a word, word-bigram,
skip-bigram, shape, project-signal, and typed-context encoder. The selected
profile omits character n-grams after a development ablation showed that the
smaller surface generalized more selectively. All 434,229 added parameters
start at exact zero and are trained with three-order online discriminative
ensembles. The combined v0.3 artifact has 4,890,624 parameters.

## Multi-action decoding

The capability table is shared across action positions. A right-biased
segmenter separates at punctuation and conjunction boundaries, then evaluates
each local clause. Project-owned capability cues constrain a clause only when
exactly one route-local capability matches. Later clauses without an explicit
action cue may inherit the prior capability, which supports lists such as three
events at three grounded times without three model tables.

A narrow structural count decoder applies only to strong forms: an action cue
immediately after a separator, `and to` in a paired reminder, `then put`, or a
create request containing multiple grounded times and a separator. All other
counts use the learned head. This avoids the unsafe shortcut of treating every
`and` as a second operation.

## Training and teacher boundary

Phase 4 provides project-authored semantic programs, labels, split ownership,
protected placeholders, contexts, noise, and review metadata. The Phase 5
teacher pass asked the hash-pinned local Qwen3 1.7B Q4 pack for delexicalized
wording only. Deterministic curation accepted 73 templates and materialized 219
training surfaces across 37 capabilities; 95 candidates were rejected for
duplicates, length, marker drift, or missing required cues. Qwen supplied no
capability label, field value, span, weight, confidence threshold, or runtime
decision.

## Authority and integration

`classifyAssistant` returns route, ordered capability guesses, action count,
context need, calibrated confidence, and latency. The storage assistant reads
this result only when the deterministic router called a turn broad chat, the
model predicts the calendar route above 0.85, typed context satisfies any
context need, and every proposed capability is calendar-scoped. The result can
only cause the original text to enter the existing parser and optional local
fallback. It cannot populate fields or bypass source grounding.

The model has no database handle and cannot construct, resolve, confirm, or
execute CalendarIR or AssistantPlan. Existing schema validation, deterministic
date/recurrence math, dry run, visible review, destructive confirmation,
transaction, receipt, and undo boundaries remain unchanged.

## Measured checkpoint and limits

The quantized TypeScript runtime reports 90.4% route, 63.8% first-capability,
52.2% exact ordered sequence, and 69.6% multi-action exact accuracy on 293
developer challenge cases. Selective routing precision is 100% at 10.9%
coverage, with approximately 1.5 ms p95 on the development machine. The JSON
artifact is 6,536,991 bytes, below the 7 MiB gate.

These are synthetic/developer engineering results. The challenge was evaluated
in seven recorded Phase 5 iterations and is not untouched or independently
blind. The human-blind count is zero. Phase 8 must collect and freeze an
independent set before making a production generalization claim.

## Verification

`pnpm remindcore-next:check` verifies report/artifact digests, Python-to-
TypeScript INT8 outcome parity, the 42-capability contract, advisory-only
metadata, semantic probes, and the latency/size budgets. `pnpm remindcore:check`
separately protects the original five heads. `pnpm verify:model-research` runs both
with the frozen assistant evaluation and the repository-wide build/test gates.
