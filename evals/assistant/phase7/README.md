# Phase 7 assistant release suite

This frozen supplement exercises the conversational review and generalized request paths added after the original Phase 0 baseline. Its 12 scenarios and 33 turns cover mixed event/reminder previews, ordinal and typo corrections, subset narrowing, duplicate titles, saved-calendar and proposal-proposal conflicts, query isolation, cancellation, contextual class details, selected bulk deletion, and compact multi-event wording.

Every row is synthetic, `trainingExcluded`, and hash-bound by `manifest.json`. The cases are developer challenges or safety contracts, not independent human-blind language. They must never be used for RemindCore, RemindSpeak, prompt, threshold, or optional-model training.

Run only this suite:

```powershell
pnpm eval:assistant:phase7
```

Run the original frozen baseline and this supplement as one strict release gate:

```powershell
pnpm eval:assistant:gate
```

The gate requires both rules-only and native-hybrid modes to pass every scenario, turn, and assertion; answer at least 95% of in-domain turns; preserve every preview without an early write; and remain under the configured 500 ms service-level p95 ceiling. The generous ceiling is a cross-platform regression alarm, not a claimed typical latency. Reports continue to print the actual measurements.

The suite does not run the optional GGUF. Qwen quality and hardware latency remain separately measured by the installed-model worker probe; this fast gate verifies only the native-first orchestration and the fact that local-model text has no direct mutation authority.
