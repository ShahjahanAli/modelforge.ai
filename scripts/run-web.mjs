/**
 * Starts the Next.js control plane on WEB_PORT (default 9001).
 * Usage: node scripts/run-web.mjs [dev|start]
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const mode = process.argv[2] === "start" ? "start" : "dev";
const port = String(Number(process.env.WEB_PORT) || 9001);
const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../apps/web");
const require = createRequire(path.join(webDir, "package.json"));
const nextBin = require.resolve("next/dist/bin/next");

console.log(`[web] next ${mode} on :${port}`);

const child = spawn(process.execPath, [nextBin, mode, "-p", port, "-H", "0.0.0.0"], {
  cwd: webDir,
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    child.kill(signal);
  });
}
