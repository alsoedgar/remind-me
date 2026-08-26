# Original model workspace

Training code remains separate from the shipped Electron runtime. Python is a development-only dependency and will never be required to run the desktop application.

Model tracks:

- `remindcore/` — implemented compact scratch semantic planner that supplies constrained `CalendarIR.Draft` hints.
- `remindspeak/` — implemented scratch PhraseLattice response generator over verified `ResponsePlan` values.
- `planscan/` — layout-aware extraction model over document words and bounding boxes.
- `assistant_corpus/` — registry-derived, split-isolated AssistantPlan v2 corpus for the next RemindCore experiment.
- `shared/` — tokenization, dataset provenance, export, quantization, and evaluation utilities.

RemindCore, RemindSpeak, and PlanScan use project-owned architectures and zero-initialized training against contract `0.1`; see their model cards and reports. PlanScan remains fully program-trained and combines hashed text/layout features with learned block, entity, relation, group, document-type, and confidence heads. RemindCore and RemindSpeak version 0.2 additionally use the explicitly labeled `teacher_assisted/` lab: a locally installed, hash-pinned Qwen3 1.7B model proposes delexicalized surfaces or ranks protected project-authored candidates, after which deterministic filters and non-regression gates decide what may influence training. No Qwen weights, personal calendar data, or free-generated Qwen reply text enter the student artifacts. Only compact local artifacts may ship.

Model-improvement Phase 4 adds `assistant_corpus/` without changing the installed weights. It covers all 42 user-expressible registry capabilities through project-owned semantic programs, labels, values, multi-action/context structure, and noise, with 36 selectively accepted Qwen surface paraphrases. The frozen evaluation suite is used only to reject collisions, and the independent human-blind path remains unread.

Model-improvement Phase 5 adds `remindcore_next/` and promotes RemindCore v0.3.
Four new zero-initialized heads learn route, shared per-clause capability,
action count, and typed-context need over the Phase 4 contract. A second
training-only Qwen surface pass contributed 73 accepted templates and 219
project-materialized examples after deterministic curation; it contributed no
labels, facts, slots, weights, or runtime dependency. The 8,192-bucket INT8
extension remains advisory and leaves CalendarIR resolution, review, execution,
and storage with project code. The developer challenge was used in seven
recorded engineering rounds and is not presented as untouched or human-blind.

## Phase 8 parity export

`python ml/export_onnx.py export` builds one ONNX score-kernel graph per project-trained model directly from the committed quantized artifacts. The graphs gather hashed feature buckets, dequantize per output channel, normalize by feature count, and add the trained bias/temperature. Export checks each graph with the official ONNX checker and evaluates representative inputs with ONNX's reference evaluator against the same NumPy calculation before updating `models/manifest.json`.

`python ml/export_onnx.py check` is read-only: it validates graph structure, embedded metadata, manifest sizes, and SHA-256 digests. ONNX is a development/release dependency only; installed inference remains the smaller dependency-free TypeScript INT8 implementation so users do not install Python or an ONNX runtime.
