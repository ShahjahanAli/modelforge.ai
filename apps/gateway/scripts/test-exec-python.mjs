import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execPythonScript } from "../src/lib/voice/pythonExec.js";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const audio = path.join(
  root,
  "data/audio/1787493309908-e3e8b5ec-e61a-44d7-ba9b-5e76695a3265-1787493309253-9c2da14a-5a8e-495f-b4b8-8342a6b1207d-Arnob_Call_Record_20260823_trim_0-51200ms.wav",
);
const script = path.join(root, "scripts/faster-whisper-transcribe.py");
const py = "C:/Users/admin/AppData/Local/Programs/Python/Python311/python.exe";
const args = [
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
];

const { stdout } = await execPythonScript({ pythonBin: py, scriptPath: script, args });
const j = JSON.parse(stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "{}");
console.log("execPythonScript len", j.text?.length ?? 0);

const { stdout: psOut } = await execFileAsync(
  "powershell.exe",
  ["-NoProfile", "-File", path.join(here, "test-wrapper.ps1")],
  { maxBuffer: 20 * 1024 * 1024 },
);
console.log(psOut.trim());
