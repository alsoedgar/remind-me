# ADR 0009: Attest installed models and degrade by role

## Status

Accepted for Phase 8.

## Context

Hashing files during a build does not prove that the installed copy is complete, compatible, or numerically usable on a user's machine. Treating model initialization as all-or-nothing would also make a damaged response or document model prevent access to otherwise valid calendar data.

## Decision

At application startup, verify the installed manifest and every required artifact by byte length and SHA-256, then execute small manifest-bound predictions through each original runtime. Enable RemindCore, RemindSpeak, and PlanScan independently only when both integrity and behavioral probes pass. Preserve deterministic rules/templates for every learned role and retain CPU as the universal execution provider.

Cache provider selection only by manifest digest. Report attestation, fallback, model budgets, and SQLite health through a strict read-only application-info contract. Never repair a model through a runtime network request.

## Consequences

- A corrupt or incompatible learned artifact cannot silently influence calendar interpretation or wording.
- Calendar access survives a failure in an optional model role.
- Startup performs bounded hashing and probe work; subsequent provider selection can reuse a manifest-keyed cache.
- Golden probes detect packaging/runtime drift, not broad real-world accuracy, so corpus evaluation and safety gates remain necessary.
- More accelerator providers can be added only after they reproduce the role probes and preserve CPU fallback.
