# Contextual assistant Phase 3

Phase 3 repairs the optional-model routing boundary after the deterministic dialogue and grounded-answer work completed in Phases 1 and 2.

## Implemented

- Separate `CalendarFallbackPlanner` and `GeneralFallbackResponder` capabilities in the assistant service.
- Production wiring that passes the local Qwen runtime through both narrow interfaces instead of one combined planner/chat object.
- Strict contract schemas for calendar `plan` and `not-calendar` outcomes, general `answer` outcomes, and the shared `missing`, `disabled`, `timeout`, `unavailable`, and `invalid-output` failures.
- Runtime adapters that convert the older nullable Qwen APIs into typed results while preserving compatibility with existing test and integration providers.
- Calendar fallback traces that retain the exact typed failure reason without recording prompt content.
- A planner-to-responder handoff only for non-mutation language classified as `not-calendar`.
- Explicit offline/runtime limitations for unanswered general conversation.
- Calendar clarifications or limitations for planner failures, with no proposal and no database change.
- Message-scoped multi-item planning through the same typed calendar boundary.
- Recognition of calendar-reflection rewrites as calendar work, preventing grounded summaries from being diverted to broad chat.

Free-form chat is not an executable calendar representation. Any request recognized as a calendar mutation is barred from the general responder; only a source-grounded structured plan may continue into deterministic recompilation, dry run, review, confirmation, atomic apply, and undo.

## Verification

The Phase 3 boundary tests cover:

- Direct broad conversation reaching only the general responder.
- Unresolved calendar language reaching only the structured planner.
- Grounded structured plans producing review previews without applying data.
- `not-calendar`, missing, disabled, timed-out, unavailable, and invalid planner outcomes producing no proposal and no calendar state change.
- Free-form responses that claim “Done, I added it” never substituting for failed calendar planning.
- Strict schemas rejecting chat text in the planner channel, plans in the responder channel, malformed plans, and ambiguous nulls.

The August 28, 2026 verification completed with 519 tests across 66 files, TypeScript, focused ESLint and formatting checks, and a production Electron build. The assistant release gates remained green:

| Suite                | Mode          | Scenario pass | In-domain answered |     p95 |
| -------------------- | ------------- | ------------: | -----------------: | ------: |
| Baseline             | rules-only    |        100.0% |              97.7% | 41.8 ms |
| Baseline             | native-hybrid |        100.0% |              97.7% | 56.8 ms |
| Phase 7 release gate | rules-only    |        100.0% |             100.0% | 78.0 ms |
| Phase 7 release gate | native-hybrid |        100.0% |             100.0% | 82.0 ms |

## Boundaries

This phase establishes routing and authority separation. The structured conversational envelope and post-generation calendar-fact boundary are implemented in [Contextual assistant Phase 4](assistant-contextual-phase4.md). Real-Qwen quality and hardware measurements remain in their dedicated flex-model suites. The independent human study remains separate and unchanged at 0/2,000 scenarios from 0/100 participants.
