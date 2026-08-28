# Assistant release Phase 7 report

> This file records the original pending-review release supplement. The broader contextual Phase 7
> gate now composes this unchanged mutation/safety suite with 866 exact referent checks, a 100 ms
> native gate, installed-fallback resolution, and real-Qwen resource evidence. See
> `docs/evaluation/assistant-contextual-phase7.md`.

## Outcome

The native-first assistant now has a strict, hash-bound end-to-end release gate for generalized requests and conversational pending reviews. The gate passed both the unchanged 40-scenario Phase 0 baseline and the new 12-scenario, 33-turn Phase 7 supplement in rules-only and RemindCore/RemindSpeak modes.

## What the gate proves

- A preview is created without changing the calendar.
- Read-only questions keep the exact active proposal instead of treating it as saved data.
- Corrections retire and replace a preview rather than mutating it in place.
- Duplicate titles and invalid selection remain clarifications.
- Saved-calendar questions bypass an open proposal.
- Saved/proposed and proposed/proposed conflicts are grounded before confirmation.
- Cancellation clears the proposal without a calendar write.
- Ordinal bulk actions remain one reviewed transaction.
- User-reported typo, compact-time, multiple-exam, first-class, room, and follow-up forms retain their intended facts.
- Every non-receipt response preserves the calendar snapshot.

The evaluator fails the process unless both modes achieve 100% scenario, turn, assertion, and safe-preview pass rates; at least 95% in-domain answered; and p95 below 500 ms. The manifest also binds the exact suite path, byte hash, scenario count, and turn count.

## Reference run

On the Windows development machine on August 27, 2026, the unchanged baseline passed at 31.0 ms rules-only p95 and 39.8 ms native-hybrid p95. The Phase 7 supplement passed at 32.8 ms and 42.9 ms respectively. These are local engineering measurements, not cross-platform production latency claims; the 500 ms threshold is a regression ceiling for CI variance.

## Optional-model boundary

The fast gate intentionally does not download or execute Qwen. It verifies native routing and the storage safety boundary on a clean install. The separately installed Qwen worker remains covered by its grammar, exact-source grounding, utility-process, workload, and hardware probes. Its measured latency must never be blended with native p95 or presented as native-model performance.

## Remaining limitation

All Phase 7 rows are synthetic developer challenges or safety contracts and are excluded from training, but they are not independently human-blind. The honest human-blind count remains zero. A later gate must collect and freeze consented, independently authored language before claiming broad real-user generalization.
