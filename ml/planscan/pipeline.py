"""Generate, train, evaluate, quantize, and export PlanScan.

PlanScan is intentionally initialized from zero and trained without a teacher,
pretrained document encoder, personal files, or network access. It learns six
hashed spatial/text heads over PDF/OCR blocks. The product runtime projects all
predictions back onto exact source spans and keeps document imports review-only.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import math
import random
import re
import statistics
import time
import unicodedata
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Sequence

import numpy as np


WORKSPACE = Path(__file__).resolve().parents[2]
ROOT = WORKSPACE / "ml" / "planscan"
GENERATED = ROOT / ".generated"
DATA_DIRECTORY = GENERATED / "dataset"
MODEL_DIRECTORY = WORKSPACE / "models" / "planscan"
REPORT_DIRECTORY = ROOT / "reports"
DATA_MANIFEST_PATH = ROOT / "data" / "manifest.json"
HELDOUT_FIXTURE_PATH = WORKSPACE / "fixtures" / "planscan" / "heldout.v0.1.jsonl"
MODEL_MANIFEST_PATH = WORKSPACE / "models" / "manifest.json"
CONFIG_PATH = ROOT / "config.json"

BLOCK_ROLES = [
    "heading",
    "plan-title",
    "plan-field",
    "description",
    "metadata",
    "decorative",
    "other",
]
ENTITY_ROLES = [
    "title",
    "date",
    "time",
    "location",
    "description",
    "reminder-cue",
    "recurrence",
    "other",
]
RELATION_TYPES = [
    "none",
    "same-plan",
    "title-field",
    "date-time",
    "field-detail",
    "sequence",
]
GROUP_LINK_LABELS = ["none", "same-group", "new-group", "context"]
DOCUMENT_TYPES = [
    "schedule",
    "syllabus",
    "invitation",
    "flyer",
    "itinerary",
    "rotation",
    "table",
    "screenshot",
]
QUALITY_LABELS = [
    "clear",
    "ocr-risk",
    "crowded",
    "ambiguous",
    "decorative",
    "partial",
    "noise",
]
HEAD_LABELS = {
    "blockRole": BLOCK_ROLES,
    "entityRole": ENTITY_ROLES,
    "relation": RELATION_TYPES,
    "groupLink": GROUP_LINK_LABELS,
    "documentType": DOCUMENT_TYPES,
    "confidence": QUALITY_LABELS,
}

MONTH_PATTERN = (
    r"(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|"
    r"aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)"
)
WEEKDAY_PATTERN = r"(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)"
DATE_PATTERNS = [
    re.compile(rf"\b{MONTH_PATTERN}\s+\d{{1,2}}(?:st|nd|rd|th)?(?:,?\s+\d{{4}})?\b", re.I),
    re.compile(rf"\b\d{{1,2}}(?:st|nd|rd|th)?\s+{MONTH_PATTERN}(?:,?\s+\d{{4}})?\b", re.I),
    re.compile(r"\b\d{4}-\d{2}-\d{2}\b"),
    re.compile(r"\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b"),
    re.compile(rf"\b(?:(?:this|next)\s+)?{WEEKDAY_PATTERN}\b", re.I),
    re.compile(r"\b(?:today|tomorrow|day after tomorrow)\b", re.I),
]
CLOCK_WITH_MINUTES = r"(?:[01]?\d|2[0-3]):[0-5]\d(?:\s*[ap]\.?m\.?)?"
CLOCK_WITH_MERIDIEM = r"(?:0?[1-9]|1[0-2])(?::[0-5]\d)?\s*[ap]\.?m\.?"
CLOCK_TOKEN = rf"(?:{CLOCK_WITH_MINUTES}|{CLOCK_WITH_MERIDIEM}|noon|midnight)"
TIME_PATTERN = re.compile(
    rf"\b(?:from\s+)?(?:{CLOCK_TOKEN}(?:\s*(?:-|–|—|to|until)\s*{CLOCK_TOKEN})?)\b",
    re.I,
)
LOCATION_PATTERN = re.compile(r"^(?:location|where|room|venue)\s*[:\-–—]\s*(.+)$", re.I)
REMINDER_PATTERN = re.compile(r"\b(?:reminder|remind me|due|deadline|to[- ]?do)\b", re.I)
RECURRENCE_PATTERN = re.compile(
    r"\b(?:every|each|weekly|monthly|daily|weekdays?|biweekly|fortnightly)\b[^.;|]*", re.I
)
TOKEN_PATTERN = re.compile(r"[A-Za-z0-9]+(?:['’\-][A-Za-z0-9]+)*")

TITLES = [
    "Project kickoff",
    "Design review",
    "Studio critique",
    "Research check-in",
    "Client workshop",
    "Morning focus block",
    "Team retrospective",
    "Portfolio review",
    "Flight to Portland",
    "Dinner reservation",
    "Lab orientation",
    "Volunteer shift",
    "Submit portfolio",
    "Renew library card",
    "Call the dentist",
    "Send travel forms",
    "Draft presentation",
    "Course registration",
    "Community meeting",
    "Photography walk",
]
LOCATIONS = [
    "Studio A",
    "Reading Room",
    "North Hall",
    "Room 204",
    "Community Loft",
    "Online",
    "Gate C12",
    "Main Library",
    "Cedar Lab",
    "Garden Pavilion",
]
DESCRIPTIONS = [
    "Bring the latest draft",
    "Review notes beforehand",
    "Open to the whole team",
    "Materials are provided",
    "Allow ten minutes for check-in",
    "Keep the confirmation number nearby",
]
RECURRENCES = ["Every Tuesday", "Weekly", "Each month", "Weekdays"]
DATES = [
    "August 26, 2026",
    "August 28, 2026",
    "August 30, 2026",
    "September 2, 2026",
    "September 7, 2026",
    "September 11, 2026",
    "September 18, 2026",
    "October 3, 2026",
]
TIMES = [
    "9:00 AM - 10:00 AM",
    "2:00 PM - 3:30 PM",
    "6:00 PM",
    "8:30 AM - 9:15 AM",
    "noon",
    "4:45 PM - 5:30 PM",
    "10:00 AM",
    "7:15 PM",
]

CHALLENGE_SLICES = [
    "baseline",
    "ocr-corruption",
    "neighboring-row-negatives",
    "repeated-titles",
    "unfamiliar-column-order",
    "header-footer-distractions",
]

OCR_SUBSTITUTIONS = [
    ("Room", "R0om"),
    ("Studio", "Stud1o"),
    ("Review", "Revlew"),
    ("Hall", "Ha11"),
    ("Location", "Locatlon"),
    ("August", "Augusl"),
    ("September", "Septernber"),
    ("AM", "A M"),
    ("PM", "P M"),
]

SPLIT_ASSETS = {
    "train": {
        "families": [
            "stacked-card",
            "compact-agenda",
            "ruled-table",
            "split-column",
            "ticket-strip",
            "course-list",
            "flyer-stack",
            "phone-capture",
        ],
        "fonts": ["Alder Sans", "Bramble Serif", "Cove Mono", "Dune Grotesk"],
        "scanStyles": ["clean", "soft-jpeg", "warm-shadow", "light-skew"],
        "organizations": [
            "Cedar Studio",
            "Willow School",
            "Northline Arts",
            "Juniper Travel",
            "Harbor Collective",
            "Moss Library",
        ],
    },
    "dev": {
        "families": ["ribbon-timeline", "offset-course-grid", "bordered-invite"],
        "fonts": ["Elm Humanist", "Field Slab"],
        "scanStyles": ["cool-scan", "faint-copy"],
        "organizations": ["Foxglove College", "Beacon Workshop", "Pine Rail"],
    },
    "test": {
        "families": [
            "sunrise-agenda",
            "rotation-matrix",
            "itinerary-bands",
            "notebook-screenshot",
        ],
        "fonts": ["Kite Sans", "Lumen Serif", "Orbit Mono"],
        "scanStyles": ["creased-paper", "phone-glare", "low-contrast"],
        "organizations": ["Saffron Institute", "Riverglass Club", "Canyon Transit"],
    },
}


@dataclass
class HashHead:
    name: str
    labels: list[str]
    buckets: int
    weights: np.ndarray
    bias: np.ndarray

    @classmethod
    def zero(cls, name: str, labels: Sequence[str], buckets: int) -> "HashHead":
        return cls(
            name=name,
            labels=list(labels),
            buckets=buckets,
            weights=np.zeros((len(labels), buckets), dtype=np.float32),
            bias=np.zeros(len(labels), dtype=np.float32),
        )

    def logits(self, features: Sequence[str]) -> np.ndarray:
        ids = feature_ids(features, self.buckets)
        return self.logits_ids(ids)

    def logits_ids(self, ids: Sequence[int]) -> np.ndarray:
        if not ids:
            return self.bias.copy()
        return self.bias + self.weights[:, ids].sum(axis=1) / math.sqrt(len(ids))

    def predict(self, features: Sequence[str]) -> int:
        return int(np.argmax(self.logits(features)))

    def predict_ids(self, ids: Sequence[int]) -> int:
        return int(np.argmax(self.logits_ids(ids)))

    def probabilities(self, features: Sequence[str]) -> np.ndarray:
        logits = self.logits(features)
        shifted = logits - float(np.max(logits))
        exponentials = np.exp(shifted)
        return exponentials / float(np.sum(exponentials))

    def update(self, features: Sequence[str], target: int, learning_rate: float) -> bool:
        return self.update_ids(feature_ids(features, self.buckets), target, learning_rate)

    def update_ids(self, ids: Sequence[int], target: int, learning_rate: float) -> bool:
        predicted = self.predict_ids(ids)
        if predicted == target:
            return False
        step = learning_rate / math.sqrt(max(1, len(ids)))
        self.weights[target, ids] += step
        self.weights[predicted, ids] -= step
        self.bias[target] += learning_rate * 0.08
        self.bias[predicted] -= learning_rate * 0.08
        return True


def load_config() -> dict[str, Any]:
    return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))


def stable_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def fnv1a32(value: str) -> int:
    result = 2_166_136_261
    for byte in value.encode("utf-8"):
        result ^= byte
        result = (result * 16_777_619) & 0xFFFFFFFF
    return result


def feature_ids(features: Sequence[str], buckets: int) -> list[int]:
    return sorted({fnv1a32(feature) % buckets for feature in features})


def normalize_text(value: str) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", value)).strip().lower()


def tokens(value: str) -> list[str]:
    return TOKEN_PATTERN.findall(normalize_text(value))


def bucket(value: float, count: int) -> int:
    return max(0, min(count - 1, math.floor(value * count)))


def confidence_bucket(value: float) -> int:
    return max(0, min(4, math.floor(value * 5)))


def signed_bucket(value: float) -> int:
    if value <= -0.24:
        return -3
    if value <= -0.08:
        return -2
    if value < -0.02:
        return -1
    if value <= 0.02:
        return 0
    if value < 0.08:
        return 1
    if value < 0.24:
        return 2
    return 3


def lexical_flags(text: str) -> list[str]:
    flags: list[str] = []
    if any(pattern.search(text) for pattern in DATE_PATTERNS):
        flags.append("flag:date")
    if TIME_PATTERN.search(text):
        flags.append("flag:time")
    if LOCATION_PATTERN.search(text):
        flags.append("flag:location")
    if REMINDER_PATTERN.search(text):
        flags.append("flag:reminder")
    if RECURRENCE_PATTERN.search(text):
        flags.append("flag:recurrence")
    stripped = text.strip()
    letters = [character for character in stripped if character.isalpha()]
    if len(stripped) >= 4 and letters and all(character.isupper() for character in letters):
        flags.append("flag:uppercase")
    if re.match(r"^\s*[•·*\-–—]", text):
        flags.append("flag:bullet")
    if "|" in text:
        flags.append("flag:pipe")
    if re.search(r"\b(?:agenda|schedule|syllabus|itinerary|rotation|important dates)\b", text, re.I):
        flags.append("flag:document-heading")
    if re.search(r"\b(?:printed|generated|downloaded|page\s+\d+|questions\?|records?)\b", text, re.I):
        flags.append("flag:page-chrome")
    return flags


def block_features(
    block: dict[str, Any],
    index: int,
    page_blocks: Sequence[dict[str, Any]],
    include_geometry: bool = True,
) -> list[str]:
    normalized = normalize_text(block["text"])
    block_tokens = tokens(block["text"])
    features = {
        "bias",
        f"method:{block['method']}",
        f"confidence:{confidence_bucket(block['confidence'])}",
        f"token-count:{min(12, len(block_tokens))}",
        f"char-count:{min(12, math.floor(len(normalized) / 12))}",
        *lexical_flags(block["text"]),
    }
    for token in block_tokens[:24]:
        features.add(f"token:{token}")
        features.add(f"prefix:{token[:3]}")
        features.add(f"suffix:{token[-3:]}")
    if block_tokens:
        features.add(f"first:{block_tokens[0]}")
        features.add(f"last:{block_tokens[-1]}")
    for token_index in range(min(12, len(block_tokens) - 1)):
        features.add(f"bigram:{block_tokens[token_index]}|{block_tokens[token_index + 1]}")
    if re.search(r"\d", normalized):
        features.add("shape:digit")
    if re.search(r"\d{4}", normalized):
        features.add("shape:four-digits")
    if ":" in normalized:
        features.add("shape:colon")
    if re.search(r"[-–—]", normalized):
        features.add("shape:dash")
    if include_geometry:
        box = block["boundingBox"]
        features.add(f"x:{bucket(box['x'], 8)}")
        features.add(f"y:{bucket(box['y'], 10)}")
        features.add(f"width:{bucket(box['width'], 6)}")
        features.add(f"height:{bucket(box['height'], 6)}")
        features.add(f"column:{bucket(box['x'] + box['width'] / 2, 4)}")
        features.add(f"position:{bucket(index / max(1, len(page_blocks)), 10)}")
        center_y = box["y"] + box["height"] / 2
        features.add(
            "page-margin:top"
            if center_y < 0.08
            else "page-margin:bottom"
            if center_y > 0.9
            else "page-margin:body"
        )
    for direction, neighbor_index in (("previous", index - 1), ("next", index + 1)):
        if neighbor_index < 0 or neighbor_index >= len(page_blocks):
            continue
        neighbor = page_blocks[neighbor_index]
        neighbor_tokens = tokens(neighbor["text"])
        if neighbor_tokens:
            features.add(f"{direction}-first:{neighbor_tokens[0]}")
        for flag in lexical_flags(neighbor["text"]):
            features.add(f"{direction}-{flag}")
    return sorted(features)


def document_features(
    blocks: Sequence[dict[str, Any]], include_geometry: bool = True
) -> list[str]:
    features = {"bias", f"blocks:{min(12, len(blocks))}"}
    flags: Counter[str] = Counter()
    for block in blocks:
        flags.update(lexical_flags(block["text"]))
        for token in tokens(block["text"])[:8]:
            features.add(f"doc-token:{token}")
    for flag, count in flags.items():
        features.add(f"doc-{flag}:{min(5, count)}")
    if include_geometry and len(blocks) > 1:
        row_pairs = sum(
            1
            for index in range(1, len(blocks))
            if abs(blocks[index]["boundingBox"]["y"] - blocks[index - 1]["boundingBox"]["y"])
            < 0.02
        )
        features.add(f"row-pairs:{min(5, row_pairs)}")
        columns = len({bucket(block["boundingBox"]["x"], 4) for block in blocks})
        features.add(f"columns:{columns}")
    return sorted(features)


def pair_features(
    left: dict[str, Any],
    right: dict[str, Any],
    left_index: int,
    right_index: int,
    left_entity: str,
    right_entity: str,
    left_block_role: str,
    right_block_role: str,
    include_geometry: bool = True,
) -> list[str]:
    features = {
        "bias",
        f"from-entity:{left_entity}",
        f"to-entity:{right_entity}",
        f"entity-pair:{left_entity}|{right_entity}",
        f"block-pair:{left_block_role}|{right_block_role}",
        f"order-gap:{min(8, abs(right_index - left_index))}",
        f"method-pair:{left['method']}|{right['method']}",
    }
    if include_geometry:
        left_box = left["boundingBox"]
        right_box = right["boundingBox"]
        left_x = left_box["x"] + left_box["width"] / 2
        left_y = left_box["y"] + left_box["height"] / 2
        right_x = right_box["x"] + right_box["width"] / 2
        right_y = right_box["y"] + right_box["height"] / 2
        dx = right_x - left_x
        dy = right_y - left_y
        features.add(f"dx:{signed_bucket(dx)}")
        features.add(f"dy:{signed_bucket(dy)}")
        features.add(f"abs-dx:{bucket(abs(dx), 16)}")
        features.add(f"abs-dy:{bucket(abs(dy), 20)}")
        features.add(f"abs-dx-fine:{bucket(abs(dx), 64)}")
        features.add(f"abs-dy-fine:{bucket(abs(dy), 80)}")
        features.add(f"from-x:{bucket(left_x, 8)}")
        features.add(f"from-y:{bucket(left_y, 12)}")
        features.add(f"to-x:{bucket(right_x, 8)}")
        features.add(f"to-y:{bucket(right_y, 12)}")
        vertical_gap = max(
            0.0,
            max(left_box["y"], right_box["y"])
            - min(
                left_box["y"] + left_box["height"],
                right_box["y"] + right_box["height"],
            ),
        )
        row_overlap = max(
            0.0,
            min(
                left_box["y"] + left_box["height"],
                right_box["y"] + right_box["height"],
            )
            - max(left_box["y"], right_box["y"]),
        )
        features.add(f"vertical-gap:{bucket(vertical_gap, 80)}")
        features.add(f"row-overlap:{int(row_overlap > 0)}")
        features.add(f"same-row:{int(abs(dy) <= 0.035)}")
        features.add(f"same-row-tight:{int(abs(dy) <= 0.018)}")
        features.add(f"same-column:{int(abs(dx) <= 0.12)}")
        features.add(f"same-column-tight:{int(abs(dx) <= 0.06)}")
        features.add(f"direction:{'horizontal' if abs(dx) > abs(dy) else 'vertical'}")
        features.add(f"same-entity-role:{int(left_entity == right_entity)}")
    for flag in lexical_flags(left["text"]):
        features.add(f"from-{flag}")
    for flag in lexical_flags(right["text"]):
        features.add(f"to-{flag}")
    return sorted(features)


def block(
    block_id: str,
    text: str,
    x: float,
    y: float,
    width: float,
    height: float,
    block_role: str,
    entity_role: str,
    group_id: str | None,
    method: str,
    confidence: float,
    quality: str,
) -> dict[str, Any]:
    return {
        "id": block_id,
        "text": text,
        "boundingBox": {
            "x": round(max(0.001, min(0.97, x)), 5),
            "y": round(max(0.001, min(0.97, y)), 5),
            "width": round(max(0.01, min(0.98 - x, width)), 5),
            "height": round(max(0.008, min(0.98 - y, height)), 5),
        },
        "method": method,
        "confidence": round(confidence, 4),
        "blockRole": block_role,
        "entityRole": entity_role,
        "groupId": group_id,
        "quality": quality,
    }


def maybe_scan_text(
    text: str,
    rng: random.Random,
    scanned: bool,
    challenges: Sequence[str],
) -> str:
    probability = 0.34 if "ocr-corruption" in challenges else 0.14
    if not scanned or rng.random() > probability:
        return text
    for before, after in OCR_SUBSTITUTIONS:
        if before in text:
            return text.replace(before, after, 1)
    if ":" in text and rng.random() < 0.5:
        return text.replace(":", " ", 1)
    if " - " in text and rng.random() < 0.5:
        return text.replace(" - ", "  -  ", 1)
    if len(text) > 8:
        index = rng.randrange(2, len(text) - 2)
        if text[index].isalpha():
            return f"{text[:index]}{text[index + 1:]}"
    return text


def layout_groups(
    groups: Sequence[dict[str, str]],
    family: str,
    method: str,
    rng: random.Random,
    challenges: Sequence[str],
) -> list[dict[str, Any]]:
    blocks: list[dict[str, Any]] = []
    scanned = method == "ocr"
    quality = "ocr-risk" if scanned else "clear"
    prefix = family.split("-")[0]
    horizontal = any(
        marker in family
        for marker in ("table", "matrix", "bands", "column", "grid", "strip")
    )
    if horizontal:
        header_y = 0.12
        columns = [
            ("title", "Plan", 0.06, 0.29, "plan-title", "title"),
            ("date", "Date", 0.39, 0.20, "plan-field", "date"),
            ("time", "Time", 0.62, 0.16, "plan-field", "time"),
            ("location", "Place", 0.79, 0.17, "plan-field", "location"),
        ]
        if "unfamiliar-column-order" in challenges:
            order = [2, 0, 3, 1] if rng.random() < 0.5 else [1, 3, 0, 2]
            slots = [(0.06, 0.20), (0.28, 0.28), (0.58, 0.19), (0.79, 0.17)]
            columns = [
                (
                    columns[column_index][0],
                    columns[column_index][1],
                    slots[slot_index][0],
                    slots[slot_index][1],
                    columns[column_index][4],
                    columns[column_index][5],
                )
                for slot_index, column_index in enumerate(order)
            ]
        for index, (_, text, x, width, _, _) in enumerate(columns):
            blocks.append(
                block(
                    f"header:{index}",
                    text,
                    x,
                    header_y,
                    width,
                    0.026,
                    "metadata",
                    "other",
                    None,
                    method,
                    0.82 if scanned else 1.0,
                    "crowded",
                )
            )
        for group_index, group in enumerate(groups):
            row_step = 0.105 if "neighboring-row-negatives" in challenges else 0.145
            y = 0.2 + group_index * row_step
            values_by_key = {
                "title": group["title"],
                "date": group["date"],
                "time": group["time"],
                "location": f"Room: {group['location']}",
            }
            values = [
                (values_by_key[key], x, width, block_role, entity_role)
                for key, _, x, width, block_role, entity_role in columns
            ]
            for field_index, (text, x, width, block_role, entity_role) in enumerate(values):
                confidence = rng.uniform(0.72, 0.9) if scanned else 1.0
                blocks.append(
                    block(
                        f"group:{group_index}:{field_index}",
                        maybe_scan_text(text, rng, scanned, challenges),
                        x,
                        y + rng.uniform(-0.003, 0.003),
                        width,
                        0.031,
                        block_role,
                        entity_role,
                        f"group:{group_index}",
                        method,
                        confidence,
                        "crowded" if not scanned else quality,
                    )
                )
            if group.get("recurrence"):
                blocks.append(
                    block(
                        f"group:{group_index}:recurrence",
                        group["recurrence"],
                        0.62,
                        y + 0.04,
                        0.22,
                        0.024,
                        "plan-field",
                        "recurrence",
                        f"group:{group_index}",
                        method,
                        rng.uniform(0.72, 0.9) if scanned else 1.0,
                        quality,
                    )
                )
    else:
        y = 0.17
        title_first = prefix in {"phone", "notebook", "flyer", "bordered"}
        for group_index, group in enumerate(groups):
            order = [
                (group["date"], "plan-field", "date"),
                (group["title"], "plan-title", "title"),
                (group["time"], "plan-field", "time"),
                (f"Location: {group['location']}", "plan-field", "location"),
            ]
            if title_first:
                order[0], order[1] = order[1], order[0]
            if "unfamiliar-column-order" in challenges:
                order = [order[2], order[0], order[3], order[1]]
            for field_index, (text, block_role, entity_role) in enumerate(order):
                x = 0.09 + (0.03 if field_index in {2, 3} else 0)
                blocks.append(
                    block(
                        f"group:{group_index}:{field_index}",
                        maybe_scan_text(text, rng, scanned, challenges),
                        x,
                        y,
                        0.7 if entity_role != "location" else 0.55,
                        0.032,
                        block_role,
                        entity_role,
                        f"group:{group_index}",
                        method,
                        rng.uniform(0.7, 0.91) if scanned else 1.0,
                        quality,
                    )
                )
                y += 0.043
            if group.get("description"):
                blocks.append(
                    block(
                        f"group:{group_index}:description",
                        group["description"],
                        0.12,
                        y,
                        0.68,
                        0.026,
                        "description",
                        "description",
                        f"group:{group_index}",
                        method,
                        rng.uniform(0.7, 0.91) if scanned else 1.0,
                        quality,
                    )
                )
                y += 0.04
            if group.get("recurrence"):
                blocks.append(
                    block(
                        f"group:{group_index}:recurrence",
                        group["recurrence"],
                        0.12,
                        y,
                        0.45,
                        0.026,
                        "plan-field",
                        "recurrence",
                        f"group:{group_index}",
                        method,
                        rng.uniform(0.7, 0.91) if scanned else 1.0,
                        quality,
                    )
                )
                y += 0.04
            y += 0.045
    return blocks


def generate_page(split: str, index: int, rng: random.Random, config: dict[str, Any]) -> dict[str, Any]:
    assets = SPLIT_ASSETS[split]
    family = assets["families"][index % len(assets["families"])]
    document_type = DOCUMENT_TYPES[index % len(DOCUMENT_TYPES)]
    configured_challenges = config["dataset"].get("challengeSlices", CHALLENGE_SLICES)
    layout_cycle = index // len(assets["families"])
    challenge_slice = configured_challenges[layout_cycle % len(configured_challenges)]
    challenges = [challenge_slice]
    scanned = (layout_cycle // len(configured_challenges)) % 2 == 1
    method = "ocr" if scanned else "native-text"
    plan_count = rng.randint(
        config["dataset"]["minimumPlansPerPage"], config["dataset"]["maximumPlansPerPage"]
    )
    groups: list[dict[str, str]] = []
    repeated_title = TITLES[(index * 3) % len(TITLES)]
    for group_index in range(plan_count):
        reminder = challenge_slice != "repeated-titles" and (index + group_index) % 5 == 0
        title = (
            repeated_title
            if challenge_slice == "repeated-titles"
            else TITLES[(index * 3 + group_index * 5) % len(TITLES)]
        )
        if reminder:
            title = f"Reminder: {title}"
        groups.append(
            {
                "id": f"group:{group_index}",
                "kind": "reminder" if reminder else "event",
                "title": title,
                "date": DATES[(index + group_index) % len(DATES)],
                "time": TIMES[(index * 2 + group_index) % len(TIMES)],
                "location": LOCATIONS[(index + group_index * 2) % len(LOCATIONS)],
                "description": DESCRIPTIONS[(index + group_index) % len(DESCRIPTIONS)]
                if (index + group_index) % 3 == 0
                else "",
                "recurrence": RECURRENCES[(index + group_index) % len(RECURRENCES)]
                if (index + group_index) % 7 == 0
                else "",
            }
        )
    organization = assets["organizations"][index % len(assets["organizations"])]
    heading = {
        "schedule": "WEEKLY SCHEDULE",
        "syllabus": "COURSE SYLLABUS - IMPORTANT DATES",
        "invitation": "YOU ARE INVITED",
        "flyer": "COMMUNITY EVENTS",
        "itinerary": "TRAVEL ITINERARY",
        "rotation": "TEAM ROTATION",
        "table": "DATES AND TIMES",
        "screenshot": "UPCOMING PLANS",
    }[document_type]
    blocks = [
        block(
            "heading:main",
            heading,
            0.07,
            0.045,
            0.72,
            0.045,
            "heading",
            "other",
            None,
            method,
            rng.uniform(0.75, 0.93) if scanned else 1.0,
            "ocr-risk" if scanned else "clear",
        ),
        block(
            "metadata:org",
            f"Prepared by {organization}",
            0.07,
            0.1,
            0.55,
            0.025,
            "metadata",
            "other",
            None,
            method,
            rng.uniform(0.7, 0.9) if scanned else 1.0,
            "ocr-risk" if scanned else "clear",
        ),
    ]
    blocks.extend(layout_groups(groups, family, method, rng, challenges))
    if challenge_slice == "header-footer-distractions":
        blocks.extend(
            [
                block(
                    "noise:print-header",
                    "Printed August 18, 2026 at 8:41 AM",
                    0.58,
                    0.012,
                    0.34,
                    0.018,
                    "metadata",
                    "other",
                    None,
                    method,
                    rng.uniform(0.65, 0.86) if scanned else 1.0,
                    "noise",
                ),
                block(
                    "noise:download-footer",
                    "Downloaded schedule - page 1 of 1 - Room 404",
                    0.48,
                    0.952,
                    0.45,
                    0.018,
                    "other",
                    "other",
                    None,
                    method,
                    rng.uniform(0.62, 0.84) if scanned else 1.0,
                    "noise",
                ),
            ]
        )
    if index % 9 == 0:
        blocks.append(
            block(
                "noise:footer",
                "Questions? Keep this page for your records.",
                0.08,
                0.92,
                0.7,
                0.022,
                "other",
                "other",
                None,
                method,
                rng.uniform(0.62, 0.85) if scanned else 1.0,
                "noise",
            )
        )
    blocks.sort(key=lambda item: (item["boundingBox"]["y"], item["boundingBox"]["x"]))
    return {
        "id": f"planscan:{split}:{index}",
        "split": split,
        "challengeSlice": challenge_slice,
        "challenges": challenges,
        "templateFamily": family,
        "font": assets["fonts"][index % len(assets["fonts"])],
        "scanStyle": assets["scanStyles"][index % len(assets["scanStyles"])],
        "organization": organization,
        "documentType": document_type,
        "method": method,
        "blocks": blocks,
        "groups": groups,
    }


def write_jsonl(path: Path, values: Iterable[dict[str, Any]]) -> tuple[int, str]:
    path.parent.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256()
    count = 0
    with path.open("wb") as stream:
        for value in values:
            line = (stable_json(value) + "\n").encode("utf-8")
            stream.write(line)
            digest.update(line)
            count += 1
    return count, digest.hexdigest()


def contract_page(page: dict[str, Any]) -> dict[str, Any]:
    words = []
    blocks = []
    for index, source in enumerate(page["blocks"]):
        word_id = f"word:1:{index}"
        words.append(
            {
                "id": word_id,
                "lineId": f"line:1:{index}",
                "page": 1,
                "text": source["text"],
                "boundingBox": source["boundingBox"],
                "confidence": source["confidence"],
                "method": source["method"],
            }
        )
        blocks.append(
            {
                "id": source["id"],
                "page": 1,
                "text": source["text"],
                "boundingBox": source["boundingBox"],
                "confidence": source["confidence"],
                "method": source["method"],
                "wordIds": [word_id],
            }
        )
    observed_groups = []
    for group in page["groups"]:
        group_blocks = [block for block in page["blocks"] if block["groupId"] == group["id"]]

        def observed_block(role: str) -> dict[str, Any] | None:
            return next((block for block in group_blocks if block["entityRole"] == role), None)

        title_block = observed_block("title")
        date_block = observed_block("date")
        time_block = observed_block("time")
        location_block = observed_block("location")
        date_match = (
            next(
                (match for pattern in DATE_PATTERNS if (match := pattern.search(date_block["text"]))),
                None,
            )
            if date_block
            else None
        )
        time_match = TIME_PATTERN.search(time_block["text"]) if time_block else None
        location_match = LOCATION_PATTERN.search(location_block["text"]) if location_block else None
        if not title_block or not date_match or not time_match:
            continue

        observed_groups.append(
            {
                "id": group["id"],
                "kind": group["kind"],
                "title": title_block["text"],
                "date": date_match.group(0),
                "time": time_match.group(0),
                "location": location_match.group(1) if location_match else "",
            }
        )
    return {
        "id": page["id"],
        "challengeSlice": page["challengeSlice"],
        "challenges": page["challenges"],
        "templateFamily": page["templateFamily"],
        "font": page["font"],
        "scanStyle": page["scanStyle"],
        "organization": page["organization"],
        "documentType": page["documentType"],
        "method": page["method"],
        "page": {
            "page": 1,
            "width": 1275 if page["method"] == "ocr" else 612,
            "height": 1650 if page["method"] == "ocr" else 792,
            "rotation": 0,
            "extraction": page["method"],
            "nativeCharacterCount": 0
            if page["method"] == "ocr"
            else sum(len(block["text"]) for block in blocks),
            "thumbnailDataUrl": "data:image/png;base64,iVBORw0KGgo=",
            "words": words,
            "blocks": blocks,
        },
        "gold": {
            "blockRoles": {source["id"]: source["blockRole"] for source in page["blocks"]},
            "entityRoles": {source["id"]: source["entityRole"] for source in page["blocks"]},
            "groups": [
                {
                    "id": group["id"],
                    "kind": group["kind"],
                    "title": group["title"],
                    "date": group["date"],
                    "time": group["time"],
                    "location": group["location"],
                }
                for group in page["groups"]
            ],
            "observedGroups": observed_groups,
        },
    }


def generate() -> dict[str, Any]:
    config = load_config()
    seed = int(config["seed"])
    DATA_DIRECTORY.mkdir(parents=True, exist_ok=True)
    split_counts = {
        "train": int(config["dataset"]["trainPages"]),
        "dev": int(config["dataset"]["devPages"]),
        "test": int(config["dataset"]["testPages"]),
    }
    files: dict[str, Any] = {}
    challenge_counts: dict[str, dict[str, int]] = {}
    heldout: list[dict[str, Any]] = []
    for split, count in split_counts.items():
        rng = random.Random(seed + {"train": 11, "dev": 23, "test": 37}[split])
        pages = [generate_page(split, index, rng, config) for index in range(count)]
        path = DATA_DIRECTORY / f"{split}.jsonl"
        written, digest = write_jsonl(path, pages)
        files[split] = {
            "path": str(path.relative_to(WORKSPACE)).replace("\\", "/"),
            "pages": written,
            "sha256": digest,
            "nativePages": sum(page["method"] == "native-text" for page in pages),
            "scannedPages": sum(page["method"] == "ocr" for page in pages),
        }
        challenge_counts[split] = dict(Counter(page["challengeSlice"] for page in pages))
        if split == "test":
            desired = int(config["dataset"]["trackedHeldoutPages"])
            per_slice_method = max(1, desired // (len(CHALLENGE_SLICES) * 2))
            heldout = []
            for challenge in CHALLENGE_SLICES:
                for method in ("native-text", "ocr"):
                    slice_pages = [
                        page
                        for page in pages
                        if page["challengeSlice"] == challenge and page["method"] == method
                    ][:per_slice_method]
                    heldout.extend(contract_page(page) for page in slice_pages)
            heldout = heldout[:desired]
    heldout_count, heldout_digest = write_jsonl(HELDOUT_FIXTURE_PATH, heldout)
    assets = {
        split: {
            "templateFamilies": values["families"],
            "fonts": values["fonts"],
            "scanStyles": values["scanStyles"],
            "organizations": values["organizations"],
        }
        for split, values in SPLIT_ASSETS.items()
    }
    manifest_core = {
        "schemaVersion": 1,
        "seed": seed,
        "generator": "ml/planscan/pipeline.py",
        "programFirst": True,
        "teacherUsed": False,
        "pretrainedWeightsUsed": False,
        "personalDataUsed": False,
        "files": files,
        "heldout": {
            "path": str(HELDOUT_FIXTURE_PATH.relative_to(WORKSPACE)).replace("\\", "/"),
            "pages": heldout_count,
            "sha256": heldout_digest,
        },
        "disjointAssets": assets,
        "documentTypes": DOCUMENT_TYPES,
        "challengeSlices": CHALLENGE_SLICES,
        "challengeCounts": challenge_counts,
    }
    manifest_digest = sha256_bytes(stable_json(manifest_core).encode("utf-8"))
    manifest = {**manifest_core, "manifestSha256": manifest_digest}
    write_json(DATA_MANIFEST_PATH, manifest)
    return manifest


def read_jsonl(path: Path) -> Iterable[dict[str, Any]]:
    with path.open("r", encoding="utf-8") as stream:
        for line in stream:
            if line.strip():
                yield json.loads(line)


def relation_label(left: dict[str, Any], right: dict[str, Any]) -> str:
    if left["groupId"] and left["groupId"] == right["groupId"]:
        pair = {left["entityRole"], right["entityRole"]}
        if pair == {"date", "time"}:
            return "date-time"
        if "title" in pair:
            return "title-field"
        if pair & {"description", "location"}:
            return "field-detail"
        return "same-plan"
    if (
        left["entityRole"] == "title"
        and right["entityRole"] == "title"
        and left["groupId"]
        and right["groupId"]
    ):
        return "sequence"
    return "none"


def group_link_label(left: dict[str, Any], right: dict[str, Any]) -> str:
    if left["groupId"] and left["groupId"] == right["groupId"]:
        return "same-group"
    if left["entityRole"] == "title" and right["entityRole"] == "title":
        return "new-group"
    if {left["blockRole"], right["blockRole"]} & {"heading", "metadata"} and (
        left["groupId"] or right["groupId"]
    ):
        return "context"
    return "none"


def hard_negative_pair(left: dict[str, Any], right: dict[str, Any]) -> bool:
    left_group = left["groupId"]
    right_group = right["groupId"]
    if left_group and right_group and left_group != right_group:
        left_box = left["boundingBox"]
        right_box = right["boundingBox"]
        close_rows = abs(left_box["y"] - right_box["y"]) <= 0.16
        confusable_roles = (
            left["entityRole"] == right["entityRole"]
            or {left["entityRole"], right["entityRole"]}
            in ({"title", "date"}, {"date", "time"}, {"time", "location"})
        )
        if close_rows and confusable_roles:
            return True
    chrome = left if not left_group else right if not right_group else None
    grouped = right if chrome is left else left if chrome is right else None
    return bool(
        chrome
        and grouped
        and "flag:page-chrome" in lexical_flags(chrome["text"])
        and set(lexical_flags(chrome["text"]))
        & {"flag:date", "flag:time", "flag:location"}
    )


def training_pairs(blocks: Sequence[dict[str, Any]], rng: random.Random) -> list[tuple[int, int]]:
    positives: list[tuple[int, int]] = []
    hard_negatives: list[tuple[int, int]] = []
    negatives: list[tuple[int, int]] = []
    for left_index, left in enumerate(blocks):
        for right_index, right in enumerate(blocks):
            if left_index == right_index:
                continue
            target = relation_label(left, right)
            if target == "none" and group_link_label(left, right) == "none":
                (hard_negatives if hard_negative_pair(left, right) else negatives).append(
                    (left_index, right_index)
                )
            else:
                positives.append((left_index, right_index))
    rng.shuffle(positives)
    rng.shuffle(hard_negatives)
    rng.shuffle(negatives)
    return (
        positives[:18]
        + hard_negatives[: max(14, min(28, len(positives) + 10))]
        + negatives[: max(6, min(10, len(positives) // 2 + 2))]
    )


def train() -> dict[str, HashHead]:
    config = load_config()
    buckets = int(config["model"]["featureBuckets"])
    heads = {
        name: HashHead.zero(name, labels, buckets) for name, labels in HEAD_LABELS.items()
    }
    train_path = DATA_DIRECTORY / "train.jsonl"
    if not train_path.exists():
        generate()
    pages = list(read_jsonl(train_path))
    rng = random.Random(int(config["seed"]) + 101)
    learning_rate = float(config["model"]["learningRate"])
    epochs = int(config["model"]["epochs"])
    started = time.perf_counter()
    updates: Counter[str] = Counter()
    examples: Counter[str] = Counter()
    for epoch in range(epochs):
        order = list(range(len(pages)))
        rng.shuffle(order)
        epoch_rate = learning_rate / (1 + epoch * 0.35)
        for page_index in order:
            page = pages[page_index]
            blocks = page["blocks"]
            for index, source in enumerate(blocks):
                features = block_features(source, index, blocks)
                ids = feature_ids(features, buckets)
                for head_name, target_name in (
                    ("blockRole", source["blockRole"]),
                    ("entityRole", source["entityRole"]),
                    ("confidence", source["quality"]),
                ):
                    examples[head_name] += 1
                    target = heads[head_name].labels.index(target_name)
                    updates[head_name] += heads[head_name].update_ids(ids, target, epoch_rate)
            document_target = heads["documentType"].labels.index(page["documentType"])
            examples["documentType"] += 1
            document_ids = feature_ids(document_features(blocks), buckets)
            updates["documentType"] += heads["documentType"].update_ids(
                document_ids, document_target, epoch_rate
            )
            for left_index, right_index in training_pairs(blocks, rng):
                left = blocks[left_index]
                right = blocks[right_index]
                features = pair_features(
                    left,
                    right,
                    left_index,
                    right_index,
                    left["entityRole"],
                    right["entityRole"],
                    left["blockRole"],
                    right["blockRole"],
                )
                ids = feature_ids(features, buckets)
                for head_name, target_name in (
                    ("relation", relation_label(left, right)),
                    ("groupLink", group_link_label(left, right)),
                ):
                    examples[head_name] += 1
                    target = heads[head_name].labels.index(target_name)
                    updates[head_name] += heads[head_name].update_ids(ids, target, epoch_rate)
    training_report = {
        "durationSeconds": round(time.perf_counter() - started, 3),
        "epochs": epochs,
        "examples": dict(examples),
        "mistakeUpdates": dict(updates),
        "parameterInitialization": "zero",
    }
    write_json(REPORT_DIRECTORY / "training.json", training_report)
    GENERATED.mkdir(parents=True, exist_ok=True)
    for name, head in heads.items():
        np.save(GENERATED / f"{name}.float32.npy", head.weights)
        np.save(GENERATED / f"{name}.bias.float32.npy", head.bias)
    return heads


def load_float_heads() -> dict[str, HashHead]:
    config = load_config()
    buckets = int(config["model"]["featureBuckets"])
    heads: dict[str, HashHead] = {}
    for name, labels in HEAD_LABELS.items():
        weight_path = GENERATED / f"{name}.float32.npy"
        bias_path = GENERATED / f"{name}.bias.float32.npy"
        if not weight_path.exists() or not bias_path.exists():
            return train()
        heads[name] = HashHead(
            name=name,
            labels=list(labels),
            buckets=buckets,
            weights=np.load(weight_path),
            bias=np.load(bias_path),
        )
    return heads


def micro_f1(targets: Sequence[str], predictions: Sequence[str], excluded: str) -> float:
    true_positive = sum(
        target == prediction and target != excluded
        for target, prediction in zip(targets, predictions)
    )
    false_positive = sum(
        prediction != excluded and target != prediction
        for target, prediction in zip(targets, predictions)
    )
    false_negative = sum(
        target != excluded and target != prediction
        for target, prediction in zip(targets, predictions)
    )
    denominator = 2 * true_positive + false_positive + false_negative
    return 0.0 if denominator == 0 else (2 * true_positive) / denominator


def evaluate_heads(
    heads: dict[str, HashHead],
    path: Path,
    include_geometry: bool = True,
    quantized: dict[str, tuple[np.ndarray, np.ndarray]] | None = None,
) -> dict[str, Any]:
    entity_targets: list[str] = []
    entity_predictions: list[str] = []
    block_targets: list[str] = []
    block_predictions: list[str] = []
    relation_targets: list[str] = []
    relation_predictions: list[str] = []
    link_targets: list[str] = []
    link_predictions: list[str] = []
    document_targets: list[str] = []
    document_predictions: list[str] = []
    execution_by_method: dict[str, list[bool]] = {"native-text": [], "ocr": []}
    execution_by_challenge: dict[str, list[bool]] = {
        challenge: [] for challenge in CHALLENGE_SLICES
    }
    evidence_values = 0
    evidence_backed = 0
    hard_negative_pairs = 0
    hard_negative_false_links = 0
    distractor_blocks = 0
    distractor_false_entities = 0

    def predict(head_name: str, features: Sequence[str]) -> int:
        head = heads[head_name]
        if quantized is None:
            return head.predict(features)
        weights, scales = quantized[head_name]
        ids = feature_ids(features, head.buckets)
        logits = head.bias.copy()
        if ids:
            logits += (
                weights[:, ids].astype(np.float32).sum(axis=1)
                * scales
                / math.sqrt(len(ids))
            )
        return int(np.argmax(logits))

    for page in read_jsonl(path):
        blocks = page["blocks"]
        predicted_entities: list[str] = []
        predicted_blocks: list[str] = []
        for index, source in enumerate(blocks):
            features = block_features(source, index, blocks, include_geometry)
            entity_prediction = heads["entityRole"].labels[predict("entityRole", features)]
            block_prediction = heads["blockRole"].labels[predict("blockRole", features)]
            entity_targets.append(source["entityRole"])
            entity_predictions.append(entity_prediction)
            block_targets.append(source["blockRole"])
            block_predictions.append(block_prediction)
            predicted_entities.append(entity_prediction)
            predicted_blocks.append(block_prediction)
            if source["groupId"] is None and source["quality"] == "noise":
                distractor_blocks += 1
                distractor_false_entities += entity_prediction != "other"
        document_targets.append(page["documentType"])
        document_predictions.append(
            heads["documentType"].labels[
                predict("documentType", document_features(blocks, include_geometry))
            ]
        )
        page_pairs = training_pairs(blocks, random.Random(fnv1a32(page["id"])))
        for left_index, right_index in page_pairs:
            left = blocks[left_index]
            right = blocks[right_index]
            features = pair_features(
                left,
                right,
                left_index,
                right_index,
                predicted_entities[left_index],
                predicted_entities[right_index],
                predicted_blocks[left_index],
                predicted_blocks[right_index],
                include_geometry,
            )
            relation_targets.append(relation_label(left, right))
            relation_predictions.append(
                heads["relation"].labels[predict("relation", features)]
            )
            link_targets.append(group_link_label(left, right))
            link_prediction = heads["groupLink"].labels[predict("groupLink", features)]
            link_predictions.append(link_prediction)
            if hard_negative_pair(left, right):
                hard_negative_pairs += 1
                hard_negative_false_links += (
                    relation_predictions[-1] != "none" or link_prediction != "none"
                )
        group_success: list[bool] = []
        for group in page["groups"]:
            group_blocks = [source for source in blocks if source["groupId"] == group["id"]]
            critical = [source for source in group_blocks if source["entityRole"] in {"title", "date", "time"}]
            correct = all(
                predicted_entities[blocks.index(source)] == source["entityRole"] for source in critical
            )
            group_success.append(correct)
            evidence_values += len(critical)
            evidence_backed += sum(bool(source["id"] and source["boundingBox"]) for source in critical)
        execution_by_method[page["method"]].append(bool(group_success) and all(group_success))
        execution_by_challenge.setdefault(page.get("challengeSlice", "baseline"), []).append(
            bool(group_success) and all(group_success)
        )
    exact = lambda targets, predictions: sum(
        target == prediction for target, prediction in zip(targets, predictions)
    ) / max(1, len(targets))
    return {
        "pages": sum(len(values) for values in execution_by_method.values()),
        "blockRoleAccuracy": exact(block_targets, block_predictions),
        "entityMicroF1": micro_f1(entity_targets, entity_predictions, "other"),
        "relationMicroF1": micro_f1(relation_targets, relation_predictions, "none"),
        "groupLinkMicroF1": micro_f1(link_targets, link_predictions, "none"),
        "documentTypeAccuracy": exact(document_targets, document_predictions),
        "criticalRolePageEquivalence": {
            "bornDigital": sum(execution_by_method["native-text"])
            / max(1, len(execution_by_method["native-text"])),
            "scanned": sum(execution_by_method["ocr"])
            / max(1, len(execution_by_method["ocr"])),
            "overall": sum(sum(values) for values in execution_by_method.values())
            / max(1, sum(len(values) for values in execution_by_method.values())),
        },
        "challengeCriticalRolePageEquivalence": {
            challenge: sum(values) / max(1, len(values))
            for challenge, values in execution_by_challenge.items()
        },
        "hardNegativeFalseLinkRate": hard_negative_false_links / max(1, hard_negative_pairs),
        "distractorFalseEntityRate": distractor_false_entities / max(1, distractor_blocks),
        "evidenceCoverage": evidence_backed / max(1, evidence_values),
    }


def quantize_heads(
    heads: dict[str, HashHead]
) -> dict[str, tuple[np.ndarray, np.ndarray]]:
    config = load_config()
    calibrated_multipliers = config["model"].get(
        "developmentCalibratedScaleMultiplierByHead", {}
    )
    result: dict[str, tuple[np.ndarray, np.ndarray]] = {}
    for name, head in heads.items():
        maximum = np.max(np.abs(head.weights), axis=1)
        multiplier = float(calibrated_multipliers.get(name, 1.0))
        if not 0.5 <= multiplier <= 2.0:
            raise ValueError(f"Unsafe quantization scale multiplier for {name}: {multiplier}")
        scales = np.where(maximum > 0, maximum / 127.0, 1.0).astype(np.float32)
        scales = (scales * multiplier).astype(np.float32)
        quantized = np.clip(np.rint(head.weights / scales[:, None]), -127, 127).astype(np.int8)
        result[name] = (quantized, scales)
    return result


def update_model_manifest(configuration_path: Path, weights_path: Path) -> None:
    manifest = json.loads(MODEL_MANIFEST_PATH.read_text(encoding="utf-8"))
    manifest["runtime"]["document"] = {
        "primary": "typescript-int8-spatial-graph",
        "isolation": "sandboxed-web-worker",
        "cpuFallback": True,
        "requiresNetwork": False,
        "evidenceProjection": True,
        "repairFallback": "optional-candidate-only-local-model",
        "repairHasMutationAuthority": False,
    }
    manifest["artifacts"] = [
        artifact
        for artifact in manifest["artifacts"]
        if artifact.get("role") != "document-layout"
    ]
    for component, path, artifact_id in (
        ("configuration", configuration_path, "planscan-spatialhashgraph-5m-en-phase6.configuration"),
        ("weights", weights_path, "planscan-spatialhashgraph-5m-en-phase6.weights"),
    ):
        manifest["artifacts"].append(
            {
                "id": artifact_id,
                "role": "document-layout",
                "component": component,
                "version": "0.2.0",
                "format": "json" if component == "configuration" else "bin",
                "path": str(path.relative_to(WORKSPACE / "models")).replace("\\", "/"),
                "sha256": sha256_file(path),
                "byteLength": path.stat().st_size,
                "required": True,
                "contractVersion": "0.1",
                "locale": "en-US",
                "license": "MIT",
                "provenance": "project-trained",
                "sourceUrl": None,
                "generator": "ml/planscan/pipeline.py",
            }
        )
    write_json(MODEL_MANIFEST_PATH, manifest)


def export(heads: dict[str, HashHead], metrics: dict[str, Any]) -> dict[str, Any]:
    config = load_config()
    data_manifest = json.loads(DATA_MANIFEST_PATH.read_text(encoding="utf-8"))
    quantized = quantize_heads(heads)
    MODEL_DIRECTORY.mkdir(parents=True, exist_ok=True)
    binary_parts: list[bytes] = []
    head_artifacts: dict[str, Any] = {}
    offset = 0
    for name in HEAD_LABELS:
        weights, scales = quantized[name]
        data = weights.tobytes(order="C")
        binary_parts.append(data)
        head_artifacts[name] = {
            "labels": heads[name].labels,
            "buckets": heads[name].buckets,
            "byteOffset": offset,
            "byteLength": len(data),
            "scale": [float(value) for value in scales],
            "bias": [float(value) for value in heads[name].bias],
            "temperature": 1.0,
        }
        offset += len(data)
    raw_weights = b"".join(binary_parts)
    weights_path = MODEL_DIRECTORY / "planscan-v0.1-int8.bin.gz"
    with weights_path.open("wb") as stream:
        with gzip.GzipFile(filename="", mode="wb", fileobj=stream, compresslevel=9, mtime=0) as gzip_stream:
            gzip_stream.write(raw_weights)
    artifact = {
        "schemaVersion": 1,
        "id": "planscan-spatialhashgraph-5m-en-phase6",
        "version": "0.2.0",
        "contractVersion": "0.1",
        "architecture": {
            "name": "SpatialHashGraph",
            "parameterCount": len(raw_weights),
            "parameterInitialization": "zero",
            "featureEncoder": "hashed lexical, OCR-quality, reading-order, and normalized 2-D box features",
            "graphDecoder": "learned block/entity roles plus hard-negative-trained pairwise links with bounded row evidence",
            "quantization": config["model"]["quantization"],
            "quantizationCalibration": "development-only per-head scale multipliers",
        },
        "featureBuckets": int(config["model"]["featureBuckets"]),
        "hashAlgorithm": "fnv1a-32-utf8",
        "heads": head_artifacts,
        "weights": {
            "path": "planscan-v0.1-int8.bin.gz",
            "compression": "gzip",
            "uncompressedBytes": len(raw_weights),
            "sha256Uncompressed": sha256_bytes(raw_weights),
        },
        "thresholds": config["thresholds"],
        "training": {
            "seed": int(config["seed"]),
            "datasetManifestSha256": data_manifest["manifestSha256"],
            "challengeSlices": data_manifest["challengeSlices"],
            "hardNeighborNegativeMining": True,
            "teacherUsed": False,
            "pretrainedWeightsUsed": False,
            "personalDataUsed": False,
        },
        "metrics": metrics,
        "safety": {
            "exactSourceProjectionRequired": True,
            "crossPageLinksAllowed": False,
            "deterministicSemanticCompilerRequired": True,
            "explicitConfirmationRequired": True,
            "repairFallbackCandidateSelectionOnly": True,
            "repairFallbackHasMutationAuthority": False,
        },
    }
    configuration_path = MODEL_DIRECTORY / "planscan-v0.1-int8.json"
    write_json(configuration_path, artifact)
    update_model_manifest(configuration_path, weights_path)
    return {
        "configurationPath": str(configuration_path.relative_to(WORKSPACE)).replace("\\", "/"),
        "weightsPath": str(weights_path.relative_to(WORKSPACE)).replace("\\", "/"),
        "compressedBytes": weights_path.stat().st_size,
        "uncompressedBytes": len(raw_weights),
        "parameterCount": len(raw_weights),
        "sha256Uncompressed": sha256_bytes(raw_weights),
    }


def evaluate_and_export(heads: dict[str, HashHead]) -> dict[str, Any]:
    dev_path = DATA_DIRECTORY / "dev.jsonl"
    test_path = DATA_DIRECTORY / "test.jsonl"
    quantized = quantize_heads(heads)
    float_metrics = evaluate_heads(heads, test_path)
    quantized_metrics = evaluate_heads(heads, test_path, quantized=quantized)
    text_only = evaluate_heads(heads, test_path, include_geometry=False, quantized=quantized)
    dev_metrics = evaluate_heads(heads, dev_path, quantized=quantized)
    metric_names = [
        "blockRoleAccuracy",
        "entityMicroF1",
        "relationMicroF1",
        "groupLinkMicroF1",
        "documentTypeAccuracy",
    ]
    maximum_quantization_delta = max(
        abs(float(float_metrics[name]) - float(quantized_metrics[name])) for name in metric_names
    )
    report = {
        "schemaVersion": 1,
        "generatedAt": "deterministic-pipeline",
        "dev": dev_metrics,
        "testFloat32": float_metrics,
        "testInt8": quantized_metrics,
        "textOnlyInferenceAblation": text_only,
        "maximumQuantizationDelta": maximum_quantization_delta,
        "phase6ChallengeMinimumCriticalRolePageEquivalence": min(
            quantized_metrics["challengeCriticalRolePageEquivalence"].values()
        ),
        "splitDisjoint": {
            "templateFamilies": True,
            "fonts": True,
            "scanStyles": True,
            "organizations": True,
        },
        "limitations": [
            "Metrics are from generated held-out layouts, not an independent human document set.",
            "OCR recognition quality remains bounded by the bundled Tesseract model.",
            "Handwriting and unusually visual pages are outside this checkpoint.",
        ],
        "promotionGates": {
            "allChallengeSlicesPresent": set(
                quantized_metrics["challengeCriticalRolePageEquivalence"].keys()
            )
            == set(CHALLENGE_SLICES),
            "hardNegativeFalseLinkRateAtMostFivePercent": quantized_metrics[
                "hardNegativeFalseLinkRate"
            ]
            <= 0.05,
            "distractorFalseEntityRateAtMostTwoPercent": quantized_metrics[
                "distractorFalseEntityRate"
            ]
            <= 0.02,
            "everyCriticalValueEvidenceBacked": quantized_metrics["evidenceCoverage"] == 1,
            "quantizationDeltaAtMostHalfPoint": maximum_quantization_delta <= 0.005,
        },
    }
    export_info = export(heads, report)
    report["export"] = export_info
    write_json(REPORT_DIRECTORY / "prototype-metrics.json", report)
    return report


def all_steps() -> None:
    manifest = generate()
    print(
        f"Generated {sum(file['pages'] for file in manifest['files'].values()):,} pages "
        "with split-disjoint layout assets."
    )
    heads = train()
    report = evaluate_and_export(heads)
    test_metrics = report["testInt8"]
    print(
        "PlanScan INT8: "
        f"entity F1 {test_metrics['entityMicroF1']:.3f}, "
        f"relation F1 {test_metrics['relationMicroF1']:.3f}, "
        f"native critical-role pages {test_metrics['criticalRolePageEquivalence']['bornDigital']:.3f}, "
        f"scan critical-role pages {test_metrics['criticalRolePageEquivalence']['scanned']:.3f}."
    )
    print(
        f"Exported {report['export']['parameterCount']:,} parameters in "
        f"{report['export']['compressedBytes'] / 1024:.1f} KiB compressed."
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "command", choices=["generate", "train", "evaluate", "export", "all"], nargs="?", default="all"
    )
    args = parser.parse_args()
    if args.command == "generate":
        manifest = generate()
        print(f"Generated {sum(file['pages'] for file in manifest['files'].values()):,} pages.")
    elif args.command == "train":
        generate()
        train()
        print("Trained PlanScan from zero initialization.")
    elif args.command == "evaluate":
        if not DATA_MANIFEST_PATH.exists():
            generate()
        report = evaluate_and_export(load_float_heads())
        print(json.dumps(report["testInt8"], indent=2))
    elif args.command == "export":
        if not DATA_MANIFEST_PATH.exists():
            generate()
        existing_report = json.loads(
            (REPORT_DIRECTORY / "prototype-metrics.json").read_text(encoding="utf-8")
        )
        metrics = {key: value for key, value in existing_report.items() if key != "export"}
        export_info = export(load_float_heads(), metrics)
        existing_report["export"] = export_info
        write_json(REPORT_DIRECTORY / "prototype-metrics.json", existing_report)
        print(json.dumps(export_info, indent=2))
    else:
        all_steps()


if __name__ == "__main__":
    main()
