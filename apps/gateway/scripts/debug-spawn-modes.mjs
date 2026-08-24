import { exec, execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const py =
  process.env.STT_PYTHON_BIN ??
  "C:/Users/admin/AppData/Local/Programs/Python/Python311/python.exe";
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const script = path.join(root, "scripts/faster-whisper-transcribe.py");
const audio = path.join(
  root,
  "data/audio/1787493309908-e3e8b5ec-e61a-44d7-ba9b-5e76695a3265-1787493309253-9c2da14a-5a8e-495f-b4b8-8342a6b1207d-Arnob_Call_Record_20260823_trim_0-51200ms.wav",
);
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

function parse(stdout) {
  return JSON.parse(stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "{}");
}

const { stdout: efOut } = await execFileAsync(py, args, {
  maxBuffer: 20 * 1024 * 1024,
  cwd: root,
  env: process.env,
});
console.log("execFile", parse(efOut).text?.length ?? 0);

const shellLine = [py, ...args].map((part) => `"${part}"`).join(" ");
const shellOut = await new Promise((resolve, reject) => {
  const child = spawn(shellLine, {
    shell: true,
    cwd: root,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (chunk) => {
    out += chunk;
  });
  child.on("error", reject);
  child.on("close", (code) => {
    if (code !== 0) reject(new Error(`shell exit ${code}`));
    else resolve(out);
  });
});
console.log("shell spawn", parse(shellOut).text?.length ?? 0);

const psCommand = `& '${py.replace(/'/g, "''")}' '${script.replace(/'/g, "''")}' --audio '${audio.replace(/'/g, "''")}' --model bengaliAI/tugstugi_bengaliai-regional-asr_whisper-medium --device cpu --compute-type int8 --beam-size 5 --best-of 5 --temperature 0 --no-speech-threshold 0.35 --no-vad-filter --language bn`;
const { stdout: psOut } = await execAsync(
  `powershell -NoProfile -Command ${JSON.stringify(psCommand)}`,
  { cwd: root, maxBuffer: 20 * 1024 * 1024 },
);
console.log("powershell exec", parse(psOut).text?.length ?? 0);
