# Phase 0 contextual regression suite

This frozen engineering suite captures the conversational-context failures identified in the
assistant audit. It contains one exact user-reported regression in a synthetic calendar world plus
432 deterministic developer-authored combinations across time, location, date, duration, notes,
recurrence, ordinal selection, subsets, all-item scope, summaries, noisy language, and returning to
calendar results after a topic change.

All 433 scenarios and 902 turns are excluded from training. They are synthetic engineering evidence,
not independent human-blind evidence, and do not change the human-study count.

Generate or integrity-check the frozen corpus:

```powershell
pnpm eval:assistant:contextual-phase0:generate
pnpm eval:assistant:contextual-phase0:check
```

Measure the current native baseline without treating the known Phase 1/2 gaps as a release gate:

```powershell
pnpm eval:assistant:contextual-phase0:evaluate
```

Each evaluated turn includes a bounded execution trace containing only route category, context-frame
category, fallback workload/outcome, truncation, and latency. The trace never stores prompts,
calendar facts, item IDs, conversation IDs, or profile data.
