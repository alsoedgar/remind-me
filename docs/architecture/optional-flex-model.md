# Optional flexible language pack

## Purpose

The required app remains useful, private, and fully offline with deterministic rules plus the bundled project-owned RemindCore and RemindSpeak models. RemindCore supplies confidence-gated calendar intent and source-copy evidence; RemindSpeak varies phrasing around already verified facts. Both were designed for this project, start from zero initialization, and import no pretrained weights. Their current v0.3 checkpoints retain explicitly audited Qwen teacher data for delexicalized wording or preference indices, but installed student inference remains independent of Qwen. They are the default product path, not adapters around the optional model.

The same locally installed pack may be used by developers as an offline teacher. That path receives protected synthetic prompts rather than personal calendars, has no student-weight access, and writes only raw proposal logs. Deterministic curation, disjoint challenge splits, original-test regression guards, and the native pipelines decide what affects RemindCore or RemindSpeak. This is data/preference distillation, separate from the optional runtime fallback described below.

Users who want more general conversation, harder paraphrases, and broader multi-intent language coverage may explicitly install `Qwen3-1.7B-Q4_K_M.gguf`. The 1.7B Q4_K_M quantization is a deliberate capability/footprint middle tier for consumer hardware. It requires substantially more disk, memory, and CPU time than RemindCore or RemindSpeak, so the app never treats it as required. The pack is not bundled and is never downloaded during startup, packaging, tests, or ordinary first-party-model use.

For calendar planning, the constrained system prompt defines supported operation meanings instead of relying on literal command verbs. It distinguishes creation, movement, rename/recurrence updates, duplication, deletion, reminder completion, and read queries; treats a greeting attached to a calendar request as part of that request; and requires every emitted source, title, and target to remain an exact request substring. Partial moves inherit the stored day, time, and duration when the user changes only one of them. A separate broad-language mode can answer general conversation from bounded recent turns, explicit user-approved profile data, and a text projection of verified local calendar context; it has no database handle and cannot claim that a write occurred.

The pinned artifact is 1,282,439,264 bytes with SHA-256 `d2387ca2dbfee2ffabce7120d3770dadca0b293052bc2f0e138fdc940d9bc7b5`. Qwen3 1.7B is Apache-2.0 licensed. Remind Me streams the Q4_K_M GGUF from the fixed `ggml-org` Hugging Face conversion to a `.part` file, enforces the maximum byte count while downloading, hashes every chunk, and renames it atomically only after the exact digest and length match. The renderer cannot supply a URL or filesystem path.

Primary upstream references:

- [Qwen3 1.7B official model repository](https://huggingface.co/Qwen/Qwen3-1.7B-GGUF)
- [Pinned Q4_K_M GGUF repository](https://huggingface.co/ggml-org/Qwen3-1.7B-GGUF)
- [node-llama-cpp](https://github.com/withcatai/node-llama-cpp)
- [llama.cpp grammar documentation](https://github.com/ggml-org/llama.cpp/blob/master/grammars/README.md)

## Isolation and resource policy

`node-llama-cpp` 3.20.0 is pinned with one native package per Windows/Linux architecture and Metal on Apple silicon. Packaging removes unrelated architecture binaries. Windows, Linux, and Intel macOS use the portable CPU path so an incomplete Vulkan/CUDA driver cannot terminate first-run inference; Apple silicon may use its bundled Metal backend. The runtime selects an automatic compact, balanced, or performance profile from available logical processors and live memory before a cold load. Every task receives a 4,096-token sequence; the performance tier spends the former 8K KV-token budget on two independent 4K sequences so planner and chat prefixes survive an alternating fallback. Lower tiers keep one shared sequence to avoid doubling cache memory.

Stable planner policy and examples now live in the planner system prefix instead of being resent as changing request text. Chat has a separate policy prefix. Grammar objects stay cached for the process lifetime, input sections are fitted against the real Qwen tokenizer, and the current message, verified calendar projection, recent turns, and approved profile compete within an explicit token budget rather than overflowing the context. Planner output receives a 220–640-token cap based on request length and action cues. Chat uses a 56-token cap for simple factual questions and up to 64, 80, 96, or 128 tokens according to request depth and the selected hardware profile. A capped response that reaches its limit is reduced to its last complete sentence when possible.

Inference runs in an Electron utility process and serializes one job at a time. Performance requests time out after 90 seconds; balanced and compact CPU requests retain a 120-second allowance. The mmap-backed runtime unloads after 90 seconds, five minutes, or ten minutes by tier, and all tiers shorten that window to at most 90 seconds under live memory pressure. The integrity stream uses 4 MiB reads but still performs the complete pinned SHA-256 check once per application run before first inference. Calendar-plan inference starts only after the compact parser cannot safely classify a request; broad-language inference is used only when the pack is installed and enabled. Killing that process releases model memory without affecting SQLite or the renderer.

Settings reports the selected backend, thread count, per-task context, cache policy, idle window, and last bounded request metrics. These values are observability only: the renderer cannot choose unsafe runtime parameters or pass model paths.

Settings exposes install progress, enabled state, cancellation, and removal. The downloaded weight and a one-boolean state file live under Electron's per-user data directory. Disabling unloads the process; removal deletes only the pinned model and partial-download paths. Calendar data is not touched.

## Authority boundary

The model is an optional language tier, not a calendar authority. Its mutation path is deliberately narrower than its conversational ability:

1. A generation grammar permits one to eight classified actions and nullable title/target excerpts.
2. Every `sourceText`, `titleText`, and `targetText` must be an exact contiguous substring of the original request. Invented or overlapping excerpts reject the entire result.
3. The existing deterministic parser reparses each excerpt with the bounded operation hint.
4. Existing entity retrieval, date/time/recurrence resolution, risk policy, and dry run must all succeed.
5. Multiple mutations become one review proposal, one SQLite transaction, and one undo record. Any invalid item prevents the complete batch from being staged.
6. The model never receives a database handle, mutation IPC, arbitrary file path, calendar-write method, or network tool. Its conversational output is text only and cannot commit or confirm a calendar action.

If installation, integrity verification, process startup, inference, JSON validation, grounding, or deterministic recompilation fails, Remind Me keeps the first-party/rules result or returns a focused clarification or honest local limitation. No partial model output is applied.

Broad phrasing is a coverage goal, not a promise that every sentence is unambiguous or that a 1.7B quantized model matches a hosted frontier model. The assistant asks a focused question when it cannot identify an item, date, time, recurrence scope, or destructive intent safely. The optional model can make the experience more flexible and personable, but it never receives direct calendar control and cannot bypass deterministic compilation, dry run, review, confirmation, or atomic execution.
