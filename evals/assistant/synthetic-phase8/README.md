# Phase 8 synthetic engineering proxy

This frozen proxy contains **2,000 deterministic, project-authored scenarios and 2,400 turns** for immediate local-assistant stress testing. It covers every Phase 8 capability category, including 200 out-of-domain scenarios, 260 noisy-language scenarios, multi-item writes, modifications, destructive boundaries, grounded queries, contextual follow-ups, memory, conversation, and fallback targets.

It is intentionally machine-labeled `syntheticEngineeringProxy: true`, `humanEvidence: false`, and `independentHumanBlind: false`. It temporarily fills the engineering-data gap; it does not represent 100 participants, consent, annotator agreement, or independent generalization. The real human-study counter remains 0/2,000 scenarios from 0/100 participants.

## Commands

```powershell
pnpm eval:assistant:synthetic-phase8:generate
pnpm eval:assistant:synthetic-phase8:check
pnpm eval:assistant:synthetic-phase8:evaluate
pnpm eval:assistant:synthetic-phase8:gate
```

`generate` deterministically rebuilds the JSONL suite and hash-bound manifest. `check` fails if either artifact differs from the generator. `evaluate` executes the real isolated assistant service against the proxy without reading or changing the user's calendar database. `gate` additionally enforces the frozen regression thresholds.

Every row is `trainingExcluded: true`. The suite is suitable for regression discovery, performance measurement, and implementation work, but it must not be reported as a participant study.

## Current engineering result

On August 28, 2026, the enforced proxy gate passed in both service modes: 100.0% scenario pass and 96.6% clear in-domain answered, with 16.6 ms rules-only p95 and 43.9 ms native-hybrid p95 on the verification machine. The fast gate does not load the optional Qwen GGUF; its out-of-domain rows allow either a local fallback answer or the native assistant's explicit unsupported response.
