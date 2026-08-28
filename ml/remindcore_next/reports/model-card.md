# RemindCore Next model card

**Status:** promoted
**Version:** 0.4.0
**Selected capacity:** 4096 hash buckets

The added student heads are project-owned, zero-initialized classifiers trained from scratch. Qwen supplied only deterministically curated wording; no Qwen weights, private user data, or conversation logs were used.

## Developer challenge

- Route accuracy: 89.5%
- First capability accuracy: 60.3%
- Exact ordered sequence accuracy: 51.0%
- Multi-action exact accuracy: 60.7%
- Selective routing precision/coverage: 100.0% / 15.4%
- Dialogue relation accuracy: 95.9%
- Requested attribute accuracy: 87.2%
- Scope accuracy: 97.2%
- Selection accuracy: 93.6%
- Turn-kind accuracy: 85.9%

The challenge was evaluated in 7 recorded engineering rounds while the generic multi-action decoder and runtime parity were corrected. It is not untouched or independently human-blind. The honest human-blind count remains zero until Phase 8. The model is advisory only and cannot resolve, confirm, execute, or persist an action.
