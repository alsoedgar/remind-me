# ADR 0010: Selectively distill Qwen surfaces into native models

- Status: accepted
- Date: 2026-08-25
- Updates: ADR 0006 and ADR 0007

## Context

RemindCore and RemindSpeak are small, original, zero-initialized models with
auditable safety boundaries, but program-authored corpora cover fewer natural
phrasings and preferences than a general language model. The optional local
Qwen3 1.7B Q4_K_M pack already provides a capable offline teacher. Copying or
fine-tuning Qwen weights would weaken the native-model story, enlarge the
required runtime, and provide no guarantee that calendar facts remain grounded.
Blindly adding synthetic text can also amplify teacher errors or improve only a
teacher-shaped test set.

Primary research supports constrained paraphrase augmentation for intent/slot
tasks and, importantly, selective admission rather than raw synthetic volume:

- [Data-Efficient Paraphrase Generation to Bootstrap Intent Classification and Slot Labeling](https://aclanthology.org/2020.coling-industry.2/)
- [LINGUIST: Language Model Instruction Tuning to Generate Annotated Utterances for Intent Classification and Slot Tagging](https://aclanthology.org/2022.coling-1.18/)
- [Selective In-Context Data Augmentation for Intent Detection](https://aclanthology.org/2023.eacl-main.107/)
- [Qwen3 Technical Report](https://arxiv.org/abs/2505.09388/)

## Decision

Use Qwen only as an untrusted, development-time data and preference teacher.
Keep both student architectures, zero initialization, training algorithms,
quantization, inference kernels, and runtime authority boundaries project-owned.

The pinned teacher is `Qwen3-1.7B-Q4_K_M.gguf`, 1,282,439,264 bytes, SHA-256
`d2387ca2dbfee2ffabce7120d3770dadca0b293052bc2f0e138fdc940d9bc7b5`.
Generation is local and sends no personal calendar, conversation history, or
unprotected event value to the teacher.

For RemindCore:

1. Project code provides an operation and exact protected placeholder signature.
2. Qwen proposes only delexicalized user wording or hard OOD messages.
3. Curation rejects duplicates, signature changes, semantic drift, missing cues,
   unprotected specifics, non-user-voice text, and real calendar actions labeled
   OOD.
4. Project programs instantiate facts and assign all labels.
5. One template per operation is challenge-only.
6. Teacher examples may update only lexical hash buckets unused by base training.
7. Select the best teacher-challenge candidate whose original development
   accuracy drops by no more than 0.05 percentage points.

For RemindSpeak:

1. Project code constructs four placeholder-valid candidates for each style and
   speech-act case.
2. Qwen returns only the preferred candidate index.
3. No Qwen-authored text enters the phrase inventory.
4. One case per speech act is challenge-only.
5. Promote a replay count only if the original generated test metric does not
   regress and structural/factual validity remains perfect.

The artifacts must report `teacherUsed: true`, the exact teacher corpus hash and
role, and `pretrainedWeightsUsed: false`. Weight provenance remains
`project-trained`; documentation must say “zero-initialized, Qwen-assisted,” not
“trained without a teacher.” Compatibility filenames may remain v0.1 while
artifact IDs and semantic versions report v0.2.

## Promoted checkpoint

- RemindCore accepted 73 templates and 14 hard OOD messages. Its 2,640-row
  training curriculum and 158-row disjoint challenge affect 937 novel lexical
  buckets. Residual 0.005 preserves 96.92% original test accuracy and improves
  the teacher challenge from 65.19% to 68.99%; larger residuals that crossed the
  development guard were rejected.
- RemindSpeak accepted 66 preference indices and zero Qwen-authored atoms.
  Fifty-five preferences replayed 30 times add 1,650 training rows; 11 remain
  challenge-only. Mean original INT8 test accuracy rises from 77.55% to 77.63%,
  with 100% placeholder/fact validity. Replay counts that regressed the original
  test metric were rejected.

## Consequences

- The native models gain some teacher-shaped language coverage while retaining
  their small, dependency-free installed runtimes and deterministic safety gates.
- Users do not need Qwen installed to run the distilled students; the optional
  pack remains a separate broad-language fallback.
- The project can honestly demonstrate original architectures, zero-initialized
  training, custom quantized runtimes, data curation, distillation, evaluation,
  and release engineering. It cannot honestly claim the v0.2 data path used no
  foundation-model teacher.
- Teacher challenge gains are not evidence of human generalization. An
  independently collected, consented blind set and human preference study remain
  required before widening authority or making broad-quality claims.
- Raw and rejected outputs remain development records and are excluded from
  packaged applications.

## Rejected alternatives

- Copying, merging, or fine-tuning Qwen weights into the students: changes the
  model class and footprint and weakens provenance separation.
- Importing free-generated Qwen replies: the experiment failed protected-surface
  quality gates; admitted atoms are zero.
- Training on all teacher outputs: rejected samples included duplicates, semantic
  drift, malformed signatures, invented specifics, and incorrect OOD labels.
- Selecting solely on teacher challenge accuracy: this favored stronger residuals
  that regressed the original development distribution.
- Replacing the deterministic compiler or confirmation boundary: language-model
  confidence does not grant calendar authority.
