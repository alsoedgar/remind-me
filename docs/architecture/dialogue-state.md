# Dialogue state and grounded references

The local assistant keeps a small, typed dialogue state beside each conversation. It is not a transcript summary and it is not model-generated memory. SQLite stores exact calendar references, the last resolved query and UTC range, bounded ordered query frames, and one pending clarification. Dialogue payload version 2 upgrades older version 1 JSON in place; this needs no database reset or SQLite schema bump and does not rewrite events, reminders, preferences, turns, or proposals.

## Ordered query frames

Every successful list, search, availability, or conflict read appends an immutable result frame containing its operation, exact range/timezone, chronological event/reminder order, selected occurrence subset, requested fields, referent cursor, continuation cursor, and timestamp. Event references contain both the stable event ID and occurrence start, so two meetings from the same recurring series remain distinct. Events and reminders share one ordered sequence instead of separate ID buckets.

The history retains the latest twelve frames, with at most 200 occurrence references per frame. A follow-up updates only that frame's selected items, fields, referent/continuation cursors, and active-frame pointer; it does not fabricate a new calendar query. A non-calendar topic switch leaves the active frame intact. Phrases such as “previous results” can reactivate the immediately earlier frame, including after restart. Early version 2 payloads without the additive continuation field default it to null when read.

Legacy version 1 payloads retain their focus and last query. Because they did not store occurrence starts, migration marks those references as legacy-null and resolves them against current local entities/occurrences on first use. The upgraded version 2 payload is then written back automatically. Missing event/reminder IDs are pruned from both compatibility focus lists and every frame, and an invalid cursor is cleared.

## Reference resolution

The deterministic parser receives the pruned focus IDs with the current event and reminder snapshots. Singular references such as “it,” “that,” and “that one” resolve only when exactly one compatible active item is focused. A singular reference with several focused items asks which item the user means; a missing or deleted focus also asks instead of guessing.

Plural references such as “them,” “these,” “those,” and “both” can carry an exact recent result set into a read. For bulk mutations, the service first expands a bounded set of uniquely named focused items, and every resulting action then passes through the ordinary multi-request parser, AssistantPlan v2 validation, deterministic resolution, dry run, one atomic review, confirmation, and undo path.

Ordered references such as “the second one,” “number two,” “the first and third,” “the first two,” and “the last event” resolve against frame positions rather than title search. This remains unambiguous when stored items share a title. Classes, labs, lectures, reminders, events, explicit titles, and whole/selected result scopes are typed selectors. An unavailable position asks for clarification instead of falling through to fuzzy title matching.

The contextual resolver runs before generic routing and types four dimensions independently:

- requested attributes: name, time, start, end, date, location, duration, notes, recurrence, or full details;
- scope: one item, the selected subset, or all focused results;
- selection: positions, next/cursor, semantic item kind, pronoun, or saved title;
- intent: list, summarize, compare, explain, continue, modify, or delete.

Common reads such as “what times?”, “where were they?”, “how much time does each take?”, “which weekdays are those classes?”, and noisy variants stay on the deterministic local path. “Show all” restores the complete ordered frame, while “what about the others?” selects either the unselected complement or the next unpresented page. Contextual writes hand the exact selected IDs into the existing preview, dry-run, confirmation, atomic transaction, and undo pipeline.

## Grounded answer presentation

Phase 2 renders answers only from materialized entities and exact frame occurrences. The renderer receives already-verified values and has no repository access, inference path, or write authority. A normal list returns concise names. Attribute follow-ups return only the requested values; detailed and summary requests use their own explicit modes.

Results larger than eight items are grouped by local calendar date and show a precise range such as “Showing 1–8 of 13.” The frame stores the index of the next selected item, and “continue,” “next page,” or “what about the rest?” resumes from it after an application restart. The final page clears the continuation cursor and another continuation request receives a specific completion response.

Duplicate titles are never collapsed. They are disambiguated with their verified local date and time while their stable ID/occurrence keys remain unchanged. Mixed events and reminders retain chronological order, recurring occurrences remain separate, all-day values say “all day,” and absent locations or notes use explicit local-data wording. References to entities that no longer exist are pruned; a concurrent stale item is skipped and identified rather than replaced with a guess.

Mutation subsets such as “delete the first and third ones” are expanded only when every requested position exists, every position is distinct, and the selected display titles can be routed without ambiguity. The expanded commands are still proposals: all selected actions are dry-run together and shown as one atomic, undoable review. Invalid positions and duplicate-title subsets remain unexecuted and require an explicit choice.

Phase 4 also resolves factual descriptions against verified local fields. Follow-ups such as “the 3 PM one,” “the evening reminder,” and “the one in Studio B” compare the recent focus with stored local time and location values, then return exact IDs. A move or duplicate parses its destination separately, so a clock used to identify the source can never become the new event time. Exact stored titles take precedence when words such as “Morning” are part of the title itself, and multiple factual matches still require clarification.

Bounded plural descriptions such as “the morning ones” or “the ones in Studio B” may expand to two through fifty uniquely named focused items. Moves, deletes, and completions then use the ordinary exact-target batch planner, review, confirmation, transaction, and undo boundary. These common follow-ups stay on the millisecond native path even when the optional fallback is installed; unresolved or ambiguous language can still enter the grounded fallback without granting it selection authority.

## Pending-review corrections

Phase 5 gives the visible, unsaved proposal its own bounded dialogue scope. A user can say “actually make the second one 4 PM,” “keep only the first and third,” “remove the first one from that review,” or use the reviewed title. Positions always refer to the numbered review rows—not title search or the eventual chronologically sorted calendar. This also keeps duplicate-titled rows selectable by exact position.

Corrections never mutate a pending proposal in place. The service rebuilds the affected forms, resolves dates and times through the deterministic calendar engine, validates every resulting command against a sequential dry-run state, and only then stores a replacement proposal with bounded original-request and correction evidence. SQLite retires the older pending proposal in the same transaction that stores the replacement. No event or reminder is written until the replacement is confirmed, and the confirmed batch remains one undoable action.

Removing rows can narrow a batch or collapse it to an ordinary single-item proposal. Removing every row cancels the review without touching calendar data. An out-of-range position, duplicate title, invalid timing, unsupported field, stale stored target, or ambiguous instruction returns a clarification while leaving the current proposal active and byte-for-byte unchanged. Common corrections stay on the native path and do not wake the optional Qwen fallback.

## Pending-review questions

Model-improvement Phase 6 makes the same unsaved review readable as well as editable. A user can ask what is in the preview, how many changes it contains, what time or location a numbered row uses, whether selected rows repeat, or whether the proposed event times overlap saved or other reviewed events. Answers are rendered only from validated proposal forms and live stored targets; they never treat an unsaved row as calendar data and never confirm it implicitly.

Conflict checks expand repeating proposals in local wall time and compare half-open intervals against the saved calendar and the other proposal rows. A saved event being replaced or deleted by the review is excluded from the comparison. Recurring checks state their bounded 90-day horizon, duplicate titles require a visible position, and a normal question about the saved calendar continues through the ordinary read path while the proposal remains open.

The review card exposes this capability in place. Supported questions and corrections stay on the deterministic native path. Broader installed-model conversation receives a compact, read-only `activeReview` fact set, but model text still has no confirmation or mutation authority.

Query follow-ups such as “more” reuse the last resolved query range rather than depending on the immediately preceding text turn or recalculating a relative day after a restart. “Where is it?” and “when is that one?” search the focused entity by ID and render only verified stored fields.

## Clarifications

A parser clarification stores its code, source request, safe display options, and timestamp. A short answer that matches the missing fact is merged into that request and reparsed. This supports date/time replies and explicit or ordinal target choices while keeping the original write unexecuted. A different request clears the pending clarification.

Conversation clearing deletes the conversation row, so SQLite cascades its turns, proposals, and dialogue state together. The assistant then creates a fresh empty state. Calendar data and explicit user-approved profile memory remain separate and are not deleted by clearing a chat.

## Optional model context

The Qwen fallback receives a bounded fact packet ordered as active review, selected focus, requested range, and nearby background. It also receives up to eight recent turns and a separate bounded extractive summary of older turns. This context is marked as untrusted data in the worker prompt. The model may use it to phrase an answer or discuss a preview, but it cannot supply database authority: exact source grounding and the deterministic focus resolver still choose the allowlisted IDs, and only explicit confirmation applies a proposal.

## Bounds and pruning

- Compatibility focus and last-result lists are unique and capped at 100 IDs.
- Query-frame history is capped at 12 frames and 200 exact occurrence references per frame.
- Selected frame items must be members of that frame's ordered results; occurrence keys and requested fields must be unique.
- A result cursor must point to a retained ordered item.
- A continuation cursor must point to the next retained selected item and is null when the selected result is fully presented.
- Planner context is capped at 6,000 characters and chat calendar context at 8,000 characters.
- Every state read removes IDs whose local entity no longer exists.
- The stored query range must have a valid start before end.
- A response with no related items does not silently replace an established focus, while a calendar query with no results explicitly clears it.
