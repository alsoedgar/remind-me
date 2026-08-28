# Contextual assistant Phase 4

Phase 4 turns optional local-model conversation into a typed, fact-grounded response path. Qwen can still phrase answers naturally, but calendar facts and calendar state remain controlled by deterministic local code.

## Implemented

- Compact calendar fact packets with request-local references, stable fact and entity IDs, explicit fields, occurrence timestamps, priority, and provenance.
- Retrieval order of active review items, selected/focused query results, the complete requested range, and then nearby background items.
- Whole-fact truncation that preserves the highest-priority facts and never sends a clipped JSON fragment.
- Up to eight recent turns plus a bounded extractive summary of older local turns.
- Separate prompt sections for user-approved profile memory and derived conversation summary; generated summaries never enter the approved-memory array.
- A grammar-constrained response envelope with `answer`, `clarification`, `offline-limit`, and `refusal` outcomes.
- Declared calendar placeholders and exact fact-reference/field lists instead of unrestricted copied calendar values.
- Request-specific grounding guides and envelope patterns containing only the verified refs needed by that factual turn; ordinary conversation receives no calendar placeholder example.
- Post-generation checks for unknown IDs, unavailable or unused fields, undeclared placeholders, copied fact values, unverified calendar literals, and false calendar-write claims.
- Local substitution of verified facts and local derivation of related event/reminder IDs.
- Progressive word reveal only after the complete response passes validation. Raw worker chunks are never forwarded through the assistant service.
- Typed execution traces for answered, clarified, offline-limited, refused, fact-rejected, and write-claim-rejected fallback turns without prompt or fact contents.
- Packaged-worker coverage for the new chat JSON grammar.

## Authority boundary

The language model selects words and references facts; it does not create calendar truth. A calendar value can reach visible text only when the model names an existing packet reference, repeats that fact's stable ID, declares the exact field, and uses the corresponding placeholder. Deterministic code then substitutes the stored value.

The responder cannot execute a mutation. Calendar writes still require a structured planner action, exact source grounding, deterministic compilation, preview, explicit confirmation, one atomic database action, and undo. A response that says or flags that a write occurred is discarded before display, and calendar state stays unchanged.

## Verification coverage

Automated tests cover:

- Focused and requested-range facts appearing before nearby background facts.
- Stable occurrence-level fact IDs and entity links.
- Approved memory remaining separate from an older-turn summary.
- Valid placeholder rendering and cumulative post-validation streaming.
- Rejection of wrong IDs, missing fields, unused declarations, undeclared placeholders, direct fact copies, invented times, invented locations, and factual answers without references.
- Rejection of both explicit `writeClaim` flags and natural-language claims such as "I added the meeting."
- No raw or rejected model output reaching the stream, no proposal application, and no calendar-state mutation.
- Compilation of the exact packaged chat grammar with the pinned local runtime.

The August 28, 2026 verification completed with 539 tests across 67 files, TypeScript, ESLint, repository-wide formatting, a production Electron build, the offline Electron smoke test, and the release-artifact check. The frozen assistant gates remained green:

| Suite                | Mode          | Scenario pass | In-domain answered |     p95 |
| -------------------- | ------------- | ------------: | -----------------: | ------: |
| Baseline             | rules-only    |        100.0% |              97.7% | 50.9 ms |
| Baseline             | native-hybrid |        100.0% |              97.7% | 62.2 ms |
| Phase 7 release gate | rules-only    |        100.0% |             100.0% | 94.2 ms |
| Phase 7 release gate | native-hybrid |        100.0% |             100.0% | 60.8 ms |

The final configuration also passed all 7/7 frozen real-Qwen conversation cases with the pinned 1.7B Q4_K_M artifact on the Windows performance CPU profile. That slice covers capability greetings, broad advice, multi-item times, multi-item locations, offline current facts, future-planning advice, and a concise multi-turn follow-up. Median model latency was 19.1 seconds and p95 was 53.2 seconds; all inputs fit without truncation. This is a conversation-slice result, not a claim that the separate planner or hardware-performance suites are complete.

The independent human study remains separate and unchanged. Phase 4 does not treat synthetic or developer-authored cases as human evidence.
