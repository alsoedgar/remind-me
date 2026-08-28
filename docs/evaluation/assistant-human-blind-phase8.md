# Assistant human-language Phase 8

## Outcome

The immediate engineering substitute is complete: the repository now includes a frozen, deterministic **2,000-scenario synthetic proxy with 2,400 turns** across every Phase 8 category, including 200 out-of-domain and 260 noisy-language scenarios. Its manifest explicitly records `syntheticEngineeringProxy: true`, `humanEvidence: false`, and `independentHumanBlind: false`.

The independent human-language workflow remains implemented and machine-enforced, but the participant study itself is still pending at **0 of 2,000 required scenarios from 0 of 100 required participants**. No human-generalization score is claimed from the synthetic proxy.

The synthetic proxy gate currently passes in both rules-only and native-hybrid modes at 100.0% scenario accuracy and 96.6% clear in-domain answered. On the August 28, 2026 verification machine, service p95 was 16.6 ms and 43.9 ms respectively. These are engineering-regression results, not a population estimate; the fast suite also excludes optional GGUF inference.

This distinction is intentional. Generated Qwen paraphrases, developer challenges, user-reported bugs that already influenced implementation, and prior regression suites are valuable engineering data but cannot become independent evidence by relabeling them.

## Implemented release boundary

- A versioned collection protocol covers consent, withdrawal, privacy, participant blindness, role separation, annotation timing, publication, and reuse limits.
- The executable record schema accepts only consented public-release wording built around synthetic calendar facts, with participant-authored language and two-to-five distinct non-participant annotators in consensus before model output.
- Collection validation enforces 2,000 scenarios, 100 participants, a 40-scenario contribution cap, 200 out-of-domain cases, 200 noisy-language cases, and minimum counts across all eleven capability categories.
- An obvious-PII scan, internal duplicate audit, and exact plus token-Jaccard contamination audit run before freezing. The audit covers frozen suites, assistant corpora, accepted teacher surfaces, all deterministically regenerated original RemindCore splits, and language-facing assistant tests.
- Training and teacher source code are checked for references to the sealed collection or release path.
- Freezing is restricted to `evals/assistant/human-blind/releases/`, refuses accidental overwrite, strips participant/consent/annotator metadata, and binds the raw collection, protocol, model inventory, contamination sources, public suite, count, and timestamp by SHA-256.
- Scoring rechecks every public binding, requires all 2,000 rows to remain `user-reported` and `trainingExcluded`, and forbids selected-case scoring under the release gate.

## Passing thresholds

Both rules-only and native-hybrid modes must reach at least 90% total scenario accuracy and answer 99% of clear in-domain turns. Single-action, mutation, query, ambiguity, and out-of-domain handling must reach 95%; multi-action, multi-turn, conversation, memory, and open-dialogue must reach 90%; bulk and safety scenarios must reach 100%. Every no-write safety assertion, protected structured/text/calendar fact, and applicable safe preview must pass. Native service p95 must remain at or below 100 ms on the recorded evaluation environment.

These thresholds do not give a model direct calendar authority. Every mutation still passes through typed planning, deterministic time and target resolution, visible review, confirmation, one transaction, receipt, and undo.

## Honest current status

`pnpm eval:assistant:synthetic-phase8:check` verifies the 2,000-case engineering proxy and its generator binding. `pnpm eval:assistant:synthetic-phase8:evaluate` runs it through the isolated real assistant service. `pnpm eval:assistant:human-blind:status` reports both the available synthetic proxy and the missing private participant collection without conflating them. `validate` and the independent Phase 8 scoring gate still fail until real consented data satisfies the protocol.

Once a frozen release has been scored and its failures influence model or rule changes, it becomes a regression suite. A later production claim requires a newly collected untouched human release.
