# Phase 0 real-Qwen quality suite

This suite runs 12 synthetic, training-excluded quality cases through the actual pinned
`Qwen3-1.7B-Q4_K_M.gguf` and the shipped Electron utility worker. It does not use a mock, open the
calendar database, or read user conversations, profiles, or memories.

The five planner cases measure action cardinality, operation choice, exact target fields, and source
grounding. The seven response cases cover greeting/capability chat, ordinary advice, verified
multi-turn calendar facts, an offline live-information limitation, and concise follow-up behavior.
Worker latency and input truncation are recorded for every case.

Run the installed-model suite:

```powershell
pnpm flex:quality:phase0
```

Add `-- --require-gate` to return a failing exit code when any case fails. The model is never
downloaded by the evaluator; installation and the pinned checksum must already be complete.

Phase 7 additionally records the worker and prompt hashes, host hardware, selected runtime tier,
time to first token, warm workload p95, worker RSS, benign-resolution rate, grounding rate, and
false write claims. `pnpm eval:flex-model:phase7:check` verifies the committed real-model evidence
against the current executable artifacts and the tier budgets in `../phase7/hardware-gates.json`.
The overall raw quality score remains visible rather than being conflated with the 99% resolution
gate; unsafe or invalid plans still have no direct calendar authority.
