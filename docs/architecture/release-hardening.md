# Release hardening

## Startup attestation

The installed application does not trust a model merely because the file exists. Main-process startup reads `models/manifest.json`, computes its SHA-256 identity, and verifies every required artifact's relative path, exact byte length, and digest before constructing a learned runtime. It then runs a manifest-bound golden suite through the actual RemindCore, RemindSpeak, and PlanScan implementations.

Each role fails independently:

| Failed boundary               | Runtime behavior                                         |
| ----------------------------- | -------------------------------------------------------- |
| RemindCore artifact or probe  | Deterministic language rules only                        |
| RemindSpeak artifact or probe | Protected-fact response templates                        |
| PlanScan artifact or probe    | Deterministic document grouping rules                    |
| Speech artifact/runtime       | Typed input remains available; voice reports unavailable |
| Provider cache                | Repeat the bounded local benchmark and use CPU           |

Attestation never fetches a replacement, sends a report, or crashes the calendar for an optional learned path. Settings displays the manifest identity, artifact/probe status, provider labels, CPU fallback, custom disk/working-table budgets, and any degradation reason.

## Provider and memory policy

The universal implementations are `typescript-int8-cpu` for the original models and `sherpa-onnx-wasm-cpu` for speech. The first verified startup times the known-correct local paths and writes only the selected labels and timing to a provider cache keyed by the manifest SHA-256. A cache from another model inventory is ignored. Future accelerators may be added to the candidate set, but they must reproduce the same probes and CPU always remains available.

RemindCore is compact and stays ready in main. RemindSpeak and PlanScan expose bounded decompressed table sizes. Speech starts lazily, is cancellable, and exits after two idle minutes; the document PDF/OCR/PlanScan worker terminates after each completed, failed, cancelled, or discarded job. Release checks cap project-trained installed artifacts and the combined original-model working tables at 100 MiB each.

The optional flexible pack is outside the required release manifest because it is never bundled. Its official Qwen3 1.7B Q4_K_M artifact has a separately pinned byte length and SHA-256, downloads only after an explicit Settings action, and is rehashed before first load if the local file signature changed. Inference runs in a utility process with one job, a 90-second timeout, a memory-adaptive 4K–8K context, and two-minute idle termination. Packaging keeps one llama.cpp backend per target; Windows/Linux default to the portable CPU path and macOS can use its bundled Metal backend.

## Database lifecycle

SQLite enables foreign keys, a busy timeout, secure delete, and an untrusted-schema policy. File databases use WAL. Schema upgrades run in immediate transactions, reject versions newer than the application, and finish with `quick_check` before the app is considered healthy.

Recognized SQLite corruption causes the database plus present WAL/SHM files to be moved to a timestamped recovery path. A fresh database is then migrated and checked. This preserves evidence for manual recovery and makes the degraded state visible. Unrelated open failures are not guessed to be corruption.

Delete-all-data is a separate irreversible boundary. The request schema requires the exact `DELETE` token. One transaction removes all user-owned rows and action history, recreates only default local settings/calendar state, checkpoints WAL, and vacuums the file; the main process then removes known timestamped database/WAL/SHM recovery copies. It intentionally cannot be undone and is best-effort at the SQLite/filesystem layer; Settings offers backup first, while OS backups, synced history, snapshots, and flash wear leveling remain outside the app's control.

## Packaged application boundary

`electron-builder` uses maximum compression, a deterministic artifact name, and ASAR. Electron fuses disable Run-as-Node, `NODE_OPTIONS`, CLI inspect arguments, browser-specific snapshot loading, file-protocol privilege elevation, and code outside the integrity-checked ASAR; cookie encryption is enabled. WebAssembly trap handlers remain enabled because the bundled speech/OCR paths rely on WebAssembly and Electron documents a substantial explicit-bounds-check performance cost when that fuse is disabled. The renderer retains context isolation, sandboxing, denied navigation/permissions, CSP, and schema-validated IPC.

The package audit reads the packaged Electron fuse wire and requires all nine Electron 43 states explicitly. It also requires the executable, `app.asar`, the isolated flexible-model worker, exactly one supported target-native llama.cpp backend, and a completely valid model inventory; rejects Python, JSONL, ML/fixture directories, and environment files; and caps the unpacked application at 525 MiB. The reviewed increase covers the cross-platform native grammar runtime, not optional model weights. An unexpected future fuse makes the audit fail until policy is reviewed. NSIS preserves application data on ordinary uninstall so removal is not confused with the explicit secure erase flow.

## Release matrix

Normal CI regenerates the original models and ONNX graphs, runs `pnpm verify`, builds a native directory, and audits it on Windows x64, Linux x64, macOS arm64, and macOS x64. The manually dispatched signed-release workflow prepares one verified model payload and then creates platform installers. Windows requires a signing certificate; macOS requires Developer ID signing plus Apple notarization credentials; Linux produces AppImage and Debian artifacts without claiming an OS-vendor signature.

A workflow definition is not release certification. The artifact audit checks installer presence, size and native structure, and requires valid Windows Authenticode or macOS code-signing/Gatekeeper/notarization results for tagged signed targets. Each tagged artifact still needs a clean-machine install, upgrade/migration, offline smoke, and uninstall/data-retention result on its native target before publication is treated as complete.

## Reproducing the gates

```bash
pnpm verify
pnpm package:dir
pnpm package:audit
pnpm package:installer
pnpm package:artifacts:audit
```

`verify` is the source/runtime gate. `package:audit` is the installed-layout gate. The packaged executable's `--smoke-test --offline-smoke` path exercises startup attestation, calendar and assistant writes, restore/undo, ASR cancellation/restart/idle unload, document assets, secure erase, and database health with Chromium networking disabled.
