import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const audio = path.join(
  root,
  "data/audio/1787493309908-e3e8b5ec-e61a-44d7-ba9b-5e76695a3265-1787493309253-9c2da14a-5a8e-495f-b4b8-8342a6b1207d-Arnob_Call_Record_20260823_trim_0-51200ms.wav",
);
const script = path.join(root, "scripts/faster-whisper-transcribe.py");
const py = process.env.STT_PYTHON_BIN ?? "python3";
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

async function run(label, options) {
  const { stdout } = await execFileAsync(py, args, {
    maxBuffer: 10 * 1024 * 1024,
    ...options,
  });
  const j = JSON.parse(stdout.split(/\r?\n/).filter(Boolean).at(-1) ?? "{}");
  console.log(
    JSON.stringify({
      label,
      len: j.text?.length ?? 0,
      seg0: j.segments?.[0]?.text?.length ?? 0,
      seg1: j.segments?.[1]?.text?.length ?? 0,
    }),
  );
}

await run("default-node-env", {
  env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
});
await run("inherit-env-no-pythonutf8", { env: process.env });
await run("cwd-root", {
  cwd: root,
  env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
});
await run("minimal-env", {
  cwd: root,
  env: {
    Path: process.env.Path ?? process.env.PATH ?? "",
    SYSTEMROOT: process.env.SYSTEMROOT,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
  },
});

const noChunkArgs = [...args, "--no-chunk"];
async function runNoChunk(label, options) {
  const { stdout } = await execFileAsync(py, noChunkArgs, {
    maxBuffer: 10 * 1024 * 1024,
    ...options,
  });
  const j = JSON.parse(stdout.split(/\r?\n/).filter(Boolean).at(-1) ?? "{}");
  console.log(JSON.stringify({ label, len: j.text?.length ?? 0 }));
}
await runNoChunk("no-chunk-node", { cwd: root, env: process.env });
