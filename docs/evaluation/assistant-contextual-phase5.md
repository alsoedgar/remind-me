# Assistant contextual Phase 5 — native model expansion

## Outcome

Phase 5 expands the project-owned RemindCore and RemindSpeak models without
turning either model into an authority over calendar facts or writes. RemindCore
now predicts five additional contextual properties, and RemindSpeak now keeps
benign clarification and runtime limitations separate from genuine policy
boundaries.

The optional Qwen pack remains a fallback for language breadth. Its weights are
not imported into either custom model. A QLoRA fine-tune is intentionally
deferred because the new native heads pass their prespecified engineering gates;
remaining failures should first be isolated by the later fallback-performance
and independent-evaluation phases.

## RemindCore v0.4

The promoted scratch-trained artifact has nine assistant heads:

1. route;
2. ordered capability;
3. action count;
4. context required;
5. standalone, follow-up, or new topic;
6. requested attribute;
7. singular, plural, or all scope;
8. ordinal or subset selection; and
9. calendar-read, calendar-write, conversation, memory, or unclear turn kind.

All outputs are advisory. The TypeScript calendar parser, typed dialogue state,
grounding, review, destructive confirmation, atomic transaction, receipt, and
undo path retain authority. In particular, a native guess cannot populate a
field, select a database row, create a plan, or write to storage.

The selected model uses 4,096 zero-initialized hashed feature buckets with no
character n-grams. It has 4,796,416 total parameters and a 6,414,443-byte JSON
artifact. The model remains local, dependency-light, and cross-platform.

## Corpus expansion

The assistant corpus moved from 772 to 1,033 rows and from 37 to 193 contextual
rows. It now contains:

- 42 explicit new-topic examples;
- 151 follow-up examples;
- 88 multi-action examples;
- 160 Qwen-paraphrase rows accepted by deterministic curation;
- project-authored semantic targets for dialogue relation, requested attribute,
  scope, selection, and turn kind; and
- user-reported phrasing, typo/noise, ASR-like wording, ordinal/subset requests,
  multi-item turns, and topic switches.

Qwen contributes wording only. Labels, slot values, contexts, split ownership,
confidence thresholds, and runtime decisions remain project-owned. The builder
rejects invalid placeholders, duplicate families, and collisions with frozen
evaluation surfaces.

## Quantized challenge checkpoint

The 390-case developer challenge produces the following INT8 results:

| Metric                       | Result | Gate |
| ---------------------------- | -----: | ---: |
| Route accuracy               |  89.2% |  80% |
| First-capability accuracy    |  60.0% |  60% |
| Exact ordered sequence       |  50.8% |  50% |
| Multi-action exact accuracy  |  60.7% |  40% |
| Follow-up/new-topic accuracy |  95.9% |  85% |
| Requested-attribute accuracy |  87.2% |  75% |
| Scope accuracy               |  97.2% |  80% |
| Selection accuracy           |  93.6% |  80% |
| Turn-kind accuracy           |  85.9% |  85% |
| Selective route precision    |   100% |  99% |
| Selective route coverage     |  15.4% |   4% |

Python evaluation reports about 4.1 ms p95. The TypeScript parity check is
normally about 1–2 ms p95 on the development machine and has a 50 ms release
ceiling. Exact latency is hardware-dependent.

These are developer-generated engineering measurements, not an independent
human-language result. The independent Phase 8 study remains at 0/2,000
scenarios from 0/100 participants.

## RemindSpeak v0.4

RemindSpeak now has 22 protected speech acts and 528 project-authored surface
atoms. Four new acts distinguish:

- conversational clarification;
- optional runtime unavailable;
- offline fact unavailable for verification; and
- a genuine policy boundary.

Benign contextual and general-chat paths no longer use “safe action” or
calendar-boundary boilerplate. Actual safety refusal remains explicit and
separate. The 32,440,848-parameter sparse INT8 table occupies 30.9 MiB when
expanded, while its installed JSON and reproducibly compressed weights total
272,708 bytes.

The generated test split reports 74.95% mean INT8 head accuracy, 100% protected
fact retention, and zero unsupported static factual-literal introduction. The
tracked TypeScript fixture retains the reference in its top five candidates
79.6% of the time, produces zero recent exact repeats, and runs at about 11.3 ms
warm p95 on the development machine. The human preference study remains
uncollected and is not represented as complete.

## Release checks

`pnpm remindcore-next:check` now requires Python-to-TypeScript parity for all
five new semantic heads and runs direct regressions for plural time follow-ups,
subset mutation wording, and calendar-to-conversation topic switching.

The Phase 5 verification surface is:

```text
pnpm assistant-corpus:check
pnpm remindcore-next:check
pnpm remindcore:check
pnpm remindspeak:check
pnpm verify
```

The original RemindCore heads are checked separately so the new assistant heads
cannot hide a regression in the shipped calendar-intent model.

## Remaining boundary

This phase improves fast local understanding; it does not make the compact
custom models open-domain LLMs. General knowledge, unusual language, and
long-form conversation can still use the optional Qwen fallback. Phase 6 is
responsible for fallback streaming, cancellation, prompt size, scheduling,
warmth policy, and hardware acceleration. Phase 7 remains responsible for the
final contextual and real-Qwen release gates.
