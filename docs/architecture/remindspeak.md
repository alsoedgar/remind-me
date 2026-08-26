# RemindSpeak grounded response generation

RemindSpeak is the project-owned, zero-initialized native path for making replies warmer and less repetitive without allowing generated text to become calendar truth. Version 0.3 is a bounded PhraseLattice model, not a repackaged LLM, adapter, or call to the optional foundation model. It selectively learns from Qwen preference rankings over protected project-authored candidates while importing neither Qwen weights nor prose.

## Protected generation boundary

Calendar replies contain brittle names, counts, times, dates, statuses, and locations. RemindSpeak therefore chooses only the wording around values already present in a verified `ResponsePlan`.

```text
verified ResponsePlan
  -> one of 18 protected speech acts + exact fact signature + style
  -> zero-initialized lead/body/close INT8 heads
  -> 175–350 compatible project-authored compositions
  -> exact placeholder and static-literal validation
  -> style, novelty, and bounded private-preference reranking
  -> deterministic insertion of verified fact values
  -> final response

any failure -------------------------------------------> grounded template fallback
```

The model never sees SQLite and cannot construct a `ResponsePlan`. A candidate is eligible only when its speech act and placeholder signature match, every required placeholder occurs exactly once, no unknown placeholder exists, static text introduces no numeric or date literal, and the rendered reply is not an exact recent response. The renderer independently repeats those checks before inserting fact values.

The 18 acts distinguish proposals, four kinds of mutation receipt, availability, schedule summaries, next items, item details, empty schedules, ordinary conversation, approved memory, undo, rejected proposals, clarification, conflicts, unsupported requests, and errors. This prevents a greeting, memory answer, or undo from borrowing misleading schedule-summary wording.

## Model and data

Version 0.3 has 28,311,984 logical parameters across three sparse INT8 heads and 65,536 deterministic feature buckets. The lead/body/close inventories contain 90, 252, and 90 options. The 28,311,552-byte table occupies 27.0 MiB when decompressed; the JSON plus reproducibly gzipped weights occupy 223,187 bytes because structured examples activate only a small fraction of the logical table. The compression ratio is disclosed rather than treating sparse logical capacity as dense learned information.

`ml/remindspeak/pipeline.py` creates a 40,000-example program-generated base corpus across all 18 acts, then adds 1,650 replay rows from 55 accepted Qwen rankings over already-valid candidates. Eleven disjoint preference cases remain challenge-only. All 432 surface atoms and 20 style profiles are project-authored. Qwen-authored prose, pretrained weights, personal calendars, and conversation logs remain excluded. The pipeline now checks accuracy, quantization, act coverage, inventory size, memory, compressed size, teacher presence, and data provenance before overwriting the installed artifact.

## Private local adaptation

The response-style dials remain the primary control. Optional helpful/not-quite feedback adds a second, deliberately narrow signal:

- only the selected placeholder template's eight-character fingerprint, speech act, integer score, and update time are stored;
- at most 64 entries are retained, with scores clamped from -3 through 3;
- ranking bias is capped and cannot change candidate eligibility;
- reply text, placeholder values, prompts, calendar facts, and model reasoning are not stored;
- users can disable or erase the learned ranking in Settings.

The adaptation can change which safe phrase is chosen. It cannot change an answer, action, date, recurrence, target, confirmation policy, or database write.

## Measured checkpoint

The generated 5,000-example test split reaches 75.66% mean INT8 head accuracy. Quantization reduces the strongest head by 0.04 percentage points. Protected-fact retention and schema-valid candidate rates remain 100%, and unsupported static factual-literal introduction remains zero.

The tracked 250-example TypeScript fixture reports 43.6% exact top-reference selection, 83.2% reference coverage among five candidates, zero recent exact repeats, and about 8 ms warm p95 on the latest development-machine run. Exact current results live in `ml/remindspeak/reports/`.

These are generated-data and reviewed-inventory measurements, not proof of broad human-language quality. The repository includes a 24-case within-subject randomized blinded A/B study, browser runner, sealed source key, validator, scorer, and prespecified promotion gate. The current report is `awaiting-participants`; zero human judgments means zero claimed human preference result. Broader dialect, accessibility, cultural-tone, locale, and independent release evaluation remain open.

## Reproduction and study

```bash
python ml/remindspeak/pipeline.py all
pnpm models:onnx:export
pnpm remindspeak:check
pnpm remindspeak:study:prepare
pnpm remindspeak:study:score
```

Installed users need neither Python nor a network connection. Electron loads the bundled gzip artifact and runs the TypeScript INT8 kernel on Windows, macOS, and Linux. Artifact metadata is version `0.3.0`; the `remindspeak-v0.1-*` filenames remain compatibility names.
