# ADR 0012: Promote RemindCore Next only as a selective routing advisor

- Status: accepted
- Date: 2026-08-26
- Extends: ADR 0006 and ADR 0011

## Context

AssistantPlan v2 names 42 user-expressible capabilities across calendar,
conversation, memory, app, and document routes. The original native planner
recognizes thirteen calendar operations and one action at a time. Making the
optional Qwen pack the default planner would weaken the always-installed,
project-owned story and increase disk, memory, and hardware requirements.
Allowing a newly trained classifier to emit fields or executable plans would,
however, grant accuracy experiments authority over calendar state.

## Decision

Promote a zero-initialized RemindCore v0.3 extension with four compact heads:
route, shared per-clause capability, bounded action count, and typed-context
need. Select capacity and feature profiles on development behavior, require
selective precision and coverage as selection constraints, quantize per output
channel to INT8, and require TypeScript/Python outcome parity.

Use project-authored structural rules only for explicit multi-action boundaries
that the learned count head cannot represent reliably. Do not interpret every
conjunction as an action.

At runtime, accept the extension only as advice that a broad-chat-routed turn
should enter the existing calendar parsing path. Require a calendar route above
the calibrated threshold, sufficient typed context, and exclusively
calendar-scoped capability predictions. Never accept model-authored values,
plans, review policy, or writes.

Retain exact provenance: Qwen provides curated delexicalized wording only; no
teacher weights, labels, private data, or conversation logs enter the student.
Record that the developer challenge was evaluated seven times during
engineering and is no longer untouched. Do not substitute it for Phase 8's
independent human-blind gate.

## Consequences

- The installed native project model understands a substantially broader
  vocabulary and explicit multi-action structure while remaining under 7 MiB.
- Users without the optional pack gain fast local routing assistance; broad
  generation still uses the optional model when installed.
- Existing parsing, grounding, resolution, review, confirmation, storage, and
  undo remain the sole authority path.
- A correct model guess may recover a request the deterministic router called
  broad chat; an incorrect or low-confidence guess safely leaves the prior path
  unchanged.
- Synthetic and repeatedly inspected developer metrics support engineering
  promotion only. They do not establish human-language generalization.

## Rejected alternatives

- Ship Qwen weights inside the native model: no longer a scratch-trained native
  artifact and materially increases the default footprint.
- Let the classifier create AssistantPlan or CalendarIR fields: crosses the
  source-grounding and execution boundary.
- Lower the failed multi-action gate: hides a decoder defect instead of fixing
  the general clause representation.
- Treat every `and` as a second action: breaks ordinary titles and compound
  single requests.
- Call the developer challenge blind after inspecting failures: misstates the
  evidence and weakens the later release evaluation.
