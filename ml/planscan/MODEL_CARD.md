# PlanScan SpatialHashGraph 0.2 model card

## Summary

PlanScan 0.2 is an English, layout-aware advisory model for calendar-like PDFs, scans, and images. It consumes bounded OCR/PDF line blocks with normalized two-dimensional boxes and produces source-backed roles, spans, relations, event groups, document type, and confidence. It does not perform OCR, repair source text, or execute calendar actions.

This checkpoint is a project-trained model, not a wrapper around a general-purpose local LLM:

- zero parameter initialization;
- no teacher or distillation model;
- no pretrained text, vision, or document weights;
- no downloaded or personal document data;
- no network requirement in training or inference;
- deterministic feature hashing and a reproducible program-first generator.

## Architecture

`SpatialHashGraph` uses 131,072 deterministic FNV-1a feature buckets for each output channel. Text, OCR confidence, reading order, extraction method, page margins, document chrome, and normalized box/pair geometry feed six independently quantized heads:

| Head          | Labels |    Parameters | Purpose                                      |
| ------------- | -----: | ------------: | -------------------------------------------- |
| Block role    |      7 |       917,504 | heading, title, field, description, metadata |
| Entity role   |      8 |     1,048,576 | title, date, time, place, recurrence, cue    |
| Relation      |      6 |       786,432 | same-plan and typed field relationships      |
| Group link    |      4 |       524,288 | same group, new group, context, none         |
| Document type |      8 |     1,048,576 | schedule through screenshot                  |
| Confidence    |      7 |       917,504 | clear, OCR risk, crowding, ambiguity, noise  |
| **Total**     | **40** | **5,242,880** |                                              |

The release table is symmetric per-output-channel INT8. Its decompressed working set is 5.0 MiB; the sparse table gzip-compresses to 29.7 KiB and the strict runtime configuration is 9.8 KiB. The document-type head uses a 1.20 scale multiplier selected only on the development split; the untouched test split remains the quantization gate. The model runs in a portable TypeScript loop with no ONNX Runtime or platform-native dependency.

The learned pair heads score bounded two-sided neighborhoods rather than assuming that title and time always follow the date. Fine horizontal and vertical offsets, row overlap, reading direction, margin position, and page-chrome signals help separate adjacent rows. The graph decoder ranks those relationships, prevents reuse of claimed title/time/location evidence, and withholds incomplete groups. Literal date/time recognition projects learned roles to exact character offsets; it cannot invent or silently correct source text.

## Training data

The program-first generator creates 16,000 training, 2,500 development, and 2,500 test pages: 21,000 pages in total. Each split is approximately half born-digital and half OCR-like. Pages cover schedules, syllabi, invitations, flyers, itineraries, rotations, tables, and screenshots with two to five plans.

Pages are balanced across six challenge slices:

- baseline layouts;
- OCR substitutions, deletions, and spacing corruption;
- hard neighboring-row negatives;
- repeated titles in different rows;
- unfamiliar column orders, including time-before-date layouts;
- header, footer, and browser-print distractions.

Hard-negative mining presents nearby fields from different rows to the pair heads during training. Complete template families, font identities, scan styles, and organization names are disjoint across train, development, and test. The tracked TypeScript runtime set contains 120 generated test pages: ten native-text and ten OCR pages for every challenge slice. Provenance, counts, and SHA-256 digests are in `data/manifest.json`.

The synthetic layout approach was informed by document-understanding research that models two-dimensional position and text jointly, graph-based key-information extraction, and noisy-scan evaluation. PlanScan uses none of those projects' weights or training code: [LayoutLM](https://www.microsoft.com/en-us/research/wp-content/uploads/2020/02/layoutlm.pdf), [PICK](https://arxiv.org/abs/2004.07464), [FUNSD](https://arxiv.org/abs/1905.13538), and [Donut/SynthDoG](https://arxiv.org/abs/2111.15664).

## Results

### Generated 2,500-page disjoint test split

| INT8 metric                              |                 Result |
| ---------------------------------------- | ---------------------: |
| Block-role accuracy                      |                 100.0% |
| Entity micro F1                          |                 100.0% |
| Relation micro F1                        |                 97.75% |
| Group-link micro F1                      |                 99.09% |
| Document-type accuracy                   |                 79.96% |
| Critical-role page equivalence           |                 100.0% |
| Hard-neighbor false-link rate            |                  4.94% |
| Distractor false-entity rate             |                  0.00% |
| Exact evidence coverage                  |                 100.0% |
| Maximum float-to-INT8 metric change      | 0.32 percentage points |
| Minimum challenge critical-role coverage |                 100.0% |

“Critical-role page equivalence” checks whether every generated title/date/time role is recovered. It is not whole-event semantic execution. Every challenge slice reaches 100% on that narrower measure. The text-only inference ablation drops relation F1 from 97.75% to 47.40% and group-link F1 from 99.09% to 81.24%, showing that the held-out relationship task materially uses spatial features.

These are generated-data results and must not be presented as real-world document accuracy.

### Independent TypeScript runtime fixture

The 120-page runtime check validates the actual compressed INT8 artifact and product decoder. It scores two targets separately:

- **observed-source grouping** asks whether the model correctly groups the text that extraction actually produced;
- **pristine semantic fidelity** compares with the pre-corruption facts and therefore also measures text lost or altered by simulated OCR.

| Runtime metric                                    |  Result |
| ------------------------------------------------- | ------: |
| Entity micro F1                                   |  100.0% |
| Native observed-source group micro F1             |  100.0% |
| OCR observed-source group micro F1                |   99.4% |
| Native observed-source exact-page agreement       |  100.0% |
| OCR observed-source exact-page agreement          |   98.3% |
| Lowest challenge observed-source group micro F1   |   98.4% |
| Lowest challenge observed-source exact-page rate  |   95.0% |
| OCR pristine-fact group micro F1                  |   47.3% |
| Exact source evidence                             |  100.0% |
| Warm ordinary-page p95 on the development machine | 11.1 ms |

Repeated-title pages are the lowest observed-source slice at 98.36% group micro F1 and 95% exact-page agreement. Every other challenge slice reaches 100% on both measures in this tracked fixture. Promotion requires at least 98% observed-source group micro F1 and 95% exact-page agreement in every slice, plus exact evidence for every emitted value.

The 47.3% OCR pristine-fact score is reported rather than hidden because generated substitutions such as `Stud1o`, missing `AM`, or a deleted room label cannot be recovered through layout linking alone. PlanScan preserves the observed source instead of silently changing it into unsupported text. OCR recognition quality and layout grouping are therefore evaluated separately.

### Frozen document-import corpus

The project-generated Phase 0 document corpus is excluded from training. The full local extraction, PlanScan, compiler, and review-preparation path is gated separately with `pnpm eval:documents:check` and `pnpm eval:documents:baseline`. This protects PDF/image import behavior across hybrid, rotated, multi-page, month-grid, phone-photo, flyer, table, and direct-image layouts. It remains a development corpus, not an independently authored human-blind benchmark.

### Private real-document regression (2026-08-25)

One user-supplied, born-digital university schedule was checked locally without copying the PDF or its personal fields into the repository, fixtures, artifacts, or training data. The deterministic table compiler reconstructed all seven timed recurring rows and PlanScan independently corroborated all seven groups. Those series expand to 14 visible meetings per week across four courses. Two arranged/asynchronous rows were intentionally withheld because the source supplied no fixed weekday-and-time pair.

The regression also exercises a decoder boundary guard: an arranged row may not borrow time or location evidence from the next aligned table row. It is a single private-document engineering check, not a benchmark or a claim about general real-world accuracy.

## Optional parser-disagreement repair

PlanScan remains useful without any language-model pack. When deterministic rules and PlanScan produce different valid drafts for the same exact source anchor, the app may create a bounded repair session. If the separately installable Qwen3 1.7B Q4 pack is enabled, it may select one supplied, already validated candidate or withhold.

The fallback receives candidate metadata and exact title/date/time citations, not source files or storage access. It cannot rewrite a value, combine candidates, create a third proposal, emit an application action, or save data. Main and the importer revalidate selection identity, source digest, candidate identity, and exact citations. A valid alternate remains an editable, unsaved review proposal until the user confirms the normal batch.

## Safety and privacy

- The worker receives bounded in-memory blocks, not file paths or SQLite access.
- Contract validation rejects any span that is not an exact source substring with known word IDs.
- Relationships and groups cannot cross pages or refer to unknown evidence.
- The model is advisory. Calendar title copying, time resolution, recurrence, validation, commit, and undo stay deterministic.
- Model and rules proposals are drafts; explicit editable batch review is always required.
- Rules remain available if model artifacts fail validation or a group is withheld.
- Source bytes, predictions, scores, spans, and thumbnails remain temporary memory.
- The optional repair model is candidate-only and declares `hasMutationAuthority: false`.

## Intended use

Useful for clear English schedules, agendas, syllabi, invitations, flyers, travel plans, rotations, simple tables, and screenshots whose text is available from PDF.js or Tesseract. The model is designed to improve source-field grouping, especially across row-oriented layouts, without expanding mutation authority.

## Limitations and non-claims

- The model evaluation corpus is generated. No independent human-authored blind document set or reviewed production feedback set exists yet.
- The generator's lexical field classification is easier than real OCR; perfect generated entity F1 is not a real-world claim.
- OCR errors propagate by design when correction would be unsupported. Users must inspect highlighted evidence.
- English only. Handwriting, complex diagrams, calendars rendered solely as graphics, merged table cells, multi-page references, and unusually visual documents are outside this checkpoint.
- Font and scan-style identities drive layout/noise generation but are not pixel encoders; PlanScan consumes OCR/PDF geometry, not raw image pixels.
- The optional 1.7B fallback cannot recover a value absent from all extracted evidence and does not match a hosted frontier model.
- A human review study and broader licensed real-document benchmark remain required before a release-quality accuracy claim.
