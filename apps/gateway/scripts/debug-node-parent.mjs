import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

async function viaExecFile() {
  const { stdout } = await execFileAsync(py, args, {
    maxBuffer: 20 * 1024 * 1024,
    cwd: root,
    env: process.env,
  });
  return parse(stdout).text?.length ?? 0;
}

async function viaCmdRedirect() {
  const out = path.join(os.tmpdir(), `mf-asr-${Date.now()}.json`);
  const cmdArgs = ["/c", py, ...args, ">", out];
  await new Promise((resolve, reject) => {
    const child = spawn("cmd.exe", cmdArgs, {
      cwd: root,
      env: process.env,
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`cmd ${code}`))));
  });
  const stdout = await fs.readFile(out, "utf8");
  await fs.unlink(out).catch(() => {});
  return parse(stdout).text?.length ?? 0;
}

async function viaDetachedTempScript() {
  const out = path.join(os.tmpdir(), `mf-asr-${Date.now()}.json`);
  const bat = path.join(os.tmpdir(), `mf-asr-${Date.now()}.bat`);
  const quoted = (value) => `"${value.replace(/"/g, '""')}"`;
  const line = [quoted(py), ...args.map(quoted)].join(" ");
  await fs.writeFile(bat, `@echo off\r\n${line} > ${quoted(out)} 2>nul\r\n`, "utf8");
  await new Promise((resolve, reject) => {
    const child = spawn("cmd.exe", ["/c", bat], {
      cwd: root,
      env: process.env,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`bat ${code}`))));
  });
  const stdout = await fs.readFile(out, "utf8");
  await fs.unlink(out).catch(() => {});
  await fs.unlink(bat).catch(() => {});
  return parse(stdout).text?.length ?? 0;
}

async function viaFilteredEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      key.startsWith("NODE_") ||
      key.startsWith("CURSOR_") ||
      key.startsWith("VSCODE_") ||
      key === "npm_config_cache"
    ) {
      delete env[key];
    }
  }
  env.PYTHONUTF8 = "1";
  env.PYTHONIOENCODING = "utf-8";
  env.OMP_NUM_THREADS = "6";
  const { stdout } = await execFileAsync(py, args, {
    maxBuffer: 20 * 1024 * 1024,
    cwd: root,
    env,
  });
  return parse(stdout).text?.length ?? 0;
}

console.log("execFile", await viaExecFile());
console.log("cmd redirect", await viaCmdRedirect());
console.log("detached bat", await viaDetachedTempScript());
console.log("filtered env", await viaFilteredEnv());
