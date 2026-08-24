#!/usr/bin/env python3
"""Call Hugging Face Space bengaliAI regional ASR on a local audio file."""

from __future__ import annotations

import json
import os
import sys
import time
import uuid
from pathlib import Path

import urllib.error
import urllib.request

SPACE = "https://bengaliai-regional-bengali-asr-tugstugi-whisper-medium.hf.space"
FN_INDEX = 0  # /transcribe


def load_hf_token() -> str:
    token = (os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN") or "").strip()
    if token:
        return token
    env_path = Path(__file__).resolve().parents[3] / ".env"
    if env_path.is_file():
        for line in env_path.read_text(encoding="utf-8").splitlines():
            if line.startswith("HF_TOKEN="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit("HF_TOKEN missing")


def http_json(method: str, url: str, *, token: str, data: bytes | None = None, headers: dict | None = None):
    req_headers = {"Authorization": f"Bearer {token}", **(headers or {})}
    req = urllib.request.Request(url, data=data, method=method, headers=req_headers)
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            body = resp.read()
            ctype = resp.headers.get("content-type", "")
            if "application/json" in ctype or body[:1] in (b"{", b"["):
                return json.loads(body.decode("utf-8"))
            return body
    except urllib.error.HTTPError as exc:
        err = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"{method} {url} -> {exc.code}: {err[:800]}") from exc


def upload_file(audio: Path, token: str) -> dict:
    boundary = f"----mf{uuid.uuid4().hex}"
    file_bytes = audio.read_bytes()
    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="files"; filename="{audio.name}"\r\n'
        f"Content-Type: audio/wav\r\n\r\n"
    ).encode("utf-8") + file_bytes + f"\r\n--{boundary}--\r\n".encode("utf-8")
    result = http_json(
        "POST",
        f"{SPACE}/gradio_api/upload",
        token=token,
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    if isinstance(result, list) and result:
        path = result[0]
    elif isinstance(result, dict) and "path" in result:
        path = result["path"]
    else:
        raise RuntimeError(f"Unexpected upload response: {result!r}")
    return {
        "path": path,
        "meta": {"_type": "gradio.FileData"},
        "orig_name": audio.name,
        "mime_type": "audio/wav",
        "size": len(file_bytes),
    }


def transcribe(audio: Path) -> str:
    token = load_hf_token()
    session_hash = uuid.uuid4().hex
    file_data = upload_file(audio, token)
    print(json.dumps({"event": "uploaded", "path": file_data["path"], "bytes": file_data["size"]}), flush=True)

    join = http_json(
        "POST",
        f"{SPACE}/gradio_api/queue/join",
        token=token,
        data=json.dumps(
            {
                "data": [file_data],
                "fn_index": FN_INDEX,
                "session_hash": session_hash,
            }
        ).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    print(json.dumps({"event": "queued", "join": join}), flush=True)

    # Stream SSE until process_completed
    req = urllib.request.Request(
        f"{SPACE}/gradio_api/queue/data?session_hash={session_hash}",
        headers={"Authorization": f"Bearer {token}", "Accept": "text/event-stream"},
        method="GET",
    )
    text = ""
    with urllib.request.urlopen(req, timeout=600) as resp:
        for raw in resp:
            line = raw.decode("utf-8", errors="replace").strip()
            if not line.startswith("data:"):
                continue
            payload = line[5:].strip()
            if not payload:
                continue
            try:
                event = json.loads(payload)
            except json.JSONDecodeError:
                continue
            msg = event.get("msg")
            if msg:
                print(json.dumps({"event": msg, "rank": event.get("rank"), "queue_size": event.get("queue_size")}), flush=True)
            if msg == "process_completed":
                output = event.get("output") or {}
                data = output.get("data") or []
                text = str(data[0] if data else "")
                break
            if msg in {"process_generating", "estimation"}:
                continue
            if msg == "close_stream":
                break
    return text


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit("usage: call-hf-space-asr.py <audio.wav>")
    audio = Path(sys.argv[1])
    if not audio.is_file():
        raise SystemExit(f"audio not found: {audio}")
    started = time.time()
    text = transcribe(audio)
    print(
        json.dumps(
            {
                "provider": "hf-space",
                "space": "bengaliAI/regional_bengali-asr_tugstugi_whisper-medium",
                "len": len(text),
                "elapsed_sec": round(time.time() - started, 1),
                "text": text,
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
