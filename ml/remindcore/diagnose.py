"""Inspect the exported INT8 planner against the generated held-out split."""

from __future__ import annotations

import base64
import json
from collections import Counter, defaultdict

import numpy as np

import pipeline


def main() -> None:
    config = pipeline.load_config()
    datasets = pipeline.generate_dataset(config)
    artifact = json.loads(
        (pipeline.MODEL_DIRECTORY / "remindcore-v0.1-int8.json").read_text(encoding="utf-8")
    )
    head = artifact["heads"]["operation"]
    weights = (
        np.frombuffer(base64.b64decode(head["weightsBase64"]), dtype=np.int8)
        .reshape(len(head["labels"]), head["buckets"])
        .astype(np.float32)
        * np.asarray(head["scale"], dtype=np.float32)[:, None]
    )
    bias = np.asarray(head["bias"], dtype=np.float32)
    labels = list(head["labels"])
    confusion: dict[str, Counter[str]] = defaultdict(Counter)
    examples: dict[tuple[str, str], list[str]] = defaultdict(list)
    for example in datasets["test"]:
        ids = pipeline.feature_ids(
            pipeline.global_feature_names(example["text"]), config["globalBuckets"]
        )
        predicted = labels[int(np.argmax(pipeline.scores(weights, bias, ids)))]
        expected = example["program"]["operation"]
        confusion[expected][predicted] += 1
        if predicted != expected and len(examples[(expected, predicted)]) < 3:
            examples[(expected, predicted)].append(example["text"])
    for expected in labels:
        counts = confusion[expected]
        total = sum(counts.values())
        if not total:
            continue
        correct = counts[expected]
        print(f"{expected:24} {correct:4}/{total:<4} {correct / total:6.1%} {counts.most_common(4)}")
    print("\nRepresentative errors")
    for pair, texts in sorted(examples.items()):
        print(f"{pair[0]} -> {pair[1]}")
        for text in texts:
            print(f"  {text}")


if __name__ == "__main__":
    main()
