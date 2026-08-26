# ADR 0013: Bound response adaptation and separate it from facts

- Status: Accepted
- Date: 2026-08-26
- Extends: ADR 0007 and ADR 0010

## Context

RemindSpeak needs broader, more personal phrasing, but learning from raw replies or calendar values would create privacy, memorization, and factual-integrity risks. Generated developer fixtures also cannot establish that people prefer the output.

## Decision

Expand `ResponsePlan` from 11 to 18 protected speech acts and keep all 432 lead/body/close atoms project-authored. Dynamic content continues to enter only through exact placeholders.

Persist optional response feedback as a bounded tuple of template fingerprint, speech act, integer score, and update time. Retain at most 64 tuples, clamp scores to -3 through 3, cap their reranking contribution, and expose disable/reset controls. Do not store reply text, prompts, facts, or reasoning in the adaptation record. Preference ranking never changes placeholder validation or mutation authority.

Evaluate perceived quality with a separate 24-case within-subject randomized blinded A/B protocol. Keep source labels in a sealed key, require human and blindness attestations, reject incomplete/duplicate responses, and publish zero-result state explicitly. The prespecified gate requires five participants, 120 judgments, at least 60% candidate preference, a 95% Wilson lower bound of at least 50%, and at most a 1% candidate fact-issue rate.

## Consequences

- The installed native model can adapt its safe wording without collecting personal content.
- Users remain in control and can erase adaptation independently of conversations.
- A helpful rating can promote only a phrase already accepted by the grounding boundary.
- The engineering checkpoint can pass while the human study truthfully remains `awaiting-participants`.
- No human-quality promotion claim is allowed until real responses satisfy the separate gate.
