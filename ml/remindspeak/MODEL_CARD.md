# Model card — RemindSpeak PhraseLattice 28M English v0.3

## Summary

RemindSpeak is a compact conditional surface generator for calendar-assistant replies. It selects compatible lead, body, and close atoms from verified `ResponsePlan` metadata, composes candidates, and leaves all user/calendar values behind protected placeholders until independent validation succeeds.

- Model ID: `remindspeak-phrase-lattice-28m-en-phase6`
- Version: `0.3.0`
- Parameters: 28,311,984 logical trainable table entries and biases
- Initialization: zero
- Quantization: symmetric INT8 per output channel
- Installed JSON and compressed weights: 223,187 bytes
- Decompressed weight memory: 28,311,552 bytes (27.0 MiB)
- Teacher: Qwen3 1.7B Q4_K_M preference indices over protected project-authored candidates
- Imported teacher or pretrained weights: none
- Qwen-authored surface atoms admitted: 0
- Training use of personal calendar data: none
- Required network: none
- License: MIT

The logical parameter count includes the complete sparse hashed table. Most entries remain zero because each structured example activates a small feature set; deterministic gzip exploits that sparsity. This is a bounded response model, not an open-domain LLM.

## Intended use

- Phrase 18 verified proposal, mutation receipt, availability, schedule, next-item, item-detail, empty-schedule, conversation, memory, undo, rejected-draft, clarification, conflict, unsupported, and error speech acts.
- Respect local warmth, brevity, formality, playfulness, contraction, and proactivity controls.
- Produce five candidates for validation, novelty, style, and optional private-preference reranking.
- Fall back to grounded project-authored templates when loading, compatibility, validation, or selection fails.

It must not calculate calendar facts, infer missing facts, retrieve storage, alter a plan, or write to the database.

## Training data and architecture

The reproducible base corpus contains 30,000 training, 5,000 development, and 5,000 test examples across all 18 `ResponsePlan` speech acts. The promoted training set adds 1,650 replay rows from 55 accepted teacher preference cases; 11 disjoint cases remain challenge-only.

All surface vocabulary comes from 432 project-authored atoms and 20 explicit style profiles. Qwen selects indices among already-valid candidates; zero Qwen-written surface atoms enter the model. The pipeline uses no pretrained weights, personal calendars, conversation logs, or independently human-authored training examples.

Three mistake-driven multiclass heads share 65,536 deterministic FNV-1a feature buckets:

| Head  | Options | Runtime constraint                              |
| ----- | ------: | ----------------------------------------------- |
| Lead  |      90 | Must match the verified speech act              |
| Body  |     252 | Must match speech act and exact placeholder set |
| Close |      90 | Must match the verified speech act              |

Single-signature acts have 350 compatible compositions; each clarification signature has 175. The runtime rejects invalid or recently identical candidates, penalizes trigram similarity and style mismatch, applies only a capped local phrase-preference score, and returns the best five. The renderer repeats exact-placeholder and static-literal validation before deterministic fact insertion.

## Evaluation

The 5,000-example generated test split reports:

- 75.66% mean INT8 head-label accuracy;
- 0.04 percentage-point maximum head reduction from quantization;
- 100% structurally valid candidate rate and protected-fact retention;
- 0% unsupported static factual-literal introduction.

The tracked 250-example TypeScript fixture reports:

- 100% exact-placeholder validity and protected-fact retention;
- 0% unsafe unprotected date/number literals;
- 43.6% exact top-reference selection and 83.2% reference coverage among five candidates;
- 0% exact repetition when the previous reply is supplied;
- approximately 8 ms warm p95 in the latest development-machine run.

The 11-case teacher challenge is a small teacher-family diagnostic, not a human-quality claim. Exact current metrics live in `ml/remindspeak/reports/`.

The 24-case randomized blinded A/B protocol is prepared, but the current study report contains zero participants and zero judgments. Its status is `awaiting-participants`; no human preference rate is claimed. The separate gate requires five people, 120 judgments, at least 60% candidate preference, a 95% Wilson lower bound of at least 50%, and at most a 1% candidate fact-issue rate.

## Safety and adaptation

- Facts can enter only through placeholders in the verified plan.
- Required placeholders occur exactly once; unknown, duplicate, or missing placeholders reject a candidate.
- Unprotected date names and numeric literals reject a candidate.
- The model has no storage or mutation capability.
- Exact recent replies are rejected and similar recent phrasing is penalized.
- A deterministic grounded template remains available for every call.
- Optional feedback stores at most 64 template fingerprints with speech act, score, and update time.
- Scores are integers clamped from -3 through 3 and affect phrase rank only.
- Reply text, calendar facts, prompts, and reasoning are excluded from adaptation.
- Adaptation is user-disableable and resettable in Settings.

## Limitations

- The human preference gate has not been run with real participants.
- Generated data and a reviewed English phrase inventory do not cover every dialect, accessibility need, cultural tone, or locale.
- Qwen preference labels can transfer teacher style bias even though Qwen prose and weights are excluded.
- Phrase-level feedback may require several ratings before a visible selection change and does not generalize like a large token model.
- This is compositional protected generation, not free-form general conversation.

## Reproducibility and provenance

Run `pnpm teacher:check`, `python ml/remindspeak/pipeline.py all`, `pnpm models:onnx:export`, and `pnpm remindspeak:check`. Prepare and score the human protocol with `pnpm remindspeak:study:prepare` and `pnpm remindspeak:study:score`; enforce its separate promotion gate with `pnpm remindspeak:study:gate`. Compatibility filenames retain `remindspeak-v0.1-*` to avoid an installed-runtime migration.
