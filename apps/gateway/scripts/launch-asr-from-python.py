import subprocess
import sys
import json

py = sys.executable
root = r"D:/_Development/X. Project _X/78. ModelForge - LLM Runtime Platform/Development/modelforge.ai"
script = root + "/scripts/faster-whisper-transcribe.py"
audio = root + "/data/audio/1787493309908-e3e8b5ec-e61a-44d7-ba9b-5e76695a3265-1787493309253-9c2da14a-5a8e-495f-b4b8-8342a6b1207d-Arnob_Call_Record_20260823_trim_0-51200ms.wav"
args = [
    script,
    "--audio",
    audio,
    "--model",
    "bengaliAI/tugstugi_bengaliai-regional-asr_whisper-medium",
    "--device",
    "cpu",
    "--compute-type",
    "int8",
    "--beam-size",
    "5",
    "--best-of",
    "5",
    "--temperature",
    "0",
    "--no-speech-threshold",
    "0.35",
    "--no-vad-filter",
    "--language",
    "bn",
]
proc = subprocess.run([py, *args], capture_output=True, text=True, encoding="utf-8")
line = [ln for ln in proc.stdout.splitlines() if ln.strip()][-1]
data = json.loads(line)
print(json.dumps({"parent": "python", "len": len(data.get("text") or ""), "stderr_bytes": len(proc.stderr or "")}))
