# ADR 0004: Model and media worker isolation

- Status: Accepted
- Date: 2026-08-23

## Context

ONNX inference, speech recognition, OCR, and PDF parsing are CPU/memory intensive and process untrusted user files. Running them in the renderer would harm responsiveness and increase privilege.

## Decision

Run privileged or synchronous model work in Electron utility processes. Inputs and outputs use bounded versioned schemas; jobs are cancellable; workers load lazily and may be terminated after inactivity. CPU is the universal fallback.

Phase 3 implements this decision with `sherpa-onnx` 1.13.6 WebAssembly. The main process verifies the model manifest before starting the worker, forks the utility process only for warm-up or transcription, and terminates it to cancel synchronous WASM decoding. The recognizer is reused between successful requests, while the renderer receives only progress events and a validated transcript result.

Phase 4 adds a documented browser-runtime exception. PDF.js and Tesseract.js run in a dedicated, terminable module Web Worker created by the already sandboxed renderer. Their portable browser distributions depend on `OffscreenCanvas`, Web Workers, and browser-style WebAssembly asset loading; using that path avoids platform-native OCR dependencies and keeps one implementation across Windows, macOS, and Linux. The worker receives a transferred, bounded `ArrayBuffer` and packaged model URLs only. It has no Node.js, preload bridge, filesystem path, SQLite handle, or mutation IPC. The main process still owns file selection, signature/size validation, opaque review registration, and the final reviewed transaction.

Phase 7 loads PlanScan in that same document worker after extraction. Its browser-safe runtime receives only bounded positioned pages and verified packaged model bytes. It has no filesystem, network, calendar, or mutation capability; failure or cancellation preserves the Phase 4 rule-based planner and review boundary.

This exception does not make document parsing trusted. Cancellation or dialog disposal terminates the worker, CSP limits asset loading to the application origin, extraction output is schema-validated, and no write is possible before the editable review is confirmed. If future profiling shows that malformed-document crashes can escape Chromium's worker isolation or make the UI unreliable, move this same message contract behind an Electron utility process with an explicitly bundled canvas implementation.

## Consequences

- ASR crashes and memory spikes are isolated in a utility process; document jobs are isolated from the React thread but still share the sandboxed renderer process.
- Worker startup and model-session reuse must be benchmarked.
- No worker receives unrestricted renderer objects or direct database access.
- Accelerator providers are enabled only after correctness and latency checks.
- Cancellation trades a later model reload for prompt, deterministic termination and audio disposal.
- The document worker favors portable browser/WASM assets over native packages and must keep strict byte, page, pixel, word, and timeout limits.
