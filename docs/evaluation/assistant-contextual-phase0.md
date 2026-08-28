# Contextual assistant Phase 0 report

## Outcome

Phase 0 now freezes and measures the failures identified in the conversational-assistant audit. It
does not claim that the later dialogue-state and grounded-summary work is complete.

The exact user-reported flow—`do I have anything tomorrow?` followed by `what times?`—passes on the
native path. The response uses the prior verified event IDs, reports both class-time mappings, does
not call Qwen, and records the route as `calendar` with the `last-query` context frame.

## Frozen contextual corpus

The hash-bound suite contains 433 scenarios and 902 turns:

- One exact screenshot regression in a synthetic calendar world.
- 36 initial-query/follow-up combinations for each of 12 families: time, location, date, duration,
  notes, recurrence, ordinal selection, subsets, all-item scope, summaries, typo/spacing/ASR noise,
  and returning to an earlier result after a topic change.
- Every row is excluded from training. The corpus is synthetic engineering evidence, not independent
  human-blind evidence.

The manifest SHA-256 is
`7a5051bb7e334f3c4711483adb7eac74951d2777a898a2dc6c8ef44f46c99bb1`.

## Native reference baseline

The August 28, 2026 Windows reference run produced:

| Mode                          | Scenario pass | In-domain answered |      p95 |
| ----------------------------- | ------------: | -----------------: | -------: |
| Rules only                    |         16.2% |              51.3% |  47.8 ms |
| RemindCore/RemindSpeak hybrid |         18.2% |              60.6% | 110.9 ms |

The exact screenshot case passed in both modes. Time was the strongest family at 25/36 rules-only
and 30/36 native-hybrid. Recurrence, subset selection, and summaries are all 0/36, which gives Phase
1 and Phase 2 concrete targets rather than hiding them behind a small aggregate suite. The compact
machine-readable result is in `evals/assistant/contextual-phase0/baseline.reference.json`.

## Privacy-safe execution diagnostics

Every `PersistentAssistantService.send()` call now creates one bounded, process-local execution
trace containing only:

- route category;
- context-frame category;
- fallback workload and outcome;
- whether bounded context or model input was truncated;
- elapsed milliseconds.

The trace never contains prompt text, calendar facts, item IDs, conversation IDs, profile data, or
memory content. At most 200 traces are retained in memory and none are persisted by the service.
The assistant evaluator includes the corresponding trace with each synthetic turn when a report is
written.

Five focused tests distinguish an installed/answered fallback from disabled, missing, timed-out, and
invalid-output states. This is measurement only; the Phase 3 planner/responder interface split is
still intentionally pending.

## Real-Qwen reference baseline

The installed 1.28 GB `Qwen3-1.7B-Q4_K_M.gguf` was checksum-verified and run through the actual
Electron utility worker. No model was mocked, downloaded, or given access to SQLite or user data.

The frozen 12-case suite passed 8/12 strict cases:

- Planner: 3/5 after enforcing the configured 90-second timeout.
- Chat: 5/7.
- Median latency: 15.620 seconds.
- p95/cold maximum: 104.746 seconds.
- Truncated inputs: 0.

The four frozen gaps are:

1. A semantically correct two-event cold plan exceeded the configured 90-second app timeout.
2. A location update was mistranslated as an event move with the wrong target field.
3. A greeting echoed the user's question instead of explaining capabilities.
4. A contextual time answer returned both times but omitted the class-name-to-time mappings.

The full result is `evals/flex-model/phase0-quality/real-qwen.latest.json`. This is a hardware-specific
engineering baseline, not a cross-platform latency claim.

## Commands

```powershell
pnpm eval:assistant:contextual-phase0:check
pnpm eval:assistant:contextual-phase0:evaluate
pnpm flex:quality:phase0
```

The Qwen command requires the already-installed, pinned model. It never downloads a model.

## Boundary

The independent human study remains 0/2,000 scenarios from 0/100 participants. This Phase 0 corpus
and the real-Qwen prompts are synthetic, training-excluded engineering evidence and do not change
that count.
