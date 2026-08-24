import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));

for (const name of ["debug-generated.ps1", "test-asr-fresh.ps1"]) {
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-File", path.join(here, name)],
    { maxBuffer: 20 * 1024 * 1024 },
  );
  if (name.includes("debug")) {
    const len = JSON.parse(stdout.trim().split(/\r?\n/).at(-1) ?? "{}").text?.length ?? 0;
    console.log("node", name, len);
  } else {
    const m = stdout.match(/len=(\d+)/);
    console.log("node", name, m?.[1] ?? "?");
  }
}
