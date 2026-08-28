# RemindCore Next

RemindCore Next is the scratch-trained understanding extension for the
always-installed planner. Version 0.4 learns nine bounded tasks from the
AssistantPlan corpus: coarse route, ordered capability clauses, action count,
whether a turn needs dialogue context, follow-up versus new-topic relation,
requested calendar attribute, one/plural/all scope, ordinal/subset selection,
and calendar-read/calendar-write/conversation/memory/unclear turn kind.

The student starts from zero-valued project-owned HashFrame tables. Qwen weights
are never imported. Accepted Qwen data contributes surface wording only, while
project code owns labels, slots, capability metadata, review policy, feature
encoding, training, calibration, quantization, and promotion gates.

The shared capability head is evaluated once per deterministically segmented
clause, so a three-action turn does not require three separate classifier
tables. The promoted INT8 extension is advisory: it may help a broad-looking
turn enter the existing calendar parser/fallback path, but it cannot create an
AssistantPlan, resolve CalendarIR, skip review, or write SQLite.

The promoted profile uses 4,096 buckets, project signals, typed context, and no
character n-grams. A conservative structural decoder overrides the learned
action count only for explicit action transitions, paired reminder clauses, or
multi-time create lists. This raised developer multi-action exactness without
treating every conjunction as a separate action.

The deterministic corpus now contains 1,033 rows, including 193 contextual
rows and 42 explicit topic switches. Project programs own all five new target
families. Existing accepted Qwen paraphrases contribute wording only and pass
the same marker, cue, duplicate, split, and evaluation-contamination checks.

Run `pnpm remindcore-next:train` to prepare registry metadata, train development
ablations, evaluate the developer challenge, export INT8/ONNX parity artifacts,
and promote only if every configured gate passes. The challenge was used over
seven recorded engineering iterations during Phase 5; it is no longer an
untouched or human-blind set. The independent human-blind count remains zero.
