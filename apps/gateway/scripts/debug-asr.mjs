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

for (let i = 0; i < 3; i += 1) {
  const { stdout, stderr } = await execFileAsync(
    py,
    [
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
    ],
    {
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
    },
  );
  const lines = stdout.split(/\r?\n/).filter(Boolean);
  const line = lines.at(-1) ?? "";
  const j = JSON.parse(line);
  console.log(
    JSON.stringify({
      run: i,
      stdoutLines: lines.length,
      stdoutBytes: Buffer.byteLength(stdout, "utf8"),
      stderrBytes: Buffer.byteLength(stderr ?? "", "utf8"),
      len: j.text.length,
      segs: j.segments.length,
      open: j.text.slice(0, 80),
      seg0len: j.segments[0]?.text?.length,
      seg1len: j.segments[1]?.text?.length,
    }),
  );
}
