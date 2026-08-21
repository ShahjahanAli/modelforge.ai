#!/usr/bin/env python3
"""
Pyannote speaker diarization CLI for ModelForge.

Outputs JSON turns: [{start, end, speaker}, ...]
Requires: pip install pyannote.audio  + HF_TOKEN with access to pyannote models.
Audio is re-encoded to 16 kHz mono WAV via ffmpeg before diarization (avoids
torchcodec/mp3 chunk-length mismatches).
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from typing import Any


def emit(payload: dict[str, Any]) -> None:
    output = json.dumps(payload, ensure_ascii=False)
    sys.stdout.buffer.write(output.encode("utf-8"))
    sys.stdout.buffer.write(b"\n")
    sys.stdout.flush()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", default=None)
    parser.add_argument(
        "--model",
        default="pyannote/speaker-diarization-community-1",
    )
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--min-speakers", type=int, default=None)
    parser.add_argument("--max-speakers", type=int, default=None)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--preload", action="store_true")
    return parser.parse_args()


def load_pipeline(model_id: str, device: str):
    import torch
    from pyannote.audio import Pipeline

    token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN") or True
    pipeline = Pipeline.from_pretrained(model_id, token=token)
    torch_device = torch.device("cuda" if device == "cuda" and torch.cuda.is_available() else "cpu")
    try:
        pipeline.to(torch_device)
    except Exception:
        pass
    return pipeline


def convert_to_wav16k(source_path: str, dest_path: str) -> None:
    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        source_path,
        "-ac",
        "1",
        "-ar",
        "16000",
        "-sample_fmt",
        "s16",
        dest_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise RuntimeError(
            f"ffmpeg convert failed ({result.returncode}): {(result.stderr or '')[-800:]}"
        )


def main() -> None:
    args = parse_args()

    if args.check:
        try:
            import pyannote.audio  # noqa: F401

            emit(
                {
                    "ok": True,
                    "pyannoteAvailable": True,
                    "executable": sys.executable,
                    "version": sys.version.split()[0],
                }
            )
        except Exception as error:  # noqa: BLE001
            emit(
                {
                    "ok": False,
                    "pyannoteAvailable": False,
                    "error": str(error),
                    "executable": sys.executable,
                    "version": sys.version.split()[0],
                }
            )
        return

    if args.preload:
        load_pipeline(args.model, args.device)
        emit({"ok": True, "preloaded": True, "model": args.model})
        return

    if not args.audio:
        emit({"ok": False, "error": "--audio is required unless --check/--preload"})
        sys.exit(2)

    pipeline = load_pipeline(args.model, args.device)
    kwargs: dict[str, Any] = {}
    if args.min_speakers is not None:
        kwargs["min_speakers"] = args.min_speakers
    if args.max_speakers is not None:
        kwargs["max_speakers"] = args.max_speakers

    wav_path: str | None = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            wav_path = tmp.name
        convert_to_wav16k(args.audio, wav_path)
        output = pipeline(wav_path, **kwargs)
    finally:
        if wav_path and os.path.exists(wav_path):
            try:
                os.remove(wav_path)
            except OSError:
                pass

    turns: list[dict[str, Any]] = []

    # Prefer exclusive turns for ASR merge (no overlap).
    annotation = (
        getattr(output, "exclusive_speaker_diarization", None)
        or getattr(output, "speaker_diarization", None)
        or output
    )
    for turn, _, speaker in annotation.itertracks(yield_label=True):
        start = float(turn.start)
        end = float(turn.end)
        if end <= start:
            continue
        turns.append(
            {
                "start": start,
                "end": end,
                "speaker": str(speaker),
            }
        )

    turns.sort(key=lambda item: item["start"])
    speakers = sorted({turn["speaker"] for turn in turns})
    emit(
        {
            "ok": True,
            "model": args.model,
            "speakers": speakers,
            "turns": turns,
        }
    )


if __name__ == "__main__":
    main()
