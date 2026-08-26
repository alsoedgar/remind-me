"""Export portable ONNX parity kernels for RemindSpeak and PlanScan.

The production TypeScript runtimes remain the smaller universal CPU path. These graphs expose the
same quantized hashed-head score operation for reproducibility, provider experiments, and release
audits without introducing a runtime dependency or changing the safety boundary.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
from pathlib import Path
from typing import Any

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper
from onnx.reference import ReferenceEvaluator


WORKSPACE = Path(__file__).resolve().parents[1]
MODEL_ROOT = WORKSPACE / "models"
MANIFEST_PATH = MODEL_ROOT / "manifest.json"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def safe_name(value: str) -> str:
    return "".join(character if character.isalnum() else "_" for character in value)


def output_count(head: dict[str, Any]) -> int:
    if "labels" in head:
        return len(head["labels"])
    return len(head["options"])


def export_model(
    configuration_path: Path,
    compressed_weights_path: Path,
    output_path: Path,
    role: str,
    quantization_policy: str,
) -> None:
    artifact = json.loads(configuration_path.read_text(encoding="utf-8"))
    raw = gzip.decompress(compressed_weights_path.read_bytes())
    if len(raw) != int(artifact["weights"]["uncompressedBytes"]):
        raise RuntimeError(f"Unexpected decompressed length for {role}")
    if hashlib.sha256(raw).hexdigest() != artifact["weights"]["sha256Uncompressed"]:
        raise RuntimeError(f"Unexpected decompressed digest for {role}")

    nodes = []
    inputs = []
    outputs = []
    initializers = []
    direct_checks: list[tuple[str, np.ndarray, np.ndarray, np.ndarray, float, int]] = []

    for head_name, head in artifact["heads"].items():
        name = safe_name(head_name)
        buckets = int(head["buckets"])
        count = output_count(head)
        byte_offset = int(head["byteOffset"])
        byte_length = int(head["byteLength"])
        weights = np.frombuffer(raw[byte_offset : byte_offset + byte_length], dtype=np.int8)
        weights = weights.reshape((count, buckets)).copy()
        scales = np.asarray(head["scale"], dtype=np.float32).reshape((count, 1))
        bias = np.asarray(head["bias"], dtype=np.float32)
        temperature = float(head.get("temperature", 1.0))
        ids_name = f"{name}_feature_ids"
        output_name = f"{name}_logits"
        axes_name = f"{name}_reduce_axes"
        one_name = f"{name}_one"
        temperature_name = f"{name}_temperature"

        inputs.append(helper.make_tensor_value_info(ids_name, TensorProto.INT64, [None]))
        outputs.append(helper.make_tensor_value_info(output_name, TensorProto.FLOAT, [count]))
        initializers.extend(
            [
                numpy_helper.from_array(weights, f"{name}_weights_int8"),
                numpy_helper.from_array(scales, f"{name}_scales"),
                numpy_helper.from_array(bias, f"{name}_bias"),
                numpy_helper.from_array(np.asarray([1], dtype=np.int64), axes_name),
                numpy_helper.from_array(np.asarray(1.0, dtype=np.float32), one_name),
                numpy_helper.from_array(
                    np.asarray(temperature, dtype=np.float32), temperature_name
                ),
            ]
        )
        nodes.extend(
            [
                helper.make_node(
                    "Gather",
                    [f"{name}_weights_int8", ids_name],
                    [f"{name}_selected_int8"],
                    axis=1,
                ),
                helper.make_node(
                    "Cast",
                    [f"{name}_selected_int8"],
                    [f"{name}_selected_float"],
                    to=TensorProto.FLOAT,
                ),
                helper.make_node(
                    "Mul",
                    [f"{name}_selected_float", f"{name}_scales"],
                    [f"{name}_dequantized"],
                ),
                helper.make_node(
                    "ReduceSum",
                    [f"{name}_dequantized", axes_name],
                    [f"{name}_sum"],
                    keepdims=0,
                ),
                helper.make_node("Size", [ids_name], [f"{name}_feature_count_int64"]),
                helper.make_node(
                    "Cast",
                    [f"{name}_feature_count_int64"],
                    [f"{name}_feature_count"],
                    to=TensorProto.FLOAT,
                ),
                helper.make_node(
                    "Max",
                    [f"{name}_feature_count", one_name],
                    [f"{name}_bounded_feature_count"],
                ),
                helper.make_node(
                    "Sqrt", [f"{name}_bounded_feature_count"], [f"{name}_divisor"]
                ),
                helper.make_node(
                    "Div", [f"{name}_sum", f"{name}_divisor"], [f"{name}_normalized"]
                ),
                helper.make_node(
                    "Add", [f"{name}_normalized", f"{name}_bias"], [f"{name}_biased"]
                ),
                helper.make_node(
                    "Div", [f"{name}_biased", temperature_name], [output_name]
                ),
            ]
        )
        direct_checks.append((ids_name, weights, scales[:, 0], bias, temperature, buckets))

    graph = helper.make_graph(
        nodes,
        f"{artifact['architecture']['name']} quantized parity scores",
        inputs,
        outputs,
        initializer=initializers,
    )
    model = helper.make_model(
        graph,
        producer_name="remind-me-ml",
        producer_version=artifact["version"],
        opset_imports=[helper.make_opsetid("", 18)],
    )
    model.ir_version = min(model.ir_version, 10)
    helper.set_model_props(
        model,
        {
            "remind_me.role": role,
            "remind_me.contract_version": artifact["contractVersion"],
            "remind_me.quantization_policy": quantization_policy,
            "remind_me.runtime_authority": "parity-only; deterministic TypeScript CPU is primary",
            "remind_me.input_contract": "sorted unique FNV-1a feature bucket IDs per head",
            "remind_me.training_teacher_used": str(
                bool(artifact.get("training", {}).get("teacherUsed", False))
            ).lower(),
        },
    )
    onnx.checker.check_model(model)

    feeds: dict[str, np.ndarray] = {}
    expected: dict[str, np.ndarray] = {}
    for ids_name, weights, scales, bias, temperature, buckets in direct_checks:
        ids = np.asarray(sorted({0, 17 % buckets, (buckets - 1)}), dtype=np.int64)
        feeds[ids_name] = ids
        expected[ids_name.replace("_feature_ids", "_logits")] = (
            bias + (weights[:, ids].astype(np.float32) * scales[:, None]).sum(axis=1) / np.sqrt(len(ids))
        ) / temperature
    reference_outputs = ReferenceEvaluator(model).run(None, feeds)
    for output_info, actual in zip(model.graph.output, reference_outputs):
        if not np.allclose(actual, expected[output_info.name], rtol=1e-5, atol=1e-5):
            raise RuntimeError(f"ONNX parity failed for {role}:{output_info.name}")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    onnx.save_model(model, output_path)


def update_manifest(outputs: list[tuple[Path, str, str]]) -> None:
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    output_paths = {str(path.relative_to(MODEL_ROOT)).replace("\\", "/") for path, _, _ in outputs}
    manifest["artifacts"] = [
        artifact for artifact in manifest["artifacts"] if artifact.get("path") not in output_paths
    ]
    for path, role, artifact_id in outputs:
        configuration_path = (
            MODEL_ROOT / "remindspeak/remindspeak-v0.1-int8.json"
            if role == "speaker"
            else MODEL_ROOT / "planscan/planscan-v0.1-int8.json"
        )
        configuration = json.loads(configuration_path.read_text(encoding="utf-8"))
        manifest["artifacts"].append(
            {
                "id": artifact_id,
                "role": role,
                "component": "weights",
                "version": configuration["version"],
                "format": "onnx",
                "path": str(path.relative_to(MODEL_ROOT)).replace("\\", "/"),
                "sha256": sha256(path),
                "byteLength": path.stat().st_size,
                "required": False,
                "contractVersion": "0.1",
                "locale": "en-US",
                "license": "MIT",
                "provenance": "project-trained",
                "sourceUrl": None,
                "generator": "ml/export_onnx.py",
            }
        )
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


def export_all() -> None:
    speaker_configuration = json.loads(
        (MODEL_ROOT / "remindspeak/remindspeak-v0.1-int8.json").read_text(encoding="utf-8")
    )
    planscan_configuration = json.loads(
        (MODEL_ROOT / "planscan/planscan-v0.1-int8.json").read_text(encoding="utf-8")
    )
    outputs = [
        (
            MODEL_ROOT / "remindspeak/remindspeak-v0.1-int8.onnx",
            "speaker",
            f"{speaker_configuration['id']}.onnx",
        ),
        (
            MODEL_ROOT / "planscan/planscan-v0.1-int8.onnx",
            "document-layout",
            f"{planscan_configuration['id']}.onnx",
        ),
    ]
    export_model(
        MODEL_ROOT / "remindspeak/remindspeak-v0.1-int8.json",
        MODEL_ROOT / "remindspeak/remindspeak-v0.1-int8.bin.gz",
        outputs[0][0],
        "speaker",
        "dynamic INT8 weight-only; binary hashed activations remain exact",
    )
    export_model(
        MODEL_ROOT / "planscan/planscan-v0.1-int8.json",
        MODEL_ROOT / "planscan/planscan-v0.1-int8.bin.gz",
        outputs[1][0],
        "document-layout",
        "calibrated static INT8 per output channel",
    )
    update_manifest(outputs)
    print(
        "Exported ONNX parity kernels: "
        + ", ".join(f"{path.name} ({path.stat().st_size / 1024 / 1024:.1f} MiB)" for path, _, _ in outputs)
    )


def check_all() -> None:
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    expected = {
        "remindspeak/remindspeak-v0.1-int8.onnx",
        "planscan/planscan-v0.1-int8.onnx",
    }
    artifacts = {artifact["path"]: artifact for artifact in manifest["artifacts"]}
    for relative_path in expected:
        artifact = artifacts.get(relative_path)
        if artifact is None:
            raise RuntimeError(f"Missing ONNX manifest entry: {relative_path}")
        path = MODEL_ROOT / relative_path
        if path.stat().st_size != artifact["byteLength"] or sha256(path) != artifact["sha256"]:
            raise RuntimeError(f"ONNX artifact failed release integrity: {relative_path}")
        model = onnx.load(path, load_external_data=False)
        onnx.checker.check_model(model)
        properties = {item.key: item.value for item in model.metadata_props}
        if "INT8" not in properties.get("remind_me.quantization_policy", ""):
            raise RuntimeError(f"ONNX quantization policy is missing: {relative_path}")
    print("Verified RemindSpeak and PlanScan ONNX parity kernels.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["export", "check"], nargs="?", default="export")
    args = parser.parse_args()
    if args.command == "export":
        export_all()
    else:
        check_all()


if __name__ == "__main__":
    main()
