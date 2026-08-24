import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const invoke = path.join(here, "invoke-faster-whisper.ps1");
const py = "C:/Users/admin/AppData/Local/Programs/Python/Python311/python.exe";
const rel = "data/audio/1787493309908-e3e8b5ec-e61a-44d7-ba9b-5e76695a3265-1787493309253-9c2da14a-5a8e-495f-b4b8-8342a6b1207d-Arnob_Call_Record_20260823_trim_0-51200ms.wav";

const { stdout } = await execFileAsync(
  "powershell.exe",
  [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    invoke,
    "-PythonBin",
    py,
    "-AudioRelativePath",
    rel,
    "-Model",
    "bengaliAI/tugstugi_bengaliai-regional-asr_whisper-medium",
    "-Device",
    "cpu",
    "-ComputeType",
    "int8",
    "-BeamSize",
    "5",
    "-BestOf",
    "5",
    "-Temperature",
    "0",
    "-NoSpeechThreshold",
    "0.35",
    "-Language",
    "bn",
    "-NoVadFilter",
  ],
  { maxBuffer: 20 * 1024 * 1024, cwd: root },
);
const parsed = JSON.parse(stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "{}");
console.log("invoke with repo cwd len", parsed.text?.length ?? 0);
