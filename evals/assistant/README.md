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

Phase 8 now provides the privacy-safe collection, validation, contamination, model-lock, freeze, and scoring workflow under `human-blind/`. The honest committed count remains zero until real consenting participants contribute language; generated or developer-authored rows cannot satisfy it.

The executable workflow requires 2,000 distinct scenarios from at least 100 participants, synthetic calendar facts, public-release consent with a closed withdrawal window, two non-participant annotators in consensus, annotation before model output, no participant exposure to project examples, and zero exact or near contamination against all frozen and training surfaces. The private collection is Git-ignored. Freezing strips every participant, consent, and annotator identifier.

Run `pnpm eval:assistant:human-blind:status` for the honest collection count. The full protocol, generated JSON Schema, commands, scoring thresholds, and publication limits are documented in `human-blind/README.md` and `human-blind/protocol-v1.md`. The old `v0.1/human-blind-intake.schema.json` is retained only as Phase 0 history and is superseded by the Phase 8 schema.

While participant recruitment is pending, `synthetic-phase8/` provides a deterministic 2,000-scenario engineering proxy spanning all eleven Phase 8 categories. Run `pnpm eval:assistant:synthetic-phase8:check` to verify its generator and manifest or `pnpm eval:assistant:synthetic-phase8:evaluate` to exercise the full service. It is explicitly project-authored, training-excluded, and non-human evidence. The ordinary engineering release can pass while this study is pending; only a claim of independent human validation requires `pnpm eval:assistant:human-blind:gate`.

## Contextual Phase 0 audit suite

`contextual-phase0/` freezes the exact “anything tomorrow?” → “what times?” regression plus 432
developer-authored combinations across requested attributes, one/multiple/all scope, ordinal and
subset selection, summaries, noisy language, and topic switching. `contextual-phase7/` preserves
all 902 request turns from that suite byte-for-byte and adds exact expected seed indexes. At run
time, those indexes resolve to randomized database IDs, preventing plausible prose from hiding a
wrong referent. Run `pnpm eval:assistant:contextual-phase7:gate` for the 100 ms release gate.

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

The main fast evaluator continues to mark `optionalFallbackEvaluated: false` because it deliberately
does not load the 1.28 GB GGUF. The optional pack now has a separate hash-bound, non-mocked Phase 0
quality run under `evals/flex-model/phase0-quality/`; run `pnpm flex:quality:phase0` on a machine with
the pinned pack already installed. Keeping that hardware-specific result separate prevents Qwen's
latency from hiding native route performance or making ordinary CI depend on an optional download.

## Phase 7 release gate

Phase 7 retains the immutable `v0.1` baseline and adds a separately hash-bound supplement under `phase7/`. The supplement covers pending-review reads and immutable corrections, conflict checks, ordinary saved-calendar questions while a proposal is open, duplicate-title clarification, explicit cancellation, contextual class details, ordinal bulk selection, and noisy multi-event input.

The evaluator now records the active-proposal transition for every turn (`created`, `same`, `replaced`, `cleared`, or `none`) and can require the calendar snapshot to remain unchanged. It also applies a universal no-calendar-write assertion to every assistant response except a mutation receipt. This catches a class of failures that final-state checks miss, such as silently replacing a preview during a question or treating an unsaved proposal as saved calendar data.

`pnpm eval:assistant:gate` verifies both frozen manifests, then requires 100% scenario, turn, assertion, and preview-safety pass rates in rules-only and native-hybrid modes; at least 95% in-domain answered; and a 500 ms service p95 ceiling. The ceiling is intentionally tolerant of cross-platform CI variance. Actual latency remains printed and should be substantially lower.

`pnpm eval:assistant:release-phase7` composes that mutation gate with the unchanged-language
contextual gate, the Phase 6 runtime contract, real-Qwen evidence and per-tier resource budgets,
and the sealed human-study boundary. It requires 100% exact referent IDs and fact grounding, at
least 95% contextual accuracy, at least 99% benign installed-fallback resolution, and native p95
below 100 ms. Human evidence is reported separately as pending and is never synthesized.

This fast release gate does not load the optional GGUF. The separate installed-worker probe measures Qwen grounding and hardware latency so a slow optional model cannot hide native regressions or make clean-install CI depend on a 1.28 GB download.
