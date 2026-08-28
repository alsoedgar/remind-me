# Contextual Phase 7 release suite

This release suite preserves every request from the frozen Phase 0 contextual regression corpus
byte-for-byte and adds expected seed indexes for every grounded result turn. The evaluator resolves
those indexes to the randomly generated database IDs for each run, so one, multiple, all, ordinal,
and subset answers must return the exact referent IDs—not merely enough IDs or matching prose.

The gate requires 100% exact referent accuracy, 100% calendar-fact grounding, at least 95%
contextual follow-up accuracy, at least 99% benign resolution, and native p95 below 100 ms in both
rules-only and project-owned native-hybrid modes.

This is a deterministic, training-excluded engineering suite. It is not independent human-blind
evidence and does not change the human-study count.

```powershell
pnpm eval:assistant:contextual-phase7:generate
pnpm eval:assistant:contextual-phase7:check
pnpm eval:assistant:contextual-phase7:gate
```
