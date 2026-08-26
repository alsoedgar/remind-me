# RemindCore Next model card

- **Status:** promoted
- **Version:** 0.3.0
- **Selected capacity:** 8192 hash buckets

The added student heads are project-owned, zero-initialized classifiers trained from scratch. Qwen supplied only deterministically curated wording; no Qwen weights, private user data, or conversation logs were used.

## Developer challenge

- Route accuracy: 90.4%
- First capability accuracy: 64.2%
- Exact ordered sequence accuracy: 52.6%
- Multi-action exact accuracy: 69.6%
- Selective routing precision/coverage: 100.0% / 10.9%

The challenge was evaluated in seven recorded engineering rounds while the generic multi-action decoder and runtime parity were corrected. It is not untouched or independently human-blind. The honest human-blind count remains zero until Phase 8. The model is advisory only and cannot resolve, confirm, execute, or persist an action.
