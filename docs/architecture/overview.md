# Architecture overview

## Objective

Remind Me must feel conversational without delegating calendar truth to probabilistic output. The architecture separates language understanding, deterministic planning, storage, and response phrasing so each can be evaluated and replaced independently. RemindCore and RemindSpeak are original, project-owned models trained from zero initialization on project-generated programs plus selectively admitted Qwen surfaces/preferences; no pretrained weights or personal data enter them. They remain the bundled default path even when the optional general-language tier is installed.

## Process boundaries

```text
┌──────────────────────────────────────────────────────────────────────┐
│ Sandboxed renderer                                                  │
│ React views · review cards · terminable PDF/OCR Web Worker          │
└─────────────────────────────┬────────────────────────────────────────┘
                              │ allowlisted, schema-validated IPC
┌─────────────────────────────▼────────────────────────────────────────┐
│ Electron main process                                               │
│ orchestration · RemindCore/RemindSpeak INT8 · storage · files      │
└───────────────┬──────────────────────────────┬───────────────────────┘
                │                              │
┌───────────────▼───────────────┐  ┌──────────▼──────────────────────┐
│ Deterministic domain packages │  │ Electron utility processes      │
│ resolve · recurrence · risk   │  │ speech · optional local LLM     │
│ dry-run · conflict · undo     │  │ bounded, cancellable, lazy      │
└───────────────┬───────────────┘  └──────────┬──────────────────────┘
                │                              │ typed model results
                └──────────────┬───────────────┘
                     ┌─────────▼──────────┐
                     │ Local SQLite store │
                     │ atomic history     │
                     └────────────────────┘
```

The renderer has no Node.js access. It receives a small frozen API from the preload script. Each main-process handler validates both the sending frame and the request/response payload.

## Safe command pipeline

1. An adapter converts text, voice transcripts, UI fields, or extracted document regions into input evidence.
2. Rules parse first; a calibrated RemindCore result may supply one of six safe operation hints and exact source-copy spans.
3. If that result is unsupported or only a generic inferred event, an explicitly installed Qwen3 1.7B Q4_K_M pack may classify one to eight exact source excerpts inside an isolated process. It may also provide broad conversational text from bounded, local context, but that text has no mutation authority.
4. The deterministic parser recompiles the original text and optional safe hint into `CalendarIR.Draft`; recognized rules win and model failure falls back to rules.
5. The compatibility boundary maps that draft into a grounded `AssistantPlan v2` action, validates its capability, target, arguments, dependencies, risk, and review policy, then compiles the action back to CalendarIR. Multi-part requests form one ordered plan before atomic review.
6. Zod validates the CalendarIR contract and structural requirements for the operation.
7. The deterministic resolver converts semantic time expressions into instants using locale, timezone, current time, and calendar context.
8. Risk, ambiguity, target selection, and confidence determine whether to answer, preview, confirm, clarify, or reject.
9. The command engine performs a dry run and presents the state difference.
10. Confirmed writes execute in one transaction and append an undoable action-history record.
11. The result becomes a verified `ResponsePlan`.
12. A template or RemindSpeak creates phrasing around protected placeholders; validation inserts facts deterministically.

No model receives a storage handle or executable IPC method.

## Implemented foundation

- Production renderer assets use the secure `remind-me://app/` custom protocol.
- Renderers use context isolation, Chromium sandboxing, no Node integration, a strict CSP, denied window creation, denied untrusted navigation, and denied runtime permission requests.
- The preload bundle is CommonJS because Electron sandboxed preloads execute in a restricted CommonJS environment.
- Workspace contracts and Zod are bundled into main/preload output; no TypeScript workspace source is loaded at application runtime.
- Phase 1 uses Temporal/IANA transitions for wall-clock resolution and recurrence. UTC offsets supplied by old fixtures are retained only as deprecated compatibility data and never drive calendar math.
- The main process owns a versioned SQLite database, atomic action history, JSON/ICS file access, and native notification scheduling.
- The renderer receives only validated snapshots and mutation receipts through the allowlisted preload bridge. Manual editors, import, completion, deletion, and undo all use this same path.
- Full and mini window states use the same allowlisted, schema-validated bridge. The main process alone controls native geometry, maximization, and always-on-top pinning; the renderer switches between the complete shell and a compact projection of the same calendar snapshot rather than opening a second data-owning window.
- The assistant is one persisted conversation surface mounted as an app-wide drawer. Optimistic user and activity bubbles are renderer-only progress state; accepted facts and changes still arrive exclusively from the validated assistant exchange contract.
- Event occurrences are expanded deterministically in local wall time; overlap uses half-open intervals so an event beginning exactly when another ends is not a conflict.
- Phase 2 adds a deterministic typed parser, contextual target retrieval, persisted dialogue turns and review proposals, and protected-fact response rendering. A bounded conversational-intent layer answers greetings, identity, wellbeing, thanks, goodbye, and capability questions without treating them as failed calendar commands. Whole-day copy language resolves a source date and target weekdays, expands the real source-day occurrences, and stages one reviewed, atomic set of recurring duplicates rather than guessing a single event.
- The Phase 2 dialogue-state layer persists focused entity IDs, last query results and ranges, and pending clarifications per conversation. It resolves singular and plural follow-ups against live local rows, survives restarts, prunes deleted references, and is reset independently when a conversation is cleared.
- Read requests resolve and dry-run before deterministic schedule, search, free/busy, or conflict evaluation. Every assistant write remains a pending proposal until the user approves it.
- Approval updates the proposal, calendar entities, and action-history receipt in one SQLite transaction. Failed or stale proposals cannot be applied a second time, and the resulting mutation stays undoable.
- Phase 3 adds microphone capture through a batched `AudioWorklet`, bounded 16 kHz Float32 IPC, verified model assets, and lazy sherpa-onnx WebAssembly inference in an Electron utility process.
- Voice recordings remain in renderer/worker memory, cancellation kills the synchronous inference worker, and successful transcripts return to the editable composer. Only sending that text enters conversation history and the existing deterministic command pipeline.
- Phase 4 keeps file paths in main, transfers validated bytes to a terminable sandboxed Web Worker, reads embedded PDF text before local OCR, and preserves normalized evidence boxes and thumbnails for an editable batch review.
- PDF/OCR results have no mutation capability. Only schema-validated reviewed forms tied to a live opaque selection can enter one main-process transaction and one undo receipt. Source bytes and extraction evidence are memory-only and are discarded on close, cancel, error, expiry, or commit.
- Document reconciliation assigns stable digest-bound source-row IDs and semantic identities before review. Exact reimports are visible but locked, likely duplicates are unselected choices, and overlapping classes with different CRNs, sections, or components are protected as distinct. SQLite schema version 4 persists only bounded identity metadata and enforces source-row uniqueness across event and reminder imports.
- Phase 5 adds the original 4.46M-parameter RemindCore planner, trained from zero over a reproducible program-first corpus. Version 0.2 adds filtered, delexicalized Qwen surfaces through a novel-bucket residual selected by an original-development regression guard. Its five INT8 heads run in TypeScript, with an ONNX parity export and exact release hashes. The expanded operation head includes event duplication, uses replicated semantic-cue features shared exactly by Python training and the TypeScript runtime, and averages three deterministic training orders into one runtime table for better generalization and quantization stability.
- RemindCore is advisory: it can hint only six non-destructive operations, cannot target stored entities or introduce destructive/series actions, and must pass calibrated operation, ambiguity, OOD, source-copy, reparse, schema, dry-run, and review gates.
- The optional Qwen3 1.7B Q4_K_M tier is separately installable and removable. It is used for broader local conversation and difficult fallback phrasing when the user's hardware can support the added 1.28 GB weight and inference cost. A pinned SHA-256 download, separate planning/chat JSON grammars, exact-substring projection, fact-reference validation, deterministic reparse, utility-process timeout, dry-run review card, and atomic batch boundary prevent it from becoming a database agent. It receives no storage handle and unloads on a hardware- and memory-aware idle window.
- Phase 6 promotes the original 28.31M-parameter RemindSpeak v0.3 surface generator. It uses Qwen preference indices over project-authored protected candidates; no Qwen-authored atom enters its 432-atom inventory. It covers 18 protected speech acts, scores lead/body/close atoms from verified `ResponsePlan` metadata, generates five candidates, enforces exact placeholders, rejects unsafe static literals and recent exact replies, and reranks for style, novelty, and bounded fact-free local feedback. A randomized blind human-study harness is prepared, but no human preference result is claimed before participants complete it.
- RemindSpeak cannot construct facts or plans. The assistant renderer independently validates every candidate, inserts values deterministically, and falls back to an existing grounded template on any model or validation failure.
- Document-improvement Phase 6 promotes PlanScan `SpatialHashGraph` 0.2, the original 5.24M-parameter layout model trained from zero on 21,000 program-first pages. Its disjoint native/OCR corpus balances six challenge slices and mines OCR corruption, hard neighboring-row negatives, repeated titles, unfamiliar column orders, and header/footer distractions.
- PlanScan runs inside the sandboxed PDF/OCR worker, predicts block/entity roles plus learned spatial links, and projects results only onto exact source substrings and word IDs. The deterministic planner compiles accepted groups, while rules supplement only unclaimed date/time anchors. A 120-page runtime suite gates each challenge slice independently.
- PlanScan cannot correct OCR text, invent a field, resolve time, or commit data. If PlanScan and rules disagree over the same source anchor, an enabled optional Qwen pack may select only between prevalidated drafts using exact quoted citations or withhold; its response explicitly has no mutation authority. Corrupt, missing, disabled, timed-out, or ungrounded model paths preserve deterministic rules and confirmation-only review.
- Phase 8 attests the complete installed model inventory at startup and runs manifest-bound golden planner, speaker, and document probes before enabling the learned paths. A failed role is disabled independently while deterministic rules, templates, and document parsing remain available.
- The 2026 model-improvement Phase 1 adds `AssistantPlan v2` plus a complete capability registry above CalendarIR. Every ordinary hybrid calendar parse now round-trips through this grounded multi-action contract, and existing batch requests assemble one ordered v2 plan before review. Registry entries explicitly separate assistant-ready, optional, app-only, and planned functions so a model cannot turn discovery into authority.
- Model-improvement Phase 2 adds typed per-conversation entity focus, last-query ranges, and pending clarifications. Model-improvement Phase 3 adds a conversation-first hierarchical router with recorded bounded rewrites, structure-preserving list handling, grounded colloquial CRUD aliases, and a date-scoped destructive guard before the same AssistantPlan/CalendarIR safety boundary.
- Model-improvement Phase 4 defines the RemindCore Next data boundary. The live registry supplies 42 user-expressible labels and documents four system-only outcomes; project semantic families, compounds, dialogue conditions, synthetic values, and noise operators own all supervision. A hash-pinned Qwen teacher may paraphrase one rotating family per capability, but exact marker, user-voice, semantic-cue, duplicate, provenance, split-family, and frozen-evaluation contamination gates decide what enters the corpus.
- Model-improvement Phase 5 makes the current review conversationally editable. Ordinals and grounded titles address visible proposal rows; deterministic field resolution plus a sequential dry run creates an immutable replacement preview, while invalid corrections preserve the original pending review. Batch narrowing, single-item collapse, confirmation, and one-step undo all reuse the existing transaction boundary without invoking Qwen for supported corrections.
- Model-improvement Phase 6 makes pending reviews queryable without confusing them with saved calendar state. Native grounded answers expose row counts, actions, dates, times, locations, notes, recurrence, and bounded conflict checks by visible position; ordinary saved-calendar questions still bypass the review. Broader local chat sees only a capped read-only review snapshot, while every change continues to require the existing deterministic proposal and confirmation boundary.
- Model-improvement Phase 7 freezes a second training-excluded end-to-end suite around generalized input and pending-review dialogue. The release gate validates exact proposal continuity or immutable replacement, universal no-write-before-receipt behavior, conflict and query isolation, noisy multi-item coverage, and a cross-platform service-latency ceiling in both rules-only and native-hybrid modes. The optional GGUF remains a separate hardware probe so its latency cannot mask native regressions.
- Model-improvement Phase 8 adds the independent human-language release boundary without manufacturing evidence. A versioned protocol and executable schema require consent, closed withdrawal, blind authorship, two-person annotation, synthetic facts, privacy review, 2,000 scenarios across at least 100 participants, and fixed capability slices. Freeze tooling audits exact and near contamination, strips collection identities, locks the model and source digests, and emits a hash-bound public suite. The strict evaluator refuses stale locks and applies separate human-generalization thresholds; the measured gate remains pending while the honest participant count is zero.
- The release runtime records offline CPU providers in a manifest-keyed local cache, enforces custom installed/working-table budgets, exposes release and database health in Settings, unloads idle speech workers, and destroys document workers after each job.
- SQLite opens through transactional migrations and `quick_check`. Recognized corruption preserves the database and WAL sidecars as timestamped recovery copies before a clean store opens; newer or unrelated schema errors fail closed. Delete-all requires an exact confirmation token and securely clears calendar, assistant, preference, notification, and undo data in one transaction.
- Platform packages are maximum-compressed ASAR applications with hardened Electron fuses. CI builds and audits native Windows x64, macOS x64/arm64, and Linux x64 layouts; tagged releases additionally require Windows signing and macOS signing/notarization credentials.

## Dependency direction

```text
contracts <- assistant-core <- calendar-engine <- storage <- desktop
                         fixture scripts ───────┘
contracts <- importers
contracts <- model-runtime <- desktop voice utility boundary / main-process original models
importers  <- desktop document worker/main boundary
ui        <- desktop
```

`contracts` must not import product, storage, or model-runtime code. This keeps schemas usable in the renderer, preload, main process, tests, data generation, and Python export tooling.

## Verification

`pnpm verify` regenerates and verifies ONNX parity graphs and first-launch probes; enforces artifact, quantization, safety, disk, and working-table budgets; checks all three original-model runtime gates; verifies the Phase 8 schema and sealed training boundary; prepares local document assets; then runs formatting, lint, strict TypeScript, tests, a production build, fixtures, and the network-offline Electron smoke. It does not pretend that an absent human collection passed. `pnpm package:audit` independently checks the native directory package, complete model inventory, optional-model worker and single target-native backend, ASAR-only layout, size ceiling, and absence of training/private files. See [release hardening](release-hardening.md), [RemindCore](remindcore.md), [RemindSpeak](remindspeak.md), [PlanScan](planscan.md), and [local document planning](local-document-planning.md).
