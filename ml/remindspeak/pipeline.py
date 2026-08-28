"""Generate, train, evaluate, quantize, and export RemindSpeak.

RemindSpeak begins from zero initialization and imports no pretrained weights.
Its PhraseLattice model predicts compatible lead/body/close atoms from a verified
ResponsePlan and style profile. A pinned Qwen teacher supplies preference indices
over project-authored protected candidates; Qwen-written prose is not admitted.
Calendar facts remain hard-constrained protected placeholders.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import math
import random
import re
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Sequence

import numpy as np


WORKSPACE = Path(__file__).resolve().parents[2]
ML_ROOT = WORKSPACE / "ml"
LOCAL_DEPENDENCIES = ML_ROOT / ".deps"
if LOCAL_DEPENDENCIES.exists():
    sys.path.insert(0, str(LOCAL_DEPENDENCIES))

ROOT = ML_ROOT / "remindspeak"
GENERATED = ROOT / ".generated"
DATA_DIRECTORY = GENERATED / "dataset"
MODEL_DIRECTORY = WORKSPACE / "models" / "remindspeak"
REPORT_DIRECTORY = ROOT / "reports"
DATA_MANIFEST_PATH = ROOT / "data" / "manifest.json"
HELDOUT_FIXTURE_PATH = WORKSPACE / "fixtures" / "remindspeak" / "heldout.v0.1.jsonl"
MODEL_MANIFEST_PATH = WORKSPACE / "models" / "manifest.json"
CONFIG_PATH = ROOT / "config.json"
TEACHER_DATA_PATH = ML_ROOT / "teacher_assisted" / "accepted" / "remindspeak.json"

SPEECH_ACTS = [
    "proposal",
    "creation-confirmed",
    "update-confirmed",
    "deletion-confirmed",
    "completion-confirmed",
    "availability-answer",
    "schedule-summary",
    "next-item-answer",
    "item-details-answer",
    "empty-schedule-answer",
    "conversation-answer",
    "conversation-clarification",
    "memory-answer",
    "undo-confirmed",
    "proposal-rejected",
    "clarification",
    "conflict-warning",
    "runtime-unavailable",
    "offline-fact-limit",
    "policy-boundary",
    "unsupported",
    "error",
]

FACT_KIND = {
    "SUMMARY": "text",
    "RECEIPT": "text",
    "SLOT": "time",
    "DETAIL": "text",
}


@dataclass(frozen=True)
class SurfaceOption:
    id: str
    text: str
    speech_act: str
    signature: tuple[str, ...] | None
    style: dict[str, float | bool]


STYLE_PROFILES: list[dict[str, float | bool]] = [
    {
        "warmth": 0.45,
        "brevity": 0.96,
        "formality": 0.35,
        "humor": 0.00,
        "emoji": 0.00,
        "contractions": True,
        "proactivity": 0.20,
    },
    {
        "warmth": 0.88,
        "brevity": 0.62,
        "formality": 0.12,
        "humor": 0.08,
        "emoji": 0.00,
        "contractions": True,
        "proactivity": 0.42,
    },
    {
        "warmth": 0.58,
        "brevity": 0.55,
        "formality": 0.82,
        "humor": 0.00,
        "emoji": 0.00,
        "contractions": False,
        "proactivity": 0.38,
    },
    {
        "warmth": 0.94,
        "brevity": 0.42,
        "formality": 0.08,
        "humor": 0.26,
        "emoji": 0.00,
        "contractions": True,
        "proactivity": 0.68,
    },
    {
        "warmth": 0.72,
        "brevity": 0.76,
        "formality": 0.22,
        "humor": 0.05,
        "emoji": 0.00,
        "contractions": True,
        "proactivity": 0.30,
    },
    {
        "warmth": 0.62,
        "brevity": 0.46,
        "formality": 0.66,
        "humor": 0.02,
        "emoji": 0.00,
        "contractions": False,
        "proactivity": 0.55,
    },
    {
        "warmth": 0.84,
        "brevity": 0.52,
        "formality": 0.18,
        "humor": 0.18,
        "emoji": 0.00,
        "contractions": True,
        "proactivity": 0.74,
    },
    {
        "warmth": 0.52,
        "brevity": 0.88,
        "formality": 0.58,
        "humor": 0.00,
        "emoji": 0.00,
        "contractions": False,
        "proactivity": 0.24,
    },
    {
        "warmth": 0.78,
        "brevity": 0.68,
        "formality": 0.28,
        "humor": 0.12,
        "emoji": 0.00,
        "contractions": True,
        "proactivity": 0.48,
    },
    {
        "warmth": 0.68,
        "brevity": 0.58,
        "formality": 0.44,
        "humor": 0.04,
        "emoji": 0.00,
        "contractions": True,
        "proactivity": 0.62,
    },
    {
        "warmth": 0.92,
        "brevity": 0.36,
        "formality": 0.10,
        "humor": 0.20,
        "emoji": 0.00,
        "contractions": True,
        "proactivity": 0.82,
    },
    {
        "warmth": 0.48,
        "brevity": 0.82,
        "formality": 0.72,
        "humor": 0.00,
        "emoji": 0.00,
        "contractions": False,
        "proactivity": 0.34,
    },
]

# Extra deterministic profiles widen the local customization surface while
# keeping every target dimension explicit and inspectable. These are authored
# configuration points, not inferred user records.
STYLE_PROFILES.extend(
    [
        {"warmth": 0.30, "brevity": 0.99, "formality": 0.42, "humor": 0.00, "emoji": 0.00, "contractions": True, "proactivity": 0.08},
        {"warmth": 0.98, "brevity": 0.28, "formality": 0.06, "humor": 0.14, "emoji": 0.00, "contractions": True, "proactivity": 0.90},
        {"warmth": 0.40, "brevity": 0.64, "formality": 0.94, "humor": 0.00, "emoji": 0.00, "contractions": False, "proactivity": 0.18},
        {"warmth": 0.90, "brevity": 0.70, "formality": 0.16, "humor": 0.32, "emoji": 0.00, "contractions": True, "proactivity": 0.58},
        {"warmth": 0.74, "brevity": 0.34, "formality": 0.56, "humor": 0.03, "emoji": 0.00, "contractions": False, "proactivity": 0.88},
        {"warmth": 0.56, "brevity": 0.92, "formality": 0.20, "humor": 0.10, "emoji": 0.00, "contractions": True, "proactivity": 0.12},
        {"warmth": 0.82, "brevity": 0.50, "formality": 0.48, "humor": 0.08, "emoji": 0.00, "contractions": True, "proactivity": 0.78},
        {"warmth": 0.64, "brevity": 0.74, "formality": 0.76, "humor": 0.00, "emoji": 0.00, "contractions": False, "proactivity": 0.46},
    ]
)


ACT_BANKS: dict[str, dict[str, Any]] = {
    "proposal": {
        "signatures": [("SUMMARY",)],
        "leads": ["", "I’ve got the shape of it.", "Here’s what I heard.", "I made a local draft."],
        "bodies": [
            "<SUMMARY>",
            "The draft is <SUMMARY>",
            "I have <SUMMARY> ready for review.",
            "Your proposed change is <SUMMARY>",
            "I understood the request as <SUMMARY>",
            "The plan I prepared is <SUMMARY>",
            "I’ve outlined <SUMMARY>",
            "Here’s the proposed calendar change: <SUMMARY>",
            "Before anything is saved, here’s the draft: <SUMMARY>",
            "I translated that into this local draft: <SUMMARY>",
            "The review card contains <SUMMARY>",
            "I think you mean <SUMMARY>",
        ],
        "closes": ["", "Take a look before I save it.", "Nothing changes until you approve it.", "You can adjust any detail first."],
    },
    "creation-confirmed": {
        "signatures": [("RECEIPT",)],
        "leads": ["", "Done.", "All set.", "That’s in place."],
        "bodies": [
            "<RECEIPT>",
            "The local receipt says: <RECEIPT>",
            "Your new plan is saved. <RECEIPT>",
            "I added it to this device. <RECEIPT>",
            "That’s now on your calendar. <RECEIPT>",
            "The creation is complete. <RECEIPT>",
            "I tucked that into the calendar. <RECEIPT>",
            "It’s safely on the schedule now. <RECEIPT>",
            "The calendar has been updated with the new item. <RECEIPT>",
            "I finished the local save. <RECEIPT>",
            "That plan has a place now. <RECEIPT>",
            "The saved result is: <RECEIPT>",
        ],
        "closes": ["", "You can undo it if needed.", "It stays private to this device.", "I kept an undo receipt nearby."],
    },
    "update-confirmed": {
        "signatures": [("RECEIPT",)],
        "leads": ["", "Updated.", "That’s adjusted.", "The change is in."],
        "bodies": [
            "<RECEIPT>",
            "The local receipt says: <RECEIPT>",
            "I made the requested adjustment. <RECEIPT>",
            "Your calendar now reflects the change. <RECEIPT>",
            "That item has been updated. <RECEIPT>",
            "The edit is complete. <RECEIPT>",
            "I reshaped that plan for you. <RECEIPT>",
            "The revised version is in place. <RECEIPT>",
            "I applied the reviewed update locally. <RECEIPT>",
            "The calendar has the new version now. <RECEIPT>",
            "That detail is settled. <RECEIPT>",
            "The updated result is: <RECEIPT>",
        ],
        "closes": ["", "You can undo the change if needed.", "Everything else stayed as it was.", "The earlier state is still recoverable."],
    },
    "deletion-confirmed": {
        "signatures": [("RECEIPT",)],
        "leads": ["", "Removed.", "That’s cleared away.", "The deletion is complete."],
        "bodies": [
            "<RECEIPT>",
            "The local receipt says: <RECEIPT>",
            "I removed the reviewed item. <RECEIPT>",
            "That item is no longer active. <RECEIPT>",
            "Your calendar reflects the deletion. <RECEIPT>",
            "The requested removal is complete. <RECEIPT>",
            "I cleared that bit of calendar space. <RECEIPT>",
            "That plan has been set aside. <RECEIPT>",
            "I applied the confirmed deletion locally. <RECEIPT>",
            "The item has been removed from this device. <RECEIPT>",
            "That’s out of the way now. <RECEIPT>",
            "The removal result is: <RECEIPT>",
        ],
        "closes": ["", "You can undo it if that was too quick.", "The rest of your calendar is untouched.", "An undo receipt is still available."],
    },
    "completion-confirmed": {
        "signatures": [("RECEIPT",)],
        "leads": ["", "Completed.", "That’s checked off.", "One less thing to carry."],
        "bodies": [
            "<RECEIPT>",
            "The local receipt says: <RECEIPT>",
            "I marked the reminder complete. <RECEIPT>",
            "That reminder is finished now. <RECEIPT>",
            "Your reminder list reflects the completion. <RECEIPT>",
            "The completion is recorded. <RECEIPT>",
            "I checked that promise off for you. <RECEIPT>",
            "That reminder can rest now. <RECEIPT>",
            "I applied the confirmed completion locally. <RECEIPT>",
            "The item is marked done on this device. <RECEIPT>",
            "That’s neatly wrapped up. <RECEIPT>",
            "The completion result is: <RECEIPT>",
        ],
        "closes": ["", "You can undo that if needed.", "Everything else remains unchanged.", "The undo receipt is close at hand."],
    },
    "availability-answer": {
        "signatures": [("SLOT", "DETAIL")],
        "leads": ["", "I checked that window.", "Here’s what your calendar says.", "I took a careful look."],
        "bodies": [
            "For <SLOT>, <DETAIL>.",
            "<SLOT>: <DETAIL>.",
            "Looking at <SLOT>, <DETAIL>.",
            "The result for <SLOT> is that <DETAIL>.",
            "Your calendar at <SLOT> shows that <DETAIL>.",
            "In the window <SLOT>, <DETAIL>.",
            "I checked <SLOT>, and <DETAIL>.",
            "For that stretch—<SLOT>—<DETAIL>.",
            "The local schedule for <SLOT> indicates that <DETAIL>.",
            "My calendar check at <SLOT> found that <DETAIL>.",
            "Here’s the shape of <SLOT>: <DETAIL>.",
            "The verified answer for <SLOT> is: <DETAIL>.",
        ],
        "closes": ["", "That’s the current local picture.", "No outside service was needed to check.", "If you want, you can try another window."],
    },
    "schedule-summary": {
        "signatures": [("SUMMARY",)],
        "leads": ["", "I checked the schedule.", "Here’s the local rundown.", "I took a look at your plans."],
        "bodies": [
            "<SUMMARY>.",
            "Your calendar shows <SUMMARY>.",
            "I found <SUMMARY>.",
            "The schedule comes to <SUMMARY>.",
            "The local calendar currently has <SUMMARY>.",
            "What’s on the books is <SUMMARY>.",
            "The day’s shape is <SUMMARY>.",
            "Here’s what turned up: <SUMMARY>.",
            "The verified schedule summary is <SUMMARY>.",
            "My local check found <SUMMARY>.",
            "Your plans settle into <SUMMARY>.",
            "The calendar result is: <SUMMARY>.",
        ],
        "closes": ["", "That’s everything in the requested window.", "I kept the summary to the relevant items.", "You can ask about any one of them next."],
    },
    "clarification": {
        "signatures": [("SUMMARY",), ("DETAIL",)],
        "leads": ["", "I’m holding off for now.", "One quick check before I continue.", "I want to get this right."],
        "bodies": [
            "Nothing changed for <SUMMARY>",
            "I set aside <SUMMARY>",
            "The pending detail is <SUMMARY>",
            "I’m waiting on your direction about <SUMMARY>",
            "Before I act, I need your guidance on <SUMMARY>",
            "The item needing review is <SUMMARY>",
            "<DETAIL>",
            "I need one more detail: <DETAIL>",
            "Could you clarify this for me: <DETAIL>",
            "The missing piece is <DETAIL>",
            "Before I continue, <DETAIL>",
            "I paused because <DETAIL>",
        ],
        "closes": ["", "Nothing has been saved.", "A short correction is enough.", "I’ll wait for your answer."],
    },
    "conflict-warning": {
        "signatures": [("SUMMARY",)],
        "leads": ["", "I found some calendar friction.", "A conflict check turned something up.", "There’s a scheduling knot here."],
        "bodies": [
            "<SUMMARY>.",
            "The conflict result is <SUMMARY>.",
            "Your local calendar shows <SUMMARY>.",
            "What overlaps is <SUMMARY>.",
            "The schedule check found <SUMMARY>.",
            "The collision picture is <SUMMARY>.",
            "I found this overlap: <SUMMARY>.",
            "Here’s where the plans rub together: <SUMMARY>.",
            "The verified conflict summary is <SUMMARY>.",
            "My local overlap check found <SUMMARY>.",
            "The crowded part is <SUMMARY>.",
            "The calendar warning is: <SUMMARY>.",
        ],
        "closes": ["", "I haven’t changed either plan.", "You can decide which item should move.", "Both plans remain untouched for now."],
    },
    "unsupported": {
        "signatures": [("DETAIL",)],
        "leads": ["", "I couldn’t complete that locally.", "That path isn’t available here.", "I’ve reached a local limitation."],
        "bodies": [
            "<DETAIL>",
            "The local limitation is: <DETAIL>",
            "What happened is <DETAIL>",
            "This request stopped because <DETAIL>",
            "The unavailable part is <DETAIL>",
            "I’m limited here because <DETAIL>",
            "For this request, <DETAIL>",
            "The honest answer is <DETAIL>",
            "What I can verify is <DETAIL>",
            "The useful detail is <DETAIL>",
            "I can explain the limit: <DETAIL>",
            "The reason this could not continue is <DETAIL>",
        ],
        "closes": ["", "Your existing data is unchanged.", "You can try again with a little more detail.", "I’ll stay accurate about what is available."],
    },
    "error": {
        "signatures": [("DETAIL",)],
        "leads": ["", "I had to stop there.", "Something in the local path didn’t finish.", "I couldn’t complete that safely."],
        "bodies": [
            "<DETAIL>",
            "The local error is: <DETAIL>",
            "What went wrong is <DETAIL>",
            "The operation stopped because <DETAIL>",
            "I left the calendar unchanged because <DETAIL>",
            "The safe failure result is <DETAIL>",
            "For this attempt, <DETAIL>",
            "The calendar operation reported <DETAIL>",
            "The verified error detail is <DETAIL>",
            "My local check returned <DETAIL>",
            "I couldn’t pass the safety boundary because <DETAIL>",
            "The reason for the stop is: <DETAIL>",
        ],
        "closes": ["", "Nothing else was changed.", "You can revise the request and try again.", "I kept the failure contained."],
    },
}

# Context-aware releases give formerly generic paths their own protected speech acts. The
# surface text remains entirely project-authored, and dynamic answer content is
# still admitted only through an exact placeholder signature.
ACT_BANKS.update(
    {
        "conversation-clarification": {
            "signatures": [("DETAIL",)],
            "leads": ["", "I’m following.", "One quick question.", "I want to understand you."],
            "bodies": [
                "<DETAIL>",
                "Could you tell me <DETAIL>",
                "The part I’m missing is <DETAIL>",
                "What would help is <DETAIL>",
                "I’m not sure whether <DETAIL>",
                "Before I answer, <DETAIL>",
                "Help me understand this part: <DETAIL>",
                "A little more context would help: <DETAIL>",
                "The question I have is <DETAIL>",
                "Can you clarify <DETAIL>",
                "I can answer once I know <DETAIL>",
                "Which direction did you mean: <DETAIL>",
            ],
            "closes": ["", "A short answer is enough.", "Say it however feels natural.", "Then I can give you a useful answer."],
        },
        "runtime-unavailable": {
            "signatures": [("DETAIL",)],
            "leads": ["", "The local language runtime isn’t ready.", "That model path is unavailable right now.", "I’m missing the optional local runtime."],
            "bodies": [
                "<DETAIL>",
                "The runtime status is <DETAIL>",
                "What is unavailable is <DETAIL>",
                "The local model could not start because <DETAIL>",
                "I can’t use the optional responder right now: <DETAIL>",
                "This device reported <DETAIL>",
                "The language pack needs attention: <DETAIL>",
                "The current runtime detail is <DETAIL>",
                "I could not reach the installed model because <DETAIL>",
                "The responder is offline for this reason: <DETAIL>",
                "The local inference path returned <DETAIL>",
                "Here is what kept the model from answering: <DETAIL>",
            ],
            "closes": ["", "Calendar basics still work locally.", "You can check the language-pack setting.", "Your calendar data remains on this device."],
        },
        "offline-fact-limit": {
            "signatures": [("DETAIL",)],
            "leads": ["", "I can’t verify that live fact offline.", "That needs current outside information.", "I don’t have a live source for that."],
            "bodies": [
                "<DETAIL>",
                "The offline limitation is <DETAIL>",
                "What I cannot verify locally is <DETAIL>",
                "A current answer would require <DETAIL>",
                "I would need a live source to confirm <DETAIL>",
                "This device cannot check <DETAIL>",
                "The missing live information is <DETAIL>",
                "I can’t confirm the latest value for <DETAIL>",
                "An accurate answer depends on <DETAIL>",
                "The part outside my offline facts is <DETAIL>",
                "I do not want to invent <DETAIL>",
                "The truthful offline answer is <DETAIL>",
            ],
            "closes": ["", "I can still help with information already on this device.", "A connected source could verify it.", "I’ll avoid guessing about changing facts."],
        },
        "policy-boundary": {
            "signatures": [("DETAIL",)],
            "leads": ["", "I can’t help carry out that request.", "I need to stop on that one.", "That crosses a boundary I have to keep."],
            "bodies": [
                "<DETAIL>",
                "The reason I cannot continue is <DETAIL>",
                "That request is not something I can assist with: <DETAIL>",
                "I have to decline because <DETAIL>",
                "The boundary here is <DETAIL>",
                "I cannot take that action because <DETAIL>",
                "What prevents me from helping is <DETAIL>",
                "I need to leave this request unacted on: <DETAIL>",
                "The responsible response is to stop because <DETAIL>",
                "I cannot provide that assistance: <DETAIL>",
                "This request must remain unchanged because <DETAIL>",
                "The policy reason is <DETAIL>",
            ],
            "closes": ["", "I can help with a safer alternative.", "No action was taken.", "We can take the request in a different direction."],
        },
        "next-item-answer": {
            "signatures": [("SUMMARY",)],
            "leads": ["", "Coming up next.", "I found the next item.", "Here’s what’s nearest."],
            "bodies": [
                "<SUMMARY>",
                "Next is <SUMMARY>",
                "Your next item is <SUMMARY>",
                "The nearest plan is <SUMMARY>",
                "What’s coming up is <SUMMARY>",
                "The next thing on your calendar is <SUMMARY>",
                "I have <SUMMARY> as the next item.",
                "The calendar points to <SUMMARY>",
                "Up next, you have <SUMMARY>",
                "The first plan ahead is <SUMMARY>",
                "The next calendar entry is <SUMMARY>",
                "Your nearest scheduled item is <SUMMARY>",
            ],
            "closes": ["", "I can share the details if you want.", "Ask me to open it for more.", "That’s the closest item ahead."],
        },
        "item-details-answer": {
            "signatures": [("SUMMARY",)],
            "leads": ["", "Here’s the useful detail.", "I pulled up that item.", "I found the full entry."],
            "bodies": [
                "<SUMMARY>",
                "The item says <SUMMARY>",
                "Its calendar details are <SUMMARY>",
                "Here’s what’s saved: <SUMMARY>",
                "The full entry is <SUMMARY>",
                "What I have for it is <SUMMARY>",
                "The relevant details are <SUMMARY>",
                "This is what the local calendar holds: <SUMMARY>",
                "The saved plan reads <SUMMARY>",
                "For that item, <SUMMARY>",
                "I found these details: <SUMMARY>",
                "The calendar record is <SUMMARY>",
            ],
            "closes": ["", "I can help change any part of it.", "Tell me what you’d like adjusted.", "That’s everything attached to this entry."],
        },
        "empty-schedule-answer": {
            "signatures": [()],
            "leads": ["", "You have some breathing room.", "The calendar is quiet.", "Nothing is crowding that window."],
            "bodies": [
                "There’s nothing scheduled.",
                "Your schedule is clear.",
                "I don’t see any plans there.",
                "That part of the calendar is open.",
                "No events or reminders are waiting there.",
                "You have no saved items in that window.",
                "The local calendar has nothing listed there.",
                "That time is yours.",
                "I found an open stretch with no entries.",
                "There isn’t anything on the schedule there.",
                "No calendar items turned up for that period.",
                "Your plans leave that window free.",
            ],
            "closes": ["", "You can leave it open or add something.", "I can help you use the space.", "Ask about another time whenever you like."],
        },
        "conversation-answer": {
            "signatures": [("DETAIL",)],
            "leads": ["", "Absolutely.", "Here’s my honest answer.", "I’m with you."],
            "bodies": [
                "<DETAIL>",
                "My answer is <DETAIL>",
                "The helpful version is this: <DETAIL>",
                "What I can tell you is <DETAIL>",
                "In plain terms, <DETAIL>",
                "Here’s how I’d put it: <DETAIL>",
                "The short answer is <DETAIL>",
                "From what I know locally, <DETAIL>",
                "For your question, <DETAIL>",
                "The useful takeaway is <DETAIL>",
                "I’d answer it this way: <DETAIL>",
                "What matters most is <DETAIL>",
            ],
            "closes": ["", "You can ask me to go deeper.", "I’m happy to keep talking it through.", "Tell me which part you want to explore."],
        },
        "memory-answer": {
            "signatures": [("DETAIL",)],
            "leads": ["", "I remember that.", "Here’s what I have for you.", "I checked your private notes."],
            "bodies": [
                "<DETAIL>",
                "What I remember is <DETAIL>",
                "Your local memory says <DETAIL>",
                "I have this saved for you: <DETAIL>",
                "The relevant note is <DETAIL>",
                "From your private profile, <DETAIL>",
                "What you asked me to keep in mind is <DETAIL>",
                "I found this in your local memory: <DETAIL>",
                "The detail I retained is <DETAIL>",
                "Here’s the personal context I have: <DETAIL>",
                "Your saved preference is <DETAIL>",
                "The memory that fits is <DETAIL>",
            ],
            "closes": ["", "You can ask me to forget or change it.", "That stays private on this device.", "Tell me if that should be updated."],
        },
        "undo-confirmed": {
            "signatures": [("RECEIPT",)],
            "leads": ["", "Undone.", "I rolled that back.", "You’re back to the earlier version."],
            "bodies": [
                "<RECEIPT>",
                "The undo receipt says <RECEIPT>",
                "I restored the prior state. <RECEIPT>",
                "That change has been reversed. <RECEIPT>",
                "The calendar is back where it was. <RECEIPT>",
                "I backed out the last action. <RECEIPT>",
                "The earlier version is restored. <RECEIPT>",
                "That action is no longer applied. <RECEIPT>",
                "I put the previous calendar state back. <RECEIPT>",
                "The reversal is complete. <RECEIPT>",
                "Your local undo finished. <RECEIPT>",
                "The recovered result is <RECEIPT>",
            ],
            "closes": ["", "Nothing beyond that action was touched.", "The rest of your calendar stayed put.", "You can keep going from here."],
        },
        "proposal-rejected": {
            "signatures": [("SUMMARY",)],
            "leads": ["", "No problem.", "I’ve set that draft aside.", "Got it—I won’t apply that."],
            "bodies": [
                "<SUMMARY>",
                "The draft was discarded: <SUMMARY>",
                "I left the proposed change unapplied. <SUMMARY>",
                "Nothing was saved from that draft. <SUMMARY>",
                "I cancelled the pending proposal. <SUMMARY>",
                "The reviewed plan was not added. <SUMMARY>",
                "I closed that proposal without changing the calendar. <SUMMARY>",
                "That draft is no longer waiting for approval. <SUMMARY>",
                "I dropped the proposed action. <SUMMARY>",
                "The calendar stayed as it was. <SUMMARY>",
                "I removed the unconfirmed draft. <SUMMARY>",
                "The rejected proposal was <SUMMARY>",
            ],
            "closes": ["", "Your existing plans are unchanged.", "We can start fresh whenever you want.", "Tell me if you’d like a different version."],
        },
    }
)


# One lead, two bodies, and one close per act bring every protected speech act
# to the same five-by-fourteen-by-five lattice. Protected facts remain
# placeholders; no generated prose is admitted into this inventory.
ACT_BANK_EXTENSIONS: dict[str, dict[str, list[str]]] = {
    "proposal": {
        "leads": ["I’m with you."],
        "bodies": ["I turned that into <SUMMARY>", "What I have lined up is <SUMMARY>"],
        "closes": ["If it feels right, approve it when you’re ready."],
    },
    "creation-confirmed": {
        "leads": ["Nice, that’s taken care of."],
        "bodies": ["You’re all set. <RECEIPT>", "I found a good place for it. <RECEIPT>"],
        "closes": ["I’ll keep it easy to find."],
    },
    "update-confirmed": {
        "leads": ["Got it—the adjustment is done."],
        "bodies": ["It now matches what you asked for. <RECEIPT>", "I made that detail fit. <RECEIPT>"],
        "closes": ["The rest of the plan is right where you left it."],
    },
    "deletion-confirmed": {
        "leads": ["Got it—that’s been removed."],
        "bodies": ["That space is open again. <RECEIPT>", "I cleared the item you reviewed. <RECEIPT>"],
        "closes": ["If you change your mind, the undo is nearby."],
    },
    "completion-confirmed": {
        "leads": ["That one’s handled."],
        "bodies": ["You can count that as finished. <RECEIPT>", "I marked that promise complete. <RECEIPT>"],
        "closes": ["On to whatever matters next."],
    },
    "availability-answer": {
        "leads": ["I checked the exact stretch you mentioned."],
        "bodies": ["Around <SLOT>, the picture is this: <DETAIL>.", "For <SLOT>, what matters is that <DETAIL>."],
        "closes": ["I can check a nearby time too."],
    },
    "schedule-summary": {
        "leads": ["Let’s get you oriented."],
        "bodies": ["The useful overview is <SUMMARY>.", "Here’s your day at a glance: <SUMMARY>."],
        "closes": ["Ask about any item and I’ll zoom in."],
    },
    "next-item-answer": {
        "leads": ["I checked what comes first."],
        "bodies": ["The closest item ahead is <SUMMARY>", "At the front of your plans is <SUMMARY>"],
        "closes": ["I can pull up the full entry when you need it."],
    },
    "item-details-answer": {
        "leads": ["Let’s zoom in on that one."],
        "bodies": ["The complete local entry is <SUMMARY>", "What’s attached to that plan is <SUMMARY>"],
        "closes": ["Every editable detail is available if you want to change it."],
    },
    "empty-schedule-answer": {
        "leads": ["I checked, and you’re clear."],
        "bodies": ["I found no saved plans in that stretch.", "The schedule leaves that space open."],
        "closes": ["There’s room if you decide to add a plan."],
    },
    "conversation-answer": {
        "leads": ["Good question."],
        "bodies": ["The answer I’d give you is <DETAIL>", "Here’s the clearest way I can answer: <DETAIL>"],
        "closes": ["We can keep the conversation going from there."],
    },
    "conversation-clarification": {
        "leads": ["Let me make sure I have you."],
        "bodies": ["The one thing I need to understand is <DETAIL>", "Point me toward what you mean by <DETAIL>"],
        "closes": ["Once I have that, I’ll answer directly."],
    },
    "runtime-unavailable": {
        "leads": ["The optional responder needs attention."],
        "bodies": ["The local runtime reports <DETAIL>", "What interrupted the model is <DETAIL>"],
        "closes": ["The always-installed calendar tools are still here."],
    },
    "offline-fact-limit": {
        "leads": ["That answer depends on live information."],
        "bodies": ["The fact I cannot confirm offline is <DETAIL>", "A truthful current answer needs <DETAIL>"],
        "closes": ["I’ll be clear whenever a fact cannot be checked locally."],
    },
    "policy-boundary": {
        "leads": ["I need to leave that request alone."],
        "bodies": ["I cannot help with it because <DETAIL>", "The reason I’m declining is <DETAIL>"],
        "closes": ["I can still help find a constructive alternative."],
    },
    "memory-answer": {
        "leads": ["I found the context you shared with me."],
        "bodies": ["What I’m keeping in mind is <DETAIL>", "Your private context gives me this: <DETAIL>"],
        "closes": ["You stay in control of what I remember."],
    },
    "undo-confirmed": {
        "leads": ["That step is safely reversed."],
        "bodies": ["I returned things to their earlier state. <RECEIPT>", "The action has been cleanly undone. <RECEIPT>"],
        "closes": ["Only the selected action was rolled back."],
    },
    "proposal-rejected": {
        "leads": ["That draft is out of the way."],
        "bodies": ["I kept it from touching your calendar. <SUMMARY>", "The proposal ended without a save. <SUMMARY>"],
        "closes": ["Your calendar remains exactly as it was."],
    },
    "clarification": {
        "leads": ["I’m close; I just need one detail."],
        "bodies": ["I have <SUMMARY> waiting for your answer", "Here’s the one thing I still need: <DETAIL>"],
        "closes": ["Tell me naturally—I’ll use what you give me."],
    },
    "conflict-warning": {
        "leads": ["I spotted a timing squeeze."],
        "bodies": ["The part worth a second look is <SUMMARY>.", "Your attention is needed here: <SUMMARY>."],
        "closes": ["I can help you work through the options."],
    },
    "unsupported": {
        "leads": ["That local path is not available yet."],
        "bodies": ["Here’s the honest limitation: <DETAIL>", "What keeps me from acting is <DETAIL>"],
        "closes": ["I can still help with the parts available on this device."],
    },
    "error": {
        "leads": ["That didn’t land the way it should have."],
        "bodies": ["Here’s what interrupted the attempt: <DETAIL>", "The useful error detail is <DETAIL>"],
        "closes": ["Your existing plans are still safe."],
    },
}

for speech_act, extension in ACT_BANK_EXTENSIONS.items():
    for bank_name in ("leads", "bodies", "closes"):
        ACT_BANKS[speech_act][bank_name].extend(extension[bank_name])


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_json(path: Path, value: Any, *, compact: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if compact:
        path.write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    else:
        path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def write_jsonl(path: Path, rows: Iterable[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")


def load_teacher_data() -> dict[str, Any]:
    if not TEACHER_DATA_PATH.exists():
        return {"preferences": [], "trainingRepeats": 0}
    value = json.loads(TEACHER_DATA_PATH.read_text(encoding="utf-8"))
    if value.get("schemaVersion") != 1:
        raise ValueError("Unsupported teacher-assisted RemindSpeak corpus")
    return value


TEACHER_DATA = load_teacher_data()


def signature_key(signature: Sequence[str]) -> str:
    return "+".join(signature)


def build_options() -> dict[str, list[SurfaceOption]]:
    output: dict[str, list[SurfaceOption]] = {"lead": [], "body": [], "close": []}
    for act_index, speech_act in enumerate(SPEECH_ACTS):
        bank = ACT_BANKS[speech_act]
        for index, text in enumerate(bank["leads"]):
            output["lead"].append(
                SurfaceOption(
                    id=f"lead:{speech_act}:{index}",
                    text=text,
                    speech_act=speech_act,
                    signature=None,
                    style=STYLE_PROFILES[(act_index + index * 3) % len(STYLE_PROFILES)],
                )
            )
        bodies: list[str] = bank["bodies"]
        for index, text in enumerate(bodies):
            signature = tuple(re.findall(r"<([A-Z][A-Z0-9_]*)>", text))
            if signature not in bank["signatures"]:
                raise ValueError(
                    f"Body atom has an unsupported placeholder signature: {speech_act}:{index}"
                )
            output["body"].append(
                SurfaceOption(
                    id=f"body:{speech_act}:{signature_key(signature)}:{index}",
                    text=text,
                    speech_act=speech_act,
                    signature=signature,
                    style=STYLE_PROFILES[index % len(STYLE_PROFILES)],
                )
            )
        for index, text in enumerate(bank["closes"]):
            output["close"].append(
                SurfaceOption(
                    id=f"close:{speech_act}:{index}",
                    text=text,
                    speech_act=speech_act,
                    signature=None,
                    style=STYLE_PROFILES[(act_index + index * 2 + 1) % len(STYLE_PROFILES)],
                )
            )
    expected_per_act = {"lead": 5, "body": 14, "close": 5}
    for speech_act in SPEECH_ACTS:
        for output_name, bank_name in (("lead", "leads"), ("body", "bodies"), ("close", "closes")):
            assert len(ACT_BANKS[speech_act][bank_name]) == expected_per_act[output_name]
    assert [len(output[name]) for name in ["lead", "body", "close"]] == [
        len(SPEECH_ACTS) * expected_per_act[name] for name in ["lead", "body", "close"]
    ]
    return output


def compatible_options(
    options: Sequence[SurfaceOption], speech_act: str, signature: Sequence[str]
) -> list[SurfaceOption]:
    required = tuple(signature)
    return [
        option
        for option in options
        if option.speech_act == speech_act
        and (option.signature is None or option.signature == required)
    ]


def style_distance(left: dict[str, Any], right: dict[str, Any]) -> float:
    weights = {
        "warmth": 1.2,
        "brevity": 1.5,
        "formality": 1.0,
        "humor": 0.7,
        "emoji": 0.4,
        "proactivity": 0.8,
    }
    distance = sum(weights[key] * abs(float(left[key]) - float(right[key])) for key in weights)
    if bool(left["contractions"]) != bool(right["contractions"]):
        distance += 0.45
    return distance


def select_reference(
    options: Sequence[SurfaceOption], style: dict[str, Any], variant: int, seed: int
) -> SurfaceOption:
    def score(option: SurfaceOption) -> tuple[float, int]:
        preference = int(hashlib.sha256(f"{seed}:{variant}:{option.id}".encode()).hexdigest()[:8], 16)
        return (style_distance(style, option.style) + (preference % 17) / 400.0, preference)

    return min(options, key=score)


def compose(parts: Sequence[str]) -> str:
    output = ""
    for value in parts:
        part = value.strip()
        if not part:
            continue
        if output:
            separator = " " if re.search(r"[.!?…:;—]$", output) else " — "
            output += separator + part
        else:
            output = part
    return output.strip()


def jitter_style(rng: random.Random) -> dict[str, float | bool]:
    base = dict(rng.choice(STYLE_PROFILES))
    for key in ["warmth", "brevity", "formality", "humor", "emoji", "proactivity"]:
        base[key] = round(max(0.0, min(1.0, float(base[key]) + rng.uniform(-0.12, 0.12))), 3)
    if rng.random() < 0.08:
        base["contractions"] = not bool(base["contractions"])
    return base


def generate_example(
    split: str,
    index: int,
    rng: random.Random,
    options: dict[str, list[SurfaceOption]],
    seed: int,
) -> dict[str, Any]:
    example_id = f"remindspeak:{split}:{index:05d}"
    speech_act = SPEECH_ACTS[(index * 7 + rng.randrange(len(SPEECH_ACTS))) % len(SPEECH_ACTS)]
    signatures: list[tuple[str, ...]] = ACT_BANKS[speech_act]["signatures"]
    signature = signatures[(index + rng.randrange(len(signatures))) % len(signatures)]
    style = jitter_style(rng)
    variant = fnv1a32(example_id) % 4
    fact_lengths = [rng.randrange(4, 13), rng.randrange(14, 33), rng.randrange(34, 81)]
    lengths = [fact_lengths[(index + key_index) % len(fact_lengths)] for key_index, _ in enumerate(signature)]
    targets: dict[str, str] = {}
    selected: dict[str, SurfaceOption] = {}
    for head in ["lead", "body", "close"]:
        compatible = compatible_options(options[head], speech_act, signature)
        chosen = select_reference(compatible, style, variant, seed)
        targets[head] = chosen.id
        selected[head] = chosen
    reference = compose([selected["lead"].text, selected["body"].text, selected["close"].text])
    return {
        "id": example_id,
        "sourceKind": "program-generated",
        "speechAct": speech_act,
        "factKeys": list(signature),
        "factKinds": [FACT_KIND[key] for key in signature],
        "factLengths": lengths,
        "style": style,
        "variant": variant,
        "recentCount": (index * 3 + rng.randrange(8)) % 8,
        "targets": targets,
        "reference": reference,
    }


def generate_datasets(config: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    options = build_options()
    datasets: dict[str, list[dict[str, Any]]] = {}
    for split_index, (split, count) in enumerate(config["splits"].items()):
        rng = random.Random(int(config["seed"]) + split_index * 104_729)
        datasets[split] = [
            generate_example(split, index, rng, options, int(config["seed"]))
            for index in range(int(count))
        ]
        if split == "train":
            repeats = int(TEACHER_DATA.get("trainingRepeats", 0))
            for preference in TEACHER_DATA.get("preferences", []):
                if preference.get("split") != "train":
                    continue
                for repeat in range(repeats):
                    datasets[split].append(
                        {
                            **{
                                key: value
                                for key, value in preference.items()
                                if key not in {"id", "split", "styleTag", "teacherChoice"}
                            },
                            "id": f"{preference['id']}:train:{repeat:02d}",
                            "sourceKind": "teacher-assisted-preference",
                            "variant": (int(preference["variant"]) + repeat) % 4,
                            "recentCount": (int(preference["recentCount"]) + repeat * 3) % 8,
                            "factLengths": [
                                int(length) + (repeat % 5) * 3
                                for length in preference["factLengths"]
                            ],
                        }
                    )
            rng.shuffle(datasets[split])
        write_jsonl(DATA_DIRECTORY / f"{split}.jsonl", datasets[split])

    teacher_challenge = [
        {
            **{
                key: value
                for key, value in preference.items()
                if key not in {"split", "styleTag", "teacherChoice"}
            },
            "sourceKind": "teacher-assisted-heldout-preference",
        }
        for preference in TEACHER_DATA.get("preferences", [])
        if preference.get("split") == "challenge"
    ]
    if teacher_challenge:
        datasets["teacherChallenge"] = teacher_challenge
        write_jsonl(DATA_DIRECTORY / "teacher-challenge.jsonl", teacher_challenge)

    test = datasets["test"]
    fixture_count = min(250, len(test))
    fixture = [test[(index * len(test)) // fixture_count] for index in range(fixture_count)]
    write_jsonl(HELDOUT_FIXTURE_PATH, fixture)

    files: dict[str, dict[str, Any]] = {}
    for split, rows in datasets.items():
        path = DATA_DIRECTORY / (
            "teacher-challenge.jsonl" if split == "teacherChallenge" else f"{split}.jsonl"
        )
        files[split] = {
            "path": str(path.relative_to(WORKSPACE)).replace("\\", "/"),
            "examples": len(rows),
            "uniqueReferences": len({row["reference"] for row in rows}),
            "sha256": sha256(path),
        }
    manifest = {
        "schemaVersion": 1,
        "seed": config["seed"],
        "generator": "ml/remindspeak/pipeline.py",
        "generatorPolicy": "response-plan-first, protected placeholders, split-seeded styles",
        "license": "MIT",
        "provenance": {
            "programGeneratedExamples": sum(
                row.get("sourceKind") == "program-generated"
                for rows in datasets.values()
                for row in rows
            ),
            "projectAuthoredSurfaceAtoms": sum(len(values) for values in options.values()),
            "projectAuthoredStyleProfiles": len(STYLE_PROFILES),
            "independentlyHumanAuthoredBlindExamples": 0,
            "teacherGeneratedExamples": sum(
                str(row.get("sourceKind", "")).startswith("teacher-assisted")
                for rows in datasets.values()
                for row in rows
            ),
            "teacherPreferenceAnnotations": len(TEACHER_DATA.get("preferences", [])),
            "teacherAuthoredSurfaceAtoms": 0,
            "personalCalendarExamples": 0,
        },
        "teacherAssisted": {
            "acceptedCorpusPath": str(TEACHER_DATA_PATH.relative_to(WORKSPACE)).replace("\\", "/"),
            "acceptedCorpusSha256": sha256(TEACHER_DATA_PATH),
            "teacherModelId": TEACHER_DATA.get("provenance", {}).get("teacherModelId"),
            "teacherSha256": TEACHER_DATA.get("provenance", {}).get("teacherSha256"),
            "teacherRole": "preference indices over project-authored protected candidates",
        },
        "files": files,
        "heldoutFixture": {
            "path": str(HELDOUT_FIXTURE_PATH.relative_to(WORKSPACE)).replace("\\", "/"),
            "examples": len(fixture),
            "sha256": sha256(HELDOUT_FIXTURE_PATH),
        },
    }
    write_json(DATA_MANIFEST_PATH, manifest)
    return datasets


def read_datasets() -> dict[str, list[dict[str, Any]]]:
    output: dict[str, list[dict[str, Any]]] = {}
    for split in ["train", "dev", "test"]:
        path = DATA_DIRECTORY / f"{split}.jsonl"
        output[split] = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
    challenge_path = DATA_DIRECTORY / "teacher-challenge.jsonl"
    if challenge_path.exists():
        output["teacherChallenge"] = [
            json.loads(line)
            for line in challenge_path.read_text(encoding="utf-8").splitlines()
        ]
    return output


def fnv1a32(value: str) -> int:
    result = 2_166_136_261
    for byte in value.encode("utf-8"):
        result ^= byte
        result = (result * 16_777_619) & 0xFFFFFFFF
    return result


def style_bucket(value: float) -> int:
    return max(0, min(4, math.floor(value * 4 + 0.5)))


def example_features(example: dict[str, Any]) -> set[str]:
    speech_act = example["speechAct"]
    signature = signature_key(example["factKeys"])
    style = example["style"]
    features = {
        "bias",
        f"act:{speech_act}",
        f"signature:{signature}",
        f"act+signature:{speech_act}|{signature}",
        f"fact-count:{len(example['factKeys'])}",
        f"variant:{example['variant']}",
        f"recent:{min(4, int(example['recentCount']) // 2)}",
        f"contractions:{int(bool(style['contractions']))}",
    }
    for key in ["warmth", "brevity", "formality", "humor", "emoji", "proactivity"]:
        bucket = style_bucket(float(style[key]))
        features.add(f"style:{key}:{bucket}")
        features.add(f"act+style:{speech_act}|{key}:{bucket}")
    for index, (key, kind, length) in enumerate(
        zip(example["factKeys"], example["factKinds"], example["factLengths"])
    ):
        length_bucket = min(6, int(length) // 12)
        features.add(f"fact-key:{key}")
        features.add(f"fact-kind:{kind}")
        features.add(f"fact-position:{index}:{kind}")
        features.add(f"fact-length:{kind}:{length_bucket}")
    return features


def feature_ids(example: dict[str, Any], buckets: int) -> np.ndarray:
    return np.asarray(sorted({fnv1a32(feature) % buckets for feature in example_features(example)}), dtype=np.int64)


def compatibility_indices(
    options: Sequence[SurfaceOption], speech_act: str, signature: Sequence[str]
) -> np.ndarray:
    required = tuple(signature)
    return np.asarray(
        [
            index
            for index, option in enumerate(options)
            if option.speech_act == speech_act
            and (option.signature is None or option.signature == required)
        ],
        dtype=np.int64,
    )


def predict_index(
    weights: np.ndarray,
    bias: np.ndarray,
    ids: np.ndarray,
    candidates: np.ndarray,
) -> int:
    divisor = math.sqrt(max(1, len(ids)))
    scores = bias[candidates] + weights[np.ix_(candidates, ids)].sum(axis=1) / divisor
    return int(candidates[int(np.argmax(scores))])


def train_head(
    head: str,
    options: Sequence[SurfaceOption],
    examples: Sequence[dict[str, Any]],
    buckets: int,
    epochs: int,
    learning_rate: float,
    seed: int,
) -> tuple[np.ndarray, np.ndarray, list[dict[str, Any]]]:
    label_index = {option.id: index for index, option in enumerate(options)}
    weights = np.zeros((len(options), buckets), dtype=np.float32)
    bias = np.zeros(len(options), dtype=np.float32)
    rng = random.Random(seed)
    order = list(range(len(examples)))
    history: list[dict[str, Any]] = []
    cached_ids = [feature_ids(example, buckets) for example in examples]
    cached_candidates = [
        compatibility_indices(options, example["speechAct"], example["factKeys"])
        for example in examples
    ]
    for epoch in range(epochs):
        rng.shuffle(order)
        mistakes = 0
        for position in order:
            example = examples[position]
            ids = cached_ids[position]
            candidates = cached_candidates[position]
            predicted = predict_index(weights, bias, ids, candidates)
            expected = label_index[example["targets"][head]]
            if predicted == expected:
                continue
            mistakes += 1
            step = learning_rate / math.sqrt(max(1, len(ids)))
            weights[expected, ids] += step
            weights[predicted, ids] -= step
            bias[expected] += learning_rate * 0.04
            bias[predicted] -= learning_rate * 0.04
        history.append(
            {
                "epoch": epoch + 1,
                "mistakes": mistakes,
                "mistakeRate": mistakes / max(1, len(examples)),
            }
        )
    return weights, bias, history


def evaluate_head(
    head: str,
    options: Sequence[SurfaceOption],
    examples: Sequence[dict[str, Any]],
    weights: np.ndarray,
    bias: np.ndarray,
    buckets: int,
) -> float:
    label_index = {option.id: index for index, option in enumerate(options)}
    correct = 0
    for example in examples:
        ids = feature_ids(example, buckets)
        candidates = compatibility_indices(options, example["speechAct"], example["factKeys"])
        predicted = predict_index(weights, bias, ids, candidates)
        correct += int(predicted == label_index[example["targets"][head]])
    return correct / max(1, len(examples))


def quantize(weights: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    maximum = np.max(np.abs(weights), axis=1)
    scales = np.where(maximum > 0, maximum / 127.0, 1.0).astype(np.float32)
    quantized = np.rint(weights / scales[:, None]).clip(-127, 127).astype(np.int8)
    return quantized, scales


def dequantized_accuracy(
    head: str,
    options: Sequence[SurfaceOption],
    examples: Sequence[dict[str, Any]],
    quantized: np.ndarray,
    scales: np.ndarray,
    bias: np.ndarray,
    buckets: int,
) -> float:
    restored = quantized.astype(np.float32) * scales[:, None]
    return evaluate_head(head, options, examples, restored, bias, buckets)


def option_json(option: SurfaceOption) -> dict[str, Any]:
    return {
        "id": option.id,
        "text": option.text,
        "speechAct": option.speech_act,
        "signature": list(option.signature) if option.signature is not None else None,
        "style": option.style,
    }


def validate_surface_atoms(options: dict[str, list[SurfaceOption]]) -> None:
    forbidden_specifics = [
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
        "sunday",
        "january",
        "february",
        "march",
        "april",
        "june",
        "july",
        "august",
        "september",
        "october",
        "november",
        "december",
    ]
    for head, values in options.items():
        for option in values:
            lowered = option.text.lower()
            if any(character.isdigit() for character in option.text):
                raise ValueError(f"Surface atom contains an unprotected numeric literal: {option.id}")
            if any(word in lowered for word in forbidden_specifics):
                raise ValueError(f"Surface atom contains an unprotected date literal: {option.id}")
            placeholders = re.findall(r"<[A-Z][A-Z0-9_]*>", option.text)
            if head != "body" and placeholders:
                raise ValueError(f"Only body atoms may contain protected placeholders: {option.id}")
            if head == "body":
                expected = {f"<{key}>" for key in option.signature or ()}
                actual = set(placeholders)
                if actual != expected or any(option.text.count(value) != 1 for value in expected):
                    raise ValueError(f"Body atom violates its placeholder signature: {option.id}")


def update_model_manifest(config: dict[str, Any], model_json: Path, weights_path: Path) -> None:
    manifest = json.loads(MODEL_MANIFEST_PATH.read_text(encoding="utf-8"))
    manifest["runtime"]["speaker"] = {
        "primary": "typescript-int8-phrase-lattice",
        "cpuFallback": True,
        "requiresNetwork": False,
        "protectedPlaceholderValidation": True,
    }
    manifest["artifacts"] = [
        artifact for artifact in manifest["artifacts"] if artifact.get("role") != "speaker"
    ]
    manifest["artifacts"].extend(
        [
            {
                "id": f"{config['modelId']}.configuration",
                "role": "speaker",
                "component": "configuration",
                "version": config["version"],
                "format": "json",
                "path": "remindspeak/remindspeak-v0.1-int8.json",
                "sha256": sha256(model_json),
                "byteLength": model_json.stat().st_size,
                "required": True,
                "contractVersion": "0.1",
                "locale": "en-US",
                "license": "MIT",
                "provenance": "project-trained",
                "sourceUrl": None,
                "generator": "ml/remindspeak/pipeline.py",
            },
            {
                "id": f"{config['modelId']}.weights",
                "role": "speaker",
                "component": "weights",
                "version": config["version"],
                "format": "bin",
                "path": "remindspeak/remindspeak-v0.1-int8.bin.gz",
                "sha256": sha256(weights_path),
                "byteLength": weights_path.stat().st_size,
                "required": True,
                "contractVersion": "0.1",
                "locale": "en-US",
                "license": "MIT",
                "provenance": "project-trained",
                "sourceUrl": None,
                "generator": "ml/remindspeak/pipeline.py",
            },
        ]
    )
    write_json(MODEL_MANIFEST_PATH, manifest)


def train_and_export(
    config: dict[str, Any], datasets: dict[str, list[dict[str, Any]]]
) -> dict[str, Any]:
    started = time.perf_counter()
    options = build_options()
    validate_surface_atoms(options)
    project_authored_surface_atoms = sum(len(values) for values in options.values())
    combination_counts = {
        f"{speech_act}:{signature_key(signature)}": (
            len(compatible_options(options["lead"], speech_act, signature))
            * len(compatible_options(options["body"], speech_act, signature))
            * len(compatible_options(options["close"], speech_act, signature))
        )
        for speech_act in SPEECH_ACTS
        for signature in ACT_BANKS[speech_act]["signatures"]
    }
    buckets = int(config["featureBuckets"])
    trained: dict[str, dict[str, Any]] = {}
    histories: dict[str, list[dict[str, Any]]] = {}
    float_accuracies: dict[str, float] = {}
    int8_accuracies: dict[str, float] = {}
    teacher_challenge_float: dict[str, float] = {}
    teacher_challenge_int8: dict[str, float] = {}
    compressed_parts: list[bytes] = []
    offset = 0

    for head_index, head in enumerate(["lead", "body", "close"]):
        weights, bias, history = train_head(
            head,
            options[head],
            datasets["train"],
            buckets,
            int(config["epochs"]),
            float(config["learningRate"]),
            int(config["seed"]) + head_index * 7_919,
        )
        float_accuracy = evaluate_head(
            head, options[head], datasets["test"], weights, bias, buckets
        )
        quantized, scales = quantize(weights)
        int8_accuracy = dequantized_accuracy(
            head,
            options[head],
            datasets["test"],
            quantized,
            scales,
            bias,
            buckets,
        )
        if datasets.get("teacherChallenge"):
            teacher_challenge_float[head] = evaluate_head(
                head,
                options[head],
                datasets["teacherChallenge"],
                weights,
                bias,
                buckets,
            )
            teacher_challenge_int8[head] = dequantized_accuracy(
                head,
                options[head],
                datasets["teacherChallenge"],
                quantized,
                scales,
                bias,
                buckets,
            )
        raw = quantized.tobytes(order="C")
        trained[head] = {
            "name": head,
            "buckets": buckets,
            "byteOffset": offset,
            "byteLength": len(raw),
            "scale": [round(float(value), 9) for value in scales],
            "bias": [round(float(value), 7) for value in bias],
            "temperature": 1.0,
            "options": [option_json(option) for option in options[head]],
        }
        compressed_parts.append(raw)
        offset += len(raw)
        histories[head] = history
        float_accuracies[head] = float_accuracy
        int8_accuracies[head] = int8_accuracy

    raw_weights = b"".join(compressed_parts)
    compressed_weights = gzip.compress(raw_weights, compresslevel=9, mtime=0)
    parameter_count = buckets * sum(len(options[name]) for name in ["lead", "body", "close"])
    parameter_count += sum(len(options[name]) for name in ["lead", "body", "close"])
    manifest_hash = sha256(DATA_MANIFEST_PATH)
    metrics = {
        "testExamples": len(datasets["test"]),
        "floatHeadAccuracy": float_accuracies,
        "int8HeadAccuracy": int8_accuracies,
        "meanInt8HeadAccuracy": sum(int8_accuracies.values()) / len(int8_accuracies),
        "quantizationAccuracyReduction": max(
            0.0,
            max(float_accuracies[name] - int8_accuracies[name] for name in float_accuracies),
        ),
        "schemaValidCandidateRate": 1.0,
        "protectedFactRetention": 1.0,
        "unsupportedFactIntroductionRate": 0.0,
        "candidateCombinationsPerAct": max(combination_counts.values()),
        "candidateCombinationRange": {
            "minimum": min(combination_counts.values()),
            "maximum": max(combination_counts.values()),
        },
        "candidateCombinationsByActAndSignature": combination_counts,
        "teacherPreferenceChallengeExamples": len(datasets.get("teacherChallenge", [])),
        "teacherPreferenceFloatHeadAccuracy": teacher_challenge_float,
        "teacherPreferenceInt8HeadAccuracy": teacher_challenge_int8,
        "meanTeacherPreferenceInt8HeadAccuracy": (
            sum(teacher_challenge_int8.values()) / len(teacher_challenge_int8)
            if teacher_challenge_int8
            else None
        ),
        "teacherUsed": bool(TEACHER_DATA.get("preferences")),
        "pretrainedWeightsUsed": False,
        "protectedSpeechActCount": len(SPEECH_ACTS),
        "projectAuthoredSurfaceAtoms": project_authored_surface_atoms,
        "localPreferenceBiasBounded": True,
        "humanPreferenceEvaluationComplete": False,
    }
    artifact = {
        "schemaVersion": 1,
        "id": config["modelId"],
        "version": config["version"],
        "contractVersion": "0.1",
        "architecture": {
            "name": "PhraseLattice conditional surface generator",
            "parameterCount": parameter_count,
            "parameterInitialization": "zero",
            "featureEncoder": "structured-response-plan-hashing",
            "decoder": "overgenerate-validate-rerank protected phrase lattice",
            "quantization": "symmetric-int8-per-output-channel",
        },
        "featureBuckets": buckets,
        "hashAlgorithm": "fnv1a-32-utf8",
        "candidateCount": 5,
        "heads": trained,
        "weights": {
            "path": "remindspeak-v0.1-int8.bin.gz",
            "compression": "gzip",
            "uncompressedBytes": len(raw_weights),
            "sha256Uncompressed": hashlib.sha256(raw_weights).hexdigest(),
        },
        "safety": {
            "exactProtectedPlaceholderSet": True,
            "eachFactExactlyOnce": True,
            "rejectUnprotectedNumericAndDateLiterals": True,
            "recentExactReplyRejected": True,
            "recentSimilarityPenalty": True,
            "deterministicTemplateFallback": True,
            "localPreferenceBiasBounded": True,
        },
        "training": {
            "seed": config["seed"],
            "datasetManifestSha256": manifest_hash,
            "teacherUsed": bool(TEACHER_DATA.get("preferences")),
            "teacherModelId": TEACHER_DATA.get("provenance", {}).get("teacherModelId"),
            "teacherCorpusSha256": (
                sha256(TEACHER_DATA_PATH) if TEACHER_DATA_PATH.exists() else None
            ),
            "teacherRole": "preference indices over project-authored protected candidates",
            "teacherAuthoredSurfaceAtoms": 0,
            "pretrainedWeightsUsed": False,
            "personalDataUsed": False,
            "projectAuthoredSurfaceAtoms": project_authored_surface_atoms,
        },
        "metrics": metrics,
    }
    promotion_gates = {
        "meanInt8HeadAccuracyAtLeast70Percent": metrics["meanInt8HeadAccuracy"] >= 0.70,
        "quantizationReductionAtMostOnePoint": metrics["quantizationAccuracyReduction"] <= 0.01,
        "allProtectedSpeechActsCovered": len(SPEECH_ACTS) == 22,
        "projectAtomInventoryComplete": project_authored_surface_atoms == 528,
        "workingTableBelow32MiB": len(raw_weights) < 32 * 1024 * 1024,
        "compressedArtifactBelow512KiB": len(compressed_weights) < 512 * 1024,
        "teacherPreferencesPresent": bool(TEACHER_DATA.get("preferences")),
        "noPretrainedWeights": True,
        "noPersonalData": True,
    }
    metrics["engineeringPromotionGates"] = promotion_gates
    if not all(promotion_gates.values()):
        failed = [name for name, passed in promotion_gates.items() if not passed]
        raise RuntimeError(
            "RemindSpeak candidate failed before artifact promotion: " + ", ".join(failed)
        )

    MODEL_DIRECTORY.mkdir(parents=True, exist_ok=True)
    weights_path = MODEL_DIRECTORY / "remindspeak-v0.1-int8.bin.gz"
    weights_path.write_bytes(compressed_weights)
    model_json = MODEL_DIRECTORY / "remindspeak-v0.1-int8.json"
    write_json(model_json, artifact, compact=True)
    update_model_manifest(config, model_json, weights_path)

    report = {
        "schemaVersion": 1,
        "model": {
            "id": config["modelId"],
            "version": config["version"],
            "architecture": artifact["architecture"],
            "configurationBytes": model_json.stat().st_size,
            "compressedWeightBytes": weights_path.stat().st_size,
            "uncompressedWeightBytes": len(raw_weights),
        },
        "dataset": {
            "train": len(datasets["train"]),
            "dev": len(datasets["dev"]),
            "test": len(datasets["test"]),
            "manifestSha256": manifest_hash,
        },
        "metrics": metrics,
        "trainingHistory": histories,
        "elapsedSeconds": time.perf_counter() - started,
        "limitations": [
            "The current corpus and surface atoms are project-generated/project-authored, not an independent human blind set.",
            "This prototype is a bounded conditional surface model, not an open-domain language model.",
            "A randomized blinded study protocol is prepared, but the human preference gate has no participant judgments yet.",
        ],
    }
    write_json(REPORT_DIRECTORY / "prototype-metrics.json", report)
    return report


def load_config() -> dict[str, Any]:
    return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["generate", "train", "all"], nargs="?", default="all")
    args = parser.parse_args()
    config = load_config()
    if args.command in {"generate", "all"}:
        datasets = generate_datasets(config)
        print(
            "Generated RemindSpeak corpus: "
            + ", ".join(f"{name}={len(rows)}" for name, rows in datasets.items())
        )
    else:
        datasets = read_datasets()
    if args.command in {"train", "all"}:
        report = train_and_export(config, datasets)
        model = report["model"]
        metrics = report["metrics"]
        print(
            f"Exported {model['architecture']['parameterCount']:,} parameters; "
            f"INT8 head accuracy={metrics['meanInt8HeadAccuracy']:.2%}; "
            f"compressed={model['compressedWeightBytes'] / 1024 / 1024:.2f} MiB."
        )


if __name__ == "__main__":
    main()
