# Model card: RemindCore HashFrame 4M English v0.2

## Summary

RemindCore v0.2 is a 4,456,448-parameter English calendar semantic planner. Its project-owned HashFrame weights start at zero and use no pretrained weights, cloud API, personal calendar data, or human conversation logs. A locally installed, hash-pinned Qwen3 1.7B Q4_K_M model was used as a development-time teacher for filtered, delexicalized request wording and hard negatives; no Qwen weights or generated calendar facts were copied into the student. The model is owned by this project under MIT.

It is not a language model and does not generate prose. It classifies supported operations, labels source spans, and estimates ambiguity/OOD/risk. A deterministic compiler remains responsible for `CalendarIR`, dates, calendar facts, safety, and writes.

## Intended use

- Shadow or confidence-gated assistance beside the deterministic parser.
- Typed or editable ASR transcript interpretation for calendar/reminder requests.
- Local CPU inference in the Remind Me Electron app.

It must not be used to autonomously execute destructive actions, infer facts absent from source text, make medical/legal/financial decisions, or act as a general assistant.

## Architecture and footprint

- HashFrame joint linear semantic planner.
- FNV-1a hashed word, word-bigram, character 3–5-gram, shape, position, replicated semantic-cue, and local token-context features.
- Operation, BIO slot, ambiguity, OOD, and risk heads.
- Three deterministic zero-initialized operation-head training orders, averaged into one runtime table.
- 4,456,448 INT8 weights with per-output-channel symmetric scales.
- 5.7 MiB TypeScript runtime artifact; 4.3 MiB ONNX parity artifact.
- Custom tokenizer contract with no vocabulary download or unknown token.

## Training data

- 36,000 original program-generated train examples plus 2,640 Qwen-assisted curriculum examples (38,640 total training rows).
- 6,000 program-generated development examples.
- 6,000 program-generated test examples.
- 158 examples in a disjoint teacher challenge; held-out teacher templates never enter training.
- Sentence-template and conversational-wrapper families are disjoint by split.
- Titles, targets, dates, and times are held out by split.
- Clean, typo, ASR-style, OCR-style, ambiguity, OOD, and locale variants.
- Human-authored blind examples: **0**.
- Accepted teacher surfaces: **73 delexicalized templates and 14 hard OOD messages**.
- Personal calendar or conversation examples: **0**.

Qwen sees protected markers such as `<TITLE>`, not real event values. Deterministic curation rejects altered placeholder signatures, semantic drift, duplicate wording, unprotected specifics, non-user-voice text, and calendar actions mislabeled as OOD. Project programs instantiate every accepted surface and assign every operation, slot, ambiguity, OOD, and risk target. Exact teacher identity, digest, accepted hashes, and rejection counts are recorded under `ml/teacher_assisted/`.

Dataset hashes and provenance are in `data/manifest.json`. The generated JSONL files are reproducible build products and are not committed; a hashed 250-example test sample is tracked under `fixtures/remindcore/` for runtime verification.

## Evaluation

Full generated test split:

| Metric                              |      Result |
| ----------------------------------- | ----------: |
| Overall operation accuracy          |      96.92% |
| Overall operation macro F1          |      97.20% |
| Eligible assistance precision       |     100.00% |
| Eligible assistance coverage        |      47.21% |
| OOD recall                          |     100.00% |
| Ambiguity recall                    |      88.82% |
| Constrained assisted-title coverage |      97.98% |
| Float operation accuracy            |      96.92% |
| INT8 operation accuracy             |      96.90% |
| Accuracy reduction from INT8        | 0.02 points |
| Python p95 per example              |     2.66 ms |

Tracked TypeScript parity fixture:

| Metric                           |  Result |
| -------------------------------- | ------: |
| Overall operation accuracy       |  97.50% |
| Eligible assistance precision    | 100.00% |
| Eligible assistance coverage     |  13.00% |
| OOD recall                       | 100.00% |
| Ambiguity recall                 |  84.13% |
| Schema-valid output              | 100.00% |
| Warm TypeScript p95              | ~1.3 ms |
| Rules safe-operation accuracy    |   5.64% |
| Confidence-gated hybrid accuracy |  33.33% |

The fixture is intentionally difficult and includes ambiguity/OOD/corruption. Its percentages are not directly comparable to the full test-set candidate coverage.

On the 158-example disjoint teacher challenge, operation accuracy improves from 65.19% with the original zero-residual checkpoint to 68.99% with the promoted residual, while eligible assistance precision remains 100%. The original 6,000-example test accuracy remains 96.92%. The selected 0.005 teacher-only residual affects 937 previously unused lexical hash buckets; larger candidates were rejected when they exceeded the 0.05-point development regression budget.

## Limitations

- Generated language substantially overestimates coverage of the generator's vocabulary and underrepresents real human phrasing.
- The teacher challenge was generated by the same Qwen family used for augmentation, so improvement on it measures transfer of that teacher's phrasings, not independent human generalization.
- Generated test accuracy is not evidence of broad real-user language coverage; no independently authored blind set has been collected.
- English only; numeric date interpretation still belongs to the existing en-US deterministic resolver.
- The raw BIO head generalizes poorly by itself. The shipped path relies on constrained source copying and must not be replaced by unconstrained spans.
- Existing-item edits need calendar context and remain rules-only.
- No independent demographic, accessibility, accent, dialect, or multilingual evaluation exists yet.
- Confidence is calibrated on generated development data. It is suitable only for the narrow current gate.

## Safety and privacy

- Model output cannot access SQLite or mutate state.
- Only six non-destructive operations are eligible for a hint.
- Values are copied from exact source spans.
- Every hint is deterministically recompiled and schema-validated.
- User review and existing confirmation policy remain mandatory.
- Missing/corrupt weights fall back to rules.
- Inference requires no network and produces no telemetry.

## Reproducibility

The exact dataset seed, operation-order seed offsets, teacher identity and hash, raw/accepted teacher records, rejection report, residual sweep, configuration, generator, evaluation, quantizer, ONNX exporter, dataset manifest, artifact hashes, ablations, and runtime verifier are in this repository. Run `pnpm teacher:check`, `python ml/remindcore/pipeline.py all`, then `pnpm remindcore:check` in the development environment.

The artifact metadata reports version `0.2.0` and `teacherUsed: true`. Compatibility filenames retain `remindcore-v0.1-*` so existing installed runtimes and release manifests do not require a file migration.
