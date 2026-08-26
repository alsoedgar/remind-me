"""Validate and curate local Qwen teacher outputs for RemindCore/RemindSpeak.

Qwen supplies surface wording only. Operation labels, placeholder signatures,
fact values, train/challenge splits, and every safety decision remain defined by
this project. Raw generations are immutable evidence; accepted files are the
only teacher data either student pipeline is allowed to read.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import random
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any


WORKSPACE = Path(__file__).resolve().parents[2]
ROOT = WORKSPACE / "ml" / "teacher_assisted"
RAW = ROOT / "raw"
ACCEPTED = ROOT / "accepted"
REPORTS = ROOT / "reports"
CONFIG_PATH = ROOT / "config.json"
CORE_RAW_PATH = RAW / "remindcore.json"
SPEAK_RAW_PATH = RAW / "remindspeak.json"
SPEAK_CASES_PATH = RAW / "remindspeak-preference-cases.json"
SPEAK_PREFERENCE_RAW_PATH = RAW / "remindspeak-preferences.json"
CORE_ACCEPTED_PATH = ACCEPTED / "remindcore.json"
SPEAK_ACCEPTED_PATH = ACCEPTED / "remindspeak.json"
REPORT_PATH = REPORTS / "curation.json"

CORE_SIGNATURES = {
    "event.create": ("TITLE", "DATE", "TIME", "RECURRENCE"),
    "event.duplicate": ("TARGET", "DATE", "TIME", "RECURRENCE"),
    "event.update": ("TARGET", "TITLE"),
    "event.move": ("TARGET", "DATE", "TIME"),
    "event.delete": ("TARGET",),
    "reminder.create": ("TITLE", "DATE", "TIME", "RECURRENCE"),
    "reminder.update": ("TARGET", "TITLE"),
    "reminder.complete": ("TARGET",),
    "reminder.delete": ("TARGET",),
    "calendar.list": ("DATE", "TIME"),
    "calendar.search": ("TARGET",),
    "calendar.availability": ("DATE", "TIME"),
    "calendar.conflicts": ("DATE", "TIME"),
}

SEMANTIC_CUES = {
    "event.create": ("add", "block", "book", "calendar", "create", "fit", "make", "plan", "put", "reserve", "schedule", "set"),
    "event.duplicate": ("again", "another", "copy", "duplicate", "mirror", "repeat", "same", "reuse"),
    "event.update": ("call", "change", "label", "name", "rename", "retitle", "update"),
    "event.move": ("bump", "change", "move", "push", "relocate", "reorganize", "reschedule", "shift", "scoot", "switch"),
    "event.delete": ("cancel", "clear", "delete", "drop", "lose", "pull", "remove", "take off"),
    "reminder.create": ("alert", "don't let me forget", "flag", "heads-up", "ping", "remind", "remember"),
    "reminder.update": ("adjust", "change", "edit", "modify", "rename", "revise", "update", "wording"),
    "reminder.complete": ("check", "complete", "done", "finish", "finished", "mark", "settle", "wrap"),
    "reminder.delete": ("clear", "delete", "dismiss", "discard", "drop", "remove"),
    "calendar.list": ("agenda", "calendar", "coming up", "day", "plans", "schedule", "what"),
    "calendar.search": ("bring up", "check", "find", "locate", "look", "pull up", "search", "show", "surface", "where", "when"),
    "calendar.availability": ("available", "availability", "free", "gap", "open", "room", "time"),
    "calendar.conflicts": ("clash", "collide", "conflict", "interfere", "overlap", "tangle"),
}

SPEAK_SIGNATURES = {
    "proposal": ("SUMMARY",),
    "creation-confirmed": ("RECEIPT",),
    "update-confirmed": ("RECEIPT",),
    "deletion-confirmed": ("RECEIPT",),
    "completion-confirmed": ("RECEIPT",),
    "availability-answer": ("SLOT", "DETAIL"),
    "schedule-summary": ("SUMMARY",),
    "clarification": ("DETAIL",),
    "conflict-warning": ("SUMMARY",),
    "unsupported": ("DETAIL",),
    "error": ("DETAIL",),
}

DATE_WORDS = {
    "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
    "january", "february", "march", "april", "may", "june", "july", "august",
    "september", "october", "november", "december",
}

NON_WRITE_ACTS = {"proposal", "availability-answer", "schedule-summary", "clarification", "conflict-warning", "unsupported", "error"}
WRITE_CLAIMS = ("added", "changed", "committed", "deleted", "done", "removed", "saved", "updated", "written")
CORE_LITERAL_FACTS = DATE_WORDS | {
    "today", "tomorrow", "yesterday", "noon", "midnight", "morning", "afternoon", "evening"
}
OOD_ACTION_PATTERNS = (
    r"\b(?:add|book|create|put|schedule|set)\b.{0,45}\b(?:appointment|calendar|event|meeting|reminder)\b",
    r"\b(?:cancel|change|copy|delete|edit|move|remove|reschedule|update)\b.{0,45}\b(?:calendar|event|meeting|reminder)\b",
    r"\b(?:calendar|event|meeting|reminder)\b.{0,45}\b(?:cancel|change|copy|delete|edit|move|remove|reschedule|update)\b",
)


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def normalized(text: str) -> str:
    text = re.sub(r"<[A-Z][A-Z0-9_]*>", "<slot>", text.casefold())
    return re.sub(r"[^a-z0-9<>]+", " ", text).strip()


def placeholders(text: str) -> list[str]:
    return re.findall(r"<([A-Z][A-Z0-9_]*)>", text)


def canonicalize_markers(text: str) -> str:
    return re.sub(
        r"<\s*([A-Z][A-Z0-9_]*)\s*>",
        lambda match: f"<{match.group(1)}>",
        text,
    )


def import_module(path: Path, name: str):
    specification = importlib.util.spec_from_file_location(name, path)
    if specification is None or specification.loader is None:
        raise RuntimeError(f"Could not import {path}")
    module = importlib.util.module_from_spec(specification)
    sys.modules[name] = module
    specification.loader.exec_module(module)
    return module


def validate_metadata(raw: dict[str, Any], config: dict[str, Any]) -> None:
    teacher = raw.get("teacher", {})
    if teacher.get("modelId") != config["teacherModelId"]:
        raise ValueError("Teacher model ID does not match the pinned curation config")
    if teacher.get("sha256") != config["teacherSha256"]:
        raise ValueError("Teacher SHA-256 does not match the pinned curation config")


def curate_core(config: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    raw = read_json(CORE_RAW_PATH)
    validate_metadata(raw, config)
    candidates: list[dict[str, Any]] = []
    ood_candidates: list[str] = []
    for batch in raw.get("batches", []):
        output = batch.get("output", {})
        if str(batch.get("id", "")).startswith("core-ood"):
            ood_candidates.extend(value for value in output.get("items", []) if isinstance(value, str))
            continue
        for value in output.get("items", []):
            if isinstance(value, dict):
                candidates.append({**value, "sourceBatch": batch.get("id")})

    rejected: Counter[str] = Counter()
    accepted_by_operation: dict[str, list[dict[str, Any]]] = defaultdict(list)
    seen: set[str] = set()
    for candidate in candidates:
        operation = candidate.get("operation")
        template = candidate.get("template")
        register = candidate.get("register")
        if operation not in CORE_SIGNATURES or not isinstance(template, str):
            rejected["schema"] += 1
            continue
        template = canonicalize_markers(re.sub(r"\s+", " ", template).strip())
        if len(template) < 8 or len(template) > 180 or "\n" in template:
            rejected["length"] += 1
            continue
        actual = placeholders(template)
        expected = CORE_SIGNATURES[operation]
        if Counter(actual) != Counter(expected) or len(actual) != len(expected):
            rejected["placeholder-signature"] += 1
            continue
        if re.search(r"<[^>]*>", re.sub(r"<[A-Z][A-Z0-9_]*>", "", template)):
            rejected["unknown-placeholder"] += 1
            continue
        lowered = template.casefold()
        static_text = re.sub(r"<[A-Z][A-Z0-9_]*>", "", lowered)
        if any(character.isdigit() for character in static_text) or any(
            re.search(rf"\b{re.escape(word)}\b", static_text) for word in CORE_LITERAL_FACTS
        ):
            rejected["unprotected-specific"] += 1
            continue
        if not any(cue in lowered for cue in SEMANTIC_CUES[operation]):
            rejected["semantic-cue"] += 1
            continue
        key = normalized(template)
        if key in seen:
            rejected["duplicate"] += 1
            continue
        seen.add(key)
        accepted_by_operation[operation].append(
            {
                "id": "qwen-core-" + hashlib.sha256(f"{operation}:{template}".encode()).hexdigest()[:12],
                "operation": operation,
                "template": template,
                "placeholders": list(expected),
                "register": register,
                "sourceBatch": candidate.get("sourceBatch"),
            }
        )

    minimum = int(config["minimumCoreTemplatesPerOperation"])
    challenge_count = int(config["coreChallengeTemplatesPerOperation"])
    templates: list[dict[str, Any]] = []
    coverage: dict[str, Any] = {}
    for operation in CORE_SIGNATURES:
        values = accepted_by_operation[operation]
        if len(values) < minimum:
            raise ValueError(
                f"Only {len(values)} valid Qwen templates for {operation}; need at least {minimum}"
            )
        for index, value in enumerate(values):
            value["split"] = "challenge" if index >= len(values) - challenge_count else "train"
            templates.append(value)
        coverage[operation] = {
            "accepted": len(values),
            "train": len(values) - challenge_count,
            "challenge": challenge_count,
        }

    remindcore_module = import_module(
        WORKSPACE / "ml" / "remindcore" / "pipeline.py", "remindcore_for_teacher_curation"
    )
    teacher_loaded_ood = set(getattr(remindcore_module, "TEACHER_OOD_TEXTS", set()))
    existing_ood = {
        normalized(value)
        for split_values in remindcore_module.OOD_BY_SPLIT.values()
        for value in split_values
        if value not in teacher_loaded_ood
    }
    accepted_ood: list[dict[str, Any]] = []
    for value in ood_candidates:
        text = re.sub(r"\s+", " ", value).strip()
        key = normalized(text)
        if len(text) < 4 or len(text) > 180:
            rejected["ood-length"] += 1
        elif key in existing_ood or key in seen:
            rejected["ood-duplicate"] += 1
        elif re.search(r"<[A-Z][A-Z0-9_]*>", text):
            rejected["ood-placeholder"] += 1
        elif text.casefold().startswith(("the user ", "when writing ", "explanations should ")):
            rejected["ood-not-user-voice"] += 1
        elif any(re.search(pattern, text, flags=re.IGNORECASE) for pattern in OOD_ACTION_PATTERNS):
            rejected["ood-calendar-action"] += 1
        else:
            seen.add(key)
            accepted_ood.append(
                {
                    "id": "qwen-ood-" + hashlib.sha256(text.encode()).hexdigest()[:12],
                    "text": text,
                    "split": "challenge" if len(accepted_ood) % 7 == 6 else "train",
                }
            )

    output = {
        "schemaVersion": 1,
        "provenance": {
            "teacherModelId": config["teacherModelId"],
            "teacherSha256": config["teacherSha256"],
            "teacherLicense": "Apache-2.0",
            "rawPath": CORE_RAW_PATH.relative_to(WORKSPACE).as_posix(),
            "rawSha256": sha256(CORE_RAW_PATH),
            "teacherRole": "surface paraphrase only; project specifications supply labels and slots",
            "pretrainedWeightsImportedIntoStudent": False,
            "personalDataUsed": False,
        },
        "templates": templates,
        "ood": accepted_ood,
        "challengeInstantiationsPerTemplate": int(config["coreInstantiationsPerChallengeTemplate"]),
    }
    report = {
        "rawCandidates": len(candidates) + len(ood_candidates),
        "acceptedTemplates": len(templates),
        "acceptedOod": len(accepted_ood),
        "coverage": coverage,
        "rejected": dict(sorted(rejected.items())),
    }
    return output, report


def prepare_speak_preferences(config: dict[str, Any]) -> dict[str, Any]:
    model = import_module(
        WORKSPACE / "ml" / "remindspeak" / "pipeline.py", "remindspeak_for_preference_cases"
    )
    options = model.build_options()
    style_profiles = list(config["styleProfiles"].items())
    requested = int(config["speakPreferenceCasesPerAct"])
    if requested > len(style_profiles):
        raise ValueError("Not enough configured styles for the requested preference cases")
    cases: list[dict[str, Any]] = []

    for act_index, speech_act in enumerate(SPEAK_SIGNATURES):
        signature = SPEAK_SIGNATURES[speech_act]
        compatible = {
            head: model.compatible_options(options[head], speech_act, signature)
            for head in ("lead", "body", "close")
        }
        for style_index, (style_tag, style) in enumerate(style_profiles[:requested]):
            ranked = {
                head: sorted(
                    values,
                    key=lambda option: (
                        model.style_distance(style, option.style),
                        hashlib.sha256(
                            f"{speech_act}:{style_tag}:{head}:{option.id}".encode()
                        ).hexdigest(),
                    ),
                )
                for head, values in compatible.items()
            }
            combinations: list[tuple[float, dict[str, Any]]] = []
            for lead in ranked["lead"][:5]:
                for body in ranked["body"][:7]:
                    for close in ranked["close"][:5]:
                        text = model.compose([lead.text, body.text, close.text])
                        distance = sum(
                            model.style_distance(style, value.style)
                            for value in (lead, body, close)
                        )
                        tie = int(
                            hashlib.sha256(
                                f"{speech_act}:{style_tag}:{lead.id}:{body.id}:{close.id}".encode()
                            ).hexdigest()[:8],
                            16,
                        )
                        combinations.append(
                            (
                                distance + (tie % 997) / 100_000,
                                {
                                    "text": text,
                                    "targets": {
                                        "lead": lead.id,
                                        "body": body.id,
                                        "close": close.id,
                                    },
                                },
                            )
                        )
            chosen: list[dict[str, Any]] = []
            seen_text: set[str] = set()
            for _score, candidate in sorted(combinations, key=lambda value: value[0]):
                key = normalized(candidate["text"])
                if key in seen_text:
                    continue
                seen_text.add(key)
                chosen.append(candidate)
                if len(chosen) == 4:
                    break
            if len(chosen) != 4:
                raise ValueError(f"Could not build four preference candidates for {speech_act}")
            random.Random(81_901 + act_index * 101 + style_index * 17).shuffle(chosen)
            case_id = f"speak-pref:{speech_act}:{style_tag}"
            cases.append(
                {
                    "id": case_id,
                    "speechAct": speech_act,
                    "factKeys": list(signature),
                    "factKinds": [model.FACT_KIND[key] for key in signature],
                    "factLengths": [18 + index * 11 for index, _key in enumerate(signature)],
                    "styleTag": style_tag,
                    "style": style,
                    "variant": style_index % 4,
                    "recentCount": (act_index + style_index) % 8,
                    "candidates": chosen,
                }
            )

    output = {
        "schemaVersion": 1,
        "generator": "ml/teacher_assisted/pipeline.py prepare",
        "policy": "four project-authored, placeholder-valid candidates; Qwen selects only an index",
        "teacherModelId": config["teacherModelId"],
        "cases": cases,
    }
    return output


def curate_speak(config: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    cases_payload = read_json(SPEAK_CASES_PATH)
    raw = read_json(SPEAK_PREFERENCE_RAW_PATH)
    validate_metadata(raw, config)
    cases = {value["id"]: value for value in cases_payload.get("cases", [])}
    choices: dict[str, int] = {}
    rejected: Counter[str] = Counter()
    for batch in raw.get("batches", []):
        for value in batch.get("output", {}).get("choices", []):
            case_id = value.get("id") if isinstance(value, dict) else None
            choice = value.get("choice") if isinstance(value, dict) else None
            if case_id not in cases or not isinstance(choice, int) or not 0 <= choice < 4:
                rejected["invalid-choice"] += 1
            elif case_id in choices:
                rejected["duplicate-choice"] += 1
            else:
                choices[case_id] = choice

    missing = sorted(set(cases) - set(choices))
    if missing:
        raise ValueError(f"Qwen preference output omitted {len(missing)} cases: {missing[:3]}")
    records: list[dict[str, Any]] = []
    coverage: Counter[str] = Counter()
    for case_id, case in cases.items():
        choice = choices[case_id]
        candidate = case["candidates"][choice]
        split = "challenge" if case["styleTag"] == "neutral" else "train"
        records.append(
            {
                "id": case_id,
                "split": split,
                "speechAct": case["speechAct"],
                "factKeys": case["factKeys"],
                "factKinds": case["factKinds"],
                "factLengths": case["factLengths"],
                "styleTag": case["styleTag"],
                "style": case["style"],
                "variant": case["variant"],
                "recentCount": case["recentCount"],
                "targets": candidate["targets"],
                "reference": candidate["text"],
                "teacherChoice": choice,
            }
        )
        coverage[f"{case['speechAct']}:{split}"] += 1

    expected = int(config["speakPreferenceCasesPerAct"])
    for speech_act in SPEAK_SIGNATURES:
        count = sum(1 for value in records if value["speechAct"] == speech_act)
        if count != expected:
            raise ValueError(f"Expected {expected} preferences for {speech_act}, found {count}")

    output = {
        "schemaVersion": 1,
        "provenance": {
            "teacherModelId": config["teacherModelId"],
            "teacherSha256": config["teacherSha256"],
            "teacherLicense": "Apache-2.0",
            "casesPath": SPEAK_CASES_PATH.relative_to(WORKSPACE).as_posix(),
            "casesSha256": sha256(SPEAK_CASES_PATH),
            "rawPath": SPEAK_PREFERENCE_RAW_PATH.relative_to(WORKSPACE).as_posix(),
            "rawSha256": sha256(SPEAK_PREFERENCE_RAW_PATH),
            "teacherRole": "preference index over project-authored protected candidates",
            "teacherAuthoredSurfaceAtomsImported": 0,
            "pretrainedWeightsImportedIntoStudent": False,
            "personalDataUsed": False,
        },
        "trainingRepeats": int(config["speakPreferenceTrainingRepeats"]),
        "preferences": records,
    }
    report = {
        "preferenceCases": len(cases),
        "acceptedPreferences": len(records),
        "trainPreferences": sum(value["split"] == "train" for value in records),
        "challengePreferences": sum(value["split"] == "challenge" for value in records),
        "teacherAuthoredSurfaceAtomsImported": 0,
        "rejected": dict(sorted(rejected.items())),
        "coverage": dict(sorted(coverage.items())),
    }
    if SPEAK_RAW_PATH.exists():
        report["rejectedFreeGenerationExperiment"] = {
            "path": SPEAK_RAW_PATH.relative_to(WORKSPACE).as_posix(),
            "sha256": sha256(SPEAK_RAW_PATH),
            "admittedAtoms": 0,
            "reason": "Qwen free-generation candidates did not clear protected-surface quality gates",
        }
    return output, report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "command", choices=("prepare", "curate", "check"), nargs="?", default="curate"
    )
    args = parser.parse_args()
    config = read_json(CONFIG_PATH)
    prepared = prepare_speak_preferences(config)
    if args.command == "prepare":
        write_json(SPEAK_CASES_PATH, prepared)
        print(f"Prepared {len(prepared['cases'])} protected RemindSpeak preference cases")
        return
    if read_json(SPEAK_CASES_PATH) != prepared:
        raise ValueError("RemindSpeak preference cases are not the deterministic preparation output")
    core, core_report = curate_core(config)
    speak, speak_report = curate_speak(config)
    if args.command == "curate":
        write_json(CORE_ACCEPTED_PATH, core)
        write_json(SPEAK_ACCEPTED_PATH, speak)
        write_json(
            REPORT_PATH,
            {
                "schemaVersion": 1,
                "teacher": config["teacherModelId"],
                "remindCore": core_report,
                "remindSpeak": speak_report,
            },
        )
        print(f"Accepted {core_report['acceptedTemplates']} RemindCore templates")
        print(f"Accepted {core_report['acceptedOod']} RemindCore OOD messages")
        print(f"Accepted {speak_report['acceptedPreferences']} RemindSpeak preferences")
        return
    if read_json(CORE_ACCEPTED_PATH) != core:
        raise ValueError("Committed RemindCore teacher corpus is not the deterministic curation output")
    if read_json(SPEAK_ACCEPTED_PATH) != speak:
        raise ValueError("Committed RemindSpeak teacher corpus is not the deterministic curation output")
    print("Teacher-assisted corpus checks passed")


if __name__ == "__main__":
    main()
