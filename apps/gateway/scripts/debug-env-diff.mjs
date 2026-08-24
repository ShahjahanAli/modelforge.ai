import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const py =
  process.env.STT_PYTHON_BIN ??
  "C:/Users/admin/AppData/Local/Programs/Python/Python311/python.exe";

const dumpScript = `
import json, os, shutil, sys
print(json.dumps({
  "ffmpeg": shutil.which("ffmpeg"),
  "ffprobe": shutil.which("ffprobe"),
  "cwd": os.getcwd(),
  "OMP_NUM_THREADS": os.environ.get("OMP_NUM_THREADS"),
  "MKL_NUM_THREADS": os.environ.get("MKL_NUM_THREADS"),
  "OPENBLAS_NUM_THREADS": os.environ.get("OPENBLAS_NUM_THREADS"),
  "CT2_USE_EXPERIMENTAL_CPU": os.environ.get("CT2_USE_EXPERIMENTAL_CPU"),
  "HF_HOME": os.environ.get("HF_HOME"),
  "PYTHONUTF8": os.environ.get("PYTHONUTF8"),
}, ensure_ascii=False))
`;

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");

async function dump(label, options) {
  const { stdout } = await execFileAsync(py, ["-c", dumpScript], options);
  console.log(label, stdout.trim());
}

await dump("node-full-env", {
  cwd: root,
  env: { ...process.env, PYTHONUTF8: "1" },
});

await dump("node-minimal-path", {
  cwd: root,
  env: {
    Path: process.env.Path ?? process.env.PATH ?? "",
    SYSTEMROOT: process.env.SYSTEMROOT,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    PYTHONUTF8: "1",
  },
});
