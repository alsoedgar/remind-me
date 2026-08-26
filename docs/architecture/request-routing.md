# Phase 3 hierarchical request routing

Phase 3 adds a deterministic router before RemindCore, Qwen, and `AssistantPlan v2`. Its job is narrow: preserve the structure and intent that already exists in the user’s message so the typed planners receive a useful request. It does not resolve dates, select database rows, construct mutations, or bypass review.

```text
raw turn
  -> conversation-first / explicit-memory classification
  -> bounded structural and colloquial repairs
  -> calendar-signal or broad-chat route
  -> deterministic parser + RemindCore agreement
  -> optional grounded Qwen translation when needed
  -> AssistantPlan v2 -> CalendarIR -> dry run -> review
```

## Why conversation is classified first

Calendar typo repair is intentionally aggressive around a small vocabulary. Applied too early, ordinary language can be distorted—for example, “hey there” previously became “hey where.” The router therefore classifies a complete raw conversational turn before calendar normalization. Mixed messages such as “hello, add lunch tomorrow” still continue to calendar planning because the conversational parser accepts only complete conversational turns.

## Recorded rewrites

Every rewrite returns its kind, before text, and after text in the route decision. The implemented set is bounded:

- Structured bullet/numbered lists retain separators and expand one explicit list header into explicit actions.
- A coordinated request can inherit a shared date when both sides carry their own time.
- “Get rid of” maps to delete only when the request names a calendar noun or a title already stored on device.
- “Push” maps to move only for a grounded target and explicit temporal destination.
- Accidental spacing around a next-item question maps to the existing brief next-item query.
- A date-bounded “what should I focus on … based on my calendar?” maps to the detailed local schedule summary for that same range.

Rewritten calendar text still enters the same source-grounded parser and plan boundary. The original user text remains on the conversation turn and proposal, while the canonical planning text is exact evidence for the parser stage.

## Destructive scope guard

A request such as “clear everything tomorrow” is not a global reset and is not silently treated as one. The scoped-clear guard identifies the date/range and any event/reminder scope, records a pending `unclear-scope` clarification, and leaves every item untouched. Whole-calendar deletion remains a separate exact-ID, counted, explicit-confirmation path.

## Native conversational floor

The small first-party conversational layer now includes bounded encouragement in addition to greetings, help, identity, architecture, local time, wellbeing, thanks, and goodbye. It is deliberately not presented as open-domain knowledge. Questions outside these grounded categories still go to the optional local language pack when installed or receive an honest local limitation.

## Verification

Router tests cover false-positive boundaries as well as successful rewrites, including non-calendar uses of “push” and “get rid of.” Service-level tests exercise shared-date and structured batches, colloquial move/delete previews, calendar reflection, encouragement, and the scoped destructive guard. The frozen 40-scenario Phase 0 suite is still training-excluded and is not described as independent human-blind data.
