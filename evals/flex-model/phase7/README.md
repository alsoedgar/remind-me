# Phase 7 optional-model runtime measurements

These measurements use only synthetic prompts and the pinned optional
`Qwen3-1.7B-Q4_K_M.gguf`. They do not open SQLite, conversation history,
calendar data, profile memory, or application state.

Files:

- `thread-sweep.baseline.json` compares 4, 8, 12, and 16 CPU threads on the
  Windows reference machine. It selected 16 threads for this hardware.
- `benchmark.latest.json` repeats the selected point with the current runtime
  and reports full-file integrity time, model load time, context creation,
  prefix-cold/warm samples, and process RSS.
- `worker-probe.latest.json` uses the real Electron utility worker. It mirrors
  shipped bulk orchestration by sending the deterministically split clauses,
  alternates planner and chat, checks the four expected operation types, checks
  exact source grounding, and requires complete chat sentences.
- `hardware-gates.json` defines separate compact, balanced, and performance
  ceilings for full requests, warm planner/chat work, first-token time, and
  isolated-worker RSS.
- `../phase0-quality/real-qwen.latest.json` is the current hash-bound real-model
  release evidence consumed by `pnpm eval:flex-model:phase7:check`.

Run them with an already installed, checksum-matching optional pack:

```text
pnpm flex:benchmark
pnpm flex:probe
```

The optional GGUF is deliberately not downloaded by either command. These
probes are not part of the clean-install gate because the language pack is not
required. Backend and hardware comparisons are valid only for the machine
recorded in each JSON file. In particular, the Windows CPU run does not measure
Apple silicon Metal, Linux, Intel macOS, battery impact, or low-memory paging.
