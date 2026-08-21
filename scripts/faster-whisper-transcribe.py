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
import sys
from pathlib import Path
from typing import Any

from faster_whisper import WhisperModel


KNOWN_MODELS = (
    "tiny",
    "base",
    "small",
    "medium",
    "large-v2",
    "large-v3",
    "distil-large-v3",
)


def hub_repo_id(model: str) -> str:
    if "/" in model:
        return model
    return f"Systran/faster-whisper-{model}"


def is_model_cached(model: str) -> bool:
    """Detect HF hub cache without loading weights into RAM."""
    home = Path(os.environ.get("HF_HOME", Path.home() / ".cache" / "huggingface"))
    hub = home / "hub"
    dirname = "models--" + hub_repo_id(model).replace("/", "--")
    snapshots = hub / dirname / "snapshots"
    if not snapshots.is_dir():
        return False
    for snap in snapshots.iterdir():
        if not snap.is_dir():
            continue
        if (snap / "model.bin").exists() or (snap / "model.safetensors").exists():
            return True
    return False


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
    parser.add_argument("--language", default=None)
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

    if args.preload:
        WhisperModel(args.model, device=args.device, compute_type=args.compute_type)
        emit({"ok": True, "cached": True, "model": args.model, "preloaded": True})
        return

    if not args.audio:
        emit({"ok": False, "error": "--audio is required unless --preload/--check-local/--list-known"})
        sys.exit(2)

    model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type)
    segments, info = model.transcribe(
        args.audio,
        language=args.language,
        beam_size=args.beam_size,
        best_of=args.best_of,
        temperature=args.temperature,
        no_speech_threshold=args.no_speech_threshold,
    )
    text_parts: list[str] = []
    payload_segments: list[dict[str, Any]] = []
    probs: list[float] = []

    for segment in segments:
        clean_text = (segment.text or "").strip()
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
        }
    )


if __name__ == "__main__":
    main()
