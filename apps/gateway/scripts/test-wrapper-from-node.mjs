import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const py = "C:/Users/admin/AppData/Local/Programs/Python/Python311/python.exe";
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const script = path.join(root, "scripts/faster-whisper-transcribe.py");
const launcher = path.join(root, "scripts/launch-faster-whisper-from-node.ps1");
const audio = path.join(
  root,
  "data/audio/1787493309908-e3e8b5ec-e61a-44d7-ba9b-5e76695a3265-1787493309253-9c2da14a-5a8e-495f-b4b8-8342a6b1207d-Arnob_Call_Record_20260823_trim_0-51200ms.wav",
);
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
const argumentsJson = JSON.stringify(args.map((arg) => arg.replace(/\\/g, "/")));
const argsFile = path.join(os.tmpdir(), `mf-stt-args-${randomUUID()}.json`);
await fs.writeFile(argsFile, argumentsJson, "utf8");
console.log("argumentsJson sample", argumentsJson.slice(0, 120));

const { stdout, stderr } = await execFileAsync(
  "powershell.exe",
  [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    launcher.replace(/\\/g, "/"),
    "-PythonBin",
    py,
    "-ScriptPath",
    script.replace(/\\/g, "/"),
    "-ArgumentsFile",
    argsFile.replace(/\\/g, "/"),
  ],
  { maxBuffer: 20 * 1024 * 1024, env: { ...process.env, PYTHONUTF8: "1" } },
);
await fs.unlink(argsFile).catch(() => {});

if (stderr?.trim()) console.log("stderr", stderr.slice(0, 200));
const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "{}";
const parsed = JSON.parse(line);
console.log("node->wrapper->python len", parsed.text?.length ?? 0);
