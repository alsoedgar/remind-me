# ADR 0011: Train from semantic programs, not teacher-authored plans

- Status: accepted
- Date: 2026-08-26
- Extends: ADR 0010

## Context

The original RemindCore v0.2 curriculum covers thirteen CalendarIR operations,
but the application now exposes a 46-capability `AssistantPlan v2` registry,
multi-action requests, bounded dialogue state, app controls, local memory, and
broader conversation routes. Training on flat intent strings would omit action
order and context. Asking a general model to author complete plans would also
let it invent labels, values, scopes, or review policy and could contaminate the
frozen Phase 0 evaluation suite.

## Decision

Phase 4 generates semantic programs before language:

1. The live capability registry supplies capability status, execution support,
   and confirmation policy.
2. Project-authored seed families supply every route, capability label,
   placeholder signature, compound action sequence, and dialogue condition.
3. Qwen may produce delexicalized paraphrases only. It never sees personal data
   or the frozen evaluation requests and cannot emit a plan or slot value.
4. Curation requires the exact protected-marker multiset, an operation-specific
   cue, user voice, bounded length, and no unprotected literal specifics.
5. Exact and high-similarity matches against the frozen developer suite are
   rejected. The independently collected human-blind path remains unread and
   unavailable to training.
6. Split assignment belongs to the semantic seed family. A seed and every
   teacher paraphrase derived from it stay in one split.
7. Project code materializes synthetic values, computes source spans, composes
   multi-action rows, and creates controlled noise variants.

Four registry IDs are deliberately absent from user-intent training because
they are system outcomes: import proposals, clarification, rejection, and
unsupported results. They remain output classes and safety paths for Phase 5.

## Consequences

- The next native model can learn the full assistant vocabulary without
  becoming a wrapper around Qwen.
- Teacher quality is auditable through raw checkpoints, accepted templates,
  rejection reasons, exact model provenance, and deterministic corpus hashes.
- App-ready but not assistant-ready capabilities are labeled
  `executableNow: false`; learning their wording cannot silently widen model
  authority.
- Synthetic development and challenge splits measure lexical and compositional
  transfer only. Independent human-blind collection is still required for a
  release-quality generalization claim.

## Rejected alternatives

- Teacher-authored JSON plans: grants the teacher label and safety-policy
  authority.
- Random row splitting: leaks paraphrases of the same semantic seed across
  train and test.
- Training directly on user-reported regressions: contaminates the frozen
  measurement boundary.
- Accepting all generated text: preserves malformed markers, semantic drift,
  duplicates, and assistant answers.
