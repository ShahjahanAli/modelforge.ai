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
import tempfile
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Iterator

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


def strip_replacement_chars(text: str) -> str:
    return (text or "").replace("\ufffd", "").replace("�", "").strip()


def uses_lenient_hallucination_filter(
    start_sec: float,
    end_sec: float,
    *,
    compact_len: int,
) -> bool:
    """Opening audio and mis-timestamped full-file blobs need a light touch."""
    if start_sec <= 35.0:
        return True
    # Whisper sometimes collapses minutes of speech into a sub-second span at t≈0.
    if start_sec < 5.0 and (end_sec - start_sec) < 3.0 and compact_len > 80:
        return True
    return False


def is_hallucinated_text(
    text: str,
    *,
    start_sec: float = 0.0,
    end_sec: float | None = None,
) -> bool:
    """Detect Whisper loop / compression-ratio style garbage.

    Segments in the first ~35s use a lenient gate — strict n-gram rules were
    dropping the only full-file segment (entire call in one Whisper span).
    """
    clean = strip_replacement_chars(text)
    if not clean:
        return True
    compact = re.sub(r"\s+", "", clean)
    end = end_sec if end_sec is not None else start_sec
    if uses_lenient_hallucination_filter(start_sec, end, compact_len=len(compact)):
        # Opening / full-file blob: only reject obvious binary loops.
        if len(compact) > 200:
            unique = len(set(compact))
            if unique <= 4:
                return True
        return False
    if len(compact) > 80:
        unique = len(set(compact))
        if unique <= 6:
            return True
    if len(compact) >= 12:
        for n in (2, 3, 4):
            if len(compact) < n * 6:
                continue
            counts: dict[str, int] = {}
            for i in range(0, len(compact) - n + 1):
                gram = compact[i : i + n]
                counts[gram] = counts.get(gram, 0) + 1
            if not counts:
                continue
            top = max(counts.values())
            if top >= max(10, (len(compact) // n) * 0.5):
                return True
    return False


def sanitize_segment_text(
    text: str,
    *,
    start_sec: float = 0.0,
    end_sec: float | None = None,
) -> str | None:
    clean = strip_replacement_chars(text)
    if not clean or is_hallucinated_text(clean, start_sec=start_sec, end_sec=end_sec):
        return None
    return clean


def probe_duration_sec(audio: str) -> float | None:
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        return None
    try:
        proc = subprocess.run(
            [
                ffprobe,
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                audio,
            ],
            capture_output=True,
            text=True,
            check=True,
        )
        value = float(proc.stdout.strip())
        return value if math.isfinite(value) and value > 0 else None
    except (subprocess.CalledProcessError, ValueError, OSError):
        return None


def extract_wav_chunk(src: str, start_sec: float, duration_sec: float, dest: Path) -> None:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg is required for chunked ASR")
    # Accurate seek: -ss after -i (first chunk skips -ss entirely).
    cmd = [
        ffmpeg,
        "-y",
        "-i",
        src,
    ]
    if start_sec > 0.05:
        cmd.extend(["-ss", str(max(0.0, start_sec))])
    cmd.extend(
        [
            "-t",
            str(max(0.1, duration_sec)),
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            str(dest),
        ]
    )
    proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if proc.returncode != 0 or not dest.is_file() or dest.stat().st_size < 44:
        err = (proc.stderr or proc.stdout or "").strip()[-500:]
        raise RuntimeError(f"ffmpeg chunk extract failed: {err}")


def repair_segment_timestamps(
    segments: list[dict[str, Any]],
    duration_sec: float | None,
) -> list[dict[str, Any]]:
    """Expand collapsed Whisper spans so UI timestamps cover the spoken audio."""
    if not segments:
        return segments
    duration = float(duration_sec or segments[-1].get("end") or 0.0)
    repaired: list[dict[str, Any]] = []
    for i, seg in enumerate(segments):
        start = float(seg["start"])
        end = float(seg["end"])
        text = str(seg.get("text") or "")
        compact = len(re.sub(r"\s+", "", text))
        next_start = float(segments[i + 1]["start"]) if i + 1 < len(segments) else duration
        if (end - start) < 3.0 and compact > 60:
            end = next_start if next_start > start else min(duration, start + max(3.0, compact / 12.0))
        if i + 1 < len(segments) and next_start - end > 2.0:
            end = next_start
        if end <= start and duration > start:
            end = duration
        if duration > 0:
            end = min(end, duration)
        repaired.append({**seg, "start": start, "end": max(end, start)})
    return repaired


def transcribe_long_audio(
    model: WhisperModel,
    audio: str,
    args: argparse.Namespace,
) -> tuple[Iterator[Any], Any]:
    """Split long calls into ~26s windows — avoids Whisper dropping the middle."""
    duration = probe_duration_sec(audio)
    threshold = float(getattr(args, "chunk_threshold_sec", 35.0))
    chunk_sec = float(getattr(args, "chunk_sec", 26.0))
    if duration is None or duration <= threshold:
        return transcribe_audio(model, audio, args)

    tmpdir = Path(tempfile.mkdtemp(prefix="mf-stt-chunks-"))
    merged: list[Any] = []
    info = None
    offset = 0.0
    try:
        while offset < duration - 0.05:
            this_dur = min(chunk_sec, duration - offset)
            chunk_path = tmpdir / f"chunk_{int(offset * 1000)}.wav"
            extract_wav_chunk(audio, offset, this_dur, chunk_path)
            chunk_end = offset + this_dur
            segs, info = transcribe_audio(model, str(chunk_path), args)
            for seg in segs:
                seg_start = float(seg.start) + offset
                seg_end = float(seg.end) + offset
                if seg_end <= seg_start:
                    seg_end = chunk_end
                merged.append(
                    SimpleNamespace(
                        start=seg_start,
                        end=seg_end,
                        text=seg.text,
                        avg_logprob=seg.avg_logprob,
                    )
                )
            offset += chunk_sec
        print(
            json.dumps(
                {
                    "event": "voice.stt.chunked",
                    "duration_sec": duration,
                    "chunks": math.ceil(duration / chunk_sec),
                    "segments": len(merged),
                },
                ensure_ascii=False,
            ),
            file=sys.stderr,
        )
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)

    merged.sort(key=lambda seg: float(seg.start))

    def iter_segments() -> Iterator[Any]:
        for seg in merged:
            yield seg

    chunk_info = SimpleNamespace(
        language=getattr(info, "language", None) if info is not None else None,
        duration=duration,
    )
    return iter_segments(), chunk_info


def transcribe_audio(model: WhisperModel, audio: str, args: argparse.Namespace):
    language = resolve_transcribe_language(args.model, args.language)
    kwargs: dict[str, Any] = {
        "beam_size": args.beam_size,
        "best_of": args.best_of,
        "temperature": args.temperature,
        "no_speech_threshold": args.no_speech_threshold,
        "vad_filter": args.vad_filter,
        "condition_on_previous_text": args.condition_on_previous_text,
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
    parser.add_argument(
        "--no-speech-threshold",
        type=float,
        default=0.35,
        help="Lower = keep quiet/opening speech (default 0.35; was 0.6)",
    )
    parser.add_argument("--compression-ratio-threshold", type=float, default=2.4)
    parser.add_argument("--log-prob-threshold", type=float, default=-1.0)
    parser.add_argument(
        "--vad-filter",
        action=argparse.BooleanOptionalAction,
        default=False,
        help="Silero VAD can skip the first ~20s of phone audio — default off",
    )
    parser.add_argument(
        "--condition-on-previous-text",
        action=argparse.BooleanOptionalAction,
        default=False,
        help="Off by default — Bengali CT2 can emit one mis-timestamped blob if on",
    )
    parser.add_argument("--language", default=None)
    parser.add_argument(
        "--initial-prompt",
        default=None,
        help="Optional Whisper initial_prompt to bias toward known names/jargon",
    )
    parser.add_argument(
        "--chunk-threshold-sec",
        type=float,
        default=35.0,
        help="Chunk audio longer than this (seconds) for fuller coverage",
    )
    parser.add_argument(
        "--chunk-sec",
        type=float,
        default=26.0,
        help="Chunk window size when chunking long audio",
    )
    parser.add_argument(
        "--no-chunk",
        action="store_true",
        help="Disable automatic chunking for long audio",
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
    if args.no_chunk:
        segments, info = transcribe_audio(model, args.audio, args)
    else:
        segments, info = transcribe_long_audio(model, args.audio, args)
    text_parts: list[str] = []
    payload_segments: list[dict[str, Any]] = []
    dropped_segments: list[dict[str, Any]] = []
    probs: list[float] = []

    raw_segments: list[Any] = []
    for segment in segments:
        raw_segments.append(segment)
        start = float(segment.start)
        end = float(segment.end)
        raw_text = segment.text or ""
        clean_text = sanitize_segment_text(raw_text, start_sec=start, end_sec=end)
        if not clean_text:
            dropped_segments.append(
                {
                    "start": start,
                    "end": end,
                    "text_preview": raw_text.strip()[:200],
                    "reason": "hallucination_filter",
                }
            )
            continue
        text_parts.append(clean_text)
        if segment.avg_logprob is not None and math.isfinite(segment.avg_logprob):
            probs.append(float(math.exp(segment.avg_logprob)))
        payload_segments.append(
            {
                "start": start,
                "end": end,
                "text": clean_text,
                "avg_logprob": float(segment.avg_logprob) if segment.avg_logprob is not None else None,
            }
        )

    # Never return empty when Whisper produced substantive text.
    if not payload_segments and raw_segments:
        best = max(raw_segments, key=lambda s: len((s.text or "").strip()))
        raw_text = strip_replacement_chars((best.text or "").strip())
        if len(raw_text) >= 8:
            print(
                json.dumps(
                    {
                        "event": "voice.stt.filter_fallback",
                        "reason": "all_segments_filtered",
                        "kept_chars": len(raw_text),
                    },
                    ensure_ascii=False,
                ),
                file=sys.stderr,
            )
            text_parts = [raw_text]
            payload_segments.append(
                {
                    "start": float(best.start),
                    "end": float(best.end),
                    "text": raw_text,
                    "avg_logprob": float(best.avg_logprob) if best.avg_logprob is not None else None,
                }
            )
            if best.avg_logprob is not None and math.isfinite(best.avg_logprob):
                probs.append(float(math.exp(best.avg_logprob)))

    if dropped_segments:
        print(
            json.dumps(
                {
                    "event": "voice.stt.dropped_segments",
                    "count": len(dropped_segments),
                    "drops": dropped_segments[:20],
                },
                ensure_ascii=False,
            ),
            file=sys.stderr,
        )

    duration_sec = probe_duration_sec(args.audio) or float(getattr(info, "duration", 0) or 0) or None
    payload_segments = repair_segment_timestamps(payload_segments, duration_sec)

    first_start = payload_segments[0]["start"] if payload_segments else None
    confidence = (sum(probs) / len(probs)) if probs else None
    emit(
        {
            "language": info.language or args.language or "unknown",
            "text": " ".join(seg["text"] for seg in payload_segments).strip(),
            "confidence": confidence,
            "segments": payload_segments,
            "first_segment_start_sec": first_start,
            "dropped_segment_count": len(dropped_segments),
            "duration_sec": duration_sec,
            "hallucination_filtered": True,
        }
    )


if __name__ == "__main__":
    main()
