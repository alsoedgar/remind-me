# Phase 8 human-blind evaluation

This directory contains the public protocol and executable collection schema for the independent human-language gate. It intentionally contains no participant records. Current collection status: **0 of 2,000 scenarios and 0 of 100 participants**.

For engineering work while recruitment is pending, the repository also ships a separate [2,000-scenario synthetic proxy](../synthetic-phase8/README.md). Its manifest is machine-labeled as project-authored and non-human, so it cannot increment this directory's participant counters or satisfy the independent gate.

The private JSONL file belongs at `collection.local.jsonl`. Git ignores it. Each line must validate against `collection-record.schema.json`; the TypeScript validator adds cross-record, cross-field, privacy, coverage, consent-window, and contamination checks that JSON Schema cannot express.

## Commands

```powershell
pnpm eval:assistant:human-blind:status
pnpm eval:assistant:human-blind:schema:check
pnpm eval:assistant:human-blind:validate
pnpm eval:assistant:human-blind:boundary
pnpm eval:assistant:human-blind:freeze -- --version=8.0.0
pnpm eval:assistant:human-blind:gate -- --suite=evals/assistant/human-blind/releases/v8.0.0/scenarios.jsonl --manifest=evals/assistant/human-blind/releases/v8.0.0/manifest.json
```

`status` succeeds when collection has not started so normal development can report the honest state. `validate` fails until every Phase 8 minimum and protection is satisfied. `freeze` refuses partial data, paths outside the dedicated release directory, and accidental overwrite. It publishes only scenario state, turns, and semantic expectations; participant, consent, and annotator identifiers remain private.

The gate requires the hash-bound release manifest, all 2,000 scenarios, user-reported provenance, the unchanged model lock and model artifacts, unchanged contamination sources, and a fresh repeat of the coverage and language-separation audits. It evaluates both rules-only and native-hybrid paths. It requires at least 90% overall scenario accuracy and 99% in-domain answered; 95% single-action, mutation, query, ambiguity, and out-of-domain handling; 90% multi-action, multi-turn, conversation, memory, and open-dialogue; and 100% bulk and safety accuracy. Every applicable safe preview, no-write safety assertion, and protected structured/text/calendar fact must pass. Each service mode's p95 must stay within 100 ms.

Do not show participants the schema's scenario examples, earlier suites, model replies, training templates, or expected parser language. Follow `protocol-v1.md` before collecting anything.
