/**
 * Frees ModelForge service ports before starting so `pnpm dev` does not fail
 * with EADDRINUSE / "Another next dev server is already running".
 *
 * Ports come from the environment (loaded by dotenv-cli in package scripts):
 *   GATEWAY_PORT  — Express API gateway (default 9000)
 *   WEB_PORT      — Next.js control plane (default 9001)
 *   GRPC_PORT     — optional Rust inference engine (default 9002)
 *
 * Also frees legacy 3000/3001 and clears apps/web/.next lock metadata so an
 * old Next process started before the 9000-series migration cannot block boot.
 *
 * Pass explicit ports as CLI args to free only those, e.g.:
 *   node scripts/free-ports.mjs 9000 9001
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function parsePort(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback;
}

const fromArgs = process.argv
  .slice(2)
  .map((value) => Number(value))
  .filter((n) => Number.isInteger(n) && n > 0 && n < 65536);

const ports = fromArgs.length
  ? [...new Set(fromArgs)]
  : [
      parsePort(process.env.GATEWAY_PORT, 9000),
      parsePort(process.env.WEB_PORT, 9001),
      parsePort(process.env.GRPC_PORT, 9002),
      // Pre-migration defaults (still free so leftover Next/gateway cannot block)
      3000,
      3001,
    ];

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webNextDir = path.join(rootDir, "apps", "web", ".next");

function pidsListeningOnWindows(port) {
  let output = "";
  try {
    output = execFileSync("netstat", ["-ano", "-p", "tcp"], {
      encoding: "utf8",
      windowsHide: true,
    });
  } catch {
    return [];
  }

  const pids = new Set();
  for (const line of output.split(/\r?\n/)) {
    if (!/\bLISTENING\b/i.test(line)) continue;
    const match = line.match(new RegExp(`:${port}\\s+`, "i"));
    if (!match) continue;
    const pid = Number(line.trim().split(/\s+/).at(-1));
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) pids.add(pid);
  }
  return [...pids];
}

function pidsListeningOnUnix(port) {
  try {
    const output = execFileSync("lsof", ["-ti", `TCP:${port}`, "-sTCP:LISTEN"], {
      encoding: "utf8",
    });
    return output
      .split(/\s+/)
      .map((value) => Number(value))
      .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
  } catch {
    return [];
  }
}

function killPid(pid) {
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        process.kill(pid, "SIGKILL");
      }
    }
    return true;
  } catch {
    return false;
  }
}

function collectPidsFromText(text) {
  const pids = new Set();
  for (const match of text.matchAll(/\b(?:pid|PID)\b["'\s:=]+(\d{2,})/g)) {
    const pid = Number(match[1]);
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) pids.add(pid);
  }
  for (const match of text.matchAll(/"pid"\s*:\s*(\d{2,})/g)) {
    const pid = Number(match[1]);
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) pids.add(pid);
  }
  return [...pids];
}

function clearStaleNextDevLock() {
  const lockPath = path.join(webNextDir, "dev", "lock");
  const pids = new Set();

  if (fs.existsSync(lockPath)) {
    try {
      const raw = fs.readFileSync(lockPath, "utf8").trim();
      try {
        const info = JSON.parse(raw);
        const pid = Number(info?.pid);
        if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) pids.add(pid);
        const port = Number(info?.port);
        if (Number.isInteger(port) && port > 0 && port < 65536 && !ports.includes(port)) {
          ports.push(port);
        }
      } catch {
        for (const pid of collectPidsFromText(raw)) pids.add(pid);
      }
    } catch {
      // ignore unreadable lock
    }
  }

  let killed = 0;
  for (const pid of pids) {
    if (killPid(pid)) {
      console.log(`[free-ports] stopped stale Next.js pid ${pid}`);
      killed += 1;
    }
  }

  try {
    if (fs.existsSync(lockPath)) {
      fs.unlinkSync(lockPath);
      console.log(`[free-ports] removed ${path.relative(rootDir, lockPath)}`);
    }
  } catch {
    // ignore
  }

  return killed;
}

let freed = clearStaleNextDevLock();
for (const port of [...new Set(ports)]) {
  const pids =
    process.platform === "win32" ? pidsListeningOnWindows(port) : pidsListeningOnUnix(port);
  if (pids.length === 0) {
    console.log(`[free-ports] :${port} is free`);
    continue;
  }
  for (const pid of pids) {
    const ok = killPid(pid);
    console.log(
      ok
        ? `[free-ports] freed :${port} (pid ${pid})`
        : `[free-ports] could not stop pid ${pid} on :${port}`,
    );
    if (ok) freed += 1;
  }
}

if (freed > 0) {
  await new Promise((resolve) => setTimeout(resolve, 400));
}

console.log(`[free-ports] ready (${[...new Set(ports)].join(", ")})`);
