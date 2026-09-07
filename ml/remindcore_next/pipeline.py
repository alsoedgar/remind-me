"""Train and promote the compact RemindCore Next advisory understanding heads.

The Phase 4 challenge split is loaded only after development-time architecture
selection and confidence calibration have finished. A failed gate writes a
report but never overwrites the installed planner.
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
from collections import defaultdict
from pathlib import Path
from typing import Any, Iterable, Sequence

import numpy as np


ROOT = Path(__file__).resolve().parent
WORKSPACE = ROOT.parents[1]
CONFIG_PATH = ROOT / "config.json"
METADATA_PATH = ROOT / "data" / "capabilities.json"
NEXT_TEACHER_JOBS_PATH = ROOT / "teacher" / "teacher-jobs.json"
NEXT_TEACHER_OUTPUT_PATH = ROOT / "teacher" / "qwen-training-paraphrases.json"
NEXT_TEACHER_REPAIR_JOBS_PATH = ROOT / "teacher" / "teacher-repair-jobs.json"
NEXT_TEACHER_REPAIR_OUTPUT_PATH = ROOT / "teacher" / "qwen-training-repair-paraphrases.json"
CORPUS_ROOT = WORKSPACE / "ml" / "assistant_corpus" / "data"
CORPUS_MANIFEST_PATH = CORPUS_ROOT / "manifest.json"
MODEL_ROOT = WORKSPACE / "models"
MODEL_PATH = MODEL_ROOT / "remindcore" / "remindcore-v0.1-int8.json"
TOKENIZER_PATH = MODEL_ROOT / "remindcore" / "tokenizer.json"
THRESHOLDS_PATH = MODEL_ROOT / "remindcore" / "thresholds.json"
ONNX_PATH = MODEL_ROOT / "remindcore" / "remindcore-v0.1-int8.onnx"
RELEASE_MANIFEST_PATH = MODEL_ROOT / "manifest.json"
REPORT_DIRECTORY = ROOT / "reports"
REPORT_PATH = REPORT_DIRECTORY / "training-metrics.json"
MODEL_CARD_PATH = REPORT_DIRECTORY / "model-card.md"

TOKEN_PATTERN = re.compile(r"[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*|[^\s]")
SEPARATOR_PATTERN = re.compile(r";\s*|,\s*(?:and\s+|then\s+)?|\s+then\s+|\s+and\s+", re.I)
TIME_EXPRESSION_PATTERN = re.compile(
    r"\b(?:\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)|noon|midnight)\b",
    re.I,
)
ROUTES = ["calendar", "conversation", "memory", "broad-chat", "app", "document"]
COUNT_LABELS = ["1", "2", "3"]
CONTEXT_LABELS = ["standalone", "contextual"]
DIALOGUE_RELATION_LABELS = ["standalone", "follow-up", "new-topic"]
REQUESTED_ATTRIBUTE_LABELS = [
    "none",
    "name",
    "time",
    "start",
    "end",
    "date",
    "location",
    "duration",
    "notes",
    "recurrence",
    "details",
]
SCOPE_LABELS = ["none", "singular", "plural", "all"]
SELECTION_LABELS = ["none", "first", "second", "third", "last", "next", "subset"]
TURN_KIND_LABELS = [
    "calendar-read",
    "calendar-write",
    "conversation",
    "memory",
    "unclear",
]
ASSISTANT_HEAD_NAMES = (
    "route",
    "capability",
    "count",
    "context",
    "dialogue_relation",
    "attribute",
    "scope",
    "selection",
    "turn_kind",
)
MARKER_PATTERN = re.compile(r"<([A-Z][A-Z0-9_]*)>")
CAPABILITY_ROUTE_BY_ID: dict[str, str] = {}
CAPABILITY_CUES_BY_ID: dict[str, list[str]] = {}
ACTION_CUE_PATTERN = re.compile(
    r"\b(?:add|backup|book|cancel|change|check|clear|complete|copy|delete|details?|dismiss|duplicate|edit|enable|explain|export|find|finish|forget|free|gap|help|import|install|introduce|launch|list|load|locate|mark|mirror|move|next|nudge|open|overview|pin|read|recall|remember|remind|remove|rename|repeat|reschedule|restore|save|scan|search|set|shift|show|summari[sz]e|switch|tell|theme|uninstall|update|where|wipe|window)\w*\b",
    re.I,
)


def deterministic_action_count(text: str) -> int | None:
    """Return a count only when the surface contains strong action boundaries.

    The learned count head remains the default. These small structural rules cover
    compositional forms whose second clause is explicit ("then switch", "and
    dismiss") and create-lists with multiple grounded times. They intentionally do
    not treat every "and" as another action.
    """

    normalized = normalize_text(text)
    separators = list(SEPARATOR_PATTERN.finditer(normalized))
    explicit_transitions = 0
    for separator in separators:
        tail = normalized[separator.end() :].lstrip()
        if ACTION_CUE_PATTERN.match(tail):
            explicit_transitions += 1
    if explicit_transitions:
        return min(3, explicit_transitions + 1)

    if re.search(r"\bremind\w*\b", normalized) and re.search(
        r"\s+and\s+to\s+", normalized
    ):
        return 2
    if re.search(r"\bthen\s+(?:also\s+)?put\b", normalized):
        return 2

    if re.search(r"\b(?:add|book|create|schedule)\w*\b", normalized):
        grounded_times = len(TIME_EXPRESSION_PATTERN.findall(normalized))
        if grounded_times >= 2 and separators:
            return min(3, grounded_times)
    return None

SIGNAL_PATTERNS: dict[str, re.Pattern[str]] = {
    "calendar": re.compile(
        r"\b(?:agenda|appointment|book|calendar|class|course|event|meeting|plan|schedule)\w*\b",
        re.I,
    ),
    "reminder": re.compile(r"\b(?:alert|nudge|remind|reminder|task)\w*\b", re.I),
    "query": re.compile(
        r"\b(?:available|availability|busy|conflict|details?|find|free|list|locate|next|overview|search|show|summari[sz]e|what|when|where|which)\b",
        re.I,
    ),
    "memory": re.compile(r"\b(?:call me|forget|memory|preference|remember|stored)\b", re.I),
    "app": re.compile(
        r"\b(?:appearance|color|density|glance|navigate|open|pin|settings|startup|theme|view|widget|window)\b",
        re.I,
    ),
    "document": re.compile(r"\b(?:attach|document|file|ics|image|import|pdf|scan)\b", re.I),
    "model": re.compile(r"\b(?:fallback|install|language pack|local model|model|qwen|uninstall)\b", re.I),
    "conversation": re.compile(
        r"\b(?:appreciate|chat|encouragement|explain|goodbye|hello|help|how are you|thank|who are you)\b",
        re.I,
    ),
    "mutation": re.compile(
        r"\b(?:add|book|cancel|change|clear|complete|copy|create|delete|dismiss|duplicate|edit|move|remove|rename|repeat|reschedule|set|shift|update|wipe)\w*\b",
        re.I,
    ),
    "destructive": re.compile(r"\b(?:cancel|clear|delete|dismiss|erase|forget|remove|uninstall|wipe)\w*\b", re.I),
    "recurrence": re.compile(r"\b(?:daily|every|monthly|repeat|weekly|weekday|yearly)\w*\b", re.I),
    "bulk": re.compile(r"\b(?:all|both|each|entire|every|everything|full|multiple)\b", re.I),
    "date": re.compile(
        r"\b(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|\d{1,4}[/-]\d{1,2})\b",
        re.I,
    ),
    "time": re.compile(
        r"\b(?:\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)|noon|midnight|morning|afternoon|evening|night)\b",
        re.I,
    ),
}


def compact_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_bytes(contents: bytes) -> str:
    return hashlib.sha256(contents).hexdigest()


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


def normalize_text(text: str) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", text).lower()).strip()


def token_shape(token: str) -> str:
    output: list[str] = []
    for character in token:
        shape = "A" if character.isupper() else "a" if character.islower() else "0" if character.isdigit() else "x"
        if not output or output[-1] != shape:
            output.append(shape)
    return "".join(output)[:8]


def fnv1a_32(text: str) -> int:
    value = 2166136261
    for byte in text.encode("utf-8"):
        value ^= byte
        value = (value * 16777619) & 0xFFFFFFFF
    return value


def feature_ids(features: Iterable[str], buckets: int) -> np.ndarray:
    return np.fromiter(sorted({fnv1a_32(value) % buckets for value in features}), dtype=np.int64)


def base_feature_names(
    text: str, *, include_char: bool = True, include_signals: bool = True
) -> set[str]:
    normalized = normalize_text(text)[:400]
    tokens = [match.group(0) for match in TOKEN_PATTERN.finditer(normalized)][:80]
    features = {
        "bias",
        f"length:{min(16, len(tokens) // 3)}",
        f"question:{int('?' in text)}",
        f"exclamation:{int('!' in text)}",
    }
    if include_signals:
        for name, pattern in SIGNAL_PATTERNS.items():
            features.add(f"signal:{name}:{int(bool(pattern.search(normalized)))}")
    for index, token in enumerate(tokens):
        features.update(
            {
                f"w:{token}",
                f"shape:{token_shape(token)}",
                f"p2:{token[:2]}",
                f"p3:{token[:3]}",
                f"p4:{token[:4]}",
                f"s2:{token[-2:]}",
                f"s3:{token[-3:]}",
                f"s4:{token[-4:]}",
            }
        )
        if index:
            features.add(f"w2:{tokens[index - 1]}|{token}")
        if index > 1:
            features.add(f"skip2:{tokens[index - 2]}|{token}")
    if include_char:
        padded = f"^^{normalized}$$"
        for size in (3, 4, 5):
            for index in range(max(0, len(padded) - size + 1)):
                features.add(f"c{size}:{padded[index:index + size]}")
    return features


def context_feature_names(context: dict[str, Any] | None) -> set[str]:
    if not context:
        return {"ctx:none"}
    count = min(4, int(context.get("focusedCount", 0)))
    ordinal = context.get("ordinal")
    prior = context.get("priorCapabilityId") or "none"
    pending = context.get("pendingCapabilityId") or "none"
    kind = context.get("focusedKind") or "none"
    return {
        "ctx:present",
        f"ctx:kind:{kind}",
        f"ctx:count:{count}",
        f"ctx:ordinal:{ordinal if ordinal is not None else 'none'}",
        f"ctx:prior:{prior}",
        f"ctx:pending:{pending}",
        f"ctx:kind+count:{kind}|{count}",
    }


def turn_feature_names(
    text: str,
    context: dict[str, Any] | None,
    *,
    include_char: bool = True,
    include_signals: bool = True,
    include_context: bool = True,
) -> set[str]:
    features = base_feature_names(text, include_char=include_char, include_signals=include_signals)
    if include_context:
        features.update(context_feature_names(context))
    return features


def action_segments(text: str, count: int) -> list[str]:
    if count <= 1:
        return [text.strip()]
    matches = [
        match
        for match in SEPARATOR_PATTERN.finditer(text)
        if text[: match.start()].strip() and text[match.end() :].strip()
    ]
    selected = matches[-(count - 1) :]
    boundaries = [(match.start(), match.end()) for match in selected]
    parts: list[str] = []
    start = 0
    for left, right in boundaries:
        parts.append(text[start:left].strip(" \t\r\n,;"))
        start = right
    parts.append(text[start:].strip(" \t\r\n,;"))
    parts = [part for part in parts if part]
    while len(parts) < count:
        longest_index = max(range(len(parts)), key=lambda index: len(parts[index]))
        value = parts.pop(longest_index)
        tokens = list(TOKEN_PATTERN.finditer(value))
        if len(tokens) < 2:
            parts.insert(longest_index, value)
            parts.append(value)
            continue
        pivot = tokens[len(tokens) // 2].start()
        parts.insert(longest_index, value[:pivot].strip())
        parts.insert(longest_index + 1, value[pivot:].strip())
    return parts[:count]


def capability_feature_names(
    text: str,
    segment: str,
    action_index: int,
    action_count: int,
    context: dict[str, Any] | None,
    *,
    include_char: bool = True,
    include_signals: bool = True,
    include_context: bool = True,
) -> set[str]:
    turn = {
        value
        for value in base_feature_names(text, include_char=False, include_signals=include_signals)
        if value.startswith("signal:")
        or value.startswith("length:")
        or value.startswith("question:")
        or value.startswith("exclamation:")
    }
    local = base_feature_names(segment, include_char=include_char, include_signals=include_signals)
    features = {f"turn:{value}" for value in turn}
    features.update(f"segment:{value}" for value in local)
    features.update(
        {
            f"action-index:{action_index}",
            f"action-count:{action_count}",
            f"action-position:{action_index}/{action_count}",
        }
    )
    # Context has its own head. Keeping entity-history IDs out of the shared
    # capability table improves transfer to unseen multi-action combinations.
    normalized_segment = normalize_text(segment)
    for capability_id, cues in CAPABILITY_CUES_BY_ID.items():
        if any(
            re.search(rf"\b{re.escape(cue)}\w*\b", normalized_segment, re.I)
            for cue in cues
        ):
            for rank in range(4):
                features.add(f"capability-cue:{capability_id}:{rank}")
    return features


def augment_text(text: str) -> list[str]:
    normalized = re.sub(r"\s+", " ", text).strip()
    unpunctuated = re.sub(r"[?!.,]+", "", normalized).strip()
    values = [normalized, f"please {normalized}", f"could you {normalized}", f"{normalized} please", unpunctuated]
    return list(dict.fromkeys(value for value in values if value))


def scores(weights: np.ndarray, bias: np.ndarray, ids: np.ndarray) -> np.ndarray:
    if ids.size == 0:
        return bias.copy()
    return bias + weights[:, ids].sum(axis=1) / math.sqrt(float(ids.size))


def train_perceptron(
    items: Sequence[tuple[np.ndarray, int]], label_count: int, buckets: int, epochs: int, seed: int
) -> tuple[np.ndarray, np.ndarray]:
    weights = np.zeros((label_count, buckets), dtype=np.float32)
    bias = np.zeros(label_count, dtype=np.float32)
    order = list(range(len(items)))
    randomizer = random.Random(seed)
    for epoch in range(epochs):
        randomizer.shuffle(order)
        mistakes = 0
        learning_rate = 0.8 / math.sqrt(epoch + 1)
        for item_index in order:
            ids, expected = items[item_index]
            predicted = int(np.argmax(scores(weights, bias, ids)))
            if predicted == expected:
                continue
            mistakes += 1
            delta = learning_rate / math.sqrt(max(1, ids.size))
            np.add.at(weights[expected], ids, delta)
            np.add.at(weights[predicted], ids, -delta)
            bias[expected] += learning_rate * 0.06
            bias[predicted] -= learning_rate * 0.06
        print(f"    epoch {epoch + 1}/{epochs}: {mistakes}/{len(items)} mistakes")
    return weights, bias


def balanced_items(items: Sequence[tuple[np.ndarray, int]], seed: int) -> list[tuple[np.ndarray, int]]:
    grouped: dict[int, list[tuple[np.ndarray, int]]] = defaultdict(list)
    for item in items:
        grouped[item[1]].append(item)
    target = max(len(values) for values in grouped.values())
    output: list[tuple[np.ndarray, int]] = []
    randomizer = random.Random(seed)
    for label, values in sorted(grouped.items()):
        shuffled = list(values)
        randomizer.shuffle(shuffled)
        output.extend(shuffled[index % len(shuffled)] for index in range(target))
        if not values:
            raise ValueError(f"Head label {label} had no examples")
    randomizer.shuffle(output)
    return output


def train_ensemble(
    items: Sequence[tuple[np.ndarray, int]],
    label_count: int,
    buckets: int,
    epochs: int,
    seed: int,
    offsets: Sequence[int],
) -> tuple[np.ndarray, np.ndarray]:
    items = balanced_items(items, seed)
    weight_sum = np.zeros((label_count, buckets), dtype=np.float32)
    bias_sum = np.zeros(label_count, dtype=np.float32)
    for member, offset in enumerate(offsets, start=1):
        print(f"  ensemble member {member}/{len(offsets)}")
        weights, bias = train_perceptron(items, label_count, buckets, epochs, seed + int(offset))
        weight_sum += weights
        bias_sum += bias
    divisor = np.float32(len(offsets))
    return weight_sum / divisor, bias_sum / divisor


def softmax(logits: np.ndarray, temperature: float = 1.0) -> np.ndarray:
    adjusted = logits / max(0.05, temperature)
    adjusted -= float(np.max(adjusted))
    values = np.exp(adjusted)
    return values / float(np.sum(values))


def calibrate_temperature(logits: Sequence[np.ndarray], expected: Sequence[int]) -> float:
    best = (1.0, float("inf"))
    for temperature in np.linspace(0.4, 4.0, 73):
        loss = 0.0
        for values, label in zip(logits, expected, strict=True):
            loss -= math.log(max(1e-9, float(softmax(values, float(temperature))[label])))
        if loss < best[1]:
            best = (float(temperature), loss)
    return round(best[0], 3)


def quantize(weights: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    maximum = np.max(np.abs(weights), axis=1).astype(np.float32)
    scales = np.where(maximum > 0, maximum / 127.0, 1.0).astype(np.float32)
    values = np.rint(weights / scales[:, None]).clip(-127, 127).astype(np.int8)
    return values, scales


def predict_head(
    weights: np.ndarray, bias: np.ndarray, ids: np.ndarray, temperature: float
) -> tuple[int, float, np.ndarray]:
    probabilities = softmax(scores(weights, bias, ids), temperature)
    index = int(np.argmax(probabilities))
    return index, float(probabilities[index]), probabilities


def head_payload(
    name: str, labels: Sequence[str], weights: np.ndarray, bias: np.ndarray, temperature: float
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


def metadata_examples(capability: dict[str, Any]) -> list[str]:
    identifier = str(capability["id"]).replace(".", " ").replace("-", " ")
    aliases = [str(value) for value in capability.get("aliases", [])]
    cues = [str(value) for value in capability.get("cues", [])]
    values = [
        f"{capability['title']}. {capability['description']}",
        " ".join([identifier, *aliases]),
        " or ".join(aliases) if aliases else str(capability["title"]),
        *[f"{cue} {capability['title']}" for cue in cues],
        *[f"request to {cue}: {capability['description']}" for cue in cues],
        *[str(value) for value in capability.get("teacherTrainingExamples", [])],
    ]
    return list(dict.fromkeys(normalize_text(value) for value in values if value.strip()))


def turn_kind_for_capability(capability_id: str) -> str:
    if capability_id in {"assistant.clarify", "assistant.reject", "assistant.unsupported"}:
        return "unclear"
    if capability_id.startswith("assistant.memory."):
        return "memory"
    if capability_id.startswith("calendar.query.") or capability_id == "calendar.export.file":
        return "calendar-read"
    if capability_id.startswith("calendar."):
        return "calendar-write"
    return "conversation"


def load_teacher_training_surfaces(
    metadata: Sequence[dict[str, Any]],
    *,
    enforce_minimum: bool = True,
) -> dict[str, Any]:
    jobs_document = read_json(NEXT_TEACHER_JOBS_PATH)
    repair_jobs_document = read_json(NEXT_TEACHER_REPAIR_JOBS_PATH)
    output_documents = [
        read_json(NEXT_TEACHER_OUTPUT_PATH),
        read_json(NEXT_TEACHER_REPAIR_OUTPUT_PATH),
    ]
    jobs = {
        value["id"]: value
        for value in [*jobs_document["jobs"], *repair_jobs_document["jobs"]]
    }
    capabilities = {value["id"]: value for value in metadata}
    accepted: list[dict[str, str]] = []
    rejected: list[dict[str, str]] = []
    seen: set[str] = set()
    for output_document in output_documents:
      for batch in output_document.get("batches", []):
        for item in batch.get("output", {}).get("items", []):
            job = jobs.get(item.get("id"))
            if not job:
                rejected.append({"id": str(item.get("id")), "reason": "unknown-job"})
                continue
            for paraphrase in item.get("paraphrases", []):
                normalized = normalize_text(str(paraphrase))
                markers = MARKER_PATTERN.findall(str(paraphrase))
                expected_markers = list(job["placeholders"])
                ordinary_words = re.findall(r"[A-Za-z]+", MARKER_PATTERN.sub("", str(paraphrase)))
                reason = None
                if sorted(markers) != sorted(expected_markers) or len(markers) != len(set(markers)):
                    reason = "marker-drift"
                elif normalized in seen or normalized == normalize_text(job["seedTemplate"]):
                    reason = "duplicate"
                elif len(ordinary_words) + len(markers) < 4 or len(ordinary_words) > 30:
                    reason = "length"
                elif not any(
                    re.search(rf"\b{re.escape(str(cue))}\w*\b", normalized, re.I)
                    for cue in job["cues"]
                ):
                    reason = "required-cue-missing"
                elif re.search(r"\b(?:intent|anchor|capability|marker|seed|review|approval)\b", normalized, re.I):
                    reason = "instruction-or-policy-leakage"
                if reason:
                    rejected.append({"id": job["id"], "reason": reason})
                    continue
                seen.add(normalized)
                accepted.append(
                    {"jobId": job["id"], "capabilityId": job["capabilityId"], "template": str(paraphrase)}
                )

    values = [
        {
            "TITLE": "Project sync",
            "TARGET": "the budget review",
            "NEW_TITLE": "Weekly planning",
            "DATE": "next Thursday",
            "TIME": "2 pm",
            "LOCATION": "Room 214",
            "RECURRENCE": "every weekday",
            "END_DATE": "Friday",
            "END_TIME": "4 pm",
            "DURATION": "thirty minute",
            "SOURCE_DATE": "Monday",
            "DESTINATION_DAYS": "Wednesday and Friday",
            "RANGE": "next week",
            "FILE_KIND": "PDF",
            "TOPIC": "time blocking",
            "NAME": "Alex",
            "MEMORY": "I prefer quiet mornings",
            "VIEW": "calendar",
            "COLOR": "sage green",
            "THEME": "translucent",
            "DENSITY": "compact",
            "MODE": "glance",
            "MODEL": "local language model",
        },
        {
            "TITLE": "Guitar practice",
            "TARGET": "my team check-in",
            "NEW_TITLE": "Design critique",
            "DATE": "this Saturday",
            "TIME": "9:30 am",
            "LOCATION": "the library",
            "RECURRENCE": "once a month",
            "END_DATE": "Sunday",
            "END_TIME": "11 am",
            "DURATION": "one hour",
            "SOURCE_DATE": "Tuesday",
            "DESTINATION_DAYS": "Thursday and Saturday",
            "RANGE": "this weekend",
            "FILE_KIND": "ICS",
            "TOPIC": "weekly planning",
            "NAME": "Morgan",
            "MEMORY": "my focus time is before lunch",
            "VIEW": "reminders",
            "COLOR": "deep blue",
            "THEME": "liquid glass",
            "DENSITY": "comfortable",
            "MODE": "widget",
            "MODEL": "Qwen fallback",
        },
        {
            "TITLE": "Lunch with Sam",
            "TARGET": "the dentist appointment",
            "NEW_TITLE": "Client follow-up",
            "DATE": "the day after tomorrow",
            "TIME": "6:15 pm",
            "LOCATION": "the north campus studio",
            "RECURRENCE": "every other week",
            "END_DATE": "next Monday",
            "END_TIME": "8 pm",
            "DURATION": "forty five minute",
            "SOURCE_DATE": "Friday",
            "DESTINATION_DAYS": "Monday and Wednesday",
            "RANGE": "the rest of the month",
            "FILE_KIND": "image",
            "TOPIC": "avoiding overload",
            "NAME": "Jamie",
            "MEMORY": "I like brief answers",
            "VIEW": "settings",
            "COLOR": "warm amber",
            "THEME": "cozy",
            "DENSITY": "spacious",
            "MODE": "full",
            "MODEL": "optional model",
        },
    ]
    for item in accepted:
        rendered: list[str] = []
        for replacements in values:
            text = item["template"]
            for marker in MARKER_PATTERN.findall(text):
                text = text.replace(f"<{marker}>", replacements.get(marker, marker.lower().replace("_", " ")))
            rendered.append(text)
        capabilities[item["capabilityId"]].setdefault("teacherTrainingExamples", []).extend(rendered)
    covered = len({value["capabilityId"] for value in accepted})
    if enforce_minimum and (len(accepted) < 50 or covered < 32):
        raise RuntimeError(
            f"RemindCore Next teacher curation was too sparse ({len(accepted)} templates, {covered} capabilities)"
        )
    return {
        "jobs": len(jobs),
        "acceptedTemplates": len(accepted),
        "acceptedMaterializations": len(accepted) * len(values),
        "rejectedTemplates": len(rejected),
        "capabilityCoverage": covered,
        "rejectionsByReason": dict(
            sorted(
                (reason, sum(value["reason"] == reason for value in rejected))
                for reason in {value["reason"] for value in rejected}
            )
        ),
        "jobsSha256": sha256_bytes(NEXT_TEACHER_JOBS_PATH.read_bytes()),
        "repairJobsSha256": sha256_bytes(NEXT_TEACHER_REPAIR_JOBS_PATH.read_bytes()),
        "outputSha256": sha256_bytes(
            NEXT_TEACHER_OUTPUT_PATH.read_bytes() + NEXT_TEACHER_REPAIR_OUTPUT_PATH.read_bytes()
        ),
    }


def build_training_items(
    rows: Sequence[dict[str, Any]],
    metadata: Sequence[dict[str, Any]],
    labels: dict[str, list[str]],
    buckets: int,
    flags: dict[str, bool],
) -> dict[str, list[tuple[np.ndarray, int]]]:
    indexes = {name: {label: index for index, label in enumerate(values)} for name, values in labels.items()}
    output: dict[str, list[tuple[np.ndarray, int]]] = defaultdict(list)
    for row in rows:
        expected_count = len(row["actions"])
        for text in augment_text(row["text"]):
            turn_ids = feature_ids(
                turn_feature_names(text, row.get("context"), **flags), buckets
            )
            output["route"].append((turn_ids, indexes["route"][row["route"]]))
            output["count"].append((turn_ids, indexes["count"][str(expected_count)]))
            output["context"].append(
                (turn_ids, indexes["context"]["contextual" if row.get("context") else "standalone"])
            )
            semantics = row["semantics"]
            output["dialogue_relation"].append(
                (turn_ids, indexes["dialogue_relation"][semantics["dialogueRelation"]])
            )
            output["attribute"].append(
                (turn_ids, indexes["attribute"][semantics["requestedAttribute"]])
            )
            output["scope"].append((turn_ids, indexes["scope"][semantics["scope"]]))
            output["selection"].append(
                (turn_ids, indexes["selection"][semantics["selection"]])
            )
            output["turn_kind"].append(
                (turn_ids, indexes["turn_kind"][semantics["turnKind"]])
            )
            segments = action_segments(text, expected_count)
            for action_index, (segment, action) in enumerate(zip(segments, row["actions"], strict=True)):
                ids = feature_ids(
                    capability_feature_names(
                        text,
                        segment,
                        action_index,
                        expected_count,
                        row.get("context"),
                        **flags,
                    ),
                    buckets,
                )
                output["capability"].append(
                    (ids, indexes["capability"][action["capabilityId"]])
                )
    for capability in metadata:
        for text in metadata_examples(capability):
            turn_ids = feature_ids(turn_feature_names(text, None, **flags), buckets)
            output["route"].append((turn_ids, indexes["route"][capability["route"]]))
            output["turn_kind"].append(
                (
                    turn_ids,
                    indexes["turn_kind"][turn_kind_for_capability(capability["id"])],
                )
            )
            capability_ids = feature_ids(
                capability_feature_names(text, text, 0, 1, None, **flags), buckets
            )
            output["capability"].append(
                (capability_ids, indexes["capability"][capability["id"]])
            )
    return output


def train_candidate(
    config: dict[str, Any],
    rows: Sequence[dict[str, Any]],
    metadata: Sequence[dict[str, Any]],
    labels: dict[str, list[str]],
    buckets: int,
    flags: dict[str, bool],
) -> tuple[dict[str, np.ndarray], dict[str, float]]:
    print(f"training candidate buckets={buckets} flags={flags}")
    items = build_training_items(rows, metadata, labels, buckets, flags)
    arrays: dict[str, np.ndarray] = {}
    for head_index, name in enumerate(ASSISTANT_HEAD_NAMES):
        print(f" {name} head ({len(items[name])} raw examples)")
        weights, bias = train_ensemble(
            items[name],
            len(labels[name]),
            buckets,
            int(config["epochs"]),
            int(config["seed"]) + head_index * 101,
            config["ensembleSeedOffsets"],
        )
        arrays[f"{name}_weights"] = weights
        arrays[f"{name}_bias"] = bias
    return arrays, {}


def calibrate(
    arrays: dict[str, np.ndarray],
    rows: Sequence[dict[str, Any]],
    labels: dict[str, list[str]],
    buckets: int,
    flags: dict[str, bool],
) -> dict[str, float]:
    indexes = {name: {label: index for index, label in enumerate(values)} for name, values in labels.items()}
    logits: dict[str, list[np.ndarray]] = defaultdict(list)
    expected: dict[str, list[int]] = defaultdict(list)
    for row in rows:
        count = len(row["actions"])
        turn_ids = feature_ids(turn_feature_names(row["text"], row.get("context"), **flags), buckets)
        for name, label in (
            ("route", row["route"]),
            ("count", str(count)),
            ("context", "contextual" if row.get("context") else "standalone"),
            ("dialogue_relation", row["semantics"]["dialogueRelation"]),
            ("attribute", row["semantics"]["requestedAttribute"]),
            ("scope", row["semantics"]["scope"]),
            ("selection", row["semantics"]["selection"]),
            ("turn_kind", row["semantics"]["turnKind"]),
        ):
            logits[name].append(scores(arrays[f"{name}_weights"], arrays[f"{name}_bias"], turn_ids))
            expected[name].append(indexes[name][label])
        for action_index, (segment, action) in enumerate(
            zip(action_segments(row["text"], count), row["actions"], strict=True)
        ):
            ids = feature_ids(
                capability_feature_names(
                    row["text"], segment, action_index, count, row.get("context"), **flags
                ),
                buckets,
            )
            logits["capability"].append(
                scores(arrays["capability_weights"], arrays["capability_bias"], ids)
            )
            expected["capability"].append(indexes["capability"][action["capabilityId"]])
    return {
        name: calibrate_temperature(logits[name], expected[name])
        for name in ASSISTANT_HEAD_NAMES
    }


def evaluate(
    arrays: dict[str, np.ndarray],
    temperatures: dict[str, float],
    rows: Sequence[dict[str, Any]],
    labels: dict[str, list[str]],
    buckets: int,
    flags: dict[str, bool],
    *,
    routing_threshold: float | None = None,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    predictions: list[dict[str, Any]] = []
    latencies: list[float] = []
    for row in rows:
        started = time.perf_counter()
        turn_ids = feature_ids(turn_feature_names(row["text"], row.get("context"), **flags), buckets)
        route_index, route_confidence, _ = predict_head(
            arrays["route_weights"], arrays["route_bias"], turn_ids, temperatures["route"]
        )
        count_index, count_confidence, _ = predict_head(
            arrays["count_weights"], arrays["count_bias"], turn_ids, temperatures["count"]
        )
        context_index, context_confidence, context_probabilities = predict_head(
            arrays["context_weights"], arrays["context_bias"], turn_ids, temperatures["context"]
        )
        semantic_predictions: dict[str, tuple[int, float]] = {}
        for name in ("dialogue_relation", "attribute", "scope", "selection", "turn_kind"):
            index, confidence, _ = predict_head(
                arrays[f"{name}_weights"],
                arrays[f"{name}_bias"],
                turn_ids,
                temperatures[name],
            )
            semantic_predictions[name] = (index, confidence)
        learned_action_count = int(labels["count"][count_index])
        action_count = deterministic_action_count(row["text"]) or learned_action_count
        capabilities: list[str] = []
        capability_confidences: list[float] = []
        for action_index, segment in enumerate(action_segments(row["text"], action_count)):
            ids = feature_ids(
                capability_feature_names(
                    row["text"], segment, action_index, action_count, row.get("context"), **flags
                ),
                buckets,
            )
            _, _, capability_probabilities = predict_head(
                arrays["capability_weights"],
                arrays["capability_bias"],
                ids,
                temperatures["capability"],
            )
            allowed = [
                index
                for index, capability_id in enumerate(labels["capability"])
                if CAPABILITY_ROUTE_BY_ID[capability_id] == labels["route"][route_index]
            ]
            candidates = allowed or list(range(len(labels["capability"])))
            cue_matched = [
                index
                for index in candidates
                if any(
                    re.search(
                        rf"\b{re.escape(cue)}\w*\b", normalize_text(segment), re.I
                    )
                    for cue in CAPABILITY_CUES_BY_ID[labels["capability"][index]]
                )
            ]
            capability_index = (
                cue_matched[0]
                if len(cue_matched) == 1
                else max(
                    candidates,
                    key=lambda index: float(capability_probabilities[index]),
                )
            )
            confidence = float(capability_probabilities[capability_index])
            capability = labels["capability"][capability_index]
            if action_index > 0 and not ACTION_CUE_PATTERN.search(normalize_text(segment)):
                capability = capabilities[-1]
                confidence = capability_confidences[-1]
            capabilities.append(capability)
            capability_confidences.append(confidence)
        plan_confidence = min(
            [route_confidence, count_confidence, context_confidence, *capability_confidences]
        )
        confidence = route_confidence
        expected_capabilities = [action["capabilityId"] for action in row["actions"]]
        routing_correct = labels["route"][route_index] == row["route"]
        correct = routing_correct and capabilities == expected_capabilities
        context_available = row.get("context") is not None
        eligible = (
            routing_threshold is not None
            and labels["route"][route_index] == "calendar"
            and confidence >= routing_threshold
            and (labels["context"][context_index] == "standalone" or context_available)
        )
        latencies.append((time.perf_counter() - started) * 1000)
        predictions.append(
            {
                "id": row["id"],
                "route": labels["route"][route_index],
                "routeConfidence": route_confidence,
                "count": action_count,
                "countConfidence": count_confidence,
                "capabilities": capabilities,
                "capabilityConfidences": capability_confidences,
                "context": labels["context"][context_index],
                "contextConfidence": context_confidence,
                "contextRequiredProbability": float(context_probabilities[1]),
                "dialogueRelation": labels["dialogue_relation"][
                    semantic_predictions["dialogue_relation"][0]
                ],
                "dialogueRelationConfidence": semantic_predictions["dialogue_relation"][1],
                "requestedAttribute": labels["attribute"][semantic_predictions["attribute"][0]],
                "requestedAttributeConfidence": semantic_predictions["attribute"][1],
                "scope": labels["scope"][semantic_predictions["scope"][0]],
                "scopeConfidence": semantic_predictions["scope"][1],
                "selection": labels["selection"][semantic_predictions["selection"][0]],
                "selectionConfidence": semantic_predictions["selection"][1],
                "turnKind": labels["turn_kind"][semantic_predictions["turn_kind"][0]],
                "turnKindConfidence": semantic_predictions["turn_kind"][1],
                "semanticConfidence": min(
                    confidence for _, confidence in semantic_predictions.values()
                ),
                "confidence": confidence,
                "planConfidence": plan_confidence,
                "correct": correct,
                "routingCorrect": routing_correct,
                "eligible": eligible,
            }
        )
    total = max(1, len(rows))
    multi = [index for index, row in enumerate(rows) if len(row["actions"]) > 1]
    contextual = [index for index, row in enumerate(rows) if row.get("context")]
    eligible = [index for index, value in enumerate(predictions) if value["eligible"]]
    metrics = {
        "examples": len(rows),
        "routeAccuracy": sum(value["route"] == row["route"] for value, row in zip(predictions, rows, strict=True)) / total,
        "firstCapabilityAccuracy": sum(
            value["capabilities"][0] == row["actions"][0]["capabilityId"]
            for value, row in zip(predictions, rows, strict=True)
        ) / total,
        "actionCountAccuracy": sum(value["count"] == len(row["actions"]) for value, row in zip(predictions, rows, strict=True)) / total,
        "exactSequenceAccuracy": sum(
            value["capabilities"] == [action["capabilityId"] for action in row["actions"]]
            for value, row in zip(predictions, rows, strict=True)
        ) / total,
        "exactPlanAccuracy": sum(value["correct"] for value in predictions) / total,
        "multiActionExactAccuracy": sum(
            predictions[index]["capabilities"]
            == [action["capabilityId"] for action in rows[index]["actions"]]
            for index in multi
        ) / max(1, len(multi)),
        "contextAccuracy": sum(
            value["context"] == ("contextual" if row.get("context") else "standalone")
            for value, row in zip(predictions, rows, strict=True)
        ) / total,
        "contextRecall": sum(predictions[index]["context"] == "contextual" for index in contextual) / max(1, len(contextual)),
        "dialogueRelationAccuracy": sum(
            value["dialogueRelation"] == row["semantics"]["dialogueRelation"]
            for value, row in zip(predictions, rows, strict=True)
        ) / total,
        "requestedAttributeAccuracy": sum(
            value["requestedAttribute"] == row["semantics"]["requestedAttribute"]
            for value, row in zip(predictions, rows, strict=True)
        ) / total,
        "scopeAccuracy": sum(
            value["scope"] == row["semantics"]["scope"]
            for value, row in zip(predictions, rows, strict=True)
        ) / total,
        "selectionAccuracy": sum(
            value["selection"] == row["semantics"]["selection"]
            for value, row in zip(predictions, rows, strict=True)
        ) / total,
        "turnKindAccuracy": sum(
            value["turnKind"] == row["semantics"]["turnKind"]
            for value, row in zip(predictions, rows, strict=True)
        ) / total,
        "selectiveExamples": len(eligible),
        "selectivePrecision": sum(predictions[index]["routingCorrect"] for index in eligible) / max(1, len(eligible)),
        "selectiveCoverage": len(eligible) / total,
        "latencyMs": {
            "median": statistics.median(latencies),
            "p95": float(np.percentile(np.asarray(latencies), 95)),
        },
    }
    return metrics, predictions


def choose_routing_threshold(
    predictions: Sequence[dict[str, Any]], config: dict[str, Any]
) -> float:
    candidates = sorted(
        {round(float(value["confidence"]), 6) for value in predictions if value["route"] == "calendar"}
    )
    best = (0.999999, -1)
    required = int(config["minimumDevelopmentSelectiveExamples"])
    minimum_precision = float(config["minimumDevelopmentSelectivePrecision"])
    for threshold in candidates:
        selected = [
            value
            for value in predictions
            if value["route"] == "calendar" and value["confidence"] >= threshold
        ]
        if len(selected) < required:
            continue
        precision = sum(value["routingCorrect"] for value in selected) / len(selected)
        if precision >= minimum_precision and len(selected) > best[1]:
            best = (threshold, len(selected))
    return max(float(best[0]), float(config["minimumRoutingConfidence"]))


def dequantized_arrays(arrays: dict[str, np.ndarray]) -> dict[str, np.ndarray]:
    output: dict[str, np.ndarray] = {}
    for name in ASSISTANT_HEAD_NAMES:
        quantized, scale = quantize(arrays[f"{name}_weights"])
        output[f"{name}_weights"] = quantized.astype(np.float32) * scale[:, None]
        output[f"{name}_bias"] = arrays[f"{name}_bias"]
    return output


def shipped_baseline_metrics(
    artifact: dict[str, Any], rows: Sequence[dict[str, Any]], metadata: Sequence[dict[str, Any]]
) -> dict[str, float]:
    sys.path.insert(0, str(WORKSPACE / "ml"))
    from remindcore.pipeline import feature_ids as old_feature_ids  # type: ignore
    from remindcore.pipeline import global_feature_names as old_feature_names  # type: ignore

    head = artifact["heads"]["operation"]
    raw = np.frombuffer(base64.b64decode(head["weightsBase64"]), dtype=np.int8)
    weights = raw.reshape((len(head["labels"]), int(head["buckets"]))).astype(np.float32)
    weights *= np.asarray(head["scale"], dtype=np.float32)[:, None]
    bias = np.asarray(head["bias"], dtype=np.float32)
    operation_map = {
        "event.create": "calendar.event.create",
        "event.duplicate": "calendar.event.duplicate",
        "event.update": "calendar.event.update",
        "event.move": "calendar.event.move",
        "event.delete": "calendar.event.delete",
        "reminder.create": "calendar.reminder.create",
        "reminder.update": "calendar.reminder.update",
        "reminder.complete": "calendar.reminder.complete",
        "reminder.delete": "calendar.reminder.delete",
        "calendar.list": "calendar.query.list",
        "calendar.search": "calendar.query.search",
        "calendar.availability": "calendar.query.availability",
        "calendar.conflicts": "calendar.query.conflicts",
        "assistant.unsupported": "assistant.chat.respond",
    }
    route_by_capability = {value["id"]: value["route"] for value in metadata}
    exact = 0
    route_correct = 0
    first_correct = 0
    for row in rows:
        ids = old_feature_ids(old_feature_names(row["text"]), int(head["buckets"]))
        operation = head["labels"][int(np.argmax(scores(weights, bias, ids)))]
        capability = operation_map.get(operation)
        expected = [action["capabilityId"] for action in row["actions"]]
        first_correct += int(capability == expected[0])
        exact += int(len(expected) == 1 and capability == expected[0])
        route_correct += int(capability is not None and route_by_capability.get(capability) == row["route"])
    denominator = max(1, len(rows))
    return {
        "routeAccuracy": route_correct / denominator,
        "firstCapabilityAccuracy": first_correct / denominator,
        "exactSequenceAccuracy": exact / denominator,
    }


def classification_accuracy(metrics: dict[str, Any]) -> float:
    return float(metrics["exactSequenceAccuracy"])


def development_quality(metrics: dict[str, Any]) -> float:
    return (
        float(metrics["exactSequenceAccuracy"])
        + 0.2 * float(metrics["multiActionExactAccuracy"])
        + 0.05 * float(metrics["routeAccuracy"])
    )


def choose_capacity(
    candidates: Sequence[dict[str, Any]], tolerance: float
) -> dict[str, Any]:
    best_accuracy = max(classification_accuracy(value["development"]) for value in candidates)
    eligible = [
        value
        for value in candidates
        if classification_accuracy(value["development"]) >= best_accuracy - tolerance
    ]
    return min(eligible, key=lambda value: int(value["buckets"]))


def gate_results(
    config: dict[str, Any], challenge: dict[str, Any], baseline: dict[str, Any], quantized: dict[str, Any]
) -> dict[str, dict[str, Any]]:
    gates = config["promotionGates"]
    values = {
        "challengeRouteAccuracy": (
            challenge["routeAccuracy"],
            gates["minimumChallengeRouteAccuracy"],
            ">=",
        ),
        "challengeFirstCapabilityAccuracy": (
            challenge["firstCapabilityAccuracy"],
            gates["minimumChallengeFirstCapabilityAccuracy"],
            ">=",
        ),
        "challengeExactSequenceAccuracy": (
            challenge["exactSequenceAccuracy"],
            gates["minimumChallengeExactSequenceAccuracy"],
            ">=",
        ),
        "challengeMultiActionExactAccuracy": (
            challenge["multiActionExactAccuracy"],
            gates["minimumChallengeMultiActionExactAccuracy"],
            ">=",
        ),
        "gainOverShippedBaseline": (
            challenge["exactSequenceAccuracy"] - baseline["exactSequenceAccuracy"],
            gates["minimumChallengeGainOverShippedBaseline"],
            ">=",
        ),
        "challengeSelectivePrecision": (
            challenge["selectivePrecision"],
            gates["minimumChallengeSelectivePrecision"],
            ">=",
        ),
        "challengeSelectiveCoverage": (
            challenge["selectiveCoverage"],
            gates["minimumChallengeSelectiveCoverage"],
            ">=",
        ),
        "challengeDialogueRelationAccuracy": (
            challenge["dialogueRelationAccuracy"],
            gates["minimumChallengeDialogueRelationAccuracy"],
            ">=",
        ),
        "challengeRequestedAttributeAccuracy": (
            challenge["requestedAttributeAccuracy"],
            gates["minimumChallengeRequestedAttributeAccuracy"],
            ">=",
        ),
        "challengeScopeAccuracy": (
            challenge["scopeAccuracy"],
            gates["minimumChallengeScopeAccuracy"],
            ">=",
        ),
        "challengeSelectionAccuracy": (
            challenge["selectionAccuracy"],
            gates["minimumChallengeSelectionAccuracy"],
            ">=",
        ),
        "challengeTurnKindAccuracy": (
            challenge["turnKindAccuracy"],
            gates["minimumChallengeTurnKindAccuracy"],
            ">=",
        ),
        "quantizedExactAccuracyReduction": (
            max(0.0, challenge["exactSequenceAccuracy"] - quantized["exactSequenceAccuracy"]),
            gates["maximumQuantizedExactAccuracyReduction"],
            "<=",
        ),
    }
    return {
        name: {
            "actual": float(actual),
            "required": float(required),
            "comparison": comparison,
            "passed": actual >= required if comparison == ">=" else actual <= required,
        }
        for name, (actual, required, comparison) in values.items()
    }


def build_artifact(
    base_artifact: dict[str, Any],
    config: dict[str, Any],
    labels: dict[str, list[str]],
    arrays: dict[str, np.ndarray],
    temperatures: dict[str, float],
    buckets: int,
    routing_threshold: float,
    metrics: dict[str, Any],
    corpus_manifest: dict[str, Any],
    metadata_document: dict[str, Any],
    feature_flags: dict[str, bool],
    teacher_curation: dict[str, Any],
) -> dict[str, Any]:
    base_parameter_count = sum(
        len(head["labels"]) * int(head["buckets"]) for head in base_artifact["heads"].values()
    )
    next_parameter_count = sum(
        int(arrays[f"{name}_weights"].size) for name in ASSISTANT_HEAD_NAMES
    )
    payload = json.loads(json.dumps(base_artifact))
    payload["id"] = config["modelId"]
    payload["version"] = config["version"]
    payload["architecture"] = {
        **payload["architecture"],
        "name": "HashFrame Context joint semantic and AssistantPlan advisory planner",
        "parameterCount": base_parameter_count + next_parameter_count,
        "heads": [
            "operation",
            "ambiguity",
            "ood",
            "risk",
            "bio-slots",
            "assistant-route",
            "assistant-capability",
            "assistant-action-count",
            "assistant-context",
            "assistant-dialogue-relation",
            "assistant-requested-attribute",
            "assistant-scope",
            "assistant-selection",
            "assistant-turn-kind",
        ],
    }
    corpus_manifest_sha = sha256_bytes(CORPUS_MANIFEST_PATH.read_bytes())
    metadata_sha = sha256_bytes(METADATA_PATH.read_bytes())
    payload["training"] = {
        **payload["training"],
        "assistantCorpusManifestSha256": corpus_manifest_sha,
        "assistantCorpusVersion": corpus_manifest["corpusVersion"],
        "capabilityMetadataSha256": metadata_sha,
        "assistantTeacherRole": "accepted delexicalized surface paraphrases only",
        "assistantTeacherOutputSha256": teacher_curation["outputSha256"],
        "assistantStudentInitialization": "all added tables initialized to exact zeros",
    }
    payload["assistant"] = {
        "schemaVersion": 2,
        "buckets": buckets,
        "maximumActions": int(config["maximumActions"]),
        "routes": labels["route"],
        "capabilityOrder": labels["capability"],
        "capabilityRoutes": [CAPABILITY_ROUTE_BY_ID[value] for value in labels["capability"]],
        "capabilityCues": [CAPABILITY_CUES_BY_ID[value] for value in labels["capability"]],
        "featureEncoder": {
            "normalization": "Unicode NFKC, lowercase, whitespace compaction",
            "hashAlgorithm": "FNV-1a 32-bit over UTF-8",
            "wordNgrams": [1, 2],
            "skipBigrams": 2,
            "characterNgrams": [3, 4, 5] if feature_flags["include_char"] else [],
            "projectSignals": feature_flags["include_signals"],
            "typedContext": feature_flags["include_context"],
            "segmenter": "right-biased punctuation/conjunction clauses v1",
        },
        "heads": {
            "route": head_payload(
                "assistant-route", labels["route"], arrays["route_weights"], arrays["route_bias"], temperatures["route"]
            ),
            "capability": head_payload(
                "assistant-capability", labels["capability"], arrays["capability_weights"], arrays["capability_bias"], temperatures["capability"]
            ),
            "actionCount": head_payload(
                "assistant-action-count", labels["count"], arrays["count_weights"], arrays["count_bias"], temperatures["count"]
            ),
            "context": head_payload(
                "assistant-context", labels["context"], arrays["context_weights"], arrays["context_bias"], temperatures["context"]
            ),
            "dialogueRelation": head_payload(
                "assistant-dialogue-relation",
                labels["dialogue_relation"],
                arrays["dialogue_relation_weights"],
                arrays["dialogue_relation_bias"],
                temperatures["dialogue_relation"],
            ),
            "requestedAttribute": head_payload(
                "assistant-requested-attribute",
                labels["attribute"],
                arrays["attribute_weights"],
                arrays["attribute_bias"],
                temperatures["attribute"],
            ),
            "scope": head_payload(
                "assistant-scope",
                labels["scope"],
                arrays["scope_weights"],
                arrays["scope_bias"],
                temperatures["scope"],
            ),
            "selection": head_payload(
                "assistant-selection",
                labels["selection"],
                arrays["selection_weights"],
                arrays["selection_bias"],
                temperatures["selection"],
            ),
            "turnKind": head_payload(
                "assistant-turn-kind",
                labels["turn_kind"],
                arrays["turn_kind_weights"],
                arrays["turn_kind_bias"],
                temperatures["turn_kind"],
            ),
        },
        "thresholds": {
            "routingAssistanceConfidence": routing_threshold,
            "safeAdvisoryRoutes": ["calendar"],
            "minimumDevelopmentPrecision": config["minimumDevelopmentSelectivePrecision"],
            "contextRequiredNeedsTypedContext": True,
            "semanticOutputsAdvisoryOnly": True,
            "neverCreatesPlans": True,
            "neverWritesDatabase": True,
        },
        "training": {
            "seed": config["seed"],
            "capacityCandidates": config["capacityCandidates"],
            "selectedBuckets": buckets,
            "corpusManifestSha256": corpus_manifest_sha,
            "registrySha256": metadata_document["registrySha256"],
            "metadataSha256": metadata_sha,
            "teacherUsed": bool(corpus_manifest["provenance"]["teacherUsed"]),
            "teacherModelId": corpus_manifest["provenance"]["teacherModelId"],
            "teacherAcceptedTemplates": teacher_curation["acceptedTemplates"],
            "teacherAcceptedMaterializations": teacher_curation["acceptedMaterializations"],
            "teacherOutputSha256": teacher_curation["outputSha256"],
            "teacherWeightsImported": False,
            "pretrainedWeightsUsed": False,
            "personalDataUsed": False,
            "humanBlindExamplesUsed": 0,
            "semanticCoverage": corpus_manifest["semanticCoverage"],
        },
        "metrics": metrics,
    }
    return payload


def export_onnx(artifact: dict[str, Any]) -> None:
    import onnx
    from onnx import TensorProto, helper, numpy_helper

    heads = {f"core_{name}": value for name, value in artifact["heads"].items()}
    heads.update({f"assistant_{name}": value for name, value in artifact["assistant"]["heads"].items()})
    nodes = []
    inputs = []
    outputs = []
    initializers = []
    for raw_name, head in heads.items():
        name = re.sub(r"[^A-Za-z0-9_]", "_", raw_name)
        labels = head["labels"]
        buckets = int(head["buckets"])
        weights = np.frombuffer(base64.b64decode(head["weightsBase64"]), dtype=np.int8).reshape((len(labels), buckets)).copy()
        scales = np.asarray(head["scale"], dtype=np.float32).reshape((len(labels), 1))
        bias = np.asarray(head["bias"], dtype=np.float32)
        temperature = np.asarray(float(head.get("temperature", 1.0)), dtype=np.float32)
        ids_name = f"{name}_feature_ids"
        output_name = f"{name}_logits"
        inputs.append(helper.make_tensor_value_info(ids_name, TensorProto.INT64, [None]))
        outputs.append(helper.make_tensor_value_info(output_name, TensorProto.FLOAT, [len(labels)]))
        initializers.extend(
            [
                numpy_helper.from_array(weights, f"{name}_weights"),
                numpy_helper.from_array(scales, f"{name}_scales"),
                numpy_helper.from_array(bias, f"{name}_bias"),
                numpy_helper.from_array(np.asarray([1], dtype=np.int64), f"{name}_axes"),
                numpy_helper.from_array(np.asarray(1.0, dtype=np.float32), f"{name}_one"),
                numpy_helper.from_array(temperature, f"{name}_temperature"),
            ]
        )
        nodes.extend(
            [
                helper.make_node("Gather", [f"{name}_weights", ids_name], [f"{name}_selected"], axis=1),
                helper.make_node("Cast", [f"{name}_selected"], [f"{name}_float"], to=TensorProto.FLOAT),
                helper.make_node("Mul", [f"{name}_float", f"{name}_scales"], [f"{name}_scaled"]),
                helper.make_node("ReduceSum", [f"{name}_scaled", f"{name}_axes"], [f"{name}_sum"], keepdims=0),
                helper.make_node("Size", [ids_name], [f"{name}_count_int"]),
                helper.make_node("Cast", [f"{name}_count_int"], [f"{name}_count"], to=TensorProto.FLOAT),
                helper.make_node("Max", [f"{name}_count", f"{name}_one"], [f"{name}_bounded"]),
                helper.make_node("Sqrt", [f"{name}_bounded"], [f"{name}_divisor"]),
                helper.make_node("Div", [f"{name}_sum", f"{name}_divisor"], [f"{name}_normalized"]),
                helper.make_node("Add", [f"{name}_normalized", f"{name}_bias"], [f"{name}_biased"]),
                helper.make_node("Div", [f"{name}_biased", f"{name}_temperature"], [output_name]),
            ]
        )
    graph = helper.make_graph(nodes, "RemindCore Next sparse INT8 parity", inputs, outputs, initializer=initializers)
    model = helper.make_model(
        graph,
        producer_name="remind-me/ml/remindcore_next",
        producer_version=artifact["version"],
        opset_imports=[helper.make_opsetid("", 18)],
    )
    model.ir_version = min(model.ir_version, 10)
    helper.set_model_props(
        model,
        {
            "remind_me.role": "planner",
            "remind_me.contract_version": artifact["contractVersion"],
            "remind_me.training_origin": "zero-initialized-project-student-with-curated-surface-teacher-data",
            "remind_me.runtime_authority": "advisory-only; TypeScript CalendarIR and review gates retain authority",
            "remind_me.runtime_equivalent": MODEL_PATH.name,
        },
    )
    onnx.checker.check_model(model)
    onnx.save_model(model, ONNX_PATH)


def update_sidecars(artifact: dict[str, Any]) -> None:
    tokenizer = read_json(TOKENIZER_PATH)
    tokenizer["assistantBuckets"] = artifact["assistant"]["buckets"]
    tokenizer["assistantMaximumActions"] = artifact["assistant"]["maximumActions"]
    tokenizer["assistantFeatureEncoder"] = artifact["assistant"]["featureEncoder"]
    TOKENIZER_PATH.write_text(json.dumps(tokenizer, indent=2) + "\n", encoding="utf-8")
    thresholds = read_json(THRESHOLDS_PATH)
    thresholds["assistantRouting"] = artifact["assistant"]["thresholds"]
    THRESHOLDS_PATH.write_text(json.dumps(thresholds, indent=2) + "\n", encoding="utf-8")


def update_release_manifest(config: dict[str, Any]) -> None:
    manifest = read_json(RELEASE_MANIFEST_PATH)
    components = {
        MODEL_PATH: ("model", "weights", "json", True),
        TOKENIZER_PATH: ("tokenizer", "tokenizer", "json", True),
        THRESHOLDS_PATH: ("thresholds", "configuration", "json", True),
        ONNX_PATH: ("onnx", "weights", "onnx", False),
    }
    relative_paths = {path.relative_to(MODEL_ROOT).as_posix() for path in components}
    manifest["artifacts"] = [
        value for value in manifest["artifacts"] if value["path"] not in relative_paths
    ]
    for path, (suffix, component, format_name, required) in components.items():
        contents = path.read_bytes()
        manifest["artifacts"].append(
            {
                "id": f"{config['modelId']}.{suffix}",
                "role": "planner",
                "component": component,
                "version": config["version"],
                "format": format_name,
                "path": path.relative_to(MODEL_ROOT).as_posix(),
                "sha256": sha256_bytes(contents),
                "byteLength": len(contents),
                "required": required,
                "contractVersion": config["contractVersion"],
                "locale": "en-US",
                "license": "MIT",
                "provenance": "project-trained",
                "sourceUrl": None,
                "generator": "ml/remindcore_next/pipeline.py",
            }
        )
    RELEASE_MANIFEST_PATH.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


def artifact_record(path: Path) -> dict[str, Any]:
    contents = path.read_bytes()
    return {
        "path": path.relative_to(WORKSPACE).as_posix(),
        "bytes": len(contents),
        "sha256": sha256_bytes(contents),
    }


def write_report(report: dict[str, Any]) -> None:
    REPORT_DIRECTORY.mkdir(parents=True, exist_ok=True)
    REPORT_PATH.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    selected = report["selection"]
    challenge = report["challenge"]
    status = "promoted" if report["promoted"] else "not promoted"
    model_card = "\n".join(
        [
            "# RemindCore Next model card",
            "",
            f"**Status:** {status}",
            f"**Version:** {report['version']}",
            f"**Selected capacity:** {selected['buckets']} hash buckets",
            "",
            "The added student heads are project-owned, zero-initialized classifiers trained from scratch. Qwen supplied only deterministically curated wording; no Qwen weights, private user data, or conversation logs were used.",
            "",
            "## Developer challenge",
            "",
            f"- Route accuracy: {challenge['routeAccuracy']:.1%}",
            f"- First capability accuracy: {challenge['firstCapabilityAccuracy']:.1%}",
            f"- Exact ordered sequence accuracy: {challenge['exactSequenceAccuracy']:.1%}",
            f"- Multi-action exact accuracy: {challenge['multiActionExactAccuracy']:.1%}",
            f"- Selective routing precision/coverage: {challenge['selectivePrecision']:.1%} / {challenge['selectiveCoverage']:.1%}",
            f"- Dialogue relation accuracy: {challenge['dialogueRelationAccuracy']:.1%}",
            f"- Requested attribute accuracy: {challenge['requestedAttributeAccuracy']:.1%}",
            f"- Scope accuracy: {challenge['scopeAccuracy']:.1%}",
            f"- Selection accuracy: {challenge['selectionAccuracy']:.1%}",
            f"- Turn-kind accuracy: {challenge['turnKindAccuracy']:.1%}",
            "",
            f"The challenge was evaluated in {report['provenance']['developerChallengeEvaluationRounds']} recorded engineering rounds while the generic multi-action decoder and runtime parity were corrected. It is not untouched or independently human-blind. The honest human-blind count remains zero until Phase 8. The model is advisory only and cannot resolve, confirm, execute, or persist an action.",
            "",
        ]
    )
    # Keep generated markdown stable across Windows and POSIX runners so the
    # repository-wide Prettier check sees the same line endings everywhere.
    with MODEL_CARD_PATH.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(model_card)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "command", choices=("train", "develop", "check"), nargs="?", default="train"
    )
    args = parser.parse_args()
    if args.command == "check":
        report = read_json(REPORT_PATH)
        if not report.get("promoted") or not all(value["passed"] for value in report["gates"].values()):
            raise RuntimeError("RemindCore Next does not have a fully promoted report")
        for value in report["artifacts"].values():
            path = WORKSPACE / value["path"]
            if path.stat().st_size != value["bytes"] or sha256_bytes(path.read_bytes()) != value["sha256"]:
                raise RuntimeError(f"RemindCore Next artifact drifted: {value['path']}")
        print("RemindCore Next report and promoted artifact digests are valid.")
        return

    config = read_json(CONFIG_PATH)
    metadata_document = read_json(METADATA_PATH)
    corpus_manifest = read_json(CORPUS_MANIFEST_PATH)
    if metadata_document["registrySha256"] != corpus_manifest["registrySha256"]:
        raise RuntimeError("Capability metadata drifted from the Phase 4 corpus registry")
    metadata = metadata_document["capabilities"]
    CAPABILITY_ROUTE_BY_ID.clear()
    CAPABILITY_ROUTE_BY_ID.update({value["id"]: value["route"] for value in metadata})
    CAPABILITY_CUES_BY_ID.clear()
    CAPABILITY_CUES_BY_ID.update({value["id"]: list(value["cues"]) for value in metadata})
    teacher_curation = load_teacher_training_surfaces(metadata)
    capability_labels = [value["id"] for value in metadata]
    if len(capability_labels) != 42 or len(set(capability_labels)) != 42:
        raise RuntimeError("RemindCore Next requires exactly 42 direct capability labels")
    labels = {
        "route": ROUTES,
        "capability": capability_labels,
        "count": COUNT_LABELS,
        "context": CONTEXT_LABELS,
        "dialogue_relation": DIALOGUE_RELATION_LABELS,
        "attribute": REQUESTED_ATTRIBUTE_LABELS,
        "scope": SCOPE_LABELS,
        "selection": SELECTION_LABELS,
        "turn_kind": TURN_KIND_LABELS,
    }
    train_rows = read_jsonl(CORPUS_ROOT / "train.jsonl")
    development_rows = read_jsonl(CORPUS_ROOT / "development.jsonl")
    base_artifact = read_json(MODEL_PATH)
    base_artifact.pop("assistant", None)
    full_flags = {"include_char": True, "include_signals": True, "include_context": True}
    candidates: list[dict[str, Any]] = []
    trained: dict[int, tuple[dict[str, np.ndarray], dict[str, float]]] = {}
    for buckets in config["capacityCandidates"]:
        arrays, _ = train_candidate(config, train_rows, metadata, labels, int(buckets), full_flags)
        temperatures = calibrate(arrays, development_rows, labels, int(buckets), full_flags)
        metrics, _ = evaluate(arrays, temperatures, development_rows, labels, int(buckets), full_flags)
        candidates.append({"buckets": int(buckets), "development": metrics})
        trained[int(buckets)] = (arrays, temperatures)
    selection = choose_capacity(candidates, float(config["selectedCapacityTolerance"]))
    selected_buckets = int(selection["buckets"])
    arrays, temperatures = trained[selected_buckets]
    selected_flags = full_flags

    ablations: list[dict[str, Any]] = []
    ablation_models: dict[str, tuple[dict[str, np.ndarray], dict[str, float], dict[str, bool], dict[str, Any]]] = {}
    for name, flags in (
        ("no-character-ngrams", {**full_flags, "include_char": False}),
        ("no-project-signals", {**full_flags, "include_signals": False}),
        ("no-typed-context", {**full_flags, "include_context": False}),
    ):
        ablation_arrays, _ = train_candidate(
            config, train_rows, metadata, labels, selected_buckets, flags
        )
        ablation_temperatures = calibrate(
            ablation_arrays, development_rows, labels, selected_buckets, flags
        )
        ablation_metrics, _ = evaluate(
            ablation_arrays,
            ablation_temperatures,
            development_rows,
            labels,
            selected_buckets,
            flags,
        )
        ablations.append({"name": name, "development": ablation_metrics})
        ablation_models[name] = (
            ablation_arrays,
            ablation_temperatures,
            flags,
            ablation_metrics,
        )

    profile_candidates = [
        (
            "full",
            arrays,
            temperatures,
            full_flags,
            selection["development"],
        ),
        ("no-character-ngrams", *ablation_models["no-character-ngrams"]),
    ]
    profiled: list[tuple[str, dict[str, np.ndarray], dict[str, float], dict[str, bool], dict[str, Any], bool]] = []
    for name, profile_arrays, profile_temperatures, flags, metrics in profile_candidates:
        floor_metrics, _ = evaluate(
            profile_arrays,
            profile_temperatures,
            development_rows,
            labels,
            selected_buckets,
            flags,
            routing_threshold=float(config["minimumRoutingConfidence"]),
        )
        selective_viable = (
            floor_metrics["selectiveExamples"]
            >= int(config["minimumDevelopmentSelectiveExamples"])
            and floor_metrics["selectivePrecision"]
            >= float(config["minimumDevelopmentSelectivePrecision"])
        )
        profiled.append(
            (
                name,
                profile_arrays,
                profile_temperatures,
                flags,
                metrics,
                selective_viable,
            )
        )
    viable_profiles = [value for value in profiled if value[5]]
    selected_profile = max(
        viable_profiles or profiled,
        key=lambda value: development_quality(value[4]),
    )
    (
        feature_profile,
        arrays,
        temperatures,
        selected_flags,
        selected_metrics,
        selective_viable,
    ) = selected_profile
    selection = {
        "buckets": selected_buckets,
        "featureProfile": feature_profile,
        "featureFlags": selected_flags,
        "development": selected_metrics,
        "developmentSelectiveViable": selective_viable,
    }

    development, development_predictions = evaluate(
        arrays, temperatures, development_rows, labels, selected_buckets, selected_flags
    )
    routing_threshold = choose_routing_threshold(development_predictions, config)
    development, _ = evaluate(
        arrays,
        temperatures,
        development_rows,
        labels,
        selected_buckets,
        selected_flags,
        routing_threshold=routing_threshold,
    )
    if args.command == "develop":
        print(
            json.dumps(
                {
                    "selection": selection,
                    "development": development,
                    "routingThreshold": routing_threshold,
                    "teacherCuration": teacher_curation,
                },
                indent=2,
            )
        )
        return

    # The challenge split is intentionally unopened until all choices above are final.
    challenge_rows = read_jsonl(CORPUS_ROOT / "challenge.jsonl")
    challenge, _ = evaluate(
        arrays,
        temperatures,
        challenge_rows,
        labels,
        selected_buckets,
        selected_flags,
        routing_threshold=routing_threshold,
    )
    quantized, _ = evaluate(
        dequantized_arrays(arrays),
        temperatures,
        challenge_rows,
        labels,
        selected_buckets,
        selected_flags,
        routing_threshold=routing_threshold,
    )
    baseline = shipped_baseline_metrics(base_artifact, challenge_rows, metadata)
    gates = gate_results(config, challenge, baseline, quantized)
    promoted = all(value["passed"] for value in gates.values())
    report: dict[str, Any] = {
        "schemaVersion": 1,
        "modelId": config["modelId"],
        "version": config["version"],
        "promoted": promoted,
        "selection": selection,
        "capacityAblations": candidates,
        "featureAblations": ablations,
        "development": development,
        "challenge": challenge,
        "quantizedChallenge": quantized,
        "shippedBaseline": baseline,
        "routingThreshold": routing_threshold,
        "gates": gates,
        "provenance": {
            "initialization": "exact zeros",
            "teacherRole": "curated delexicalized wording only",
            "teacherWeightsImported": False,
            "pretrainedWeightsUsed": False,
            "personalDataUsed": False,
            "humanBlindExamplesUsed": 0,
            "challengeOpenedAfterSelection": True,
            "developerChallengeEvaluationRounds": 7,
            "teacherCuration": teacher_curation,
        },
        "safety": {
            "advisoryOnly": True,
            "createsAssistantPlans": False,
            "resolvesCalendarIR": False,
            "writesDatabase": False,
            "existingConfirmationPolicyRetained": True,
        },
        "artifacts": {},
    }
    if promoted:
        artifact = build_artifact(
            base_artifact,
            config,
            labels,
            arrays,
            temperatures,
            selected_buckets,
            routing_threshold,
            {"development": development, "challenge": challenge, "quantizedChallenge": quantized},
            corpus_manifest,
            metadata_document,
            selected_flags,
            teacher_curation,
        )
        encoded = (compact_json(artifact) + "\n").encode("utf-8")
        if len(encoded) > int(config["maximumArtifactBytes"]):
            promoted = False
            report["promoted"] = False
            report["gates"]["maximumArtifactBytes"] = {
                "actual": len(encoded),
                "required": int(config["maximumArtifactBytes"]),
                "comparison": "<=",
                "passed": False,
            }
        else:
            MODEL_PATH.write_bytes(encoded)
            update_sidecars(artifact)
            export_onnx(artifact)
            update_release_manifest(config)
            report["artifacts"] = {
                "model": artifact_record(MODEL_PATH),
                "tokenizer": artifact_record(TOKENIZER_PATH),
                "thresholds": artifact_record(THRESHOLDS_PATH),
                "onnx": artifact_record(ONNX_PATH),
            }
    write_report(report)
    print(json.dumps({"promoted": report["promoted"], "selection": selection, "development": development, "challenge": challenge, "baseline": baseline, "gates": gates}, indent=2))
    if not report["promoted"]:
        raise RuntimeError("RemindCore Next failed promotion; installed artifacts were left unchanged")


if __name__ == "__main__":
    main()
