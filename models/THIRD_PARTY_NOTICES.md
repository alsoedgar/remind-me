# Offline voice notices

RemindCore, RemindSpeak, and PlanScan are project-owned models covered by the repository license, not third-party weights. Their checked-in pipelines train from zero initialization on reproducible program-generated corpora. This notice covers the separate upstream speech, document, and optional broad-language dependencies.

Remind Me bundles the following components for private, on-device speech recognition:

- `sherpa-onnx` 1.13.6, Copyright Xiaomi Corporation and contributors, Apache License 2.0.
- `sherpa-onnx-streaming-zipformer-en-20M-2023-02-17`, exported by the sherpa-onnx project from the Icefall LibriSpeech streaming-small model, Apache License 2.0.

Upstream sources:

- https://github.com/k2-fsa/sherpa-onnx
- https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-en-20M-2023-02-17
- https://huggingface.co/desh2608/icefall-asr-librispeech-pruned-transducer-stateless7-streaming-small

The Apache License 2.0 text is available at https://www.apache.org/licenses/LICENSE-2.0.

Phase 3 accent evaluation also includes an unmodified audio clip from the OpenSLR 83 UK and Ireland English Dialect dataset, Copyright 2018–2019 Google LLC, licensed under CC BY-SA 4.0. This evaluation-only file is not bundled in the desktop installer. See `fixtures/audio/openslr83/ATTRIBUTION.md` and its accompanying `LICENSE`.

## Local document planning notices

Remind Me bundles the following components for private PDF and image planning:

- `pdfjs-dist` 6.2.108 (Mozilla PDF.js), Copyright Mozilla Foundation and contributors, Apache License 2.0.
- `tesseract.js` 7.0.0 and its `tesseract.js-core` WebAssembly runtime, Copyright Tesseract.js contributors, Apache License 2.0.
- `@tesseract.js-data/eng` 1.0.0 English trained data, sourced from the Tesseract `tessdata` project and distributed under the MIT License by the package maintainers.

Upstream sources:

- https://github.com/mozilla/pdf.js
- https://github.com/naptha/tesseract.js
- https://github.com/naptha/tesseract.js-core
- https://github.com/naptha/tessdata

The MIT License text is available at https://opensource.org/license/mit. Build output records the pinned PDF.js/Tesseract.js versions and copied asset sizes in `document/runtime-manifest.json`; installed applications load only those local assets.

## Optional flexible language pack

Remind Me can, only after an explicit user action, download `Qwen3-1.7B-Q4_K_M.gguf` from the pinned `ggml-org` Hugging Face repository. It is not distributed in the application installer. Qwen3 1.7B is provided under the Apache License 2.0:

- https://huggingface.co/Qwen/Qwen3-1.7B-GGUF
- https://huggingface.co/ggml-org/Qwen3-1.7B-GGUF

The optional inference runtime is `node-llama-cpp` 3.20.0 under the MIT License and embeds llama.cpp:

- https://github.com/withcatai/node-llama-cpp
- https://github.com/ggml-org/llama.cpp

The application pins the Q4_K_M artifact at 1,282,439,264 bytes with SHA-256 `d2387ca2dbfee2ffabce7120d3770dadca0b293052bc2f0e138fdc940d9bc7b5` and displays the license before installation.
