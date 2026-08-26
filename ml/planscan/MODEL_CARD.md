# PlanScan SpatialHashGraph 0.1 model card

## Summary

PlanScan 0.1 is an English, layout-aware advisory model for calendar-like PDFs, scans, and images. It consumes bounded OCR/PDF line blocks with normalized two-dimensional boxes and produces source-backed roles, spans, relations, event groups, document type, and confidence. It does not perform OCR or calendar execution.

This checkpoint is a project-trained model, not a wrapper around a general-purpose local LLM:

- zero parameter initialization;
- no teacher or distillation model;
- no pretrained text, vision, or document weights;
- no downloaded or personal document data;
- no network requirement in training or inference;
- deterministic feature hashing and a reproducible program-first generator.

## Architecture

`SpatialHashGraph` uses 131,072 deterministic FNV-1a feature buckets for each output channel. Text, OCR confidence, reading order, extraction method, and normalized box features feed six independently quantized heads:

| Head          | Labels |    Parameters | Purpose                                      |
| ------------- | -----: | ------------: | -------------------------------------------- |
| Block role    |      7 |       917,504 | heading, title, field, description, metadata |
| Entity role   |      8 |     1,048,576 | title, date, time, place, recurrence, cue    |
| Relation      |      6 |       786,432 | same-plan and typed field relationships      |
| Group link    |      4 |       524,288 | same group, new group, context, none         |
| Document type |      8 |     1,048,576 | schedule through screenshot                  |
| Confidence    |      7 |       917,504 | clear, OCR risk, crowding, ambiguity, noise  |
| **Total**     | **40** | **5,242,880** |                                              |

The release table is symmetric per-output-channel INT8. Its 5.0 MiB decompressed working set is sparse and gzip-compresses to 22.1 KiB; configuration adds 7.4 KiB. The model runs in a portable TypeScript loop with no ONNX Runtime or platform-native dependency.

The learned pair heads score nearby block relationships. A bounded graph decoder combines those scores with page geometry, prevents reuse of already claimed title/time/location evidence, and withholds groups below the calibrated threshold. Literal date/time recognition projects learned roles to exact character offsets; it does not create text.

## Training data

The generator creates 12,000 training, 2,000 development, and 2,000 test pages. Each split is approximately half born-digital and half OCR-like. Pages cover schedules, syllabi, invitations, flyers, itineraries, rotations, tables, and screenshots with two to four plans.

Complete template families, font identities, scan styles, and organization names are disjoint across train, development, and test. The tracked runtime set contains 96 untouched generated test pages, balanced between native text and OCR-like input. Provenance and SHA-256 digests are in `data/manifest.json`.

The synthetic layout approach was informed by document-understanding research that models two-dimensional position and text jointly, graph-based key-information extraction, and noisy-scan evaluation. PlanScan uses none of those projects' weights or training code: [LayoutLM](https://www.microsoft.com/en-us/research/wp-content/uploads/2020/02/layoutlm.pdf), [PICK](https://arxiv.org/abs/2004.07464), [FUNSD](https://arxiv.org/abs/1905.13538), and [Donut/SynthDoG](https://arxiv.org/abs/2111.15664).

## Results

### Generated 2,000-page disjoint test split

| INT8 metric                         |                 Result |
| ----------------------------------- | ---------------------: |
| Block-role accuracy                 |                 100.0% |
| Entity micro F1                     |                 100.0% |
| Relation micro F1                   |                  89.2% |
| Group-link micro F1                 |                  94.3% |
| Document-type accuracy              |                  84.9% |
| Born-digital execution equivalence  |                 100.0% |
| OCR-like execution equivalence      |                 100.0% |
| Exact evidence coverage             |                 100.0% |
| Maximum float-to-INT8 metric change | 0.35 percentage points |

The text-only inference ablation drops relation F1 from 89.2% to 39.8% and group-link F1 from 94.3% to 65.1%, showing that the held-out relation task materially uses spatial features. These are generated-data results and must not be presented as real-world document accuracy.

### Independent TypeScript runtime fixture

The 96-page runtime check validates the actual compressed artifact and product decoder:

| Runtime metric                                       |      Result |
| ---------------------------------------------------- | ----------: |
| Entity micro F1                                      |      100.0% |
| Born-digital field/group execution equivalence       |      100.0% |
| Scanned end-to-end field/group execution equivalence |       79.2% |
| Born-digital deterministic compiler equivalence      |      100.0% |
| Scanned deterministic compiler equivalence           |       79.2% |
| Exact source evidence                                |      100.0% |
| Warm ordinary-page p95 on development machine        | below 50 ms |

The scan score intentionally compares against pre-corruption facts. Remaining misses are generated OCR substitutions such as `R0om` and `Stud1o`, or corruption of the `Room:` label. PlanScan preserves the observed source rather than silently correcting it into unsupported text. OCR quality is therefore separated from born-digital layout grouping.

### Private real-document regression (2026-08-25)

One user-supplied, born-digital university schedule was checked locally without copying the PDF or its personal fields into the repository, fixtures, artifacts, or training data. The deterministic table compiler reconstructed all 7 timed recurring rows and PlanScan independently corroborated all 7 groups. Those series expand to 14 visible meetings per week across 4 courses. Two arranged/asynchronous rows were intentionally withheld because the source supplied no fixed weekday-and-time pair.

The regression also exercises a decoder boundary guard: an arranged row may not borrow time or location evidence from the next aligned table row. It is a single private-document engineering check, not a benchmark or a claim about general real-world accuracy.

## Safety and privacy

- The worker receives bounded in-memory blocks, not file paths or SQLite access.
- Contract validation rejects any span that is not an exact source substring with known word IDs.
- Relationships and groups cannot cross pages or refer to unknown evidence.
- The model is advisory. Calendar title copying, time resolution, recurrence, validation, commit, and undo stay deterministic.
- Model and rules proposals are drafts; explicit editable batch review is always required.
- Rules remain available if model artifacts fail validation or a group is withheld.
- Source bytes, predictions, scores, spans, and thumbnails remain temporary memory.

## Intended use

Useful for clear English schedules, agendas, syllabi, invitations, flyers, travel plans, rotations, simple tables, and screenshots whose text is available from PDF.js or Tesseract. The model is designed to improve grouping, especially across row-oriented layouts, without expanding mutation authority.

## Limitations and non-claims

- The evaluation corpus is generated. No independent human-authored blind document set or reviewed production feedback set exists yet.
- The current generator's lexical field classification is easier than real OCR; perfect generated entity F1 is not a real-world claim.
- OCR errors propagate by design when correction would be unsupported. Users must inspect highlighted evidence.
- English only. Handwriting, complex diagrams, calendars rendered solely as graphics, merged table cells, multi-page references, and unusually visual documents are outside this checkpoint.
- Font and scan-style identities drive layout/noise generation but are not pixel encoders; PlanScan consumes OCR/PDF geometry, not raw image pixels.
- A human review study and broader licensed real-document benchmark remain required before a release-quality accuracy claim.
