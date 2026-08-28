# Assistant contextual Phase 6 — local fallback performance

## Outcome

Phase 6 makes the optional Qwen3 1.7B Q4 fallback feel responsive without
giving it additional calendar authority. Foreground assistant work now has
priority over PDF/image repair, inference can be stopped cooperatively, queue
and generation phases are visible in the chat UI, and safe open-ended text is
rendered from real worker token callbacks.

Calendar-factual output keeps the stricter Phase 4 boundary: generated tokens
stay private until the complete fact-reference envelope validates. The UI then
reveals only the locally rendered, verified answer. A partial model sentence can
therefore never expose an invented time, room, recurrence, status, or claimed
write.

## Scheduler and cancellation

The former promise-tail FIFO has been replaced by a bounded typed scheduler:

1. chat;
2. calendar planning;
3. document disagreement repair; and
4. document coverage fallback.

An active document job yields when foreground work arrives and resumes from its
bounded source request afterward. At most two preemptions are allowed per
document job. Each assistant request carries its renderer-generated stream ID
through IPC to the scheduler and worker `AbortSignal`. Stop works for queued,
loading, and generating requests; cancellation returns a grounded local reply
and never stages or applies a calendar mutation.

The renderer receives typed `queued`, `loading`, `generating`, `validating`, and
`cancelled` events. It keeps the thinking bubble before the first safe token,
shows cumulative text once generation is visible, and provides a Stop control
in both states.

## Prompt and context reductions

- The stable planner prefix no longer repeats the complete operation catalog.
  A short request-specific operation guide includes only plausible operations.
- Empty summary, history, calendar, and grounding sections are omitted from
  broad-chat prompts.
- Document repair and coverage policies moved into their task prompts, leaving
  a 212-character shared document system prefix.
- Repair and fallback share one document session prefix instead of destroying
  the cache when the operation changes.
- Calendar fact packets are selected by singular/plural intent, limited to 3,
  6, or 12 facts, stripped of unrequested fields, and bounded to 5,800
  characters. Review status/action fields remain available when a proposal is
  open.
- Planner dialogue context is bounded to 4,000 characters.

Every worker result records queue wait, time to first token, backend, cold start,
input truncation, and whether the stable prefix was reused. Settings exposes
these metrics without allowing the renderer to choose raw context, token, path,
or thread parameters.

## Memory and acceleration policy

Users can choose Memory saver, Automatic, or Keep warm when hardware allows.
Memory saver unloads after 30 seconds. Keep warm uses a one-hour idle window
only with at least 16 GiB total and 4 GiB currently free; otherwise the selected
hardware tier wins. Live pressure can still shorten any idle window.

Portable installers retain the existing CPU baseline on Windows/Linux and Metal
on Apple silicon. Release builders may opt into a larger Windows/Linux x64
variant by setting `REMIND_ME_LLAMA_ACCELERATION=vulkan` or
`REMIND_ME_LLAMA_ACCELERATION=cuda`. Packaging retains the CPU runtime as a
fallback, prunes every unrelated native package, and writes a manifest listing
only packaged backends. Runtime selection is Metal, CUDA, Vulkan, then CPU; the
user may always force portable CPU. This avoids increasing the normal installer
for users who do not need GPU binaries.

## Verification surface

The Phase 6 gate is:

```text
pnpm eval:flex-model:phase6:check
```

It checks prompt-size ceilings, operation-specific planning, omitted empty chat
sections, scheduler/cancellation wiring, typed stream and metrics contracts,
prefix observability, and portable/Vulkan package selection. Unit and integration
coverage additionally exercises priority ordering, document preemption/resume,
active cancellation, hardware profiles, safe live broad-chat streaming,
calendar-factual buffering, queue UI state, and the Stop bridge.

These are engineering checks, not a claim about independent language quality.
The independent Phase 8 study remains honestly pending at **0/2,000 scenarios
from 0/100 participants**. The separate synthetic stress suite does not change
that count.

## Remaining boundary

The optional model remains removable, offline after installation, and unable to
open SQLite, invoke mutation IPC, confirm a proposal, or bypass deterministic
grounding. GPU variants change execution speed and installer size only; they do
not change model weights, calendar authority, or evaluation claims.
