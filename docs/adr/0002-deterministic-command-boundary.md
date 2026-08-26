# ADR 0002: Deterministic command boundary

- Status: Accepted
- Date: 2026-08-23

## Context

Language models are useful for interpreting varied input and producing natural phrasing, but probabilistic date math or direct writes can silently corrupt a calendar.

## Decision

All inputs become versioned `CalendarIR.Draft`. Deterministic code validates, resolves, dry-runs, confirms, transacts, and records mutations. Models receive neither a database handle nor a privileged IPC method. Responses are built from verified `ResponsePlan` facts.

## Consequences

- Manual UI actions and assistant actions share undo and audit behavior.
- The model can be replaced or disabled without losing core calendar functionality.
- Schema versioning and fixture execution are required before model training.
- Ambiguous requests create focused questions instead of guessed writes.
