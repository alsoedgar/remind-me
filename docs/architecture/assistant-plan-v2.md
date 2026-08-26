# AssistantPlan v2 and capability registry

## Purpose

`CalendarIR.Draft` remains the narrow, deterministic calendar compiler contract. It intentionally represents one calendar operation, so it cannot by itself describe a request such as “add lunch, open the calendar, then switch to mini view,” express dependencies between actions, or distinguish an implemented handler from a feature that merely exists elsewhere in the app.

`AssistantPlan v2` is the domain-level orchestration contract above `CalendarIR`. It gives native rules, RemindCore, the optional Qwen translator, document planning, and future dialogue models one verified target without granting any of them execution authority.

```text
user source
   -> planner-specific interpretation
   -> AssistantPlan v2
        actions[] + capabilities + evidence + dependencies + response goal
   -> capability/status validation
   -> existing typed handler adapter
   -> CalendarIR resolve/dry-run or another allowlisted app handler
   -> review/confirmation
```

## Plan invariants

Every plan contains:

- Version `2`, a bounded request ID, the original source text, planner provenance, status, confidence, and one response goal.
- One to fifty ordered actions. Every action has its own request ID, capability ID, typed target and argument family, risk, recurrence scope, evidence references, review policy, and dependencies.
- Source evidence that already satisfies the existing strict evidence contract.
- A response goal that separates brief answers, detailed answers, previews, clarifications, receipts, conversation, and unsupported responses. It also bounds item and word counts and declares which fact classes the response should include.

The schema rejects duplicate action/evidence IDs, unknown evidence references, forward or missing dependencies, non-exact text evidence spans, and clarification/unsupported statuses without their matching actions. Dependencies can reference only an earlier action, which makes cycles structurally impossible.

## Capability truthfulness

The registry assigns every capability one status:

| Status            | Meaning                                                                                                              |
| ----------------- | -------------------------------------------------------------------------------------------------------------------- |
| `assistant-ready` | The assistant currently has an allowlisted typed handler for this capability.                                        |
| `conditional`     | The handler exists but requires an explicitly installed optional component, currently the broad local language pack. |
| `app-ready`       | The app already supports the feature through UI/IPC, but natural-language assistant dispatch is not connected yet.   |
| `planned`         | The capability is named for planning/evaluation but no production handler exists.                                    |

This distinction prevents a model or help response from treating “known to the registry” as “safe to execute.” `assertAssistantPlanExecutable` accepts only `assistant-ready` actions. App-ready navigation, appearance, window, startup, import/export, and model-management entries cannot pass that guard until a later phase adds a user-visible dispatcher and its policy.

Each definition also declares its argument and target families, handler boundary, confirmation policy, multi-action support, optional-model requirement, and language aliases. Validation runs before handler dispatch.

## Current compatibility path

All ordinary hybrid calendar parses now cross the v2 boundary:

1. Rules and the gated RemindCore hint produce a `CalendarIR.Draft` exactly as before.
2. The compatibility adapter maps the draft to a grounded v2 action and validates its capability.
3. The v2 action is compiled back into `CalendarIR.Draft`.
4. Only that round-tripped draft reaches deterministic resolution, dry-run, review, and storage.

Multi-part calendar requests also assemble one v2 plan before the existing atomic batch proposal is staged. This preserves current behavior while proving that the new contract can carry every reviewed action in source order. Qwen output still passes exact-substring grounding and deterministic reparse before it reaches this boundary.

The existing whole-schedule clear and copy-day handlers also validate dedicated v2 capabilities before staging. A clear action uses a bounded `calendar-bulk` target containing the exact captured event/reminder IDs and scope; a copy-day action carries the exact source IDs and reviewed recurrence. Neither helper replaces the existing payload, dry run, confirmation, transaction, or undo checks.

The compatibility adapter maps every existing CalendarIR operation, including clarification, rejection, unsupported, and document proposals. Low-risk writes remain previews; deletes and future/series scopes remain explicit confirmations; reads and clarification never gain write authority.

## Deliberate non-goals for this phase

- App-ready capabilities are not yet dispatched from chat.
- `AssistantPlan` is transient and is not added to the user database or conversation payload.
- The schema does not make RemindCore generative or broaden its calibrated eligibility gate.
- Dialogue entity state and pronoun resolution are implemented by the Phase 2 state layer described in `dialogue-state.md`; they remain outside the transient plan payload itself.
- Model architecture/training and Qwen runtime optimization remain later phases.

These boundaries let evaluation distinguish language understanding, plan construction, capability availability, deterministic execution, and response generation instead of collapsing them into one accuracy number.

## Verification

Tests cover complete registry coverage, status truthfulness, argument/target mismatch rejection, app-ready execution rejection, exact evidence projection, destructive-review preservation, multi-action dependency ordering, CalendarIR round trips, and live hybrid-parser integration. The frozen Phase 0 end-to-end suite must remain unchanged after this compatibility migration.
