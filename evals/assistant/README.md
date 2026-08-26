# Assistant evaluation

This directory is the Phase 0 measurement boundary for RemindCore, RemindSpeak, deterministic routing, and the optional local-language fallback.

The committed `v0.1/scenarios.jsonl` suite contains real user-reported regressions, developer challenge cases, and explicit safety contracts. It is frozen by `v0.1/manifest.json`, versioned, and marked `trainingExcluded: true`. The runner refuses to score it if its count or SHA-256 no longer matches. It is useful for repeatable regression measurement, but it is **not** called independent human-blind data because several requests already influenced the app.

Run the complete baseline:

```powershell
pnpm eval:assistant:baseline
```

Run one route or one case while developing:

```powershell
pnpm eval:assistant:baseline:native
pnpm exec tsx scripts/evaluate-assistant-baseline.ts --case=user.multi-create-two-classes --no-write
```

The runner creates an isolated in-memory database per scenario, fixes locale/timezone, seeds only synthetic calendar facts, executes the real `PersistentAssistantService`, checks the review-before-write boundary, and then scores semantic outcomes. It never opens or changes the user's calendar database.

## Independent human-blind collection

Phase 0 deliberately reports the current human-blind count as zero. To collect it honestly:

1. Ask participants to write requests without seeing training templates or the expected parser vocabulary.
2. Have a separate annotator record the expected response kind, action count, targets, dates/times, recurrence, and safe confirmation behavior.
3. Store rows locally as `v0.1/human-blind.local.jsonl`; this path is git-ignored and must never be used by `ml/remindcore`, `ml/remindspeak`, teacher generation, prompt tuning, or paraphrase generation.
4. Validate and score it with `pnpm exec tsx scripts/evaluate-assistant-baseline.ts --suite=evals/assistant/v0.1/human-blind.local.jsonl`.
5. Freeze a hashed release snapshot only after collection ends. Keep at least 2,000 untouched scenarios for the final release gate.

The intake schema is documented in `v0.1/human-blind-intake.schema.json`. Calendar contents should be synthetic or explicitly consented; do not collect private calendar exports.

## Phase 0 targets

These are forward release targets, not claims about the current baseline:

- 95% single-action scenario accuracy.
- 90% multi-action and multi-turn scenario accuracy.
- At least 99.5% precision for native model-assisted plans at 80% or greater native coverage.
- At least 95% ambiguity and out-of-domain recall.
- Fewer than 1% unanswered clear in-domain requests.
- Zero unconfirmed destructive, bulk, or series-wide writes.
- 100% preservation of calendar facts in user-visible answers.
- Native p95 under 100 ms, excluding database startup.
- Optional Qwen planning accepted by grounding on more than 97% of sampled requests, with warm CPU targets below 8 seconds for one action and 20 seconds for four actions.

The optional Qwen pack remains marked `fallbackBenchmarkPending` until its slow, hardware-specific benchmark is run separately. Mixing it into the fast native suite would hide route latency and make ordinary CI impractical.
