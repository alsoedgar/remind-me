# Phase 4 AssistantPlan training corpus

Model-improvement Phase 4 prepares the data contract for RemindCore Next. It
does not replace the installed v0.2 weights yet; training and promotion belong
to Phase 5.

The corpus is built in four layers:

```text
46-capability live registry
  -> 42 user-expressible intent specifications + 4 documented system outcomes
  -> project semantic families, compounds, and dialogue programs
  -> optional Qwen surface paraphrases behind deterministic curation
  -> project-only value materialization, noise transforms, and exact slot spans
  -> train / development / challenge JSONL with family isolation
```

Each row carries one ordered action list, a coarse route, current execution
eligibility, confirmation policy, protected source spans, optional bounded
dialogue conditions, semantic family, noise profile, and provenance. This lets
Phase 5 train separate route, action, slot, context, ambiguity, and risk heads
without teaching the model final timestamps or database IDs.

The teacher boundary is intentionally narrower than runtime fallback planning.
Qwen receives no calendar snapshot and returns no label. A teacher paraphrase
is admitted only when project code proves its marker signature and basic intent
cues are intact. Evaluation collision filtering occurs after generation; the
evaluation language itself is never placed in a teacher prompt.

The committed manifest reports row counts and hashes, capability coverage by
split, source and noise distributions, contextual and multi-action counts,
teacher provenance, and zero accepted evaluation collisions. `pnpm
assistant-corpus:check` regenerates every artifact in memory and fails on any
drift from the registry, raw teacher record, accepted templates, split files, or
manifest.

The current artifact admits 36 Qwen surfaces across 34 capabilities after 32
candidate rejections. Together with 126 project seed templates, compounds,
dialogue programs, hard negatives, and controlled noise, that produces 772
de-duplicated rows. Train/development/challenge contain 280/199/293 rows and all
three retain complete 42-capability coverage with zero semantic-family overlap.
Seventy rows are multi-action, 37 are contextual, and no human-blind example or
personal value is used.
