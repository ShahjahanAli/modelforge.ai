import type { DiarizationConfig } from "./diarize.js";

export type DiarizationBackend = "local" | "cloud";
export type DiarizationMode = "per-turn" | "merge";

export function resolveDiarizationBackend(raw?: string): DiarizationBackend {
  const v = (raw ?? process.env.DIARIZATION_BACKEND ?? "").trim().toLowerCase();
  if (v === "cloud" || v === "pyannoteai" || v === "api") return "cloud";
  if (v === "local") return "local";
  // Default: cloud when API key is present, otherwise local.
  return process.env.PYANNOTE_API_KEY?.trim() ? "cloud" : "local";
}

export function resolveDiarizationMode(raw?: string): DiarizationMode {
  const v = (raw ?? process.env.DIARIZATION_MODE ?? "per-turn").trim().toLowerCase();
  return v === "merge" ? "merge" : "per-turn";
}

/** Build diarization config from process env (+ optional overrides). */
export function diarizationConfigFromEnv(overrides?: {
  enabled?: boolean;
  backend?: DiarizationBackend;
  mode?: DiarizationMode;
}): DiarizationConfig {
  const backend = overrides?.backend ?? resolveDiarizationBackend();
  const mode = overrides?.mode ?? resolveDiarizationMode();
  const cloudModel = process.env.DIARIZATION_CLOUD_MODEL?.trim() || "precision-2";
  const localModel =
    process.env.DIARIZATION_MODEL?.trim() || "pyannote/speaker-diarization-community-1";

  return {
    enabled: overrides?.enabled ?? process.env.DIARIZATION_ENABLED === "true",
    backend,
    mode,
    pythonBin: process.env.STT_PYTHON_BIN ?? "python3",
    scriptPath: process.env.DIARIZATION_SCRIPT ?? "scripts/pyannote-diarize.py",
    model: backend === "cloud" ? cloudModel : localModel,
    device: process.env.DIARIZATION_DEVICE === "cuda" ? "cuda" : "cpu",
    minSpeakers: process.env.DIARIZATION_MIN_SPEAKERS
      ? Number(process.env.DIARIZATION_MIN_SPEAKERS)
      : undefined,
    maxSpeakers: process.env.DIARIZATION_MAX_SPEAKERS
      ? Number(process.env.DIARIZATION_MAX_SPEAKERS)
      : undefined,
    apiKey: process.env.PYANNOTE_API_KEY?.trim() || undefined,
    turnPadMs: process.env.DIARIZATION_TURN_PAD_MS
      ? Number(process.env.DIARIZATION_TURN_PAD_MS)
      : 200,
    asrConcurrency: process.env.DIARIZATION_ASR_CONCURRENCY
      ? Number(process.env.DIARIZATION_ASR_CONCURRENCY)
      : 2,
  };
}

/** Slice of VoiceEnv for diarization (status probes + logging). */
export function diarizationVoiceEnvFields() {
  const cfg = diarizationConfigFromEnv();
  return {
    DIARIZATION_ENABLED: cfg.enabled,
    DIARIZATION_BACKEND: cfg.backend,
    DIARIZATION_MODE: cfg.mode,
    DIARIZATION_PROVIDER: "pyannote" as const,
    DIARIZATION_MODEL:
      process.env.DIARIZATION_MODEL?.trim() || "pyannote/speaker-diarization-community-1",
    DIARIZATION_CLOUD_MODEL: process.env.DIARIZATION_CLOUD_MODEL?.trim() || "precision-2",
    DIARIZATION_DEVICE: cfg.device,
    DIARIZATION_SCRIPT: cfg.scriptPath,
    DIARIZATION_MIN_SPEAKERS: cfg.minSpeakers,
    DIARIZATION_MAX_SPEAKERS: cfg.maxSpeakers,
    DIARIZATION_TURN_PAD_MS: cfg.turnPadMs,
    DIARIZATION_ASR_CONCURRENCY: cfg.asrConcurrency,
    PYANNOTE_API_KEY: cfg.apiKey,
  };
}
