import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const psScript = path.join(here, "test-asr-fresh.ps1");

async function viaNodeExecFilePy() {
  const py = "C:/Users/admin/AppData/Local/Programs/Python/Python311/python.exe";
  const root = path.resolve(here, "../../..");
  const audio = path.join(
    root,
    "data/audio/1787493309908-e3e8b5ec-e61a-44d7-ba9b-5e76695a3265-1787493309253-9c2da14a-5a8e-495f-b4b8-8342a6b1207d-Arnob_Call_Record_20260823_trim_0-51200ms.wav",
  );
  const script = path.join(root, "scripts/faster-whisper-transcribe.py");
  const args = [
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
  ];
  const { stdout } = await execFileAsync(py, args, {
    maxBuffer: 20 * 1024 * 1024,
    cwd: root,
    env: process.env,
  });
  const parsed = JSON.parse(stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "{}");
  return parsed.text?.length ?? 0;
}

async function viaPowerShellScript() {
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-File", psScript],
    { maxBuffer: 20 * 1024 * 1024 },
  );
  const match = stdout.match(/len=(\d+)/);
  return match ? Number(match[1]) : 0;
}

async function viaPowerShellScriptSpawn() {
  const out = await new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-File", psScript], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let data = "";
    child.stdout.on("data", (chunk) => {
      data += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`ps exit ${code}`));
      else resolve(data);
    });
  });
  const match = out.match(/len=(\d+)/);
  return match ? Number(match[1]) : 0;
}

console.log("node->python", await viaNodeExecFilePy());
console.log("node->ps execFile", await viaPowerShellScript());
console.log("node->ps spawn", await viaPowerShellScriptSpawn());
