# Offline voice architecture

## Shipped baseline

Phase 3 uses `sherpa-onnx` 1.13.6 WebAssembly with the English streaming Zipformer 20M model from 2023-02-17. The shipped INT8 encoder, decoder, joiner, tokens, and smoke audio total 43.3 MiB; the reusable JavaScript/WASM runtime adds 14.4 MiB to the installer. The model and runtime require no Python, native addon, account, service, or first-run download.

The compact model is the default because it keeps the verified Windows unpacked application at 386.7 MiB and decodes the evaluation clips comfortably faster than their audio duration on the development machine. Accuracy is intentionally bounded: English accents and noisy microphones can still need transcript edits. Larger or multilingual packs remain an explicit future option, not a silent download.

## Data flow

```text
microphone
  -> renderer AudioWorklet (batched mono PCM, memory only)
  -> resample / DC filter / edge trim / bounded gain at 16 kHz
  -> Zod-validated ArrayBuffer over the frozen preload bridge
  -> main-process model manifest and job checks
  -> lazily forked Electron utility process
  -> sherpa-onnx WASM modified-beam transcription
  -> time-aware transcript normalization
  -> editable assistant composer
  -> existing CalendarIR review / confirmation / undo path
```

ASR never receives a database handle. A transcript is not a command until the user sends it, and it gains no privileges that typed text lacks.

## Capture and lifecycle

- The renderer requests one audio track with echo cancellation, noise suppression, and automatic gain control; camera permission is always denied.
- The `AudioWorklet` batches samples off the UI thread. Capture is mono and stops automatically at 30 seconds.
- PCM remains in memory. Tracks and audio nodes are closed on stop, cancellation, navigation, and unmount.
- The main process verifies every required model artifact against its pinned byte length and SHA-256 digest before inference.
- The runtime and model load only on first voice use and the recognizer stays warm after a successful job.
- sherpa-onnx WASM decoding is synchronous inside its worker. Cancellation therefore rejects the job and kills the utility process, guaranteeing termination and disposal; a later request lazily reloads it.
- Half a second of internal boundary silence protects the first and last spoken words, while modified-beam search improves calendar-language recognition without a larger model.

## Verification

`pnpm verify` covers:

- manifest path traversal, size, hash, and missing/corrupt asset handling;
- bounded voice IPC schemas and progress/cancellation contracts;
- 48 kHz to 16 kHz resampling, DC removal, silence trimming, and deterministic background noise;
- real inference over the pinned clean WAV, a noisy variant, two synthetic calendar speaking profiles, and an attributed Irish-English calendar/time fixture;
- twelve typed/spoken equivalence pairs that must resolve to the same semantic `CalendarIR`;
- a production Electron smoke with network emulation offline, real bridge IPC, forced ASR cancellation, worker restart, and successful transcription.

The current Windows directory package is exercised end-to-end after packaging, and a Linux x64 directory package is produced successfully on the development host. `electron-builder` is configured for Windows, macOS, and Linux, and the WASM inference payload is platform-neutral. CI repeats Phase 3 verification and directory packaging on native runners for all three systems; microphone hardware checks still belong to the release matrix rather than being inferred from the Windows run.

## Reproducing model assets

Run `pnpm models:fetch` to restore ignored ONNX files in a development checkout, then `pnpm models:verify`. Downloads are pinned to immutable upstream revisions and accepted only after their exact hashes match `models/manifest.json`. Installed applications contain these verified files and have no download code.

Licenses and upstream attribution are recorded in `models/THIRD_PARTY_NOTICES.md` and `fixtures/audio/openslr83/ATTRIBUTION.md`.
