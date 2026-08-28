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
  -> standalone/follow-up/new-topic head
  -> requested-attribute head
  -> singular/plural/all scope head
  -> ordinal/subset selection head
  -> calendar-read/calendar-write/conversation/memory/unclear head
  -> confidence gate
       -> calendar advisory: enter the existing parser/fallback path
       -> otherwise: keep the deterministic router's decision
```

The nine assistant heads use the same 4,096-bucket FNV-1a word, word-bigram,
skip-bigram, shape, project-signal, and typed-context encoder. The selected
profile omits character n-grams after a development ablation showed that the
smaller surface generalized more selectively. All 340,051 assistant parameters
start at exact zero and are trained with three-order online discriminative
ensembles. The combined v0.4 artifact has 4,796,416 parameters.

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

Phase 5 provides project-authored semantic programs, labels, split ownership,
protected placeholders, contexts, noise, and review metadata. The corpus now
contains 1,033 rows, including 193 contextual turns, 42 explicit topic switches,
88 multi-action turns, and 160 deterministically accepted Qwen paraphrase rows.
Every row carries project-derived targets for dialogue relation, requested
attribute, scope, selection, and turn kind. The hash-pinned local Qwen3 1.7B Q4
pack supplies delexicalized wording only; it supplies no label, field value,
span, weight, confidence threshold, or runtime decision. Deterministic curation,
family-separated splits, protected-marker validation, and frozen-evaluation
collision checks remain mandatory.

## Authority and integration

`classifyAssistant` returns route, ordered capability guesses, action count,
context need, dialogue relation, requested attribute, scope, selection, turn
kind, calibrated confidences, and latency. The semantic fields are explicitly
advisory. The storage assistant reads the routing result only when the
deterministic router called a turn broad chat, the model predicts a calendar
read or write rather than a new topic, confidence exceeds 0.85, typed context
satisfies any context need, and every proposed capability is calendar-scoped.
The result can only cause the original text to enter the existing parser and
optional local fallback. It cannot populate fields or bypass source grounding.

The model has no database handle and cannot construct, resolve, confirm, or
execute CalendarIR or AssistantPlan. Existing schema validation, deterministic
date/recurrence math, dry run, visible review, destructive confirmation,
transaction, receipt, and undo boundaries remain unchanged.

## Measured checkpoint and limits

The quantized TypeScript runtime reports 89.2% route, 60.0% first-capability,
50.8% exact ordered sequence, and 60.7% multi-action exact accuracy on 390
developer challenge cases. The five Phase 5 heads report 95.9% dialogue
relation, 87.2% requested attribute, 97.2% scope, 93.6% selection, and 85.9%
turn-kind accuracy. Selective routing precision is 100% at 15.4% coverage, with
approximately 1.4 ms p95 on the latest development-machine run. The JSON
artifact is 6,414,443 bytes, below the 7 MiB gate.

These are synthetic/developer engineering results. The challenge was evaluated
in seven recorded Phase 5 iterations and is not untouched or independently
blind. The human-blind count is zero. Phase 8 must collect and freeze an
independent set before making a production generalization claim.

Phase 7 therefore adds an execution-level release gate rather than claiming a
larger model score. The original frozen baseline and a separate 12-scenario,
33-turn supplement run through the real storage assistant in rules-only and
native-hybrid modes. The supplement is excluded from all training and verifies
proposal continuity, immutable review replacement, no calendar write without a
receipt, multi-item wording, conflicts, ordinal selection, and contextual
questions. This protects shipped behavior while preserving Phase 8 as the
independent human-language gate.

Phase 8 implements that gate's collection and release infrastructure, not its
missing participants. Its private record contract requires explicit public-
release consent, a closed withdrawal window, participant-blind authorship,
synthetic calendar worlds, and consensus from two non-participant annotators
before model output. An audit requires 2,000 distinct scenarios from at least
100 people, fixed category and noise slices, and zero exact or 0.90-Jaccard
collisions with frozen or training surfaces. Freezing removes all collection
identifiers and binds the suite, protocol, model inventory, and contamination
sources. The evaluator refuses stale bindings and applies the human thresholds
in both rules-only and native-hybrid modes. Until a real collection is frozen,
the status remains 0/2,000 and no broad-generalization result is claimed.

## Verification

`pnpm remindcore-next:check` verifies report/artifact digests, Python-to-
TypeScript INT8 parity for the original and Phase 5 heads, the 42-capability
contract, advisory-only metadata, follow-up/subset/topic-switch probes, and the
latency/size budgets. `pnpm remindcore:check`
separately protects the original five heads. `pnpm verify:model-research` runs both
with `pnpm eval:assistant:gate`, the Phase 8 schema/training-boundary checks, and
the repository-wide build/test gates. `pnpm eval:assistant:human-blind:status`
reports collection readiness without treating zero honest records as an error.
