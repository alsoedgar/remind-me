# RemindCore

The 3–5M parameter pipeline proof is implemented. HashFrame v0.2 starts from zero, trains on the original 48,000 reproducible program-generated examples plus an audited Qwen-assisted language curriculum, averages three deterministic operation-head training orders into one table, jointly predicts operation/spans/ambiguity/OOD/risk, exports per-output-channel INT8 JSON plus ONNX, and runs through a dependency-free TypeScript kernel behind the existing CalendarIR safety boundary. The Qwen teacher supplies only delexicalized request wording and hard negatives; project code supplies every label and fact, reserves a disjoint challenge, and promotes only a residual that stays inside the original development regression guard.

Key files:

- `pipeline.py` — deterministic data generation, scratch training, calibration, evaluation, quantization, export, and release-manifest update.
- `config.json` — pinned seed, model size, epochs, and split sizes.
- `data/manifest.json` — exact split hashes, template-family separation, and provenance.
- `reports/` — full Python and shipped TypeScript runtime metrics.
- `MODEL_CARD.md` — intended use, results, safety, and known limitations.
- `../teacher_assisted/` — pinned teacher prompts, raw outputs, accepted corpus, rejection report, and reproducibility checks.

Create a development virtual environment from `pyproject.toml`, then run `python ml/remindcore/pipeline.py all`. Python is never required by the installed desktop app.
