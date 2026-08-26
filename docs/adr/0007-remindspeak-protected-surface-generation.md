# ADR 0007: Protected RemindSpeak surface generation

- Status: accepted
- Date: 2026-08-24
- Updated by: ADR 0010 for the v0.2 Qwen-ranked preference curriculum

## Context

Template rotation is safe but becomes repetitive. A free-running local decoder can offer more variation, but even a fluent response is unacceptable if it drops, changes, duplicates, or invents a calendar fact.

## Decision

Use a scratch-trained conditional phrase-lattice model behind the verified `ResponsePlan` boundary.

- The model selects compatible lead, body, and close atoms from speech-act, placeholder-signature, style, and novelty features.
- Generate five candidates from a bounded reviewed inventory.
- Require the exact protected placeholder set and one occurrence per fact.
- Reject static numeric/date literals, exact recent replies, and invalid candidates.
- Rerank for learned compatibility, style, brevity, and recent trigram novelty.
- Insert verified values deterministically only after validation.
- Retain existing grounded templates as the final fallback.
- Give the model no database, calendar engine, IPC mutation, or network capability.

## Consequences

Replies can vary combinatorially and respond to local style controls while factual safety remains testable. The model is much smaller on disk than an open-ended LLM and works through one portable TypeScript runtime. Its bounded inventory cannot match the expressive range of a large pretrained model, and naturalness still requires independent human evaluation.
