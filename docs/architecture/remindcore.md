# RemindCore local semantic planner

RemindCore is the project-owned, zero-initialized native path for understanding calendar language. Version 0.3 retains the complete v0.2 planner described below and adds the bounded [RemindCore Next understanding extension](remindcore-next.md). It is not a repackaged LLM, adapter, or runtime call to the optional foundation model. It selectively learns from audited Qwen-generated request surfaces without importing Qwen weights or facts. It remains the bundled default planner; its narrow assistance gate and generated-data evaluation are documented rather than presented as general-language performance.

## Why this architecture

The prototype combines five compact supervised heads over one deterministic feature encoder:

| Head      | Output                                      | Runtime use                                     |
| --------- | ------------------------------------------- | ----------------------------------------------- |
| Operation | 13 calendar operations plus OOD             | Proposes one safe semantic hint                 |
| BIO slots | title, target, date, time, recurrence spans | Copies source text; never invents values        |
| Ambiguity | clear / ambiguous                           | Closes the model-assistance gate                |
| OOD       | in-domain / out-of-domain                   | Rejects unrelated or calendar-adjacent requests |
| Risk      | read / low / medium / high / destructive    | Evaluation and shadow signal only               |

Word features provide precise calendar vocabulary. Character 3–5-grams improve typo, OCR, and ASR robustness. Feature hashing gives a fixed memory budget without a downloaded vocabulary. The constrained copy decoder combines learned BIO evidence with a small calendar grammar, which keeps titles and targets anchored to exact source spans.

This direction is informed by primary research on [feature hashing](https://arxiv.org/abs/0902.2206), [joint intent and slot modeling](https://aclanthology.org/P19-1519/), byte/character robustness in [ByT5](https://arxiv.org/abs/2105.13626), [confidence calibration](https://proceedings.mlr.press/v70/guo17a.html), [energy-style OOD detection](https://arxiv.org/abs/2210.08830), [data-efficient paraphrase augmentation](https://aclanthology.org/2020.coling-industry.2/), and [selective synthetic-data filtering](https://aclanthology.org/2023.eacl-main.107/). RemindCore's implementation and weights are project-specific and trained from zero initialization; those papers and Qwen surfaces supplied design/data evidence, not pretrained parameters.

## Runtime flow

```text
request text
   ├─ deterministic rules parse ───────────────────────────────┐
   └─ RemindCore INT8 heads -> calibrated safe hint            │
                          │                                    │
                          └─ only if rules were unsupported or │
                             used generic dated-event fallback │
                                                               v
original text + source copy spans -> deterministic reparse -> CalendarIR.Draft
    -> schema validation -> deterministic resolution/dry-run -> user review
    -> explicit confirmation -> one SQLite transaction -> receipt + undo
```

The model has no storage API and never receives a database handle. Calendar state retrieval, entity targeting, recurrence math, timezones, DST, conflicts, free/busy, writes, and replies remain deterministic.

## Data and reproducibility

`ml/remindcore/pipeline.py` deterministically generates programs first, then renders text. The base corpus has 36,000 train, 6,000 development, and 6,000 test requests. The promoted training set adds 2,640 examples instantiated from accepted Qwen surfaces; a separate 158-example teacher challenge is never trained. The corpus includes split-disjoint sentence wrappers, held-out titles/targets/dates/times, broad conversational calendar frames, ambiguity, OOD, typo, ASR-style, OCR-style, casual abbreviations, and en-US/en-GB variants. The operation head averages three zero-initialized perceptron training orders selected on the development split into one table; a guarded residual can update only hash buckets previously unused by the base training surfaces.

The development-only teacher lab sends Qwen protected signatures such as `<TITLE>|<DATE>|<TIME>`, never personal values. It accepted 73 delexicalized templates and 14 hard OOD messages. Curation rejects placeholder changes, missing operation cues, duplicates, unprotected specifics, non-user-voice content, and true calendar actions proposed as OOD. One template per operation is challenge-only. A sweep of residual strengths promotes the strongest teacher transfer that remains within a 0.05-point original-development regression budget; the current 0.005 residual touches 937 novel lexical buckets.

The manifest records exact hashes and makes two limitations explicit:

- all current examples are program-generated;
- teacher-assisted examples are explicitly identified and use project-generated labels/facts;
- the required independently authored human blind set is still zero.

The tracked 600-example runtime fixture is a deterministic systematic sample of the test split. It verifies Python/export/TypeScript parity without requiring the full generated corpus in source control.

## Artifacts

| Artifact                    | Purpose                                     | Approximate size |
| --------------------------- | ------------------------------------------- | ---------------: |
| `remindcore-v0.1-int8.json` | Shipped TypeScript INT8 tables and metadata |          6.2 MiB |
| `remindcore-v0.1-int8.onnx` | Quantized parity/portable graph             |          4.7 MiB |
| `tokenizer.json`            | Normalization and hashing contract          |           <1 KiB |
| `thresholds.json`           | Calibrated assistance/safety gate           |           <1 KiB |

All four appear in `models/manifest.json` with exact size, SHA-256, contract version, MIT license, and `project-trained` provenance. The ONNX graph uses standard `MatMulInteger`, `Cast`, `Mul`, and `Add` operators. ONNX is an open portable representation; the official [IR specification](https://onnx.ai/onnx/repo-docs/IR.html) and [operator catalog](https://onnx.ai/onnx/operators/) define the bundled graph.

## Measured checkpoint

The original complete generated test split reports:

- 97.73% operation accuracy and 97.94% macro F1 across the expanded operation inventory;
- 100% precision among requests eligible for model assistance, at 51.46% coverage of the full generated test split;
- 99.65% OOD recall and 89.98% ambiguity recall;
- 98.48% constrained assisted-title coverage;
- a 0.05 percentage-point operation-accuracy reduction after INT8 quantization (97.73% float, 97.68% INT8 in this run);
- 3.03 ms Python evaluation p95.

The tracked TypeScript fixture retains 100% eligible precision at 17.5% eligible coverage, 100% OOD recall, 100% schema validity, and approximately 1.2 ms warm p95 in the latest development-machine gate. On the disjoint teacher challenge, operation accuracy rises from 61.39% at zero residual to 67.09% at the promoted residual while assisted precision remains 100%. Exact current values live in `ml/remindcore/reports/`.

These are generated-data engineering metrics, not production or human-generalization claims. The expanded checkpoint clears the generated-data accuracy target, but ambiguity recall and independently authored language remain open gates, so model assistance stays narrow. Increasing data quantity alone is not enough; the next gate requires independently collected language, per-operation calibration, locale expansion, adversarial targeting tests, and execution-equivalent evaluation over real calendar contexts.

## Reproducing the model

Python is development-only. Create a virtual environment under `ml/.venv`, install `ml/remindcore/pyproject.toml`, then run:

```bash
python ml/remindcore/pipeline.py all
pnpm models:verify
pnpm remindcore:check
```

Installed users never run these commands. Electron bundles the verified artifacts and executes the TypeScript kernel on Windows, macOS, and Linux.

Artifact metadata is version `0.3.0`; the `remindcore-v0.1-*` compatibility filenames are intentionally retained to avoid a runtime and installer migration.
