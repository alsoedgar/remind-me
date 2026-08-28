# Contract reference — version 0.1

## CalendarIR lifecycle

`CalendarIR.Draft` is safe model output. It preserves semantic temporal anchors, source spans, evidence, references, ambiguity, confidence, risk, and intended mutation scope.

`CalendarIR.Resolved` is produced only by deterministic code. It contains resolved instants, validated target IDs, normalized recurrence, and a confirmation requirement. Only resolved commands may reach dry-run or transaction code.

The version is carried in every draft, resolved command, response plan, fixture, model manifest entry, and stored action. Contract migrations must be explicit.

## AssistantPlan v2

`AssistantPlan v2` is the domain-level orchestration contract above CalendarIR. It can carry one to fifty ordered actions, typed targets and argument families, exact evidence references, backward-only dependencies, risk/review policies, planner provenance, and a bounded response goal. CalendarIR remains the deterministic execution contract for calendar handlers.

The capability registry distinguishes `assistant-ready`, optional `conditional`, existing `app-ready`, and unimplemented `planned` surfaces. A capability being present in the registry never grants authority: only assistant-ready plans with matching target and argument families pass the executable guard. See [AssistantPlan v2 and capability registry](assistant-plan-v2.md).

## Operations

| Family    | Operations                                                                        |
| --------- | --------------------------------------------------------------------------------- |
| Events    | `event.create`, `event.update`, `event.move`, `event.delete`                      |
| Reminders | `reminder.create`, `reminder.update`, `reminder.complete`, `reminder.delete`      |
| Queries   | `calendar.list`, `calendar.search`, `calendar.availability`, `calendar.conflicts` |
| Safety    | `assistant.clarify`, `assistant.reject`, `assistant.unsupported`                  |
| Imports   | `import.propose`                                                                  |

Mutation scope is one of `single`, `occurrence`, `future`, or `series`.

## Temporal expressions

The Phase 0 schema supports:

- Absolute local dates.
- Relative-day offsets.
- `this` and `next` weekday anchors.
- A verbatim escape form that must clarify or fail deterministic resolution.
- Timed windows, all-day dates, and inclusive all-day date ranges.
- An explicit IANA timezone or the user’s local default.

The model does not emit UTC values. Phase 1 added IANA transition handling and wall-time recurrence instances behind this contract. Phase 2 adds a deterministic English parser for common expressions while deterministic code continues to own final instants.

Phase 3 treats ASR output as editable text evidence, never as resolved calendar facts. Transcript normalization joins common split time forms and converts spoken clock phrases before the same Phase 2 parser runs; the model still cannot emit executable UTC values or bypass review.

## Risk and disposition

| Condition                                                    | Disposition |
| ------------------------------------------------------------ | ----------- |
| Read-only calendar query                                     | Answer      |
| Clear low/medium-risk mutation                               | Preview     |
| Delete, high/destructive risk, future scope, or series scope | Confirm     |
| Any recorded ambiguity                                       | Clarify     |
| Rejected or unsupported request                              | Reject      |

Confidence can make a policy stricter, never less strict than the operation/scope rule.

## ResponsePlan

Every natural reply is grounded in a verified plan containing:

- One of 18 protected speech acts, including distinct conversation, memory,
  empty-schedule, next-item, detail, undo, and rejected-proposal paths.
- Protected fact placeholders and their rendered values.
- Evidence links.
- Bounded style controls.
- A guaranteed template fallback.
- Recent reply fingerprints for novelty reranking.

The schema requires unique placeholders and exact placeholder presence in the fallback. RemindSpeak and the independent renderer boundary require the exact placeholder set, one occurrence per fact, and no unprotected numeric or date literal before verified values are inserted. Invalid model candidates fall back to the plan's grounded template.

## Optional-model chat envelope

Optional Qwen conversation returns one strict envelope kind: `answer`, `clarification`, `offline-limit`, or `refusal`. Each envelope contains text, a bounded list of calendar fact references, and a non-authoritative write-claim flag. Calendar references pair a request-local `F1`–`F24` label with an exact stable fact ID and one or more declared fields.

The associated fact packet contains occurrence-level fact IDs, stable entity IDs, kind, retrieval priority, provenance, occurrence time, and nullable display fields. Packet refs and referenced field names must be unique. The storage boundary resolves placeholders only after schema, ID, field, literal, and write-claim validation; model text never supplies related entity IDs or executable actions.

## IPC

The registry defines request and response schemas for:

- `app:get-info`
- `preferences:get`
- `preferences:update`
- `calendar:get-snapshot`
- `calendar:check-availability`
- `event:save` and `event:delete`
- `reminder:save`, `reminder:complete`, and `reminder:delete`
- `history:undo`
- `data:export` and `data:import`
- `data:delete-all`
- `assistant:get-conversation`
- `assistant:feedback` for bounded, fact-free local phrase ranking
- `assistant:send`
- `assistant:stream` for typed queue/status and cumulative response chunks
- `assistant:cancel`
- `assistant:confirm`
- `assistant:reject`
- `assistant:clear`
- `flex-model:get-status`
- `flex-model:install`, `flex-model:cancel`, and `flex-model:remove`
- `flex-model:set-enabled` and `flex-model:configure`
- `flex-model:progress`
- `voice:get-info`
- `voice:warm`
- `voice:transcribe`
- `voice:cancel`
- `voice:progress`
- `document:select`
- `document:commit`
- `document:discard`
- `document:repair`
- `document:fallback`
- `assistant:interpret`
- `calendar:dry-run`

`app:get-info` includes strict release-attestation and database-runtime status. It reports verified artifact counts, golden-probe results, provider/fallback choices, custom installed and working-table bytes, manifest identity, SQLite schema version, integrity result, and whether a recovery copy was created. It never exposes a user path, model feature, conversation, or calendar value.

`data:delete-all` requires the literal confirmation token `DELETE` and a bounded replacement snapshot range. The main process clears every persisted user-data class in one non-undoable transaction, reseeds only the default local calendar and preferences, removes recognized recovery database sidecars, reschedules notifications, and returns deleted row/file counts plus an empty snapshot. The confirmation contract cannot be bypassed by the renderer.

Phase 2 exposes the conversation and assistant orchestration channels through the same frozen preload bridge. Phase 6 adds typed queue-state events, cumulative bounded response chunks, and cancellation by opaque stream ID. The optional-model configuration contract exposes only bounded warmth and acceleration preferences; backend selection remains constrained to verified packaged artifacts. `assistant:interpret` and `calendar:dry-run` remain lower-level reserved channels: the renderer intentionally receives only the safe orchestration API and cannot bypass review. Every implemented handler validates the sender frame plus request and response payloads; SQLite and filesystem APIs never enter the renderer.

The Phase 3 voice contract accepts only mono 16 kHz Float32 PCM, caps recordings at 30 seconds/1.92 MB, identifies every job, and bounds progress/result fields. Microphone access is limited to audio-only requests from the trusted application renderer. The bridge exposes status, warm-up, transcription, cancellation, and scoped progress subscription—never a worker handle or filesystem path.

## Document planning

The Phase 5 document contract bounds sources to 25 MiB, PDFs to 20 pages, decoded images to 25 megapixels, extraction to 12,000 words/200,000 characters, and reviews to 50 drafts. A `DocumentSelection` contains opaque source metadata and an `ArrayBuffer`, never a path. Source metadata is strict, digest-backed, and limited to PDF/PNG/JPEG/WebP media types.

`DocumentExtraction` preserves page dimensions, rotation, extraction method, a private navigation thumbnail, an optional bounded high-resolution review image, positioned words, line blocks, confidence, and normalized bounding boxes. Each editable `DocumentImportDraft` carries field-specific evidence links and source confidence into those blocks. `DocumentAnalysis` separately carries identifiable skipped rows with their page, category, reason, confidence, and resolvable evidence IDs. Progress stages and page counters are bounded before entering React; review pixels and extracted prose never enter the commit contract.

Phase 7 optionally attaches a strict `PlanScanAnalysis` to that extraction. It contains block/entity predictions, exact source spans, spatial relations, linked plan groups, document type, bounded confidence, processing duration, and warnings. Contract refinement proves that every prediction references an existing block, every span is an exact source substring, every relation references existing blocks, and every group field references evidence on the same extraction. The model may link evidence but may not repair OCR, synthesize text, resolve calendar time, or produce a committed command.

Phase 6 parser repair is a separate, optional contract. A `DocumentRepairRequest` exists only for a bounded PlanScan/rules disagreement over one exact source anchor. Each supplied candidate resolves to a prevalidated local draft and carries exact title/date plus any printed time citations. The model output can select one supplied candidate ID or withhold; validation rejects unknown IDs, changed spans, missing required roles, duplicate decisions, or source-selection mismatches. `DocumentRepairResponse` fixes the model identity and requires `hasMutationAuthority: false`. Applying a valid response can only replace an in-memory review draft with its registered alternative; it cannot call `document:commit` or construct a new form.

`DocumentFallbackRequest` covers a different failure mode: extracted source evidence that neither PlanScan nor rules grouped into a draft. It binds one live selection digest to one page and at most 18 compact block projections, including geometry, OCR confidence, and whether each block is already claimed. `DocumentFallbackModelOutput` contains one to eight groups made only of title/date/time/location/recurrence/description block IDs; it has no natural-language values or mutation operations. `DocumentFallbackResponse` pins Qwen3 1.7B Q4, echoes the request/page, and fixes `hasMutationAuthority: false`. Importer validation rejects unknown or repeated IDs, claimed date/time cores, missing explicit date/fixed-time evidence, no-fixed-time rows, and malformed role assignments before deterministic planning may create an in-memory review draft.

`document:select` opens the native picker and validates file bytes in main. `document:discard` expires the opaque review. `document:commit` accepts only selected, editable event/reminder forms tied to a live selection ID. Each item carries a digest-bound stable source-row ID plus optional class schedule metadata; duplicate source rows in one request are rejected, and main verifies every digest against the still-live selection before storage runs. The storage service validates the entire batch and returns the ordinary `CalendarMutationResult` with one undo receipt.

Each draft also carries a strict semantic import identity and a reconciliation result. Class identities include course, section/CRN, component, weekdays/time, and term; general event and reminder identities use canonical local date/time fields. Reconciliation distinguishes a previously imported source row, a likely semantic duplicate, and a protected distinct class. SQLite persists only the digest/row identity, semantic key, and bounded identity metadata beside the resulting entity. Source bytes, paths, thumbnails, extracted prose, and evidence boxes remain absent from the commit and storage contracts.
