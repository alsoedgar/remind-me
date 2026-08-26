# ADR 0001: Local-first privacy boundary

- Status: Accepted
- Date: 2026-08-23

## Context

Calendar, reminder, conversation, audio, and document content is highly personal. The product also needs to work immediately without accounts or service dependencies.

## Decision

All core data and inference remain on the user’s device. Telemetry is off, required network traffic is zero, and the installer bundles the assets needed for core behavior. Optional external integrations must be isolated, explicit, and revocable.

## Consequences

- The application owns backup, migrations, export, deletion, and recovery.
- Installer size is larger than a cloud-wrapper application.
- Model capability is bounded by local storage and compute budgets.
- Offline tests become a release gate rather than a best-effort feature.
