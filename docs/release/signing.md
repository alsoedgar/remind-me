# Signing and native release checklist

## Required tagged-release secrets

| Target          | Required repository secrets                                                                        |
| --------------- | -------------------------------------------------------------------------------------------------- |
| Windows x64     | `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`                                                             |
| macOS x64/arm64 | `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` |
| Linux x64       | None in the current AppImage/deb workflow                                                          |

`WIN_CSC_LINK` and `MAC_CSC_LINK` may identify the certificate in a form supported by electron-builder. Do not commit certificate material or passwords. The tagged workflow fails before packaging when a required value is absent; local unsigned output is useful for development but is not a releasable Windows/macOS artifact.

## Candidate checks

For every native target:

1. Run `pnpm verify` and the package audit on the same revision and verified model manifest.
2. Install on a clean supported machine with networking disabled and no Python, Ollama, OCR, or model runtime preinstalled.
3. Confirm first-launch attestation, all three probes, CPU fallback, microphone denial/retry, native PDF input, raster OCR, typed assistant behavior, and secure erase.
4. Upgrade from the preceding released schema with calendar and conversation data present; verify migration, recurrence, notifications, and undo.
5. Feed a deliberately corrupt database in a disposable profile; confirm the recovery copy and clean startup warning.
6. Feed one altered model artifact; confirm only that role degrades and no download occurs.
7. Uninstall with data retention, reinstall and verify recovery; separately use delete-all and verify the old data does not return.
8. Record installed/unpacked size, peak working set during planner/speaker/ASR/OCR use, cold and warm latency, and signature/notarization verification.

Windows artifacts must show a valid expected publisher signature. macOS artifacts must pass code-signing verification, Gatekeeper assessment, and notarization/stapling checks on both architectures. Linux artifacts must install/run on the declared distributions; the project does not describe them as vendor-signed until a Linux signing policy is added.

## Publication rule

The release workflow publishes immutable tag assets only after every platform build job succeeds. Release notes should include the application version, manifest SHA-256, supported architectures, known model limitations, package sizes, and any feature that entered deterministic fallback. Never label a locally unsigned or unnotarized build as a production release.

`pnpm package:artifacts:audit` checks expected installer formats, architecture-local package structure, nonempty update metadata, and a 300 MiB per-artifact ceiling. Passing `--require-signature` additionally requires valid Authenticode on Windows or strict code-signing, Gatekeeper assessment, and a valid stapled notarization ticket on macOS. The tagged workflow supplies that flag for both signed platforms. Without it, a local Windows build reports `NotSigned` instead of disguising development output as a release.
