#!/usr/bin/env python3
"""
NeMo ASR CLI for ModelForge (Bangla Conformer-CTC and other HF NeMo ASR repos).

Modes:
  default   --audio ...  transcribe (resamples to 16 kHz mono when needed)
  --preload              download/warm a Hugging Face NeMo ASR model
  --check-local          report whether hub weights are cached
  --check-nemo           report whether nemo_toolkit[asr] imports
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

KNOWN_MODELS = (
    {
        "id": "kazalbrur/bangla-stt-conformer-120m-dialects",
        "label": "Bhatiyali (Bangla dialects 120M)",
        "approxDownloadGb": 0.5,
    },
)


def emit(payload: dict[str, Any]) -> None:
    output = json.dumps(payload, ensure_ascii=False)
    sys.stdout.buffer.write(output.encode("utf-8"))
    sys.stdout.buffer.write(b"\n")
    sys.stdout.flush()


def hub_cache_dir(repo_id: str) -> Path:
    home = Path(os.environ.get("HF_HOME", Path.home() / ".cache" / "huggingface"))
    dirname = "models--" + repo_id.replace("/", "--")
    return home / "hub" / dirname


def is_model_cached(repo_id: str) -> bool:
    snapshots = hub_cache_dir(repo_id) / "snapshots"
    if not snapshots.is_dir():
        return False
    for snap in snapshots.iterdir():
        if not snap.is_dir():
            continue
        # NeMo packs vary: .nemo archive, config + weights, or safetensors.
        names = {p.name.lower() for p in snap.iterdir() if p.is_file()}
        if any(name.endswith(".nemo") for name in names):
            return True
        if "model_config.yaml" in names or "config.json" in names:
            if any(
                name.endswith(ext)
                for name in names
                for ext in (".ckpt", ".pt", ".bin", ".safetensors", ".nemo")
            ):
                return True
        # Snapshot present with substantial payload is enough for "downloaded".
        if any(p.stat().st_size > 1_000_000 for p in snap.rglob("*") if p.is_file()):
            return True
    return False


def ensure_16k_mono_wav(src: str) -> tuple[str, bool]:
    """Return (path, is_temp). Prefer ffmpeg; fall back to torchaudio."""
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg:
        tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        tmp.close()
        subprocess.run(
            [
                ffmpeg,
                "-y",
                "-i",
                src,
                "-ac",
                "1",
                "-ar",
                "16000",
                "-sample_fmt",
                "s16",
                tmp.name,
            ],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return tmp.name, True

    try:
        import torchaudio  # type: ignore
    except Exception as error:  # noqa: BLE001
        raise RuntimeError(
            "Need ffmpeg on PATH or torchaudio to resample audio to 16 kHz mono"
        ) from error

    waveform, sample_rate = torchaudio.load(src)
    if waveform.shape[0] > 1:
        waveform = waveform.mean(dim=0, keepdim=True)
    if sample_rate != 16000:
        waveform = torchaudio.functional.resample(waveform, sample_rate, 16000)
    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    tmp.close()
    torchaudio.save(tmp.name, waveform, 16000)
    return tmp.name, True


def load_model(repo_id: str, map_location: str):
    import nemo.collections.asr as nemo_asr  # type: ignore

    model = nemo_asr.models.ASRModel.from_pretrained(model_name=repo_id)
    model.eval()
    try:
        import torch

        device = torch.device(map_location if map_location in ("cpu", "cuda") else "cpu")
        if device.type == "cuda" and not torch.cuda.is_available():
            device = torch.device("cpu")
        model = model.to(device)
    except Exception:
        pass
    return model


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", default=None)
    parser.add_argument(
        "--model",
        default="kazalbrur/bangla-stt-conformer-120m-dialects",
    )
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--preload", action="store_true")
    parser.add_argument("--check-local", action="store_true")
    parser.add_argument("--check-nemo", action="store_true")
    parser.add_argument("--list-known", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    if args.list_known:
        emit({"models": KNOWN_MODELS})
        return

    if args.check_nemo:
        try:
            import nemo.collections.asr as nemo_asr  # noqa: F401

            emit(
                {
                    "ok": True,
                    "nemoAvailable": True,
                    "executable": sys.executable,
                    "version": sys.version.split()[0],
                }
            )
        except Exception as error:  # noqa: BLE001
            emit(
                {
                    "ok": False,
                    "nemoAvailable": False,
                    "error": str(error),
                    "executable": sys.executable,
                    "version": sys.version.split()[0],
                }
            )
        return

    if args.check_local:
        emit(
            {
                "ok": True,
                "cached": is_model_cached(args.model),
                "model": args.model,
            }
        )
        return

    if args.preload:
        load_model(args.model, args.device)
        emit({"ok": True, "cached": True, "model": args.model, "preloaded": True})
        return

    if not args.audio:
        emit({"ok": False, "error": "--audio is required unless --preload/--check-local/--check-nemo"})
        sys.exit(2)

    wav_path, is_temp = ensure_16k_mono_wav(args.audio)
    try:
        model = load_model(args.model, args.device)
        results = model.transcribe([wav_path])
        text = ""
        if results:
            first = results[0]
            text = getattr(first, "text", None) or (first if isinstance(first, str) else str(first))
            text = (text or "").strip()
        emit(
            {
                "language": "bn",
                "text": text,
                "confidence": None,
                "segments": (
                    [{"start": 0.0, "end": 0.0, "text": text, "avg_logprob": None}] if text else []
                ),
            }
        )
    finally:
        if is_temp:
            try:
                os.unlink(wav_path)
            except OSError:
                pass


if __name__ == "__main__":
    main()
