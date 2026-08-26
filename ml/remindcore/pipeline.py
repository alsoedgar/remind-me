"""Generate, train, calibrate, evaluate, quantize, and export RemindCore.

The pipeline intentionally uses only NumPy for learning. It does not download a
teacher or initialize from another model. The shipped planner is a compact set of
INT8 task heads over deterministic hashed text features; calendar facts are still
compiled and validated by the TypeScript CalendarIR boundary.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import math
import random
import re
import statistics
import sys
import time
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Sequence

import numpy as np


WORKSPACE = Path(__file__).resolve().parents[2]
ROOT = WORKSPACE / "ml"
LOCAL_DEPENDENCIES = ROOT / ".deps"
if LOCAL_DEPENDENCIES.exists():
    sys.path.insert(0, str(LOCAL_DEPENDENCIES))
GENERATED = ROOT / "remindcore" / ".generated"
DATA_DIRECTORY = GENERATED / "dataset"
MODEL_DIRECTORY = WORKSPACE / "models" / "remindcore"
REPORT_DIRECTORY = ROOT / "remindcore" / "reports"
MANIFEST_PATH = ROOT / "remindcore" / "data" / "manifest.json"
HELDOUT_FIXTURE_PATH = WORKSPACE / "fixtures" / "remindcore" / "heldout.v0.1.jsonl"
CONFIG_PATH = ROOT / "remindcore" / "config.json"
TEACHER_DATA_PATH = ROOT / "teacher_assisted" / "accepted" / "remindcore.json"

TOKEN_PATTERN = re.compile(r"[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*|[^\s]", re.UNICODE)

OPERATIONS = [
    "event.create",
    "event.duplicate",
    "event.update",
    "event.move",
    "event.delete",
    "reminder.create",
    "reminder.update",
    "reminder.complete",
    "reminder.delete",
    "calendar.list",
    "calendar.search",
    "calendar.availability",
    "calendar.conflicts",
    "assistant.unsupported",
]
RISKS = ["read", "low", "medium", "high", "destructive"]
TOKEN_LABELS = [
    "O",
    "B-TITLE",
    "I-TITLE",
    "B-TARGET",
    "I-TARGET",
    "B-DATE",
    "I-DATE",
    "B-TIME",
    "I-TIME",
    "B-RECURRENCE",
    "I-RECURRENCE",
]

OPERATION_RISK = {
    "event.create": "low",
    "event.duplicate": "low",
    "event.update": "medium",
    "event.move": "medium",
    "event.delete": "destructive",
    "reminder.create": "low",
    "reminder.update": "medium",
    "reminder.complete": "low",
    "reminder.delete": "destructive",
    "calendar.list": "read",
    "calendar.search": "read",
    "calendar.availability": "read",
    "calendar.conflicts": "read",
    "assistant.unsupported": "read",
}

SAFE_ASSISTED_OPERATIONS = {
    "event.create",
    "reminder.create",
    "calendar.list",
    "calendar.search",
    "calendar.availability",
    "calendar.conflicts",
}

TEMPLATES: dict[str, dict[str, list[tuple[str, str]]]] = {
    "train": {
        "event.create": [
            ("event-direct-schedule", "Schedule {title} {date} {time} {recurrence}"),
            ("event-direct-add", "Add {title} to my calendar {date} {time} {recurrence}"),
            ("event-direct-block", "Block {title} {date} {time} {recurrence}"),
            ("event-politeness", "Please put {title} on the calendar for {date} {time} {recurrence}"),
        ],
        "event.duplicate": [
            ("duplicate-direct", "Duplicate {target} to {date} {time} {recurrence}"),
            ("duplicate-copy", "Copy {target} onto {date} {time} {recurrence}"),
            ("duplicate-clone", "Clone {target} for {date} {time} {recurrence}"),
        ],
        "reminder.create": [
            ("reminder-direct", "Remind me to {title} {date} {time} {recurrence}"),
            ("reminder-remember", "Remember to {title} {date} {time} {recurrence}"),
            ("reminder-set", "Set a reminder to {title} {date} {time} {recurrence}"),
            ("reminder-about", "Add a reminder about {title} {date} {time} {recurrence}"),
        ],
        "calendar.list": [
            ("list-what", "What do I have {date} {time}"),
            ("list-show", "Show me my schedule {date} {time}"),
            ("list-busy", "How busy am I {date} {time}"),
        ],
        "calendar.search": [
            ("search-find", "Find {target}"),
            ("search-when", "When is {target}"),
            ("search-look-up", "Look up {target}"),
        ],
        "calendar.availability": [
            ("availability-free", "Am I free {date} {time}"),
            ("availability-open", "Is that time open {date} {time}"),
            ("availability-available", "Am I available {date} {time}"),
        ],
        "calendar.conflicts": [
            ("conflict-direct", "Do I have any conflicts {date} {time}"),
            ("conflict-overlap", "Show overlaps {date} {time}"),
            ("conflict-double", "Am I double booked {date} {time}"),
        ],
        "event.move": [
            ("move-direct", "Move {target} to {date} {time}"),
            ("move-reschedule", "Reschedule {target} for {date} {time}"),
        ],
        "event.update": [
            ("event-rename", "Rename {target} to {title}"),
            ("event-call", "Call {target} {title} instead"),
        ],
        "event.delete": [
            ("event-delete", "Delete {target}"),
            ("event-cancel", "Cancel {target}"),
        ],
        "reminder.update": [
            ("reminder-rename", "Rename reminder {target} to {title}"),
            ("reminder-change", "Change reminder {target} to {title}"),
        ],
        "reminder.complete": [
            ("complete-mark", "Mark {target} done"),
            ("complete-finish", "Finish {target}"),
            ("complete-check", "Check off {target}"),
        ],
        "reminder.delete": [
            ("reminder-delete", "Delete reminder {target}"),
            ("reminder-remove", "Remove my reminder {target}"),
        ],
    },
    "dev": {
        "event.create": [
            ("event-carve", "Can you carve out time for {title} {date} {time} {recurrence}"),
            ("event-pencil", "I'd like {title} penciled in {date} {time} {recurrence}"),
        ],
        "reminder.create": [
            ("reminder-forget", "Make sure I don't forget to {title} {date} {time} {recurrence}"),
            ("reminder-prompt", "Prompt me to {title} {date} {time} {recurrence}"),
        ],
        "calendar.list": [
            ("list-walk", "Walk me through my agenda {date} {time}"),
            ("list-plans", "What are my plans {date} {time}"),
        ],
        "calendar.search": [
            ("search-locate", "Locate {target} on my calendar"),
            ("search-hunt", "Can you hunt down {target}"),
        ],
        "calendar.availability": [
            ("availability-room", "Do I have room {date} {time}"),
            ("availability-clear", "Does my calendar look clear {date} {time}"),
        ],
        "calendar.conflicts": [
            ("conflict-clash", "Are there any clashes {date} {time}"),
            ("conflict-collision", "Check for calendar collisions {date} {time}"),
        ],
        "event.move": [("move-shift", "Shift {target} over to {date} {time}")],
        "event.duplicate": [("duplicate-again", "Put another {target} on {date} {time} {recurrence}")],
        "event.update": [("event-retitle", "Retitle {target} as {title}")],
        "event.delete": [("event-take-off", "Take {target} off my calendar")],
        "reminder.update": [("reminder-reword", "Reword {target} as {title}")],
        "reminder.complete": [("complete-cross", "Cross {target} off")],
        "reminder.delete": [("reminder-drop", "Drop the reminder {target}")],
    },
    "test": {
        "event.create": [
            ("event-make-room", "Make room in my calendar for {title} {date} {time} {recurrence}"),
            ("event-hold", "Please hold {date} {time} for {title} {recurrence}"),
        ],
        "reminder.create": [
            ("reminder-nudge", "Give me a nudge to {title} {date} {time} {recurrence}"),
            ("reminder-jog", "Jog my memory about {title} {date} {time} {recurrence}"),
        ],
        "calendar.list": [
            ("list-looking", "How is {date} looking {time}"),
            ("list-rundown", "Give me the rundown for {date} {time}"),
        ],
        "calendar.search": [
            ("search-track", "Track down {target} for me"),
            ("search-spot", "Where did I put {target}"),
        ],
        "calendar.availability": [
            ("availability-space", "Is there space in my day {date} {time}"),
            ("availability-squeeze", "Could I squeeze something in {date} {time}"),
        ],
        "calendar.conflicts": [
            ("conflict-bump", "Does anything bump into something else {date} {time}"),
            ("conflict-competing", "Find competing plans {date} {time}"),
        ],
        "event.move": [("move-slide", "Slide {target} to {date} {time}")],
        "event.duplicate": [("duplicate-second", "Make a second {target} for {date} {time} {recurrence}")],
        "event.update": [("event-label", "Give {target} the new name {title}")],
        "event.delete": [("event-scrap", "Scrap {target} from my plans")],
        "reminder.update": [("reminder-edit", "Edit {target} so it says {title}")],
        "reminder.complete": [("complete-tick", "Tick {target} off my list")],
        "reminder.delete": [("reminder-erase", "Erase the reminder for {target}")],
    },
}

# A scratch model has no pretrained synonym knowledge. These training-only lexical
# frames teach the supported vocabulary while the dev/test *sentence families*
# remain disjoint. This is a deliberate compositional split, not a zero-shot claim.
TEMPLATES["train"]["event.create"].extend(
    [
        ("event-lexical-carve", "Carve out {date} {time} for {title} {recurrence}"),
        ("event-lexical-pencil", "Pencil {title} into my day {date} {time} {recurrence}"),
        ("event-lexical-room", "Make room for {title} {date} {time} {recurrence}"),
        ("event-lexical-hold", "Hold time for {title} on {date} {time} {recurrence}"),
    ]
)
TEMPLATES["train"]["reminder.create"].extend(
    [
        ("reminder-lexical-nudge", "Nudge me about {title} {date} {time} {recurrence}"),
        ("reminder-lexical-jog", "Jog my memory to {title} {date} {time} {recurrence}"),
        ("reminder-lexical-forget", "Don't let me forget {title} {date} {time} {recurrence}"),
        ("reminder-lexical-prompt", "Give me a prompt for {title} {date} {time} {recurrence}"),
    ]
)
TEMPLATES["train"]["calendar.list"].extend(
    [
        ("list-lexical-agenda", "Read my agenda for {date} {time}"),
        ("list-lexical-rundown", "I need a rundown of {date} {time}"),
        ("list-lexical-looking", "Tell me how {date} is looking {time}"),
    ]
)
TEMPLATES["train"]["calendar.search"].extend(
    [
        ("search-lexical-locate", "Help locate {target}"),
        ("search-lexical-hunt", "Hunt for {target}"),
        ("search-lexical-track", "Track {target} down"),
        ("search-lexical-where", "Where is {target} on the calendar"),
    ]
)
TEMPLATES["train"]["calendar.availability"].extend(
    [
        ("availability-lexical-room", "Is there room {date} {time}"),
        ("availability-lexical-clear", "Is my day clear {date} {time}"),
        ("availability-lexical-space", "Do I have space {date} {time}"),
        ("availability-lexical-squeeze", "Can I squeeze in a plan {date} {time}"),
    ]
)
TEMPLATES["train"]["calendar.conflicts"].extend(
    [
        ("conflict-lexical-clash", "Find clashes {date} {time}"),
        ("conflict-lexical-collision", "Look for collisions {date} {time}"),
        ("conflict-lexical-bump", "Will any plans bump together {date} {time}"),
        ("conflict-lexical-competing", "Check competing plans {date} {time}"),
    ]
)
TEMPLATES["train"]["event.move"].extend(
    [
        ("move-lexical-shift", "Shift {target} to {date} {time}"),
        ("move-lexical-slide", "Slide {target} over to {date} {time}"),
    ]
)
TEMPLATES["train"]["event.duplicate"].extend(
    [
        ("duplicate-lexical-another", "Put another {target} on {date} {time} {recurrence}"),
        ("duplicate-lexical-second", "Make a second copy of {target} for {date} {time} {recurrence}"),
        ("duplicate-lexical-again", "Schedule {target} again on {date} {time} {recurrence}"),
    ]
)
TEMPLATES["train"]["event.update"].extend(
    [
        ("event-lexical-retitle", "Retitle {target} to {title}"),
        ("event-lexical-new-name", "Give {target} a new name: {title}"),
    ]
)
TEMPLATES["train"]["event.delete"].extend(
    [
        ("event-lexical-take-off", "Take {target} off the calendar"),
        ("event-lexical-scrap", "Scrap the plan {target}"),
    ]
)
TEMPLATES["train"]["reminder.update"].extend(
    [
        ("reminder-lexical-reword", "Reword {target} to {title}"),
        ("reminder-lexical-edit", "Edit reminder {target} to say {title}"),
    ]
)
TEMPLATES["train"]["reminder.complete"].extend(
    [
        ("complete-lexical-cross", "Cross off {target}"),
        ("complete-lexical-tick", "Tick {target} as finished"),
    ]
)
TEMPLATES["train"]["reminder.delete"].extend(
    [
        ("reminder-lexical-drop", "Drop reminder {target}"),
        ("reminder-lexical-erase", "Erase my {target} reminder"),
    ]
)

# These additional families deliberately cover conversational, indirect, and
# compact request surfaces. They remain project-authored frames whose slot
# values are filled programmatically. These particular frames are project-authored
# and contain no teacher output or conversation logs; accepted teacher frames are
# loaded separately below. Development and test families stay split-disjoint.
BROAD_TEMPLATES: dict[str, dict[str, list[tuple[str, str]]]] = {
    "train": {
        "event.create": [
            ("train-broad-set-aside", "Set aside {date} {time} for {title} {recurrence}"),
            ("train-broad-put-down", "Put down {title} for {date} {time} {recurrence}"),
            ("train-broad-need-calendar", "I need {title} on my calendar {date} {time} {recurrence}"),
            ("train-broad-lets-schedule", "Let's schedule {title} {date} {time} {recurrence}"),
            ("train-broad-reserve", "Reserve {date} {time} for {title} {recurrence}"),
        ],
        "event.duplicate": [
            ("train-broad-repeat-event", "Repeat {target} on {date} {time} {recurrence}"),
            ("train-broad-same-event", "Add the same {target} for {date} {time} {recurrence}"),
            ("train-broad-use-copy", "Use {target} as a copy for {date} {time} {recurrence}"),
        ],
        "reminder.create": [
            ("train-broad-heads-up", "Give me a heads-up to {title} {date} {time} {recurrence}"),
            ("train-broad-make-sure", "Make sure I remember to {title} {date} {time} {recurrence}"),
            ("train-broad-like-reminder", "I'd like a reminder to {title} {date} {time} {recurrence}"),
            ("train-broad-ping", "Ping me to {title} {date} {time} {recurrence}"),
        ],
        "calendar.list": [
            ("train-broad-coming-up", "What's coming up {date} {time}"),
            ("train-broad-on-deck", "Tell me what's on deck {date} {time}"),
            ("train-broad-catch-up", "Catch me up on my plans {date} {time}"),
            ("train-broad-day-look", "What does my day look like {date} {time}"),
        ],
        "calendar.search": [
            ("train-broad-do-i-have", "Do I have {target} on my calendar"),
            ("train-broad-pull-up", "Pull up {target}"),
            ("train-broad-which-day", "Which day is {target}"),
        ],
        "calendar.availability": [
            ("train-broad-fit", "Could I fit something in {date} {time}"),
            ("train-broad-book-window", "Can I book that window {date} {time}"),
            ("train-broad-have-opening", "Do I have an opening {date} {time}"),
        ],
        "calendar.conflicts": [
            ("train-broad-overlapping", "Is anything overlapping {date} {time}"),
            ("train-broad-collide", "Do any plans collide {date} {time}"),
            ("train-broad-conflict-check", "Run a conflict check {date} {time}"),
        ],
        "event.move": [
            ("train-broad-push", "Push {target} to {date} {time}"),
            ("train-broad-bump", "Bump {target} over to {date} {time}"),
            ("train-broad-change-time", "Change the time for {target} to {date} {time}"),
        ],
        "event.update": [
            ("train-broad-change-title", "Change the title of {target} to {title}"),
            ("train-broad-update-name", "Update {target} with the name {title}"),
        ],
        "event.delete": [
            ("train-broad-remove-event", "Remove {target} from my calendar"),
            ("train-broad-get-rid-event", "Get rid of the event {target}"),
        ],
        "reminder.update": [
            ("train-broad-change-reminder", "Update the reminder {target} to {title}"),
            ("train-broad-fix-reminder", "Fix {target} so the reminder says {title}"),
        ],
        "reminder.complete": [
            ("train-broad-done-with", "I'm done with {target}"),
            ("train-broad-complete-reminder", "Complete the reminder {target}"),
        ],
        "reminder.delete": [
            ("train-broad-remove-reminder", "Remove the reminder for {target}"),
            ("train-broad-clear-reminder", "Clear my {target} reminder"),
        ],
    },
    "dev": {
        "event.create": [("dev-broad-find-time", "Find a place for {title} {date} {time} {recurrence}")],
        "event.duplicate": [("dev-broad-do-again", "Do {target} again {date} {time} {recurrence}")],
        "reminder.create": [("dev-broad-keep-on-radar", "Keep {title} on my radar {date} {time} {recurrence}")],
        "calendar.list": [("dev-broad-fill-me-in", "Fill me in on {date} {time}")],
        "calendar.search": [("dev-broad-bring-up", "Bring up {target} for me")],
        "calendar.availability": [("dev-broad-gap", "Is there a gap {date} {time}")],
        "calendar.conflicts": [("dev-broad-tangled", "Are my plans tangled up {date} {time}")],
        "event.move": [("dev-broad-put-later", "Put {target} at {date} {time} instead")],
        "event.update": [("dev-broad-adjust-label", "Adjust the label on {target} to {title}")],
        "event.delete": [("dev-broad-lose-event", "Lose {target} from the schedule")],
        "reminder.update": [("dev-broad-revise-reminder", "Revise {target} to read {title}")],
        "reminder.complete": [("dev-broad-wrap-up", "Wrap up {target}")],
        "reminder.delete": [("dev-broad-dismiss-reminder", "Dismiss the reminder {target}")],
    },
    "test": {
        "event.create": [("test-broad-slot-in", "Slot in {title} {date} {time} {recurrence}")],
        "event.duplicate": [("test-broad-reuse", "Reuse {target} for {date} {time} {recurrence}")],
        "reminder.create": [("test-broad-flag", "Flag {title} for me {date} {time} {recurrence}")],
        "calendar.list": [("test-broad-whats-ahead", "What's ahead for me {date} {time}")],
        "calendar.search": [("test-broad-surface", "Surface {target} from my plans")],
        "calendar.availability": [("test-broad-breathing-room", "Is there breathing room {date} {time}")],
        "calendar.conflicts": [("test-broad-interfere", "Do any plans interfere {date} {time}")],
        "event.move": [("test-broad-scoot", "Scoot {target} to {date} {time}")],
        "event.update": [("test-broad-correct-name", "Correct the name of {target} to {title}")],
        "event.delete": [("test-broad-pull-event", "Pull {target} from the calendar")],
        "reminder.update": [("test-broad-revise-wording", "Revise the wording of {target} to {title}")],
        "reminder.complete": [("test-broad-settle", "Settle the reminder {target}")],
        "reminder.delete": [("test-broad-discard-reminder", "Discard my reminder {target}")],
    },
}

for split, operation_templates in BROAD_TEMPLATES.items():
    for operation, templates in operation_templates.items():
        TEMPLATES[split][operation].extend(templates)

# The scratch classifier cannot inherit synonym knowledge. These training-only
# sentences expose the lexical cues used by the held-out broad families while
# preserving different sentence structures and distinct family IDs.
BROAD_LEXICAL_TEMPLATES: dict[str, list[tuple[str, str]]] = {
    "event.create": [
        ("train-lexical-find-place", "Find calendar time for {title} {date} {time} {recurrence}"),
        ("train-lexical-slot", "Slot time for {title} {date} {time} {recurrence}"),
    ],
    "event.duplicate": [
        ("train-lexical-do-again", "Do another {target} again on {date} {time} {recurrence}"),
        ("train-lexical-reuse", "Reuse a copy of {target} {date} {time} {recurrence}"),
    ],
    "reminder.create": [
        ("train-lexical-radar", "Put {title} on my reminder radar {date} {time} {recurrence}"),
        ("train-lexical-flag", "Flag a reminder for {title} {date} {time} {recurrence}"),
    ],
    "calendar.list": [
        ("train-lexical-fill-in", "Fill me in with my schedule {date} {time}"),
        ("train-lexical-ahead", "Tell me what lies ahead {date} {time}"),
    ],
    "calendar.search": [
        ("train-lexical-bring-up", "Bring {target} up from the calendar"),
        ("train-lexical-surface", "Surface the calendar item {target}"),
    ],
    "calendar.availability": [
        ("train-lexical-gap", "Find a free gap {date} {time}"),
        ("train-lexical-breathing-room", "Check for breathing room {date} {time}"),
    ],
    "calendar.conflicts": [
        ("train-lexical-tangled", "Find tangled plans {date} {time}"),
        ("train-lexical-interfere", "Check whether plans interfere {date} {time}"),
    ],
    "event.move": [
        ("train-lexical-scoot", "Scoot the event {target} over to {date} {time}"),
        ("train-lexical-instead", "Put {target} on {date} {time} instead"),
    ],
    "event.update": [
        ("train-lexical-adjust-label", "Adjust {target} with the label {title}"),
        ("train-lexical-correct-name", "Correct {target} with the name {title}"),
    ],
    "event.delete": [
        ("train-lexical-lose", "Lose the calendar event {target}"),
        ("train-lexical-pull", "Pull the event {target} off my plans"),
    ],
    "reminder.update": [
        ("train-lexical-revise-read", "Revise reminder {target} so it reads {title}"),
        ("train-lexical-revise-wording", "Revise the reminder wording from {target} to {title}"),
    ],
    "reminder.complete": [
        ("train-lexical-wrap-up", "Wrap the reminder {target} up as done"),
        ("train-lexical-settle", "Settle {target} as a completed reminder"),
    ],
    "reminder.delete": [
        ("train-lexical-dismiss", "Dismiss {target} from my reminders"),
        ("train-lexical-discard", "Discard the reminder for {target}"),
    ],
}

for operation, templates in BROAD_LEXICAL_TEMPLATES.items():
    TEMPLATES["train"][operation].extend(templates)

# A few low-frequency scratch-only synonyms need additional independent
# contexts to learn a stable operation boundary. These are varied frames, not
# duplicated records, and their weighting is explicit here for reproducibility.
LEXICAL_REINFORCEMENT: dict[str, list[tuple[str, str]]] = {
    "event.duplicate": [
        ("train-reinforce-reuse-on", "Reuse {target} on {date} {time} {recurrence}"),
        ("train-reinforce-reuse-event", "Reuse the event {target} for {date} {time} {recurrence}"),
        ("train-reinforce-reused-copy", "Schedule a reused copy of {target} {date} {time} {recurrence}"),
        ("train-reinforce-second-copy", "Create a second copy of {target} {date} {time} {recurrence}"),
        ("train-reinforce-repeat-copy", "Repeat a copy of {target} {date} {time} {recurrence}"),
        ("train-reinforce-again-copy", "Put a copy of {target} on the calendar again {date} {time} {recurrence}"),
    ],
    "calendar.search": [
        ("train-reinforce-surface-item", "Surface the item named {target}"),
        ("train-reinforce-surface-plan", "Surface my plan for {target}"),
        ("train-reinforce-surface-calendar", "Surface {target} from the calendar"),
        ("train-reinforce-search-surface", "Search and surface {target}"),
        ("train-reinforce-show-match", "Show the matching plan {target}"),
    ],
    "reminder.complete": [
        ("train-reinforce-settle-done", "Settle reminder {target} as done"),
        ("train-reinforce-settle-complete", "Settle {target} as complete"),
        ("train-reinforce-settle-finished", "Settle the reminder {target} as finished"),
        ("train-reinforce-wrap-finished", "Wrap up {target} as finished"),
        ("train-reinforce-finish-reminder", "Finish and settle reminder {target}"),
    ],
    "reminder.update": [
        ("train-reinforce-revise-wording", "Revise the wording for {target} so it says {title}"),
        ("train-reinforce-revise-text", "Revise reminder text {target} to {title}"),
        ("train-reinforce-wording-change", "Change the wording of {target} to {title}"),
        ("train-reinforce-revise-name", "Revise the reminder {target} with {title}"),
    ],
    "event.delete": [
        ("train-reinforce-pull-calendar", "Pull {target} from the calendar"),
        ("train-reinforce-pull-schedule", "Pull {target} off the schedule"),
        ("train-reinforce-pull-remove", "Pull and remove the event {target}"),
    ],
}

for operation, templates in LEXICAL_REINFORCEMENT.items():
    TEMPLATES["train"][operation].extend(templates)


def load_teacher_data() -> dict[str, Any]:
    if not TEACHER_DATA_PATH.exists():
        return {"templates": [], "ood": [], "challengeInstantiationsPerTemplate": 0}
    value = json.loads(TEACHER_DATA_PATH.read_text(encoding="utf-8"))
    if value.get("schemaVersion") != 1:
        raise ValueError("Unsupported teacher-assisted RemindCore corpus")
    return value


TEACHER_DATA = load_teacher_data()
TEACHER_TEMPLATES = list(TEACHER_DATA.get("templates", []))


# Sentence wrappers multiply pragmatic surface forms without changing the slot
# program. IDs are disjoint by split so the manifest can audit this additional
# compositional boundary independently from template-family separation.
SURFACE_FRAMES: dict[str, list[tuple[str, str, str]]] = {
    "train": [
        ("train-frame-direct", "", ""),
        ("train-frame-please", "Please, ", "."),
        ("train-frame-can-you", "Can you ", "?"),
        ("train-frame-would-you", "Would you ", "?"),
        ("train-frame-can-please", "Can you please ", "?"),
        ("train-frame-would-please", "Would you please ", "?"),
        ("train-frame-please-do", "Please do ", "."),
    ],
    "dev": [
        ("dev-frame-direct", "", ""),
        ("dev-frame-can", "Can you ", "?"),
        ("dev-frame-would", "Would you ", "?"),
        ("dev-frame-please", "Please, ", "."),
    ],
    "test": [
        ("test-frame-direct", "", ""),
        ("test-frame-please-do", "Please do ", "."),
        ("test-frame-can-please", "Can you please ", "?"),
        ("test-frame-would-please", "Would you please ", "?"),
    ],
}

QUERY_SURFACE_FRAMES: dict[str, list[tuple[str, str, str]]] = {
    "train": [
        ("train-query-direct", "", ""),
        ("train-query-quick", "Quick question: ", "?"),
        ("train-query-checking", "Just checking: ", "?"),
        ("train-query-planning", "For planning, ", "?"),
        ("train-query-decide", "Before I decide, ", "?"),
        ("train-query-curious", "Curious about this: ", "?"),
        ("train-query-looking", "As I look ahead, ", "?"),
        ("train-query-wondering", "I’ve been wondering: ", "?"),
        ("train-query-can-plan", "So I can plan ahead, ", "?"),
    ],
    "dev": [
        ("dev-query-direct", "", ""),
        ("dev-query-curious", "I’m curious: ", "?"),
        ("dev-query-ahead", "Looking ahead, ", "?"),
    ],
    "test": [
        ("test-query-direct", "", ""),
        ("test-query-wondering", "I was wondering: ", "?"),
        ("test-query-plan", "So I can plan, ", "?"),
    ],
}

STATEMENT_SURFACE_FRAMES: dict[str, list[tuple[str, str, str]]] = {
    "train": [
        ("train-statement-direct", "", ""),
        ("train-statement-note", "Quick note: ", "."),
        ("train-statement-calendar", "For my calendar, ", "."),
        ("train-statement-ahead", "Thinking ahead, ", "."),
    ],
    "dev": [
        ("dev-statement-direct", "", ""),
        ("dev-statement-small", "One small thing: ", "."),
        ("dev-statement-plans", "For my plans, ", "."),
    ],
    "test": [
        ("test-statement-direct", "", ""),
        ("test-statement-heads-up", "A heads-up: ", "."),
        ("test-statement-thinking", "I’m thinking ahead: ", "."),
    ],
}

OOD_BY_SPLIT = {
    "train": [
        "Write me a poem about late summer",
        "What is the weather tomorrow",
        "Send an email to Morgan",
        "Explain how black holes work",
        "Order more coffee beans",
        "Play something quiet",
        "How many cups are in a gallon",
        "Summarize this article for me",
        "Book a flight to Denver",
        "Tell me a joke",
        "Draft a friendly note to my manager",
        "Will it rain Friday afternoon",
        "Find a tomato soup recipe",
        "Dim the living room lights",
        "Recommend something to watch",
        "Help debug a TypeScript error",
        "Reserve a restaurant table",
        "Translate a paragraph to Spanish",
        "Compare train ticket prices",
        "Make a weekend grocery list",
        "Hello there",
        "How are you doing today",
        "What kind of assistant are you",
        "What can you help me with",
        "Who made you",
        "Tell me something interesting",
        "What happened in the news",
        "Explain recursion in simple terms",
        "Write a short birthday card",
        "Help me plan a healthy dinner",
        "What is the capital of Portugal",
        "Convert twenty dollars to euros",
        "How do I reset my router",
        "Suggest a book for vacation",
        "Give me advice about a friendship",
        "Create a workout routine",
        "Can you answer a general question",
        "Describe the photo I attached",
        "Summarize the PDF I imported",
        "What will technology look like in ten years",
    ],
    "dev": [
        "Draft a friendly message to my manager",
        "Will it rain on Friday afternoon",
        "Find a recipe for tomato soup",
        "Turn the living room lights down",
        "What should I watch tonight",
        "Good morning how is it going",
        "Tell me what you are capable of",
        "Explain why the sky looks blue",
        "Help me compose a thank you note",
        "What might cities be like in the future",
    ],
    "test": [
        "Help me debug this TypeScript error",
        "Reserve a table at a nearby restaurant",
        "Translate this paragraph into Spanish",
        "How much is a train ticket to Chicago",
        "Make a grocery list for the weekend",
        "Hi what can you do for me",
        "Tell me about yourself",
        "Teach me the basics of photosynthesis",
        "Write a friendly congratulations message",
        "What was daily life like a century ago",
    ],
}

TEACHER_OOD_TEXTS = {
    str(value["text"])
    for value in TEACHER_DATA.get("ood", [])
    if value.get("split") == "train"
}

VALUES = {
    "train": {
        "title": [
            "team sync",
            "call Mom",
            "water the plants",
            "dentist appointment",
            "deep work",
            "pick up groceries",
            "project review",
            "take medication",
            "yoga class",
            "submit the report",
            "CS 251 lecture",
            "calculus discussion",
            "chemistry lab",
            "office hours",
            "therapy session",
            "morning run",
            "school pickup",
            "dinner with Alex",
            "focus block",
            "budget check-in",
            "car service",
            "flight check-in",
            "volunteer shift",
            "language practice",
            "weekly planning",
            "client demo",
            "study group",
            "vet appointment",
            "rent payment",
            "meal prep",
        ],
        "target": [
            "team sync",
            "water the plants",
            "project review",
            "dentist",
            "yoga class",
            "CS 251 lecture",
            "calculus discussion",
            "office hours",
            "school pickup",
            "client demo",
            "study group",
            "weekly planning",
            "car service",
            "therapy session",
            "rent payment",
        ],
        "date": [
            "today",
            "tomorrow",
            "next Friday",
            "this Monday",
            "September 2",
            "2026-09-04",
            "the day after tomorrow",
            "this Saturday",
            "next week",
            "August 31",
            "9/12/2026",
            "two days from now",
            "this weekend",
            "next Thursday",
            "October 3",
            "2026-10-19",
        ],
        "time": [
            "at 8 AM",
            "at 6:30 PM",
            "at noon",
            "from 2 PM to 4 PM",
            "in the morning",
            "at 1 PM",
            "at 9:45 AM",
            "around 3 PM",
            "between 10 AM and 11 AM",
            "at 13:30",
            "in the evening",
            "after lunch",
        ],
        "recurrence": [
            "",
            "every day",
            "every week",
            "every weekday",
            "monthly",
            "on Mondays and Wednesdays",
            "every other Friday",
            "on weekends",
            "twice a week",
            "until the end of the month",
        ],
    },
    "dev": {
        "title": ["budget huddle", "renew the library books", "practice cello", "lunch with Priya", "physics recitation", "passport renewal", "design critique", "evening walk"],
        "target": ["budget huddle", "library books", "cello practice", "lunch with Priya", "physics recitation", "passport renewal", "design critique", "evening walk"],
        "date": ["day after tomorrow", "next Tuesday", "October 11", "10/14/2026", "this Sunday", "three days from now", "November 9", "2026-12-02"],
        "time": ["at 7:15 AM", "at 5 PM", "in the evening", "from 10 AM to noon", "around 11 AM", "at 14:20", "after dinner", "between 3 PM and 5 PM"],
        "recurrence": ["", "every two weeks", "weekly", "on Tuesdays and Thursdays", "through December"],
    },
    "test": {
        "title": ["portfolio polish", "feed Juniper", "planning retro", "coffee with Elena", "biology seminar", "tax appointment", "reading hour", "train departure"],
        "target": ["portfolio polish", "feed Juniper", "planning retro", "coffee with Elena", "biology seminar", "tax appointment", "reading hour", "train departure"],
        "date": ["next Wednesday", "November 6", "11/8/2026", "tomorrow", "this Friday", "four days from now", "December 14", "2027-01-05"],
        "time": ["at 9:45 AM", "at 4 PM", "in the afternoon", "from 1 PM to 3 PM", "around 8:30 AM", "at 18:10", "before lunch", "between 6 PM and 7 PM"],
        "recurrence": ["", "every month", "daily", "on Monday Wednesday and Friday", "every other week"],
    },
}


@dataclass(frozen=True)
class Token:
    text: str
    normalized: str
    start: int
    end: int


def compact_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_bytes(contents: bytes) -> str:
    return hashlib.sha256(contents).hexdigest()


def normalize_text(text: str) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", text).lower()).strip()


def tokens_with_spans(text: str) -> list[Token]:
    return [
        Token(match.group(0), normalize_text(match.group(0)), match.start(), match.end())
        for match in TOKEN_PATTERN.finditer(text)
    ]


def fnv1a_32(text: str) -> int:
    value = 2166136261
    for byte in text.encode("utf-8"):
        value ^= byte
        value = (value * 16777619) & 0xFFFFFFFF
    return value


def feature_ids(features: Iterable[str], buckets: int) -> np.ndarray:
    return np.fromiter(
        sorted({fnv1a_32(feature) % buckets for feature in features}), dtype=np.int64
    )


def token_shape(token: str) -> str:
    output: list[str] = []
    for character in token:
        shape = "A" if character.isupper() else "a" if character.islower() else "0" if character.isdigit() else "x"
        if not output or output[-1] != shape:
            output.append(shape)
    return "".join(output)[:8]


def global_feature_names(text: str, include_char: bool = True) -> set[str]:
    normalized = normalize_text(text)[:320]
    tokens = [token.normalized for token in tokens_with_spans(normalized)][:64]
    date_signal = bool(
        re.search(
            r"\b(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|"
            r"january|february|march|april|may|june|july|august|september|october|november|"
            r"december|\d{4}-\d{2}-\d{2}|\d{1,2}/\d{1,2})\b",
            normalized,
        )
    )
    time_signal = bool(
        re.search(
            r"\b(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)|noon|midnight|morning|afternoon|evening|night)\b",
            normalized,
        )
    )
    calendar_signal = bool(
        re.search(
            r"\b(?:calendar|schedule|agenda|plan|plans|remind|reminder|free|available|event|"
            r"meeting|appointment|conflict|overlap|booked|move|shift|duplicate|copy|clone|delete|cancel|done)\b",
            normalized,
        )
    )
    features = {
        "bias",
        f"length:{min(12, len(tokens) // 3)}",
        f"date-signal:{int(date_signal)}",
        f"time-signal:{int(time_signal)}",
        f"calendar-signal:{int(calendar_signal)}",
        f"temporal-pair:{int(date_signal)}{int(time_signal)}",
    }
    cue_patterns = {
        "event.create": r"\b(?:carve|pencil|penciled|make room|hold)\b",
        "reminder.create": r"\b(?:nudge|jog my memory|forget|prompt me|give me a prompt)\b",
        "calendar.list": r"\b(?:what do i have|show me my schedule|what(?:'s| is) on my|rundown|agenda|walk me through|how is .+ looking)\b",
        "calendar.search": r"\b(?:locate|hunt down|hunt for|track down|where did i put)\b",
        "calendar.availability": r"\b(?:squeeze|space in my day|calendar look clear|have room)\b",
        "calendar.conflicts": r"\b(?:clashes|collisions|bump into|competing plans)\b",
        "event.move": r"\b(?:move|reschedule|shift|slide)\b",
        "event.duplicate": r"\b(?:duplicate|copy|clone|another|second)\b",
        "event.update": r"\b(?:retitle|new name)\b",
        "event.delete": r"\b(?:scrap|take .+ off)\b",
        "reminder.update": r"\b(?:reword|edit .+ say|change reminder)\b",
        "reminder.complete": r"\b(?:cross .+ off|tick .+ off|mark .+ done|check off)\b",
        "reminder.delete": r"\b(?:drop (?:the )?reminder|erase (?:the )?reminder|remove my reminder)\b",
        "assistant.unsupported": r"\b(?:debug|email|flight|grocery list|rain|recipe|restaurant|reserve a table|ticket|translate|weather)\b",
    }
    for cue, pattern in cue_patterns.items():
        if re.search(pattern, normalized):
            features.add(f"semantic-cue:{cue}")
            for rank in range(4):
                features.add(f"semantic-cue-boost:{cue}:{rank}")
    for index, token in enumerate(tokens):
        features.add(f"w:{token}")
        features.add(f"shape:{token_shape(token)}")
        features.add(f"p2:{token[:2]}")
        features.add(f"p3:{token[:3]}")
        features.add(f"s2:{token[-2:]}")
        features.add(f"s3:{token[-3:]}")
        if index:
            features.add(f"w2:{tokens[index - 1]}|{token}")
    if include_char:
        padded = f"^^{normalized}$$"
        for size in (3, 4, 5):
            for index in range(max(0, len(padded) - size + 1)):
                features.add(f"c{size}:{padded[index:index + size]}")
    return features


def token_feature_names(tokens: Sequence[Token], index: int, operation: str) -> set[str]:
    token = tokens[index]
    previous = tokens[index - 1].normalized if index else "<s>"
    following = tokens[index + 1].normalized if index + 1 < len(tokens) else "</s>"
    value = token.normalized
    features = {
        "bias",
        f"tok:{value}",
        f"prev:{previous}",
        f"next:{following}",
        f"prev+tok:{previous}|{value}",
        f"tok+next:{value}|{following}",
        f"shape:{token_shape(token.text)}",
        f"p2:{value[:2]}",
        f"p3:{value[:3]}",
        f"s2:{value[-2:]}",
        f"s3:{value[-3:]}",
        f"position:{min(7, (index * 8) // max(1, len(tokens)))}",
        f"intent:{operation}",
        f"intent+prev:{operation}|{previous}",
        f"intent+next:{operation}|{following}",
    }
    wrapped = f"^{value}$"
    for size in (2, 3, 4):
        for start in range(max(0, len(wrapped) - size + 1)):
            features.add(f"tc{size}:{wrapped[start:start + size]}")
    return features


def corrupt_value(value: str, kind: str, randomizer: random.Random) -> str:
    if not value or kind == "clean":
        return value
    if kind == "asr":
        replacements = {
            "tomorrow": "to morrow",
            "calendar": "calender",
            "reminder": "remind her",
            "schedule": "skedule",
            "two": "to",
            "2": "two",
            "1 PM": "one p m",
            "3 PM": "three p m",
            "8 AM": "eight a m",
            "4 PM": "four p m",
            "6:30 PM": "six thirty p m",
        }
        output = value
        for source, target in replacements.items():
            output = output.replace(source, target)
        return output.lower()
    if kind == "chat":
        replacements = {
            "tomorrow": "tmrw",
            "please": "pls",
            "appointment": "appt",
            "minutes": "mins",
            "calendar": "cal",
            "reminder": "remndr",
        }
        output = value
        for source, target in replacements.items():
            output = output.replace(source, target)
        return output
    if kind == "ocr":
        replacements = str.maketrans({"o": "0", "O": "0", "l": "1"})
        candidates = [index for index, character in enumerate(value) if character in "oOl"]
        if not candidates:
            return value
        position = randomizer.choice(candidates)
        return value[:position] + value[position].translate(replacements) + value[position + 1 :]
    if kind == "typo" and len(value) > 4:
        candidates = [index for index, character in enumerate(value) if character.isalpha()]
        if candidates:
            position = randomizer.choice(candidates)
            return value[:position] + value[position + 1 :]
    return value


def render_template(template: str, values: dict[str, str]) -> tuple[str, list[dict[str, Any]]]:
    cursor = 0
    pieces: list[str] = []
    spans: list[dict[str, Any]] = []
    for match in re.finditer(r"\{([a-z]+)\}", template):
        pieces.append(template[cursor : match.start()])
        slot = match.group(1).upper()
        value = values.get(match.group(1), "")
        start = sum(len(piece) for piece in pieces)
        pieces.append(value)
        if value:
            spans.append({"kind": slot, "start": start, "end": start + len(value), "text": value})
        cursor = match.end()
    pieces.append(template[cursor:])
    text = re.sub(r"\s+", " ", "".join(pieces)).strip()

    # Whitespace compaction can shift offsets; locate each rendered value in order again.
    search_start = 0
    normalized_spans: list[dict[str, Any]] = []
    for span in spans:
        location = text.find(span["text"], search_start)
        if location < 0:
            location = text.find(span["text"])
        if location >= 0:
            normalized_spans.append(
                {**span, "start": location, "end": location + len(span["text"])}
            )
            search_start = location + len(span["text"])
    return text, normalized_spans


def ambiguity_variant(
    operation: str, template: str, values: dict[str, str], randomizer: random.Random
) -> tuple[dict[str, str], bool]:
    required: list[str] = []
    if operation in {"event.create", "reminder.create", "event.move", "event.duplicate"}:
        required = ["date", "time"]
    elif operation == "calendar.availability":
        required = ["date"]
    if not required or randomizer.random() >= 0.32:
        return values, False
    available = [name for name in required if f"{{{name}}}" in template]
    if not available:
        return values, False
    missing = randomizer.choice(available)
    return {**values, missing: ""}, True


def apply_surface_frame(
    text: str,
    spans: Sequence[dict[str, Any]],
    prefix: str,
    suffix: str,
) -> tuple[str, list[dict[str, Any]]]:
    if prefix and text:
        text = text[0].lower() + text[1:]
    framed = f"{prefix}{text}{suffix}"
    offset = len(prefix)
    return framed, [
        {**span, "start": int(span["start"]) + offset, "end": int(span["end"]) + offset}
        for span in spans
    ]


def surface_frames_for_text(
    split: str, operation: str, text: str
) -> list[tuple[str, str, str]]:
    if operation == "calendar.search":
        return [QUERY_SURFACE_FRAMES[split][0]]
    if re.match(
        r"^(?:am|are|can|could|did|do|does|how|is|should|what|when|where|which|will|would)\b",
        text,
        flags=re.IGNORECASE,
    ):
        return QUERY_SURFACE_FRAMES[split]
    if re.match(r"^(?:i\b|i['’]m\b|i['’]d\b|let['’]s\b|don['’]t\b)", text, flags=re.IGNORECASE):
        return [STATEMENT_SURFACE_FRAMES[split][0]]
    return SURFACE_FRAMES[split]


def make_example(
    split: str, index: int, operation: str, randomizer: random.Random
) -> dict[str, Any]:
    if operation == "assistant.unsupported":
        source = randomizer.choice(OOD_BY_SPLIT[split])
        corruption = randomizer.choices(
            ["clean", "typo", "asr", "ocr", "chat"],
            weights=[0.67, 0.13, 0.09, 0.05, 0.06],
            k=1,
        )[0]
        text = corrupt_value(source, corruption, randomizer)
        return {
            "id": f"{split}:{index:06d}",
            "split": split,
            "sourceKind": (
                "teacher-assisted-ood"
                if source in TEACHER_OOD_TEXTS
                else "program-generated-ood"
            ),
            "templateFamily": f"ood-{split}",
            "locale": randomizer.choice(["en-US", "en-GB"]),
            "corruption": corruption,
            "surfaceFrame": "none",
            "text": text,
            "program": {"operation": operation, "risk": "read"},
            "ambiguous": False,
            "ood": True,
            "slots": [],
        }

    family, template = randomizer.choice(TEMPLATES[split][operation])
    value_pool = VALUES[split]
    corruption = randomizer.choices(
        ["clean", "typo", "asr", "ocr", "chat"],
        weights=[0.60, 0.15, 0.12, 0.06, 0.07],
        k=1,
    )[0]
    values = {
        name: corrupt_value(randomizer.choice(options), corruption, randomizer)
        for name, options in value_pool.items()
    }
    if operation == "reminder.create" and values["time"].startswith("from "):
        values["time"] = "at 2 PM"
    values, ambiguous = ambiguity_variant(operation, template, values, randomizer)
    text, spans = render_template(template, values)
    surface_frame, prefix, suffix = randomizer.choice(
        surface_frames_for_text(split, operation, text)
    )
    text, spans = apply_surface_frame(text, spans, prefix, suffix)
    if corruption == "asr":
        text = text.lower().rstrip(".?!")
    return {
        "id": f"{split}:{index:06d}",
        "split": split,
        "sourceKind": (
            "teacher-assisted-paraphrase"
            if family.startswith("teacher-qwen3-")
            else "program-generated"
        ),
        "templateFamily": family,
        "locale": randomizer.choice(["en-US", "en-GB"]),
        "corruption": corruption,
        "surfaceFrame": surface_frame,
        "text": text,
        "program": {"operation": operation, "risk": OPERATION_RISK[operation]},
        "ambiguous": ambiguous,
        "ood": False,
        "slots": spans,
    }


def write_jsonl(path: Path, examples: Sequence[dict[str, Any]]) -> tuple[int, str]:
    contents = "".join(compact_json(example) + "\n" for example in examples).encode("utf-8")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(contents)
    return len(contents), sha256_bytes(contents)


def generate_teacher_training(config: dict[str, Any]) -> list[dict[str, Any]]:
    randomizer = random.Random(int(config["seed"]) + 71_117)
    curriculum = config.get("teacherCurriculum", {})
    repetitions = int(curriculum.get("instantiationsPerTemplate", 0))
    ood_repeats = int(curriculum.get("oodRepeats", 0))
    examples: list[dict[str, Any]] = []
    training_templates = [
        value for value in TEACHER_TEMPLATES if value.get("split") == "train"
    ]
    for template_index, value in enumerate(training_templates):
        operation = str(value["operation"])
        template = re.sub(
            r"<([A-Z][A-Z0-9_]*)>",
            lambda match: "{" + match.group(1).lower() + "}",
            str(value["template"]),
        )
        for repetition in range(repetitions):
            corruption = randomizer.choices(
                ["clean", "typo", "asr", "chat"], weights=[0.66, 0.12, 0.14, 0.08], k=1
            )[0]
            values = {
                name: corrupt_value(randomizer.choice(options), corruption, randomizer)
                for name, options in VALUES["train"].items()
            }
            if not values["recurrence"]:
                values["recurrence"] = randomizer.choice(
                    [item for item in VALUES["train"]["recurrence"] if item]
                )
            if operation == "reminder.create" and values["time"].startswith("from "):
                values["time"] = "at 2 PM"
            text, spans = render_template(template, values)
            if corruption == "asr":
                text = text.lower().rstrip(".?!")
            examples.append(
                {
                    "id": f"teacher-train:{template_index:03d}:{repetition:03d}",
                    "split": "train",
                    "sourceKind": "teacher-assisted-paraphrase",
                    "templateFamily": str(value["id"]),
                    "locale": randomizer.choice(["en-US", "en-GB"]),
                    "corruption": corruption,
                    "surfaceFrame": "teacher-curriculum",
                    "text": text,
                    "program": {
                        "operation": operation,
                        "risk": OPERATION_RISK[operation],
                    },
                    "ambiguous": False,
                    "ood": False,
                    "slots": spans,
                }
            )
    for ood_index, value in enumerate(
        item for item in TEACHER_DATA.get("ood", []) if item.get("split") == "train"
    ):
        for repetition in range(ood_repeats):
            text = str(value["text"])
            corruption = "clean"
            if repetition % 5 == 4:
                corruption = "typo"
                text = corrupt_value(text, corruption, randomizer)
            examples.append(
                {
                    "id": f"teacher-train:ood:{ood_index:03d}:{repetition:03d}",
                    "split": "train",
                    "sourceKind": "teacher-assisted-ood",
                    "templateFamily": str(value["id"]),
                    "locale": "en-US",
                    "corruption": corruption,
                    "surfaceFrame": "teacher-curriculum",
                    "text": text,
                    "program": {"operation": "assistant.unsupported", "risk": "read"},
                    "ambiguous": False,
                    "ood": True,
                    "slots": [],
                }
            )
    randomizer.shuffle(examples)
    return examples


def generate_teacher_challenge(config: dict[str, Any]) -> list[dict[str, Any]]:
    randomizer = random.Random(int(config["seed"]) + 88_019)
    repetitions = int(TEACHER_DATA.get("challengeInstantiationsPerTemplate", 0))
    examples: list[dict[str, Any]] = []
    challenge_templates = [
        value for value in TEACHER_TEMPLATES if value.get("split") == "challenge"
    ]
    for template_index, value in enumerate(challenge_templates):
        operation = str(value["operation"])
        template = re.sub(
            r"<([A-Z][A-Z0-9_]*)>",
            lambda match: "{" + match.group(1).lower() + "}",
            str(value["template"]),
        )
        for repetition in range(repetitions):
            corruption = randomizer.choices(
                ["clean", "typo", "asr"], weights=[0.72, 0.12, 0.16], k=1
            )[0]
            values = {
                name: corrupt_value(randomizer.choice(options), corruption, randomizer)
                for name, options in VALUES["test"].items()
            }
            if not values["recurrence"]:
                values["recurrence"] = randomizer.choice(
                    [item for item in VALUES["test"]["recurrence"] if item]
                )
            if operation == "reminder.create" and values["time"].startswith("from "):
                values["time"] = "at 4 PM"
            text, spans = render_template(template, values)
            if corruption == "asr":
                text = text.lower().rstrip(".?!")
            examples.append(
                {
                    "id": f"teacher-challenge:{template_index:03d}:{repetition:03d}",
                    "split": "teacherChallenge",
                    "sourceKind": "teacher-assisted-heldout-paraphrase",
                    "templateFamily": str(value["id"]),
                    "locale": randomizer.choice(["en-US", "en-GB"]),
                    "corruption": corruption,
                    "surfaceFrame": "teacher-heldout",
                    "text": text,
                    "program": {
                        "operation": operation,
                        "risk": OPERATION_RISK[operation],
                    },
                    "ambiguous": False,
                    "ood": False,
                    "slots": spans,
                }
            )
    for index, value in enumerate(
        item for item in TEACHER_DATA.get("ood", []) if item.get("split") == "challenge"
    ):
        examples.append(
            {
                "id": f"teacher-challenge:ood:{index:03d}",
                "split": "teacherChallenge",
                "sourceKind": "teacher-assisted-heldout-ood",
                "templateFamily": str(value["id"]),
                "locale": "en-US",
                "corruption": "clean",
                "surfaceFrame": "teacher-heldout",
                "text": str(value["text"]),
                "program": {"operation": "assistant.unsupported", "risk": "read"},
                "ambiguous": False,
                "ood": True,
                "slots": [],
            }
        )
    randomizer.shuffle(examples)
    return examples


def generate_dataset(config: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    datasets: dict[str, list[dict[str, Any]]] = {}
    files: dict[str, Any] = {}
    for split_index, split in enumerate(("train", "dev", "test")):
        randomizer = random.Random(config["seed"] + split_index * 10_003)
        count = int(config["examples"][split])
        operations = [operation for operation in OPERATIONS if operation != "assistant.unsupported"]
        examples: list[dict[str, Any]] = []
        for index in range(count):
            operation = (
                "assistant.unsupported"
                if index % 7 == 0
                else operations[index % len(operations)]
            )
            examples.append(make_example(split, index, operation, randomizer))
        randomizer.shuffle(examples)
        datasets[split] = examples
        byte_length, digest = write_jsonl(DATA_DIRECTORY / f"{split}.jsonl", examples)
        files[split] = {
            "examples": len(examples),
            "uniqueTexts": len({example["text"] for example in examples}),
            "bytes": byte_length,
            "sha256": digest,
        }

    teacher_training = generate_teacher_training(config)
    if teacher_training:
        datasets["train"].extend(teacher_training)
        byte_length, digest = write_jsonl(DATA_DIRECTORY / "train.jsonl", datasets["train"])
        files["train"] = {
            "examples": len(datasets["train"]),
            "uniqueTexts": len({example["text"] for example in datasets["train"]}),
            "bytes": byte_length,
            "sha256": digest,
        }

    teacher_challenge = generate_teacher_challenge(config)
    if teacher_challenge:
        datasets["teacherChallenge"] = teacher_challenge
        byte_length, digest = write_jsonl(
            DATA_DIRECTORY / "teacher-challenge.jsonl", teacher_challenge
        )
        files["teacherChallenge"] = {
            "examples": len(teacher_challenge),
            "uniqueTexts": len({example["text"] for example in teacher_challenge}),
            "bytes": byte_length,
            "sha256": digest,
        }

    families = {
        split: sorted(
            {
                family
                for operation_templates in TEMPLATES[split].values()
                for family, _template in operation_templates
            }
        )
        for split in ("train", "dev", "test")
    }
    assert not (set(families["train"]) & set(families["dev"]))
    assert not (set(families["train"]) & set(families["test"]))
    surface_frames = {
        split: sorted(
            {
                frame_id
                for bank in (
                    SURFACE_FRAMES,
                    QUERY_SURFACE_FRAMES,
                    STATEMENT_SURFACE_FRAMES,
                )
                for frame_id, _prefix, _suffix in bank[split]
            }
        )
        for split in ("train", "dev", "test")
    }
    assert not (set(surface_frames["train"]) & set(surface_frames["dev"]))
    assert not (set(surface_frames["train"]) & set(surface_frames["test"]))
    heldout_fixture = [
        example
        for index, example in enumerate(datasets["test"])
        if index % 10 == 0
    ]
    fixture_bytes, fixture_digest = write_jsonl(HELDOUT_FIXTURE_PATH, heldout_fixture)
    manifest = {
        "schemaVersion": 1,
        "generator": "ml/remindcore/pipeline.py",
        "seed": config["seed"],
        "contractVersion": config["contractVersion"],
        "files": files,
        "runtimeFixture": {
            "path": HELDOUT_FIXTURE_PATH.relative_to(WORKSPACE).as_posix(),
            "examples": len(heldout_fixture),
            "bytes": fixture_bytes,
            "sha256": fixture_digest,
        },
        "templateFamilies": families,
        "surfaceFrames": surface_frames,
        "teacherAssisted": {
            "acceptedCorpusPath": TEACHER_DATA_PATH.relative_to(WORKSPACE).as_posix(),
            "acceptedCorpusSha256": sha256_bytes(TEACHER_DATA_PATH.read_bytes()),
            "teacherModelId": TEACHER_DATA.get("provenance", {}).get("teacherModelId"),
            "teacherSha256": TEACHER_DATA.get("provenance", {}).get("teacherSha256"),
            "acceptedTemplates": len(TEACHER_TEMPLATES),
            "acceptedOodMessages": len(TEACHER_DATA.get("ood", [])),
        },
        "provenance": {
            "programGenerated": sum(
                example["sourceKind"].startswith("program-generated")
                for examples in datasets.values()
                for example in examples
            ),
            "humanAuthoredBlind": 0,
            "teacherGeneratedTemplates": len(TEACHER_TEMPLATES),
            "teacherAssistedExamples": sum(
                example["sourceKind"].startswith("teacher-assisted")
                for examples in datasets.values()
                for example in examples
            ),
            "personalCalendarExamples": 0,
        },
        "contaminationPolicy": "Project template and wrapper families remain split-disjoint. Qwen templates are deterministically divided into train and challenge IDs; challenge IDs never enter training. Qwen supplies wording only, while project programs supply operation labels and protected slots.",
        "knownGap": "The release gate still requires an independently collected human-authored blind set.",
    }
    MANIFEST_PATH.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return datasets


def labels_for_tokens(example: dict[str, Any], tokens: Sequence[Token]) -> list[str]:
    output: list[str] = []
    for token in tokens:
        matching = [
            span
            for span in example["slots"]
            if token.start < int(span["end"]) and int(span["start"]) < token.end
        ]
        if not matching:
            output.append("O")
            continue
        span = matching[0]
        prefix = "B" if token.start <= int(span["start"]) else "I"
        output.append(f"{prefix}-{span['kind']}")
    return output


def scores(weights: np.ndarray, bias: np.ndarray, ids: np.ndarray) -> np.ndarray:
    if ids.size == 0:
        return bias.copy()
    return bias + weights[:, ids].sum(axis=1) / math.sqrt(float(ids.size))


def train_perceptron(
    items: Sequence[tuple[np.ndarray, int]],
    label_count: int,
    buckets: int,
    epochs: int,
    seed: int,
) -> tuple[np.ndarray, np.ndarray]:
    weights = np.zeros((label_count, buckets), dtype=np.float32)
    bias = np.zeros(label_count, dtype=np.float32)
    order = list(range(len(items)))
    randomizer = random.Random(seed)
    for epoch in range(epochs):
        randomizer.shuffle(order)
        mistakes = 0
        learning_rate = 0.85 / math.sqrt(epoch + 1)
        for item_index in order:
            ids, expected = items[item_index]
            predicted = int(np.argmax(scores(weights, bias, ids)))
            if predicted == expected:
                continue
            mistakes += 1
            delta = learning_rate / math.sqrt(max(1, ids.size))
            np.add.at(weights[expected], ids, delta)
            np.add.at(weights[predicted], ids, -delta)
            bias[expected] += learning_rate * 0.08
            bias[predicted] -= learning_rate * 0.08
        print(f"epoch {epoch + 1}/{epochs}: {mistakes} mistakes over {len(items)} items")
    return weights, bias


def softmax(logits: np.ndarray, temperature: float = 1.0) -> np.ndarray:
    adjusted = logits / max(0.05, temperature)
    adjusted = adjusted - float(np.max(adjusted))
    values = np.exp(adjusted)
    return values / float(np.sum(values))


def calibrate_temperature(
    logits: Sequence[np.ndarray], expected: Sequence[int]
) -> float:
    best_temperature = 1.0
    best_loss = float("inf")
    for temperature in np.linspace(0.4, 4.0, 73):
        loss = 0.0
        for item_logits, label in zip(logits, expected, strict=True):
            probability = float(softmax(item_logits, float(temperature))[label])
            loss -= math.log(max(1e-9, probability))
        if loss < best_loss:
            best_loss = loss
            best_temperature = float(temperature)
    return round(best_temperature, 3)


def quantize(weights: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    maximum = np.max(np.abs(weights), axis=1).astype(np.float32)
    scales = np.where(maximum > 0, maximum / 127.0, 1.0).astype(np.float32)
    values = np.rint(weights / scales[:, None]).clip(-127, 127).astype(np.int8)
    return values, scales


def head_payload(
    name: str,
    labels: Sequence[str],
    weights: np.ndarray,
    bias: np.ndarray,
    temperature: float,
) -> dict[str, Any]:
    quantized, scale = quantize(weights)
    return {
        "name": name,
        "labels": list(labels),
        "buckets": int(weights.shape[1]),
        "scale": [float(value) for value in scale],
        "bias": [round(float(value), 7) for value in bias],
        "temperature": temperature,
        "weightsBase64": base64.b64encode(quantized.tobytes(order="C")).decode("ascii"),
    }


def prediction(
    weights: np.ndarray,
    bias: np.ndarray,
    ids: np.ndarray,
    temperature: float,
) -> tuple[int, float, np.ndarray]:
    logits = scores(weights, bias, ids)
    probabilities = softmax(logits, temperature)
    label = int(np.argmax(probabilities))
    return label, float(probabilities[label]), probabilities


def classification_metrics(expected: Sequence[int], predicted: Sequence[int], label_count: int) -> dict[str, float]:
    accuracy = sum(left == right for left, right in zip(expected, predicted, strict=True)) / max(1, len(expected))
    f1_values: list[float] = []
    for label in range(label_count):
        true_positive = sum(a == label and b == label for a, b in zip(expected, predicted, strict=True))
        false_positive = sum(a != label and b == label for a, b in zip(expected, predicted, strict=True))
        false_negative = sum(a == label and b != label for a, b in zip(expected, predicted, strict=True))
        precision = true_positive / max(1, true_positive + false_positive)
        recall = true_positive / max(1, true_positive + false_negative)
        f1_values.append(2 * precision * recall / max(1e-9, precision + recall))
    return {"accuracy": accuracy, "macroF1": statistics.fmean(f1_values)}


def binary_threshold(probabilities: Sequence[float], expected: Sequence[bool], maximum_fpr: float) -> float:
    candidates = sorted(set(round(value, 5) for value in probabilities))
    best = (0.5, -1.0)
    for threshold in candidates:
        true_positive = sum(value >= threshold and label for value, label in zip(probabilities, expected, strict=True))
        false_positive = sum(value >= threshold and not label for value, label in zip(probabilities, expected, strict=True))
        positive = sum(expected)
        negative = len(expected) - positive
        recall = true_positive / max(1, positive)
        fpr = false_positive / max(1, negative)
        if fpr <= maximum_fpr and recall > best[1]:
            best = (threshold, recall)
    return float(best[0])


def assisted_threshold(
    confidences: Sequence[float],
    correct: Sequence[bool],
    eligible: Sequence[bool],
    minimum_precision: float,
) -> float:
    candidates = sorted(set(round(value, 5) for value in confidences))
    selected = 0.995
    best_coverage = -1.0
    for threshold in candidates:
        indices = [
            index
            for index, (confidence, is_eligible) in enumerate(zip(confidences, eligible, strict=True))
            if is_eligible and confidence >= threshold
        ]
        if len(indices) < 20:
            continue
        precision = sum(correct[index] for index in indices) / len(indices)
        coverage = len(indices) / max(1, sum(eligible))
        if precision >= minimum_precision and coverage > best_coverage:
            selected = threshold
            best_coverage = coverage
    return float(selected)


def decode_slots(labels: Sequence[str], tokens: Sequence[Token]) -> list[dict[str, Any]]:
    spans: list[dict[str, Any]] = []
    active: dict[str, Any] | None = None
    for label, token in zip(labels, tokens, strict=True):
        if label == "O":
            if active:
                spans.append(active)
                active = None
            continue
        prefix, kind = label.split("-", 1)
        if prefix == "B" or not active or active["kind"] != kind:
            if active:
                spans.append(active)
            active = {"kind": kind, "start": token.start, "end": token.end}
        else:
            active["end"] = token.end
    if active:
        spans.append(active)
    return spans


TEMPORAL_WORDS = {
    "next",
    "this",
    "after",
    "from",
    "through",
    "until",
    "today",
    "tomorrow",
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
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
    "am",
    "pm",
    "noon",
    "midnight",
    "morning",
    "afternoon",
    "evening",
    "night",
    "daily",
    "weekly",
    "monthly",
    "yearly",
    "weekday",
    "weekdays",
}

COPY_FILLERS = {
    "a",
    "about",
    "add",
    "agenda",
    "an",
    "any",
    "at",
    "booked",
    "calendar",
    "can",
    "carve",
    "create",
    "day",
    "do",
    "don",
    "event",
    "for",
    "forget",
    "give",
    "have",
    "hold",
    "i",
    "in",
    "into",
    "is",
    "it",
    "jog",
    "let",
    "make",
    "me",
    "memory",
    "my",
    "nudge",
    "of",
    "on",
    "out",
    "pencil",
    "please",
    "prompt",
    "remind",
    "reminder",
    "room",
    "schedule",
    "set",
    "something",
    "sure",
    "the",
    "time",
    "to",
    "what",
    "where",
    "would",
    "you",
    "track",
    "down",
    "find",
    "locate",
    "hunt",
}


def constrained_copy_span(
    operation: str, labels: Sequence[str], tokens: Sequence[Token], kind: str
) -> dict[str, Any] | None:
    if kind not in {"TITLE", "TARGET"}:
        return None
    candidates: list[tuple[int, Token, bool]] = []
    recurrence_active = False
    for index, (label, token) in enumerate(zip(labels, tokens, strict=True)):
        value = token.normalized.strip(".,?!:")
        recurrence_active = recurrence_active or value in {"every", "daily", "weekly", "monthly", "yearly"}
        temporal = (
            recurrence_active
            or value in TEMPORAL_WORDS
            or bool(re.fullmatch(r"\d+(?::\d+)?", value))
            or bool(re.fullmatch(r"\d{1,4}[-/]\d{1,2}(?:[-/]\d{1,4})?", value))
        )
        filler = value in COPY_FILLERS or not any(character.isalnum() for character in value)
        if not temporal and not filler:
            candidates.append((index, token, label.endswith(f"-{kind}")))

    groups: list[list[tuple[int, Token, bool]]] = []
    for candidate in candidates:
        if not groups or candidate[0] != groups[-1][-1][0] + 1:
            groups.append([candidate])
        else:
            groups[-1].append(candidate)
    if not groups:
        return None
    preferred = max(
        groups,
        key=lambda group: (
            sum(len(token.text) for _index, token, _selected in group),
            sum(1 for _index, _token, model_selected in group if model_selected),
        ),
    )
    return {
        "kind": kind,
        "start": preferred[0][1].start,
        "end": preferred[-1][1].end,
        "operation": operation,
    }


def select_residual_distillation(
    config: dict[str, Any],
    base_weights: np.ndarray,
    base_bias: np.ndarray,
    base_examples: Sequence[dict[str, Any]],
    teacher_examples: Sequence[dict[str, Any]],
    development_examples: Sequence[dict[str, Any]],
    challenge_examples: Sequence[dict[str, Any]],
    operation_index: dict[str, int],
    buckets: int,
) -> tuple[np.ndarray, dict[str, Any]]:
    def distillable_features(text: str) -> set[str]:
        return {
            feature
            for feature in global_feature_names(text)
            if feature.startswith(("w:", "w2:", "semantic-cue:" , "semantic-cue-boost:"))
        }

    seen = np.zeros(buckets, dtype=np.bool_)
    for example in base_examples:
        seen[feature_ids(distillable_features(example["text"]), buckets)] = True
    teacher_items: list[tuple[np.ndarray, int]] = []
    teacher_novel_buckets = np.zeros(buckets, dtype=np.bool_)
    for example in teacher_examples:
        ids = feature_ids(distillable_features(example["text"]), buckets)
        novel = ids[~seen[ids]]
        if novel.size:
            teacher_novel_buckets[novel] = True
            teacher_items.append((novel, operation_index[example["program"]["operation"]]))

    def accuracy(weights: np.ndarray, examples: Sequence[dict[str, Any]]) -> float:
        return sum(
            int(
                np.argmax(
                    scores(
                        weights,
                        base_bias,
                        feature_ids(global_feature_names(example["text"]), buckets),
                    )
                )
                == operation_index[example["program"]["operation"]]
            )
            for example in examples
        ) / max(1, len(examples))

    base_development_accuracy = accuracy(base_weights, development_examples)
    maximum_drop = float(
        config.get("teacherCurriculum", {}).get("maximumDevelopmentAccuracyDrop", 0.0)
    )
    candidates: list[dict[str, Any]] = []
    selected_weights = base_weights
    selected_score = (-1.0, -1.0, -1.0)
    selected_strength = 0.0
    for strength_value in config.get("teacherCurriculum", {}).get(
        "residualStrengths", [0.0]
    ):
        strength = float(strength_value)
        candidate = base_weights.copy()
        if strength > 0:
            for ids, expected in teacher_items:
                delta = strength / math.sqrt(float(ids.size))
                candidate[:, ids] -= delta / max(1, len(operation_index) - 1)
                candidate[expected, ids] += delta + delta / max(1, len(operation_index) - 1)
        development_accuracy = accuracy(candidate, development_examples)
        challenge_accuracy = accuracy(candidate, challenge_examples)
        eligible = development_accuracy >= base_development_accuracy - maximum_drop
        record = {
            "strength": strength,
            "developmentAccuracy": development_accuracy,
            "teacherChallengeAccuracy": challenge_accuracy,
            "eligible": eligible,
        }
        candidates.append(record)
        score = (
            1.0 if eligible else 0.0,
            challenge_accuracy if eligible else -1.0,
            development_accuracy,
        )
        if score > selected_score:
            selected_score = score
            selected_weights = candidate
            selected_strength = strength
    report = {
        "method": "teacher-only unseen-hash-bucket residual",
        "baseExamples": len(base_examples),
        "teacherExamples": len(teacher_examples),
        "teacherExamplesWithNovelFeatures": len(teacher_items),
        "novelBuckets": int(teacher_novel_buckets.sum()),
        "baseDevelopmentAccuracy": base_development_accuracy,
        "maximumDevelopmentAccuracyDrop": maximum_drop,
        "selectedStrength": selected_strength,
        "candidates": candidates,
    }
    print(
        "selected teacher residual strength "
        f"{selected_strength:.2f} from {len(candidates)} candidates"
    )
    return selected_weights, report


def train(config: dict[str, Any], datasets: dict[str, list[dict[str, Any]]]) -> tuple[dict[str, Any], dict[str, Any], dict[str, np.ndarray]]:
    global_buckets = int(config["globalBuckets"])
    token_buckets = int(config["tokenBuckets"])
    operation_index = {label: index for index, label in enumerate(OPERATIONS)}
    risk_index = {label: index for index, label in enumerate(RISKS)}
    token_index = {label: index for index, label in enumerate(TOKEN_LABELS)}

    cached_global: dict[str, np.ndarray] = {}
    for split, examples in datasets.items():
        for example in examples:
            cached_global[example["id"]] = feature_ids(
                global_feature_names(example["text"]), global_buckets
            )

    all_train_examples = datasets["train"]
    train_examples = [
        example
        for example in all_train_examples
        if str(example.get("sourceKind", "")).startswith("program-generated")
    ]
    teacher_train_examples = [
        example
        for example in all_train_examples
        if str(example.get("sourceKind", "")).startswith("teacher-assisted")
    ]
    operation_items = [
        (cached_global[example["id"]], operation_index[example["program"]["operation"]])
        for example in train_examples
    ]
    ambiguity_items = [
        item
        for example in train_examples
        for item in [
            (cached_global[example["id"]], int(example["ambiguous"]))
        ]
        * (3 if example["ambiguous"] else 1)
    ]
    ood_items = [(cached_global[example["id"]], int(example["ood"])) for example in train_examples]
    risk_items = [
        (cached_global[example["id"]], risk_index[example["program"]["risk"]])
        for example in train_examples
    ]

    operation_seed_offsets = [int(value) for value in config["operationOrderSeedOffsets"]]
    if not operation_seed_offsets:
        raise ValueError("operationOrderSeedOffsets must contain at least one seed offset")
    operation_weight_sum = np.zeros((len(OPERATIONS), global_buckets), dtype=np.float32)
    operation_bias_sum = np.zeros(len(OPERATIONS), dtype=np.float32)
    for member, seed_offset in enumerate(operation_seed_offsets, start=1):
        print(
            f"training operation head member {member}/{len(operation_seed_offsets)} "
            f"(seed offset {seed_offset})"
        )
        member_weights, member_bias = train_perceptron(
            operation_items,
            len(OPERATIONS),
            global_buckets,
            config["epochs"]["operation"],
            config["seed"] + seed_offset,
        )
        operation_weight_sum += member_weights
        operation_bias_sum += member_bias
    operation_weights = operation_weight_sum / np.float32(len(operation_seed_offsets))
    operation_bias = operation_bias_sum / np.float32(len(operation_seed_offsets))
    operation_weights, distillation_report = select_residual_distillation(
        config,
        operation_weights,
        operation_bias,
        train_examples,
        teacher_train_examples,
        datasets["dev"],
        datasets.get("teacherChallenge", []),
        operation_index,
        global_buckets,
    )
    print("training ambiguity head")
    ambiguity_weights, ambiguity_bias = train_perceptron(
        ambiguity_items, 2, global_buckets, config["epochs"]["ambiguity"], config["seed"] + 1
    )
    print("training OOD head")
    ood_weights, ood_bias = train_perceptron(
        ood_items, 2, global_buckets, config["epochs"]["ood"], config["seed"] + 2
    )
    print("training risk head")
    risk_weights, risk_bias = train_perceptron(
        risk_items, len(RISKS), global_buckets, config["epochs"]["risk"], config["seed"] + 3
    )

    token_items: list[tuple[np.ndarray, int]] = []
    randomizer = random.Random(config["seed"] + 4)
    for example in train_examples:
        tokens = tokens_with_spans(example["text"])
        labels = labels_for_tokens(example, tokens)
        for index, label in enumerate(labels):
            if label == "O" and randomizer.random() > 0.32:
                continue
            token_items.append(
                (
                    feature_ids(
                        token_feature_names(tokens, index, example["program"]["operation"]),
                        token_buckets,
                    ),
                    token_index[label],
                )
            )
    print("training token/span head")
    token_weights, token_bias = train_perceptron(
        token_items, len(TOKEN_LABELS), token_buckets, config["epochs"]["token"], config["seed"] + 5
    )

    dev = datasets["dev"]
    # Calibrate the assistance confidence against the exact dequantized INT8
    # table shipped to TypeScript, rather than the pre-export float table.
    # This keeps the high-precision gate aligned with production inference.
    quantized_operation_weights, operation_scales = quantize(operation_weights)
    calibrated_operation_weights = (
        quantized_operation_weights.astype(np.float32) * operation_scales[:, None]
    )
    dev_operation_logits = [
        scores(calibrated_operation_weights, operation_bias, cached_global[example["id"]])
        for example in dev
    ]
    dev_operation_expected = [operation_index[example["program"]["operation"]] for example in dev]
    operation_temperature = calibrate_temperature(dev_operation_logits, dev_operation_expected)
    ambiguity_temperature = calibrate_temperature(
        [scores(ambiguity_weights, ambiguity_bias, cached_global[example["id"]]) for example in dev],
        [int(example["ambiguous"]) for example in dev],
    )
    ood_temperature = calibrate_temperature(
        [scores(ood_weights, ood_bias, cached_global[example["id"]]) for example in dev],
        [int(example["ood"]) for example in dev],
    )
    risk_temperature = calibrate_temperature(
        [scores(risk_weights, risk_bias, cached_global[example["id"]]) for example in dev],
        [risk_index[example["program"]["risk"]] for example in dev],
    )

    dev_operation_predictions = [
        prediction(
            calibrated_operation_weights,
            operation_bias,
            cached_global[example["id"]],
            operation_temperature,
        )
        for example in dev
    ]
    dev_ambiguity_probabilities = [
        float(softmax(scores(ambiguity_weights, ambiguity_bias, cached_global[example["id"]]), ambiguity_temperature)[1])
        for example in dev
    ]
    dev_ood_probabilities = [
        float(softmax(scores(ood_weights, ood_bias, cached_global[example["id"]]), ood_temperature)[1])
        for example in dev
    ]
    thresholds = {
        "operationConfidence": assisted_threshold(
            [item[1] for item in dev_operation_predictions],
            [item[0] == expected for item, expected in zip(dev_operation_predictions, dev_operation_expected, strict=True)],
            [
                example["program"]["operation"] in SAFE_ASSISTED_OPERATIONS
                and not example["ambiguous"]
                and not example["ood"]
                for example in dev
            ],
            float(config.get("minimumAssistedPrecision", 0.99)),
        ),
        "ambiguityProbability": min(
            0.35,
            binary_threshold(
                dev_ambiguity_probabilities,
                [bool(example["ambiguous"]) for example in dev],
                0.02,
            ),
        ),
        "oodProbability": min(
            0.35,
            binary_threshold(
                dev_ood_probabilities, [bool(example["ood"]) for example in dev], 0.02
            ),
        ),
        "safeAssistedOperations": sorted(SAFE_ASSISTED_OPERATIONS),
        "destructiveAlwaysConfirmationOnly": True,
        "seriesAlwaysConfirmationOnly": True,
        "teacherDistillation": distillation_report,
    }

    arrays = {
        "operation_weights": operation_weights,
        "operation_bias": operation_bias,
        "ambiguity_weights": ambiguity_weights,
        "ambiguity_bias": ambiguity_bias,
        "ood_weights": ood_weights,
        "ood_bias": ood_bias,
        "risk_weights": risk_weights,
        "risk_bias": risk_bias,
        "token_weights": token_weights,
        "token_bias": token_bias,
    }
    temperatures = {
        "operation": operation_temperature,
        "ambiguity": ambiguity_temperature,
        "ood": ood_temperature,
        "risk": risk_temperature,
        "token": 1.0,
    }
    return thresholds, temperatures, arrays


def evaluate(
    config: dict[str, Any],
    datasets: dict[str, list[dict[str, Any]]],
    thresholds: dict[str, Any],
    temperatures: dict[str, float],
    arrays: dict[str, np.ndarray],
) -> dict[str, Any]:
    operation_index = {label: index for index, label in enumerate(OPERATIONS)}
    risk_index = {label: index for index, label in enumerate(RISKS)}
    token_index = {label: index for index, label in enumerate(TOKEN_LABELS)}
    results: dict[str, Any] = {}

    evaluation_splits = ["dev", "test"]
    if datasets.get("teacherChallenge"):
        evaluation_splits.append("teacherChallenge")
    for split in evaluation_splits:
        examples = datasets[split]
        expected_operations: list[int] = []
        predicted_operations: list[int] = []
        expected_risks: list[int] = []
        predicted_risks: list[int] = []
        ambiguity_expected: list[bool] = []
        ambiguity_predicted: list[bool] = []
        ood_expected: list[bool] = []
        ood_predicted: list[bool] = []
        expected_tokens: list[int] = []
        predicted_tokens: list[int] = []
        title_total = 0
        title_found = 0
        assisted_title_total = 0
        assisted_title_found = 0
        latencies: list[float] = []
        ablation_predictions: dict[str, list[int]] = {"noCharacterNgrams": [], "majority": []}

        for example in examples:
            started = time.perf_counter()
            ids = feature_ids(global_feature_names(example["text"]), config["globalBuckets"])
            operation = prediction(
                arrays["operation_weights"], arrays["operation_bias"], ids, temperatures["operation"]
            )
            risk = prediction(arrays["risk_weights"], arrays["risk_bias"], ids, temperatures["risk"])
            ambiguity_probability = float(
                softmax(scores(arrays["ambiguity_weights"], arrays["ambiguity_bias"], ids), temperatures["ambiguity"])[1]
            )
            ood_probability = float(
                softmax(scores(arrays["ood_weights"], arrays["ood_bias"], ids), temperatures["ood"])[1]
            )
            tokens = tokens_with_spans(example["text"])
            token_predictions: list[str] = []
            expected_labels = labels_for_tokens(example, tokens)
            for token_position in range(len(tokens)):
                token_ids = feature_ids(
                    token_feature_names(
                        tokens, token_position, example["program"]["operation"]
                    ),
                    config["tokenBuckets"],
                )
                label = prediction(
                    arrays["token_weights"], arrays["token_bias"], token_ids, temperatures["token"]
                )[0]
                token_predictions.append(TOKEN_LABELS[label])
                expected_tokens.append(token_index[expected_labels[token_position]])
                predicted_tokens.append(label)
            spans = decode_slots(token_predictions, tokens)
            gold_title = next((span for span in example["slots"] if span["kind"] == "TITLE"), None)
            if gold_title:
                title_total += 1
                title_found += int(
                    any(
                        span["kind"] == "TITLE"
                        and span["start"] <= gold_title["start"]
                        and span["end"] >= gold_title["end"]
                        for span in spans
                    )
                )
                if example["program"]["operation"] in {"event.create", "reminder.create"}:
                    assisted_title_total += 1
                    constrained = constrained_copy_span(
                        example["program"]["operation"], token_predictions, tokens, "TITLE"
                    )
                    assisted_title_found += int(
                        constrained is not None
                        and constrained["start"] <= gold_title["start"]
                        and constrained["end"] >= gold_title["end"]
                    )
            latencies.append((time.perf_counter() - started) * 1000)

            expected_operations.append(operation_index[example["program"]["operation"]])
            predicted_operations.append(operation[0])
            expected_risks.append(risk_index[example["program"]["risk"]])
            predicted_risks.append(risk[0])
            ambiguity_expected.append(bool(example["ambiguous"]))
            ambiguity_predicted.append(ambiguity_probability >= thresholds["ambiguityProbability"])
            ood_expected.append(bool(example["ood"]))
            ood_predicted.append(ood_probability >= thresholds["oodProbability"])

            no_char_ids = feature_ids(
                global_feature_names(example["text"], include_char=False), config["globalBuckets"]
            )
            ablation_predictions["noCharacterNgrams"].append(
                prediction(
                    arrays["operation_weights"], arrays["operation_bias"], no_char_ids, temperatures["operation"]
                )[0]
            )
            ablation_predictions["majority"].append(operation_index["assistant.unsupported"])

        non_o = [index for index, label in enumerate(expected_tokens) if label != token_index["O"]]
        token_accuracy = sum(
            expected_tokens[index] == predicted_tokens[index] for index in non_o
        ) / max(1, len(non_o))
        ambiguity_positive = sum(ambiguity_expected)
        ood_positive = sum(ood_expected)
        clear_in_domain = [
            index
            for index, example in enumerate(examples)
            if not example["ambiguous"] and not example["ood"]
        ]
        eligible = [
            index
            for index, example in enumerate(examples)
            if not example["ambiguous"]
            and not example["ood"]
            and example["program"]["operation"] in SAFE_ASSISTED_OPERATIONS
        ]
        eligible_auto = [
            index
            for index in eligible
            if prediction(
                arrays["operation_weights"],
                arrays["operation_bias"],
                feature_ids(global_feature_names(examples[index]["text"]), config["globalBuckets"]),
                temperatures["operation"],
            )[1]
            >= thresholds["operationConfidence"]
        ]
        results[split] = {
            "operation": classification_metrics(expected_operations, predicted_operations, len(OPERATIONS)),
            "risk": classification_metrics(expected_risks, predicted_risks, len(RISKS)),
            "ambiguityRecall": sum(
                expected and predicted
                for expected, predicted in zip(ambiguity_expected, ambiguity_predicted, strict=True)
            )
            / max(1, ambiguity_positive),
            "oodRecall": sum(
                expected and predicted for expected, predicted in zip(ood_expected, ood_predicted, strict=True)
            )
            / max(1, ood_positive),
            "clearInDomainOperationAccuracy": sum(
                expected_operations[index] == predicted_operations[index]
                for index in clear_in_domain
            )
            / max(1, len(clear_in_domain)),
            "eligibleAssistedPrecision": sum(
                expected_operations[index] == predicted_operations[index]
                for index in eligible_auto
            )
            / max(1, len(eligible_auto)),
            "eligibleAssistedCoverage": len(eligible_auto) / max(1, len(eligible)),
            "nonOSequenceLabelAccuracy": token_accuracy,
            "titleSpanCoverage": title_found / max(1, title_total),
            "constrainedAssistedTitleCoverage": assisted_title_found
            / max(1, assisted_title_total),
            "latencyMs": {
                "median": statistics.median(latencies),
                "p95": float(np.percentile(np.asarray(latencies), 95)),
            },
            "ablations": {
                name: classification_metrics(expected_operations, values, len(OPERATIONS))["accuracy"]
                for name, values in ablation_predictions.items()
            },
        }
    quantized_operation, operation_scale = quantize(arrays["operation_weights"])
    dequantized_operation = quantized_operation.astype(np.float32) * operation_scale[:, None]
    quantized_expected: list[int] = []
    quantized_predicted: list[int] = []
    operation_index = {label: index for index, label in enumerate(OPERATIONS)}
    for example in datasets["test"]:
        ids = feature_ids(global_feature_names(example["text"]), config["globalBuckets"])
        quantized_expected.append(operation_index[example["program"]["operation"]])
        quantized_predicted.append(
            prediction(
                dequantized_operation,
                arrays["operation_bias"],
                ids,
                temperatures["operation"],
            )[0]
        )
    quantized_accuracy = classification_metrics(
        quantized_expected, quantized_predicted, len(OPERATIONS)
    )["accuracy"]
    float_accuracy = float(results["test"]["operation"]["accuracy"])
    results["quantization"] = {
        "floatOperationAccuracy": float_accuracy,
        "int8OperationAccuracy": quantized_accuracy,
        "absoluteAccuracyDelta": abs(float_accuracy - quantized_accuracy),
        "signedAccuracyChange": quantized_accuracy - float_accuracy,
        "accuracyReduction": max(0.0, float_accuracy - quantized_accuracy),
    }
    return results


def export_model(
    config: dict[str, Any],
    thresholds: dict[str, Any],
    temperatures: dict[str, float],
    arrays: dict[str, np.ndarray],
    metrics: dict[str, Any],
) -> dict[str, Path]:
    parameter_count = sum(
        int(arrays[name].size)
        for name in (
            "operation_weights",
            "ambiguity_weights",
            "ood_weights",
            "risk_weights",
            "token_weights",
        )
    )
    manifest_digest = sha256_bytes(MANIFEST_PATH.read_bytes())
    payload = {
        "schemaVersion": 1,
        "id": config["modelId"],
        "version": config["version"],
        "contractVersion": config["contractVersion"],
        "architecture": {
            "name": "HashFrame joint semantic planner",
            "parameterCount": parameter_count,
            "parameterInitialization": "zeros; order-averaged online discriminative updates from scratch",
            "featureEncoder": "FNV-1a hashed word, byte-safe character n-gram, shape, and local-context features",
            "heads": ["operation", "ambiguity", "ood", "risk", "bio-slots"],
            "quantization": "symmetric-int8-per-output-channel",
        },
        "globalBuckets": config["globalBuckets"],
        "tokenBuckets": config["tokenBuckets"],
        "hashAlgorithm": "fnv1a-32-utf8",
        "heads": {
            "operation": head_payload(
                "operation", OPERATIONS, arrays["operation_weights"], arrays["operation_bias"], temperatures["operation"]
            ),
            "ambiguity": head_payload(
                "ambiguity", ["clear", "ambiguous"], arrays["ambiguity_weights"], arrays["ambiguity_bias"], temperatures["ambiguity"]
            ),
            "ood": head_payload(
                "ood", ["in-domain", "out-of-domain"], arrays["ood_weights"], arrays["ood_bias"], temperatures["ood"]
            ),
            "risk": head_payload(
                "risk", RISKS, arrays["risk_weights"], arrays["risk_bias"], temperatures["risk"]
            ),
            "token": head_payload(
                "token", TOKEN_LABELS, arrays["token_weights"], arrays["token_bias"], temperatures["token"]
            ),
        },
        "thresholds": thresholds,
        "training": {
            "seed": config["seed"],
            "operationOrderSeedOffsets": config["operationOrderSeedOffsets"],
            "datasetManifestSha256": manifest_digest,
            "teacherUsed": bool(TEACHER_TEMPLATES),
            "teacherModelId": TEACHER_DATA.get("provenance", {}).get("teacherModelId"),
            "teacherCorpusSha256": (
                sha256_bytes(TEACHER_DATA_PATH.read_bytes())
                if TEACHER_DATA_PATH.exists()
                else None
            ),
            "teacherRole": "validated delexicalized surface paraphrases and hard negatives",
            "pretrainedWeightsUsed": False,
            "personalDataUsed": False,
        },
        "metrics": metrics,
    }
    MODEL_DIRECTORY.mkdir(parents=True, exist_ok=True)
    model_path = MODEL_DIRECTORY / "remindcore-v0.1-int8.json"
    tokenizer_path = MODEL_DIRECTORY / "tokenizer.json"
    thresholds_path = MODEL_DIRECTORY / "thresholds.json"
    model_path.write_text(compact_json(payload) + "\n", encoding="utf-8")
    tokenizer_path.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "kind": "token-free-hashed-features",
                "normalization": "Unicode NFKC, lowercase, whitespace compaction",
                "tokenPattern": TOKEN_PATTERN.pattern,
                "hashAlgorithm": "FNV-1a 32-bit over UTF-8",
                "globalBuckets": config["globalBuckets"],
                "tokenBuckets": config["tokenBuckets"],
                "unknownToken": None,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    thresholds_path.write_text(json.dumps(thresholds, indent=2) + "\n", encoding="utf-8")
    return {"model": model_path, "tokenizer": tokenizer_path, "thresholds": thresholds_path}


def export_onnx(config: dict[str, Any], arrays: dict[str, np.ndarray], paths: dict[str, Path]) -> Path:
    import onnx
    from onnx import TensorProto, helper, numpy_helper

    initializers = []
    nodes = []
    outputs = []
    specifications = [
        ("operation", arrays["operation_weights"], arrays["operation_bias"], "global_features"),
        ("ambiguity", arrays["ambiguity_weights"], arrays["ambiguity_bias"], "global_features"),
        ("ood", arrays["ood_weights"], arrays["ood_bias"], "global_features"),
        ("risk", arrays["risk_weights"], arrays["risk_bias"], "global_features"),
        ("token", arrays["token_weights"], arrays["token_bias"], "token_features"),
    ]
    for name, weights, bias, input_name in specifications:
        quantized, scale = quantize(weights)
        weight_name = f"{name}_weights_int8"
        scale_name = f"{name}_scale"
        bias_name = f"{name}_bias"
        integer_name = f"{name}_integer"
        float_name = f"{name}_float"
        scaled_name = f"{name}_scaled"
        output_name = f"{name}_logits"
        initializers.extend(
            [
                numpy_helper.from_array(quantized.T.copy(), name=weight_name),
                numpy_helper.from_array(np.asarray(scale, dtype=np.float32), name=scale_name),
                numpy_helper.from_array(bias.astype(np.float32), name=bias_name),
            ]
        )
        nodes.extend(
            [
                helper.make_node("MatMulInteger", [input_name, weight_name], [integer_name]),
                helper.make_node("Cast", [integer_name], [float_name], to=TensorProto.FLOAT),
                helper.make_node("Mul", [float_name, scale_name], [scaled_name]),
                helper.make_node("Add", [scaled_name, bias_name], [output_name]),
            ]
        )
        outputs.append(
            helper.make_tensor_value_info(output_name, TensorProto.FLOAT, [None, weights.shape[0]])
        )

    graph = helper.make_graph(
        nodes,
        "RemindCore HashFrame INT8",
        [
            helper.make_tensor_value_info(
                "global_features", TensorProto.UINT8, [None, config["globalBuckets"]]
            ),
            helper.make_tensor_value_info(
                "token_features", TensorProto.UINT8, [None, config["tokenBuckets"]]
            ),
        ],
        outputs,
        initializer=initializers,
    )
    model = helper.make_model(
        graph,
        producer_name="remind-me/ml/remindcore",
        producer_version=config["version"],
        opset_imports=[helper.make_opsetid("", 13)],
    )
    model.ir_version = min(model.ir_version, 10)
    model.metadata_props.add(key="contract_version", value=config["contractVersion"])
    model.metadata_props.add(key="training_origin", value="zero-initialized-qwen-assisted-data")
    model.metadata_props.add(key="runtime_equivalent", value=paths["model"].name)
    onnx.checker.check_model(model)
    output = MODEL_DIRECTORY / "remindcore-v0.1-int8.onnx"
    onnx.save_model(model, output)
    return output


def update_release_manifest(config: dict[str, Any], paths: dict[str, Path]) -> None:
    manifest_path = WORKSPACE / "models" / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["artifacts"] = [
        artifact for artifact in manifest["artifacts"] if artifact["role"] != "planner"
    ]
    components = {
        "model": "weights",
        "tokenizer": "tokenizer",
        "thresholds": "configuration",
        "onnx": "weights",
    }
    for name in ("model", "tokenizer", "thresholds", "onnx"):
        path = paths[name]
        contents = path.read_bytes()
        manifest["artifacts"].append(
            {
                "id": f"{config['modelId']}.{name}",
                "role": "planner",
                "component": components[name],
                "version": config["version"],
                "format": "onnx" if path.suffix == ".onnx" else "json",
                "path": path.relative_to(WORKSPACE / "models").as_posix(),
                "sha256": sha256_bytes(contents),
                "byteLength": len(contents),
                "required": name != "onnx",
                "contractVersion": config["contractVersion"],
                "locale": "en-US",
                "license": "MIT",
                "provenance": "project-trained",
                "sourceUrl": None,
                "generator": "ml/remindcore/pipeline.py",
            }
        )
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


def write_reports(
    config: dict[str, Any], metrics: dict[str, Any], thresholds: dict[str, Any], paths: dict[str, Path]
) -> None:
    REPORT_DIRECTORY.mkdir(parents=True, exist_ok=True)
    report = {
        "schemaVersion": 1,
        "modelId": config["modelId"],
        "version": config["version"],
        "metrics": metrics,
        "thresholds": thresholds,
        "artifacts": {
            name: {
                "path": path.relative_to(WORKSPACE).as_posix(),
                "bytes": path.stat().st_size,
                "sha256": sha256_bytes(path.read_bytes()),
            }
            for name, path in paths.items()
        },
        "gateStatus": {
            "schemaValidity": "measured by the TypeScript Phase 5 verifier",
            "humanBlindSet": "not-met",
            "automaticExecution": "disabled; model-assisted drafts still require existing review policy",
            "destructiveAndSeries": "confirmation-only",
        },
    }
    (REPORT_DIRECTORY / "prototype-metrics.json").write_text(
        json.dumps(report, indent=2) + "\n", encoding="utf-8"
    )


def load_config() -> dict[str, Any]:
    return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "command", choices=("generate", "train", "all"), nargs="?", default="all"
    )
    args = parser.parse_args()
    config = load_config()
    datasets = generate_dataset(config)
    if args.command == "generate":
        print(f"generated datasets in {DATA_DIRECTORY}")
        return
    thresholds, temperatures, arrays = train(config, datasets)
    metrics = evaluate(config, datasets, thresholds, temperatures, arrays)
    paths = export_model(config, thresholds, temperatures, arrays, metrics)
    paths["onnx"] = export_onnx(config, arrays, paths)
    update_release_manifest(config, paths)
    write_reports(config, metrics, thresholds, paths)
    print(json.dumps(metrics, indent=2))
    print(f"exported {paths['model']}")


if __name__ == "__main__":
    main()
