# Local model assets

`manifest.json` is the release inventory for bundled local inference. Every artifact has a role, component, version, format, relative path, exact byte length, SHA-256 digest, locale, license, source, and contract version.

Restore missing development assets and verify the installation with:

```bash
pnpm models:fetch
pnpm models:verify
```

The fetch script uses pinned upstream revisions, rejects unexpected lengths or hashes, and is not included in the desktop runtime. Electron installers copy the verified `models/` tree into application resources; users do not need to download a model after installation.

## First-party model track

RemindCore and RemindSpeak are the project's native assistant models and remain the default language path. They are original architectures trained from zero initialization by the checked-in research pipelines, not fine-tuned or repackaged foundation models. Version 0.2 uses explicitly disclosed data distillation from the optional Qwen3 1.7B pack: RemindCore admits filtered delexicalized request surfaces and hard negatives, while RemindSpeak admits only preference indices over project-authored protected candidates. No Qwen/pretrained weights, Qwen-authored reply atoms, personal data, or independently authored human blind set enter the students. Exact teacher hashes, rejection reports, held-out challenges, and non-regression sweeps keep the work reproducible and portfolio-relevant without presenting teacher-generated metrics as real-user generalization.

Large upstream and parity weight formats are ignored by normal Git. Release automation must fetch or regenerate and verify them before building. Small original compressed artifacts, text manifests, tokens, smoke fixtures, licenses, and notices remain reviewable in the repository.

RemindCore is different from the upstream speech and Qwen models: its project-trained INT8 JSON, tokenizer contract, thresholds, and ONNX parity graph are produced from the local research pipeline. The manifest labels the weight provenance `project-trained` and separately records `teacherUsed: true`; `models:fetch` will never substitute a remote student artifact. A missing original artifact must be rebuilt in the development ML environment; installed releases bundle the verified result.

RemindSpeak's project-trained configuration and reproducibly gzipped INT8 table are produced by `ml/remindspeak/pipeline.py`. The required compressed artifact is small enough to keep with the source, expands to a bounded 26.8 MiB table at runtime, and is validated by `remindspeak:check`. It has no remote substitute. Qwen is used only in the development teacher lab and is not required for RemindSpeak inference.

Qwen3 1.7B Q4_K_M is intentionally outside this first-party inventory. It is an optional, explicitly installed Apache-2.0 language-capacity tier for broader conversation and paraphrases on capable hardware; it neither replaces the original models nor receives direct calendar mutation authority. Its planner output must be source-grounded, deterministically recompiled, dry-run, reviewed, and confirmed before one atomic, undoable transaction. See `docs/architecture/optional-flex-model.md` for its separate lifecycle and trust boundary.

PlanScan's project-trained configuration and reproducibly gzipped INT8 SpatialHashGraph heads are produced by `ml/planscan/pipeline.py`. The 5.24M-parameter model is trained from zero initialization on a split-disjoint synthetic document corpus, expands to a bounded 5 MiB working table, and is validated by the PlanScan and Phase 8 gates. It has no pretrained backbone, teacher, remote service, or remote substitute.

Phase 8 adds a valid ONNX score-kernel graph for every original model. `ml/export_onnx.py` reconstructs each graph from the quantized project artifact, embeds the quantization policy as metadata, validates structure with the ONNX checker, and runs direct numerical parity with ONNX's reference evaluator. These graphs are portable research/interchange artifacts; the dependency-free TypeScript INT8 kernels remain the selected installed CPU runtimes. Run `pnpm models:onnx:export` to regenerate them and `pnpm models:onnx:check` to audit an existing release inventory.

`release-probes.v0.1.json` is generated from held-out, contract-valid fixtures and registered as a required manifest artifact. Startup verifies the manifest and all required byte lengths/digests, then checks three RemindCore decisions, protected RemindSpeak candidates, and real PlanScan document grouping. A mismatching learned role is disabled independently and its deterministic fallback remains usable. `pnpm release:prepare` regenerates both ONNX graphs and the probe suite before package creation.

See `THIRD_PARTY_NOTICES.md` for upstream licenses, `docs/architecture/release-hardening.md` for Phase 8 attestation, `docs/architecture/offline-voice.md` for the speech boundary, and the individual RemindCore, RemindSpeak, and PlanScan architecture documents for the original models.
