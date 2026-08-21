import { writeFileSync } from "node:fs";

const token = process.env.INTERNAL_SERVICE_TOKEN ?? "";
const envBin = process.env.STT_PYTHON_BIN ?? "";
const out = { envBin };

try {
  const res = await fetch("http://localhost:9000/internal/voice/status", {
    headers: { "x-internal-token": token },
  });
  out.status = res.status;
  const body = await res.json();
  out.pythonBin = body.pythonBin;
  out.pythonVersion = body.pythonVersion;
  out.nemoAvailable = body.nemoAvailable;
  out.fasterWhisperAvailable = body.fasterWhisperAvailable;
  out.error = body.error;
  out.provider = body.provider;
} catch (error) {
  out.fetchError = error instanceof Error ? error.message : String(error);
}

writeFileSync(
  new URL("./voice-status-probe.json", import.meta.url),
  `${JSON.stringify(out, null, 2)}\n`,
);
