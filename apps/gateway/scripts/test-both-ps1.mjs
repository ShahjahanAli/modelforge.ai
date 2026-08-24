import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));

for (const name of ["invoke-faster-whisper.ps1", "test-wrapper.ps1"]) {
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(here, name)],
    { maxBuffer: 20 * 1024 * 1024 },
  );
  const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "{}";
  const parsed = JSON.parse(line);
  console.log(name, parsed.text?.length ?? 0, "stdoutBytes", Buffer.byteLength(stdout));
}
