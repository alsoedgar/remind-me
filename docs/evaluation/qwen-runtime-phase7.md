# Qwen runtime Phase 7 report

## Outcome

The optional Qwen path is now hardware-bounded, workload-separated, observable,
and reproducibly probed. It remains an explicit local fallback behind the
project-owned RemindCore and RemindSpeak models and has no database authority.

## Reference measurement

The measured machine was Windows x64 with an AMD Ryzen AI 9 HX 370, 24 logical
processors, and 31.12 GiB RAM. The pinned model was exactly 1,282,439,264 bytes
with SHA-256
`d2387ca2dbfee2ffabce7120d3770dadca0b293052bc2f0e138fdc940d9bc7b5`.

The thread sweep's warm median was 5,696.54 ms at 4 threads, 3,856.67 ms at 8,
3,310.30 ms at 12, and 3,173.13 ms at 16 for the same short synthetic response.
That justified retaining the 16-thread performance point; it is not presented
as a before/after application speedup. The current selected-point repeat
measured a 1,579.65 ms full-file integrity pass, 4,075.03 ms model load,
3,234.28 ms warm median for that micro-workload, and 2,335.8 MiB process RSS.

The real utility-worker probe used four split bulk clauses plus two chat turns.
It passed the operation sequence `event.create`, `reminder.create`,
`event.move`, `reminder.delete`, retained exact source grounding, and kept both
workloads alive while alternating. Its cold constrained plan took 74,403 ms.
Subsequent plans took 19,661, 15,758, and 13,358 ms. The first chat-prefix use
took 21,955 ms; the later concise next-item answer took 11,484 ms and ended
normally in 38 tokens.

## Engineering changes

- Compact, balanced, and performance profiles use `availableParallelism()` and
  live memory instead of assuming all logical CPUs and RAM are available.
- Performance hardware uses separate 4K planner/chat sequences within an 8K
  total KV-token budget. Lower tiers use one 4K shared sequence.
- Stable policy and examples form cacheable workload-specific system prefixes.
- The JSON grammar is lazy-created once per worker lifetime.
- The Qwen tokenizer fits profile memory, recent turns, verified calendar data,
  dialogue focus, and the current message before generation.
- Planner caps range from 220 to 640 tokens. Chat caps adapt from a concise 56
  to the profile maximum; capped prose is trimmed to a complete sentence when
  possible.
- Full SHA-256 verification remains mandatory, with larger read chunks.
- Settings exposes the automatic tier and last-request metrics without giving
  the renderer control of model paths or unsafe native options.

## Limits and interpretation

The 1.7B Q4 model is still much slower and less reliable than the native stack
on CPU. Direct unsplit multi-action JSON is not trusted; the application first
uses its deterministic clause splitter, then grounds every model excerpt,
recompiles through typed parsers, and rejects the entire proposal on any invalid
item. The probe mirrors that user-facing orchestration.

Only one Windows CPU machine is measured here. Metal support is selected only
on packaged Apple silicon, but no Metal number is claimed. Phase 8 must collect
cross-platform latency, peak memory, paging, power, quality, and failure rates
before making broader performance claims.

## Verification and local artifact

The Phase 7 gate passed 48 test files / 337 tests, all 256 golden fixtures and
17 operations, model and document attestations, formatting, lint, typecheck,
the production build, and the offline Electron smoke. The packaged Windows x64
executable also passed its offline smoke. Package audit reported 507.6 MiB
unpacked, one `win-x64` optional-model backend, all 16 verified required model
artifacts, nine hardened Electron fuses, the complete worker/prompt/schema set,
and ASAR-only application loading.

The local NSIS installer is 155,373,128 bytes (148.2 MiB) with SHA-256
`844066F486021E67EA569BF8C920FD3E118F1B52A0CE0E474EEC1FF0F1F7B017`.
It is explicitly `NotSigned`; this local build is not represented as a signed
Windows release. The app ID and user-data directory are unchanged, and the
packaging/smoke process did not modify the existing calendar database.
