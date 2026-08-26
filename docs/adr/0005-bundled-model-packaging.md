# ADR 0005: Bundled and verified model assets

- Status: Accepted
- Date: 2026-08-23

## Context

Out-of-box offline behavior conflicts with first-run model downloads and external runtimes. Native inference can also require target-specific binaries.

## Decision

Each platform installer bundles required weights, tokenizer data, schemas, thresholds, golden predictions, and hashes. `models/manifest.json` is the machine-readable inventory. Runtime initialization verifies required artifact paths, lengths, and SHA-256 hashes before loading a model; build/release smoke tests also run known audio through the real packaged inference path.

Phase 3 uses the same sherpa-onnx JavaScript/WebAssembly runtime on Windows, macOS, and Linux instead of shipping three speech-native addons. The English Zipformer model is pinned to exact upstream files and licensed in `models/THIRD_PARTY_NOTICES.md`.

Phase 4 applies the same out-of-box rule to documents. The lockfile pins PDF.js, Tesseract.js, its WebAssembly cores, and English trained data. `pnpm document-assets:prepare` copies only the required browser assets into ignored generated public output and writes a version/size manifest before development and production builds. Electron packages that renderer output, so installed applications never fetch OCR or PDF runtime files.

Phase 7 adds the project-trained PlanScan configuration and reproducibly gzipped INT8 weights to both `models/manifest.json` and the generated document assets. The preparer verifies and copies those exact local artifacts; the worker verifies their uncompressed digest before inference. A missing or corrupt PlanScan artifact disables learned linking and exposes the existing rule planner instead of attempting a download.

## Consequences

- Release artifacts are larger and platform-specific.
- Large weights belong in release assets or Git LFS, not normal Git history.
- Corrupt or incompatible assets trigger a safe fallback rather than partial writes.
- Signing/notarization occurs after model assets and Electron fuses are finalized.
- Development checkouts can reproduce missing assets with `pnpm models:fetch`; installed applications never invoke that script.
