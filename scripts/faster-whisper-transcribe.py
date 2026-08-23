#!/usr/bin/env python3
"""
Minimal Faster-Whisper CLI wrapper returning normalized JSON for ModelForge.

Modes:
  default   --audio ...  transcribe
  --preload              download/warm a model into the local cache
  --check-local          report whether weights are already cached (no download)
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

from faster_whisper import WhisperModel


REPO_ROOT = Path(__file__).resolve().parent.parent
CT2_CACHE_ROOT = REPO_ROOT / "data" / "voice" / "ct2"

KNOWN_MODELS = (
    "tiny",
    "base",
    "small",
    "medium",
    "large-v2",
    "large-v3",
    "distil-large-v3",
    "bengaliAI/tugstugi_bengaliai-regional-asr_whisper-medium",
)

# Hugging Face Whisper fine-tunes published in Transformers format (not CTranslate2).
TRANSFORMERS_WHISPER_HF_MODELS = frozenset(
    {
        "bengaliAI/tugstugi_bengaliai-regional-asr_whisper-medium",
    }
)


def hub_repo_id(model: str) -> str:
    if "/" in model:
        return model
    return f"Systran/faster-whisper-{model}"


def ct2_local_dir(model: str) -> Path:
    return CT2_CACHE_ROOT / model.replace("/", "--")


def hf_hub_snapshots(model: str) -> Path | None:
    home = Path(os.environ.get("HF_HOME", Path.home() / ".cache" / "huggingface"))
    snapshots = home / "hub" / ("models--" + hub_repo_id(model).replace("/", "--")) / "snapshots"
    return snapshots if snapshots.is_dir() else None


def is_ct2_weights_dir(root: Path) -> bool:
    if (root / "model.bin").exists():
        return True
    safetensors = root / "model.safetensors"
    if not safetensors.exists():
        return False
    config = root / "config.json"
    if not config.is_file():
        return True
    try:
        data = json.loads(config.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return True
    architectures = data.get("architectures")
    if isinstance(architectures, list) and architectures:
        return not any("Whisper" in str(entry) for entry in architectures)
    return True


def is_transformers_whisper_dir(root: Path) -> bool:
    config = root / "config.json"
    if not config.is_file():
        return False
    try:
        data = json.loads(config.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    architectures = data.get("architectures") or []
    return any("Whisper" in str(entry) for entry in architectures)


def is_model_cached(model: str) -> bool:
    """Detect CTranslate2 weights without loading them into RAM."""
    local = ct2_local_dir(model)
    if is_ct2_weights_dir(local):
        return True

    snapshots = hf_hub_snapshots(model)
    if not snapshots:
        return False
    for snap in snapshots.iterdir():
        if snap.is_dir() and is_ct2_weights_dir(snap):
            return True
    return False


def compute_type_to_quantization(compute_type: str) -> str:
    normalized = compute_type.strip().lower()
    if normalized in {"int8", "int8_float16", "uint8"}:
        return "int8"
    if normalized in {"float32", "fp32"}:
        return "float32"
    return "float16"


def convert_transformers_whisper_to_ct2(hf_model: str, output_dir: Path, compute_type: str) -> None:
    if is_ct2_weights_dir(output_dir):
        return
    if output_dir.exists():
        shutil.rmtree(output_dir)

    output_dir.parent.mkdir(parents=True, exist_ok=True)
    quant = compute_type_to_quantization(compute_type)
    converter = shutil.which("ct2-transformers-converter")
    cmd: list[str]
    if converter:
        cmd = [
            converter,
            "--model",
            hf_model,
            "--output_dir",
            str(output_dir),
            "--copy_files",
            "tokenizer.json",
            "preprocessor_config.json",
            "--quantization",
            quant,
        ]
    else:
        cmd = [
            sys.executable,
            "-m",
            "ctranslate2.converters.transformers",
            "--model",
            hf_model,
            "--output_dir",
            str(output_dir),
            "--copy_files",
            "tokenizer.json",
            "preprocessor_config.json",
            "--quantization",
            quant,
        ]
    try:
        subprocess.run(cmd, check=True)
    except FileNotFoundError as exc:
        raise RuntimeError(
            "CTranslate2 converter not found. Install with: pip install ctranslate2 transformers torch"
        ) from exc
    except subprocess.CalledProcessError as exc:
        if output_dir.exists() and not is_ct2_weights_dir(output_dir):
            shutil.rmtree(output_dir, ignore_errors=True)
        raise RuntimeError(
            f"CTranslate2 conversion failed for {hf_model}. "
            "Install conversion deps: pip install transformers torch"
        ) from exc
    if not is_ct2_weights_dir(output_dir):
        if output_dir.exists():
            shutil.rmtree(output_dir, ignore_errors=True)
        raise RuntimeError(f"CTranslate2 conversion finished but weights are missing in {output_dir}")


def resolve_whisper_model_path(model: str, compute_type: str) -> str:
    """Return a WhisperModel load path (local CT2 dir or HF repo id)."""
    if model in TRANSFORMERS_WHISPER_HF_MODELS:
        local = ct2_local_dir(model)
        if is_ct2_weights_dir(local):
            return str(local)
        convert_transformers_whisper_to_ct2(model, local, compute_type)
        return str(local)

    if "/" in model:
        snapshots = hf_hub_snapshots(model)
        if snapshots:
            for snap in sorted(snapshots.iterdir(), reverse=True):
                if snap.is_dir() and is_transformers_whisper_dir(snap):
                    local = ct2_local_dir(model)
                    if is_ct2_weights_dir(local):
                        return str(local)
                    convert_transformers_whisper_to_ct2(str(snap), local, compute_type)
                    return str(local)

    return model


def is_bengali_tuned_model(model: str) -> bool:
    lowered = model.lower()
    return any(token in lowered for token in ("bengali", "bangla", "bengaliai", "tugstugi"))


def resolve_transcribe_language(model: str, language: str | None) -> str | None:
    if language:
        return language
    if is_bengali_tuned_model(model):
        return "bn"
    return None


def is_hallucinated_text(text: str) -> bool:
    """Detect Whisper loop / compression-ratio style garbage."""
    clean = (text or "").strip()
    if not clean:
        return True
    # Replacement chars / binary junk
    if "\ufffd" in clean or clean.count("�") >= 2:
        return True
    # Extremely long single segment relative to unique content
    if len(clean) > 80:
        unique = len(set(clean.replace(" ", "")))
        if unique <= 6:
            return True
    # Repeated short n-grams (মামামামা, ওোোোো, ত্রিক্রিকালিকি…)
    compact = re.sub(r"\s+", "", clean)
    if len(compact) >= 12:
        for n in (1, 2, 3, 4):
            if len(compact) < n * 6:
                continue
            # Find the most common n-gram density
            counts: dict[str, int] = {}
            for i in range(0, len(compact) - n + 1):
                gram = compact[i : i + n]
                counts[gram] = counts.get(gram, 0) + 1
            if not counts:
                continue
            top = max(counts.values())
            if top >= max(8, (len(compact) // n) * 0.45):
                return True
    return False


def sanitize_segment_text(text: str) -> str | None:
    clean = (text or "").strip()
    if not clean or is_hallucinated_text(clean):
        return None
    return clean


def transcribe_audio(model: WhisperModel, audio: str, args: argparse.Namespace):
    language = resolve_transcribe_language(args.model, args.language)
    kwargs: dict[str, Any] = {
        "beam_size": args.beam_size,
        "best_of": args.best_of,
        "temperature": args.temperature,
        "no_speech_threshold": args.no_speech_threshold,
        # Critical: previous-text conditioning is the main cause of মামামা / ওোোো loops.
        "condition_on_previous_text": False,
        "compression_ratio_threshold": args.compression_ratio_threshold,
        "log_prob_threshold": args.log_prob_threshold,
    }
    prompt = getattr(args, "initial_prompt", None)
    # Keep prompts short; long Bangla prompts can destabilize fine-tuned CT2 models.
    if prompt:
        trimmed = str(prompt).strip()[:240]
        if trimmed:
            kwargs["initial_prompt"] = trimmed
    try:
        return model.transcribe(audio, language=language, **kwargs)
    except IndexError:
        # Short diarization clips can break Whisper language detection.
        fallback = language or ("bn" if is_bengali_tuned_model(args.model) else None)
        if fallback is None:
            raise
        return model.transcribe(audio, language=fallback, **kwargs)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", default=None)
    parser.add_argument("--model", default="small")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--compute-type", default="int8")
    parser.add_argument("--beam-size", type=int, default=5)
    parser.add_argument("--best-of", type=int, default=5)
    parser.add_argument("--temperature", type=float, default=0.0)
    parser.add_argument("--no-speech-threshold", type=float, default=0.6)
    parser.add_argument("--compression-ratio-threshold", type=float, default=2.4)
    parser.add_argument("--log-prob-threshold", type=float, default=-1.0)
    parser.add_argument("--language", default=None)
    parser.add_argument(
        "--initial-prompt",
        default=None,
        help="Optional Whisper initial_prompt to bias toward known names/jargon",
    )
    parser.add_argument("--preload", action="store_true")
    parser.add_argument("--check-local", action="store_true")
    parser.add_argument("--list-known", action="store_true")
    return parser.parse_args()


def emit(payload: dict[str, Any]) -> None:
    output = json.dumps(payload, ensure_ascii=False)
    sys.stdout.buffer.write(output.encode("utf-8"))
    sys.stdout.buffer.write(b"\n")
    sys.stdout.flush()


def main() -> None:
    args = parse_args()

    if args.list_known:
        emit({"models": list(KNOWN_MODELS)})
        return

    if args.check_local:
        cached = is_model_cached(args.model)
        emit({"ok": True, "cached": cached, "model": args.model, "repo": hub_repo_id(args.model)})
        return

    model_path = resolve_whisper_model_path(args.model, args.compute_type)

    if args.preload:
        WhisperModel(model_path, device=args.device, compute_type=args.compute_type)
        emit({"ok": True, "cached": True, "model": args.model, "preloaded": True, "path": model_path})
        return

    if not args.audio:
        emit({"ok": False, "error": "--audio is required unless --preload/--check-local/--list-known"})
        sys.exit(2)

    model = WhisperModel(model_path, device=args.device, compute_type=args.compute_type)
    segments, info = transcribe_audio(model, args.audio, args)
    text_parts: list[str] = []
    payload_segments: list[dict[str, Any]] = []
    probs: list[float] = []

    for segment in segments:
        clean_text = sanitize_segment_text(segment.text or "")
        if not clean_text:
            continue
        text_parts.append(clean_text)
        if segment.avg_logprob is not None and math.isfinite(segment.avg_logprob):
            probs.append(float(math.exp(segment.avg_logprob)))
        payload_segments.append(
            {
                "start": float(segment.start),
                "end": float(segment.end),
                "text": clean_text,
                "avg_logprob": float(segment.avg_logprob) if segment.avg_logprob is not None else None,
            }
        )

    confidence = (sum(probs) / len(probs)) if probs else None
    emit(
        {
            "language": info.language or args.language or "unknown",
            "text": " ".join(text_parts).strip(),
            "confidence": confidence,
            "segments": payload_segments,
            "hallucination_filtered": True,
        }
    )


if __name__ == "__main__":
    main()
