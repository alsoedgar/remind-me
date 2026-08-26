# Assistant Phase 0 baseline

Generated: 2026-08-26T09:46:27.945Z

Suite: `evals/assistant/v0.1/scenarios.jsonl` (40 frozen scenarios; SHA-256 `0adff837434c8902a720f6e85b9e5d1049e117619521d831ef04748a8c776ca5`)

Human-blind scenarios collected: **0**. The committed seed suite is regression/challenge data and is never presented as an independent human-blind set.

| Mode | Scenario pass | Turn pass | In-domain answered | Safe previews | Median | p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| rules-only | 100.0% (40/40) | 100.0% | 97.7% | 100.0% | 7.5 ms | 29.3 ms |
| native-hybrid | 100.0% (40/40) | 100.0% | 97.7% | 100.0% | 13.5 ms | 27.7 ms |

## Capability breakdown

| Category | rules-only | native-hybrid |
| --- | ---: | ---: |
| ambiguity | 100.0% (2/2) | 100.0% (2/2) |
| bulk | 100.0% (4/4) | 100.0% (4/4) |
| conversation | 100.0% (5/5) | 100.0% (5/5) |
| memory | 100.0% (2/2) | 100.0% (2/2) |
| multi-action | 100.0% (5/5) | 100.0% (5/5) |
| multi-turn | 100.0% (2/2) | 100.0% (2/2) |
| mutation | 100.0% (5/5) | 100.0% (5/5) |
| open-dialogue | 100.0% (2/2) | 100.0% (2/2) |
| query | 100.0% (7/7) | 100.0% (7/7) |
| safety | 100.0% (2/2) | 100.0% (2/2) |
| single-action | 100.0% (4/4) | 100.0% (4/4) |

## Native component checks

- RemindCore generated-fixture operation accuracy: **97.5%**. Its confidence gate reaches **13.0%** coverage at **100.0%** eligible precision; ambiguity recall is **84.1%** and component p95 is **1.2 ms**.
- RemindSpeak protected-fact retention: **100.0%**; reference response in top five: **88.8%**; recent exact-repeat rate: **0.0%**; component p95 is **6.6 ms**.
- The generated component fixtures and this full-service challenge suite answer different questions. High isolated component scores do not erase end-to-end routing failures.

## rules-only failures

None.

## native-hybrid failures

None.
