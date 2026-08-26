# AssistantPlan v2 training corpus

This directory is the model-improvement Phase 4 data boundary for the next
RemindCore training experiment. It expands the older single-operation teacher
lab to the complete user-facing `AssistantPlan v2` vocabulary while keeping
calendar facts and labels project-owned.

The deterministic preparation step derives its inventory from the live
46-capability registry. Four capabilities are system outcomes rather than user
intents (`calendar.import.propose`, `assistant.clarify`, `assistant.reject`, and
`assistant.unsupported`), so the corpus documents and excludes them. The
remaining 42 capabilities each receive three disjoint semantic families: one
for training, one for development, and one for challenge evaluation.

Qwen is an untrusted development-time paraphrase teacher. It sees only a
project-authored meaning, a delexicalized seed, and protected markers such as
`<TITLE>` and `<DATE>`. It cannot choose a capability, create a slot value,
resolve a date, select an event ID, set review policy, or write calendar data.
Deterministic curation rejects altered marker signatures, missing intent cues,
assistant-style answers, duplicates, unprotected specifics, and exact or near
collisions with the frozen assistant evaluation suite.

The materializer adds only project-authored synthetic values and records exact
slot spans. It also creates:

- ordered two- and three-action programs;
- context-dependent pronoun, ordinal, and clarification turns;
- deterministic typo, accidental-spacing, ASR, and punctuation variants; and
- registry-derived execution and confirmation labels.

The promoted Phase 4 corpus contains 126 project seeds plus 36 accepted Qwen
paraphrases covering 34 capabilities. After value/noise materialization and
exact de-duplication it has 772 rows: 280 train, 199 development, and 293
challenge. Every split covers all 42 direct capabilities; 70 rows contain two
or three ordered actions, 37 require dialogue state, and 28 are hard
calendar-adjacent negatives. Curation rejected 32 raw candidates and admitted
zero frozen-evaluation collisions.

Template families never cross train/development/challenge splits. The frozen
Phase 0 suite is used only as a contamination rejection set and is never shown
to Qwen. A local human-blind file is never read; the manifest truthfully records
zero human-blind training examples.

Run from the workspace root:

```powershell
pnpm assistant-corpus:prepare
pnpm assistant-corpus:generate
pnpm assistant-corpus:curate
pnpm assistant-corpus:check
```

Generation uses the already installed, exact-hash Qwen pack and checkpoints
after each local batch. It does not download a model. `accepted/templates.json`
and `data/*.jsonl` are the only Phase 5 inputs; raw teacher output is retained
for auditability, never treated as a training corpus directly.

This is synthetic-data distillation, not Qwen weight copying. A future student
checkpoint using these rows must be described as project-owned,
zero-initialized, and Qwen-assisted. Corpus challenge results remain developer
diagnostics, not evidence of independent human generalization.
