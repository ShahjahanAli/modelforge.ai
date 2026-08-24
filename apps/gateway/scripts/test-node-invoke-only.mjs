import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const gatewayRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requestFile = path.join(gatewayRoot, "scripts", ".mf-stt-request.json");
const invoke = path.join(gatewayRoot, "scripts", "invoke-faster-whisper.ps1");
const repoRoot = path.resolve(gatewayRoot, "../..");

await fs.writeFile(
  requestFile,
  JSON.stringify({
    pythonBin: "C:/Users/admin/AppData/Local/Programs/Python/Python311/python.exe",
    audioRelativePath:
      "data/audio/1787493309908-e3e8b5ec-e61a-44d7-ba9b-5e76695a3265-1787493309253-9c2da14a-5a8e-495f-b4b8-8342a6b1207d-Arnob_Call_Record_20260823_trim_0-51200ms.wav",
    model: "bengaliAI/tugstugi_bengaliai-regional-asr_whisper-medium",
    device: "cpu",
    computeType: "int8",
    beamSize: 5,
    bestOf: 5,
    temperature: 0,
    noSpeechThreshold: 0.35,
    language: "bn",
    initialPrompt: "",
    noVadFilter: true,
    conditionOnPreviousText: false,
  }),
  "utf8",
);

const { stdout } = await execFileAsync(
  "powershell.exe",
  ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", invoke],
  { maxBuffer: 20 * 1024 * 1024, cwd: repoRoot },
);
const len = JSON.parse(stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "{}").text?.length ?? 0;
console.log("node-direct-invoke len", len);
