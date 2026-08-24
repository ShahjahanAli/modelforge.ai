import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const py = "C:/Users/admin/AppData/Local/Programs/Python/Python311/python.exe";
const script = path.join(root, "scripts/faster-whisper-transcribe.py");
const launcher = path.join(root, "scripts/launch-faster-whisper-from-node.ps1");

const { stdout: argsFileOut } = await execFileAsync(
  "powershell.exe",
  ["-NoProfile", "-File", path.join(here, "write-ps-args.ps1")],
  { maxBuffer: 1024 * 1024 },
);
const argsFile = argsFileOut.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
console.log("argsFile", argsFile);

const { stdout } = await execFileAsync(
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
  { maxBuffer: 20 * 1024 * 1024 },
);
const parsed = JSON.parse(stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "{}");
console.log("PS-generated args via launcher len", parsed.text?.length ?? 0);
