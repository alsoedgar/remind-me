# Dialogue state and grounded references

Phase 2 adds a small, typed dialogue state beside each local assistant conversation. It is not a transcript summary and it is not model-generated memory. SQLite stores the exact entity IDs returned by the last calendar read, the currently focused event/reminder IDs, the last resolved query and UTC range, and one pending clarification. Database schema version 3 migrates existing installations forward without rewriting events, reminders, preferences, turns, or proposals.

## Reference resolution

The deterministic parser receives the pruned focus IDs with the current event and reminder snapshots. Singular references such as “it,” “that,” and “that one” resolve only when exactly one compatible active item is focused. A singular reference with several focused items asks which item the user means; a missing or deleted focus also asks instead of guessing.

Plural references such as “them,” “these,” “those,” and “both” can carry an exact recent result set into a read. For bulk mutations, the service first expands a bounded set of uniquely named focused items, and every resulting action then passes through the ordinary multi-request parser, AssistantPlan v2 validation, deterministic resolution, dry run, one atomic review, confirmation, and undo path.

Query follow-ups such as “more” reuse the last resolved query range rather than depending on the immediately preceding text turn or recalculating a relative day after a restart. “Where is it?” and “when is that one?” search the focused entity by ID and render only verified stored fields.

## Clarifications

A parser clarification stores its code, source request, safe display options, and timestamp. A short answer that matches the missing fact is merged into that request and reparsed. This supports date/time replies and explicit or ordinal target choices while keeping the original write unexecuted. A different request clears the pending clarification.

Conversation clearing deletes the conversation row, so SQLite cascades its turns, proposals, and dialogue state together. The assistant then creates a fresh empty state. Calendar data and explicit user-approved profile memory remain separate and are not deleted by clearing a chat.

## Optional model context

The Qwen fallback receives a bounded JSON view of focused item labels, the active range, the last query shape, and the pending question. This context is marked as untrusted data in the worker prompt. The model may use it to classify phrasing, but it cannot supply database authority: exact source grounding and the deterministic focus resolver still choose the allowlisted IDs.

## Bounds and pruning

- Focus and last-result lists are unique and capped at 100 IDs.
- Planner context is capped at 6,000 characters and chat calendar context at 8,000 characters.
- Every state read removes IDs whose local entity no longer exists.
- The stored query range must have a valid start before end.
- A response with no related items does not silently replace an established focus, while a calendar query with no results explicitly clears it.
