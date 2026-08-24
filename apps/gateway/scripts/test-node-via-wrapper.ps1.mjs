import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));

const { stdout } = await execFileAsync(
  "powershell.exe",
  ["-NoProfile", "-File", path.join(here, "test-wrapper.ps1")],
  { maxBuffer: 20 * 1024 * 1024 },
);
console.log(stdout.trim());

const { stdout: stdout2 } = await execFileAsync(
  "powershell.exe",
  ["-NoProfile", "-File", path.join(here, "test-asr-fresh.ps1")],
  { maxBuffer: 20 * 1024 * 1024 },
);
console.log(stdout2.trim());
