# Phase 8 independent human-language protocol, version 1.0

## Purpose

This protocol measures whether the shipped local assistant understands language from people who did not create the app, its models, its prompts, or its evaluation examples. It separates engineering regressions from evidence about new-user language. A frozen release is still only eligible for scoring; it becomes a passed result only when the executable Phase 8 gate succeeds.

The committed collection count starts at zero. Missing participants must never be replaced with generated, paraphrased, developer-authored, or model-authored examples.

## Roles and separation

- A participant authors requests against synthetic calendar worlds. They do not annotate their own requests.
- A collection coordinator records consent and supplies capability-neutral tasks or synthetic worlds without suggesting phrases.
- At least two pseudonymous annotators independently label each scenario and reconcile disagreements before any model output is shown.
- A release custodian closes withdrawal, runs privacy and contamination checks, locks the model inventory, and freezes the de-identified scenario projection.
- A developer may inspect results only after the release is frozen. Once results influence development, that release remains a regression set and a new untouched release is required for a future generalization claim.

Participant, annotator, and consent identifiers are random study pseudonyms. A participant identifier cannot appear in that record's annotator list. The public release contains none of these identifiers.

## Consent and privacy

Before collection, each participant must explicitly consent to evaluation use and public release of their exact authored wording. Consent records stay in the private collection, not the public evaluation suite. Every record has a withdrawal deadline. Freezing is forbidden until every deadline has passed and any withdrawal has been removed.

Only synthetic calendar facts are allowed. Do not import a participant's real calendar, contacts, documents, locations, class schedule, account data, or other personal material. Preserve the participant's wording, including typos and spacing, but replace the whole scenario rather than editing it if it contains identifying data. Both a human privacy review and the automated obvious-PII scan must pass.

## Blind authorship

Participants may be told the app's high-level capabilities, but not its parser vocabulary, prompts, training templates, prior evaluation requests, model responses, accepted paraphrases, or expected labels. They must not browse the repository or watch a product demo containing example requests before authorship. The coordinator must not rewrite, correct, expand, or paraphrase their wording.

Voice cases may preserve the participant's uncorrected local transcription and should be tagged `asr` or `noise`. Typo, OCR-style, and spacing cases keep the observed surface and receive the matching tag. All requested calendar facts still come from the assigned synthetic world.

## Annotation

Each scenario records the initial synthetic calendar state, exact participant turns, acceptable response kinds, grounded facts that must appear or remain absent, proposed operation and item cardinality where applicable, review-state transitions, and post-confirmation or post-rejection state. An annotation must test semantic behavior, not one exact prose response.

The two annotators label independently, discuss differences, and store only their consensus. They must finish before seeing model output. Ambiguous requests should expect a clarification or safe refusal rather than a guessed write. Every mutation must explicitly test the preview-before-write boundary and the resulting state. Multi-turn cases must preserve the exact authored order.

## Required release coverage

A Phase 8 release requires at least 2,000 scenarios from at least 100 participants, no more than 40 scenarios from one participant, at least 200 out-of-domain scenarios, and at least 200 noisy-language scenarios. Category minimums are enforced by the executable policy:

- 200 single-action, 200 multi-action, and 200 mutation scenarios.
- 100 bulk, 200 query, and 200 multi-turn scenarios.
- 150 conversation, 100 memory, 150 ambiguity, 150 safety, and 150 open-dialogue scenarios.

Categories and slices may overlap only where the schema permits; scenario counts are not inflated by duplicating a turn. Exact and near-duplicate participant language is rejected so the minimum represents distinct evidence.

## Contamination and model lock

The private collection is stored at `evals/assistant/human-blind/collection.local.jsonl`, which is ignored by Git. Training, teacher generation, prompt construction, threshold selection, and repair generation must never read that path or a frozen human-blind release.

Before freezing, the tool compares participant turns with every frozen assistant suite; accepted training, challenge, teacher, and repair surface; the deterministically regenerated RemindCore train/development/test/teacher-challenge corpora; and the assistant's language-facing unit/integration requests. It requires zero normalized exact matches and zero token-Jaccard matches at or above 0.90. It binds the digest of every contamination source into the release manifest. Validation, freezing, and scoring regenerate the original corpus first so a clean checkout evaluates the same surfaces.

The release also binds `models/manifest.json` and this protocol. Scoring refuses to run if the suite, protocol, model inventory, or contamination-source digest changes. The raw collection hash is retained in the manifest for private provenance verification without publishing consent records or participant identifiers.

## Freeze and score sequence

1. Run the status and schema checks without exposing the private file.
2. Close withdrawals, remove withdrawn records, and run validation until every privacy, independence, coverage, duplicate, and contamination blocker is clear.
3. Run the training-boundary check.
4. Freeze a new immutable version under `evals/assistant/human-blind/releases/`.
5. Do not modify the model or bound sources. Run the Phase 8 gate against that release.
6. Publish the manifest, de-identified scenarios, full aggregate metrics, hardware context, and failures. Do not publish the raw collection.

The release claim is a measured result for the locked app and collected population, not proof that every possible request will work.
