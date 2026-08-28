# Assistant contextual Phase 7 — release gates

## Outcome

Phase 7 establishes an engineering release gate for contextual calendar accuracy, mutation safety,
fallback resolution, and hardware-bounded local inference. The engineering gate can pass while the
independent human study is pending; it does not convert synthetic evidence into a human-validation
claim.

## Frozen contextual evidence

`contextual-phase7` preserves the language from the original Phase 0 regression suite byte-for-byte:
433 scenarios and 902 turns covering requested attributes, one/multiple/all scope, ordinal and
subset selection, summaries, noisy language, and topic switching. It adds 866 exact seed-index
expectations. The evaluator resolves those indexes to freshly randomized SQLite entity IDs on each
run, so an answer cannot pass by mentioning plausible text while returning the wrong referent IDs.

The Windows reference run passed every scenario and assertion in both modes:

| Mode          | Scenario accuracy | Exact referents | Calendar facts | Benign resolution | Native p95 |
| ------------- | ----------------: | --------------: | -------------: | ----------------: | ---------: |
| Rules only    |            100.0% |          100.0% |         100.0% |            100.0% |    49.2 ms |
| Native hybrid |            100.0% |          100.0% |         100.0% |            100.0% |    59.9 ms |

The separate 40-scenario baseline and 12-scenario mutation/review supplement still require 100%
scenario, turn, assertion, and safe-preview results. The focused safety run adds 145 tests for
wrong-target selection, exact model source spans, no write claims, complete-or-nothing batches,
context resolution, and fact-reference validation. A 128-request benign installed-responder matrix
requires at least 99% non-unsupported outcomes and an unchanged calendar; the reference run passed
all 128.

## Real Qwen measurement

The actual checksum-pinned Qwen3 1.7B Q4_K_M pack—not a mock—was run through the shipped Electron
utility worker. The report binds the suite, model, worker, prompts, planner schema, and chat schema
by SHA-256.

Reference hardware: Windows x64, 24 logical processors, 31,866 MiB total RAM, CPU backend,
`performance` tier.

| Measurement               |    Result | Tier ceiling |
| ------------------------- | --------: | -----------: |
| Benign resolution         |    100.0% |        99.0% |
| Calendar/source grounding |    100.0% |       100.0% |
| False write claims        |         0 |            0 |
| Truncated frozen inputs   |         0 |            0 |
| Full-request p95          |  70.973 s |    120.000 s |
| Warm planner p95          |  30.207 s |     60.000 s |
| Warm chat p95             |  41.852 s |     60.000 s |
| First-token p95           |  29.810 s |     45.000 s |
| Peak isolated-worker RSS  | 2,848 MiB |    3,584 MiB |

Raw task-quality accuracy was 83.3% and remains visible as a separate metric. The two misses were
one direct unsplit two-event planner case and one raw capability reply. The application does not
turn either miss into an unsafe write: multi-item plans are complete-or-nothing and capability
questions have a fast native path. This gate measures safe useful resolution and grounding; it does
not misrepresent the 1.7B model as universally correct.

## Human evidence status

Independent human-blind validation is pending at 0/2,000 scenarios from 0/100 participants. This
does not block the engineering release. It does block claims such as “95% accurate on independent
human language” until the separately consented, annotated, contamination-audited study exists.
`pnpm eval:assistant:human-blind:gate` remains the opt-in future claim gate.

## Commands

```text
pnpm eval:assistant:contextual-phase7:check
pnpm eval:assistant:contextual-phase7:gate
pnpm eval:flex-model:phase7:measure
pnpm eval:flex-model:phase7:check
pnpm eval:assistant:release-phase7
```

`pnpm verify` includes the engineering release gate and the human-data boundary/schema checks, but
does not require nonexistent participant data or download the optional model during clean CI.
