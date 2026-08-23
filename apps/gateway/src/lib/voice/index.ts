import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { FasterWhisperProvider } from "./fasterWhisper.js";
import { NemoAsrProvider } from "./nemoAsr.js";
import { isHfRepoCachedOnDisk, isWhisperModelCachedOnDisk } from "./cache.js";
import {
  getActiveVoiceModelInstall,
  NEMO_MODEL_CATALOG,
  WHISPER_MODEL_CATALOG,
} from "./modelJobs.js";
import { checkPyannoteAvailable } from "./diarize.js";
import { resolveActiveSttSelection, type SttProviderId } from "./runtimeConfig.js";
import type { SttProvider, TranscriptArtifact } from "./types.js";

const execFileAsync = promisify(execFile);

type PackageProbe = {
  fasterWhisperAvailable: boolean;
  nemoAvailable: boolean;
  executable?: string;
  version?: string;
  nemoError?: string;
  checkedAt: number;
};

const PACKAGE_PROBE_TTL_MS = 60_000;
const packageProbeCache = new Map<string, PackageProbe>();
let packageProbeInFlight: Promise<PackageProbe> | null = null;

type DiarizeProbe = {
  available: boolean;
  error?: string;
  checkedAt: number;
};

const diarizeProbeCache = new Map<string, DiarizeProbe>();
let diarizeProbeInFlight: Promise<DiarizeProbe> | null = null;

async function probePyannoteCached(env: VoiceEnv): Promise<DiarizeProbe> {
  const key = `${env.STT_PYTHON_BIN}|${env.DIARIZATION_SCRIPT}`;
  const cached = diarizeProbeCache.get(key);
  if (cached && Date.now() - cached.checkedAt < PACKAGE_PROBE_TTL_MS) {
    return cached;
  }
  if (diarizeProbeInFlight) return diarizeProbeInFlight;

  diarizeProbeInFlight = (async () => {
    const result = await checkPyannoteAvailable({
      pythonBin: env.STT_PYTHON_BIN,
      scriptPath: env.DIARIZATION_SCRIPT,
    });
    const probe: DiarizeProbe = {
      available: result.available,
      error: result.error,
      checkedAt: Date.now(),
    };
    diarizeProbeCache.set(key, probe);
    return probe;
  })().finally(() => {
    diarizeProbeInFlight = null;
  });

  return diarizeProbeInFlight;
}

async function probeSttPackages(env: VoiceEnv): Promise<PackageProbe> {
  const key = `${env.STT_PYTHON_BIN}|${env.STT_NEMO_SCRIPT}`;
  const cached = packageProbeCache.get(key);
  if (cached && Date.now() - cached.checkedAt < PACKAGE_PROBE_TTL_MS) {
    return cached;
  }

  if (packageProbeInFlight) return packageProbeInFlight;

  packageProbeInFlight = (async () => {
    const result: PackageProbe = {
      fasterWhisperAvailable: false,
      nemoAvailable: false,
      checkedAt: Date.now(),
    };

    try {
      await execFileAsync(env.STT_PYTHON_BIN, ["-c", "import faster_whisper; print('ok')"], {
        maxBuffer: 1024 * 1024,
        timeout: 30_000,
      });
      result.fasterWhisperAvailable = true;
    } catch {
      result.fasterWhisperAvailable = false;
    }

    try {
      const nemoScript = resolveVoicePath(env.STT_NEMO_SCRIPT);
      if (existsSync(nemoScript)) {
        const { stdout, stderr } = await execFileAsync(
          env.STT_PYTHON_BIN,
          [nemoScript, "--check-nemo"],
          { maxBuffer: 4 * 1024 * 1024, timeout: 180_000 },
        );
        const line = [...stdout.split(/\r?\n/), ...stderr.split(/\r?\n/)]
          .map((part) => part.trim())
          .filter((part) => part.startsWith("{") && part.includes("nemoAvailable"))
          .at(-1);
        const parsed = line
          ? (JSON.parse(line) as {
              nemoAvailable?: boolean;
              error?: string;
              executable?: string;
              version?: string;
            })
          : {};
        result.nemoAvailable = parsed.nemoAvailable === true;
        result.executable = parsed.executable;
        result.version = parsed.version;
        if (!result.nemoAvailable && parsed.error) result.nemoError = parsed.error;
      }
    } catch (error) {
      result.nemoAvailable = false;
      result.nemoError = error instanceof Error ? error.message : String(error);
    }

    packageProbeCache.set(key, result);
    return result;
  })().finally(() => {
    packageProbeInFlight = null;
  });

  return packageProbeInFlight;
}

function projectRoot(): string {
  return path.resolve(import.meta.dirname, "../../../../..");
}

export function resolveVoicePath(inputPath: string): string {
  if (path.isAbsolute(inputPath)) return inputPath;
  return path.resolve(projectRoot(), inputPath);
}

export interface VoiceEnv {
  VOICE_ENABLED: boolean;
  VOICE_UPLOAD_DIR: string;
  VOICE_MAX_UPLOAD_MB: number;
  VOICE_RETENTION_HOURS: number;
  VOICE_RATE_LIMIT_PER_HOUR: number;
  STT_PROVIDER: SttProviderId;
  STT_LANGUAGE: string;
  STT_FASTER_WHISPER_MODEL: string;
  STT_FASTER_WHISPER_DEVICE: "cpu" | "cuda";
  STT_FASTER_WHISPER_COMPUTE_TYPE: string;
  STT_FASTER_WHISPER_BEAM_SIZE: number;
  STT_FASTER_WHISPER_BEST_OF: number;
  STT_FASTER_WHISPER_TEMPERATURE: number;
  STT_FASTER_WHISPER_NO_SPEECH_THRESHOLD: number;
  STT_PYTHON_BIN: string;
  STT_FASTER_WHISPER_SCRIPT: string;
  STT_NEMO_MODEL: string;
  STT_NEMO_DEVICE: "cpu" | "cuda";
  STT_NEMO_SCRIPT: string;
  DIARIZATION_ENABLED: boolean;
  DIARIZATION_PROVIDER: "pyannote";
  DIARIZATION_MODEL: string;
  DIARIZATION_DEVICE: "cpu" | "cuda";
  DIARIZATION_SCRIPT: string;
  DIARIZATION_MIN_SPEAKERS?: number;
  DIARIZATION_MAX_SPEAKERS?: number;
}

let cachedProvider: SttProvider | null = null;
let cachedProviderKey: string | null = null;

function providerKey(env: VoiceEnv): string {
  return [
    env.STT_PROVIDER,
    env.STT_FASTER_WHISPER_MODEL,
    env.STT_FASTER_WHISPER_DEVICE,
    env.STT_FASTER_WHISPER_COMPUTE_TYPE,
    env.STT_NEMO_MODEL,
    env.STT_NEMO_DEVICE,
    env.STT_PYTHON_BIN,
    env.STT_FASTER_WHISPER_SCRIPT,
    env.STT_NEMO_SCRIPT,
  ].join("|");
}

export function resetSttProviderCache(): void {
  cachedProvider = null;
  cachedProviderKey = null;
}

export function createSttProvider(env: VoiceEnv): SttProvider {
  const key = providerKey(env);
  if (cachedProvider && cachedProviderKey === key) return cachedProvider;

  if (env.STT_PROVIDER === "nemo") {
    cachedProvider = new NemoAsrProvider({
      pythonBin: env.STT_PYTHON_BIN,
      scriptPath: env.STT_NEMO_SCRIPT,
      model: env.STT_NEMO_MODEL,
      device: env.STT_NEMO_DEVICE,
    });
  } else {
    cachedProvider = new FasterWhisperProvider({
      pythonBin: env.STT_PYTHON_BIN,
      scriptPath: env.STT_FASTER_WHISPER_SCRIPT,
      model: env.STT_FASTER_WHISPER_MODEL,
      device: env.STT_FASTER_WHISPER_DEVICE,
      computeType: env.STT_FASTER_WHISPER_COMPUTE_TYPE,
      beamSize: env.STT_FASTER_WHISPER_BEAM_SIZE,
      bestOf: env.STT_FASTER_WHISPER_BEST_OF,
      temperature: env.STT_FASTER_WHISPER_TEMPERATURE,
      noSpeechThreshold: env.STT_FASTER_WHISPER_NO_SPEECH_THRESHOLD,
    });
  }
  cachedProviderKey = key;
  return cachedProvider;
}

/** Merge env defaults with admin-selected runtime provider/model. */
export async function resolveVoiceEnv(env: VoiceEnv): Promise<VoiceEnv> {
  const active = await resolveActiveSttSelection({
    provider: env.STT_PROVIDER,
    whisperModel: env.STT_FASTER_WHISPER_MODEL,
    nemoModel: env.STT_NEMO_MODEL,
  });
  if (active.provider === "nemo") {
    return {
      ...env,
      STT_PROVIDER: "nemo",
      STT_NEMO_MODEL: active.model,
    };
  }
  return {
    ...env,
    STT_PROVIDER: "faster-whisper",
    STT_FASTER_WHISPER_MODEL: active.model,
  };
}

export async function ensureVoiceUploadDir(uploadDir: string): Promise<string> {
  const resolved = resolveVoicePath(uploadDir);
  await mkdir(resolved, { recursive: true });
  return resolved;
}

export function ensureWhisperScript(scriptPath: string) {
  const resolved = resolveVoicePath(scriptPath);
  if (!existsSync(resolved)) {
    throw new Error(`STT script not found: ${resolved}`);
  }
}

export function ensureSttScript(env: VoiceEnv) {
  const script =
    env.STT_PROVIDER === "nemo" ? env.STT_NEMO_SCRIPT : env.STT_FASTER_WHISPER_SCRIPT;
  ensureWhisperScript(script);
}

export async function cleanupOldVoiceUploads(uploadDir: string, retentionHours: number): Promise<number> {
  const dir = resolveVoicePath(uploadDir);
  const retentionMs = Math.max(1, retentionHours) * 60 * 60 * 1000;
  const cutoff = Date.now() - retentionMs;
  let deleted = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const absolute = path.join(dir, entry.name);
    try {
      const info = await stat(absolute);
      if (info.mtimeMs < cutoff) {
        await rm(absolute, { force: true });
        deleted += 1;
      }
    } catch {
      // Best-effort cleanup.
    }
  }
  return deleted;
}

/** Empty, "auto", or "detect" => Whisper auto-detects unless the model is Bengali-tuned. */
export function resolveSttLanguageHint(configured?: string, model?: string): string | undefined {
  const value = configured?.trim().toLowerCase();
  if (!value || value === "auto" || value === "detect") {
    if (model && isBengaliTunedSttModel(model)) return "bn";
    return undefined;
  }
  return value;
}

const BENGALI_STT_MODEL_PATTERN =
  /bengali|bangla|bengaliai|tugstugi|bhatiyali|kazalbrur\/bangla/i;

export function isBengaliTunedSttModel(model: string): boolean {
  return BENGALI_STT_MODEL_PATTERN.test(model);
}

export function buildVoiceAnalysisSystemPrompt(transcript: TranscriptArtifact): string {
  const language = transcript.language?.trim() || "unknown";
  return [
    "You analyze speech transcripts.",
    `Respond in the same language as the transcript (detected: ${language}).`,
    "Do not translate or rewrite the transcript unless the user explicitly asks.",
    "Provide concise, actionable insights based only on what was said.",
  ].join(" ");
}

export function buildVoiceAnalysisPrompt(
  transcript: TranscriptArtifact,
  userPrompt: string,
): string | null {
  const instruction = userPrompt.trim();
  if (!instruction) return null;
  return [
    instruction,
    "",
    "Detected transcript language:",
    transcript.language || "unknown",
    "",
    "Transcript:",
    transcript.text,
  ].join("\n");
}

export interface VoiceModelCatalogEntry {
  id: string;
  label: string;
  approxDownloadGb: number;
  cached: boolean;
  active: boolean;
  license?: string;
}

export interface VoiceStatus {
  enabled: boolean;
  provider: string;
  language: string;
  configuredModel: string;
  envModel: string;
  envProvider: string;
  device: string;
  computeType: string;
  modelCached: boolean;
  models: VoiceModelCatalogEntry[];
  providers: Array<{ id: SttProviderId; label: string; available: boolean }>;
  activeInstall: {
    id: string;
    provider: string;
    model: string;
    status: string;
    message: string | null;
  } | null;
  uploadDir: string;
  scriptPath: string;
  scriptExists: boolean;
  pythonBin: string;
  pythonAvailable: boolean;
  pythonVersion: string | null;
  fasterWhisperAvailable: boolean;
  nemoAvailable: boolean;
  diarization: {
    enabled: boolean;
    provider: string;
    model: string;
    device: string;
    available: boolean;
    scriptExists: boolean;
    hfTokenConfigured: boolean;
    error?: string;
  };
  ready: boolean;
  error?: string;
}

export async function probeVoiceStatus(env: VoiceEnv): Promise<VoiceStatus> {
  const resolved = await resolveVoiceEnv(env);
  const scriptPath = resolveVoicePath(
    resolved.STT_PROVIDER === "nemo"
      ? resolved.STT_NEMO_SCRIPT
      : resolved.STT_FASTER_WHISPER_SCRIPT,
  );
  const uploadDir = resolveVoicePath(resolved.VOICE_UPLOAD_DIR);
  const activeModel =
    resolved.STT_PROVIDER === "nemo"
      ? resolved.STT_NEMO_MODEL
      : resolved.STT_FASTER_WHISPER_MODEL;
  const envModel =
    env.STT_PROVIDER === "nemo" ? env.STT_NEMO_MODEL : env.STT_FASTER_WHISPER_MODEL;

  const status: VoiceStatus = {
    enabled: resolved.VOICE_ENABLED,
    provider: resolved.STT_PROVIDER,
    language:
      resolved.STT_PROVIDER === "nemo"
        ? "bn"
        : (resolveSttLanguageHint(resolved.STT_LANGUAGE, activeModel) ?? "auto"),
    configuredModel: activeModel,
    envModel,
    envProvider: env.STT_PROVIDER,
    device:
      resolved.STT_PROVIDER === "nemo"
        ? resolved.STT_NEMO_DEVICE
        : resolved.STT_FASTER_WHISPER_DEVICE,
    computeType:
      resolved.STT_PROVIDER === "nemo" ? "pytorch" : resolved.STT_FASTER_WHISPER_COMPUTE_TYPE,
    modelCached: false,
    models: [],
    providers: [],
    activeInstall: null,
    uploadDir,
    scriptPath,
    scriptExists: existsSync(scriptPath),
    pythonBin: resolved.STT_PYTHON_BIN,
    pythonAvailable: false,
    pythonVersion: null,
    fasterWhisperAvailable: false,
    nemoAvailable: false,
    diarization: {
      enabled: resolved.DIARIZATION_ENABLED,
      provider: resolved.DIARIZATION_PROVIDER,
      model: resolved.DIARIZATION_MODEL,
      device: resolved.DIARIZATION_DEVICE,
      available: false,
      scriptExists: existsSync(resolveVoicePath(resolved.DIARIZATION_SCRIPT)),
      hfTokenConfigured: Boolean(
        process.env.HF_TOKEN?.trim() || process.env.HUGGING_FACE_HUB_TOKEN?.trim(),
      ),
    },
    ready: false,
  };

  const install = getActiveVoiceModelInstall();
  if (install) {
    status.activeInstall = {
      id: install.id,
      provider: install.provider,
      model: install.model,
      status: install.status,
      message: install.message,
    };
  }

  try {
    await execFileAsync(
      resolved.STT_PYTHON_BIN,
      ["--version"],
      { maxBuffer: 1024 * 1024, timeout: 10_000 },
    ).then(({ stdout: versionOut, stderr: versionErr }) => {
      status.pythonAvailable = true;
      status.pythonVersion = (versionOut || versionErr).trim() || "Python available";
    });
  } catch (error) {
    status.error = error instanceof Error ? error.message : "Python unavailable";
    status.providers = [
      { id: "faster-whisper", label: "Faster-Whisper", available: false },
      { id: "nemo", label: "NeMo (Bangla)", available: false },
    ];
    return status;
  }

  const packages = await probeSttPackages(resolved);
  status.fasterWhisperAvailable = packages.fasterWhisperAvailable;
  status.nemoAvailable = packages.nemoAvailable;
  if (packages.executable) status.pythonBin = packages.executable;
  if (packages.version) status.pythonVersion = `Python ${packages.version}`;
  if (!packages.nemoAvailable && packages.nemoError && resolved.STT_PROVIDER === "nemo") {
    status.error = `NeMo check failed (${packages.executable ?? resolved.STT_PYTHON_BIN}): ${packages.nemoError}`;
  }

  status.providers = [
    {
      id: "faster-whisper",
      label: "Faster-Whisper",
      available: status.fasterWhisperAvailable,
    },
    { id: "nemo", label: "NeMo (Bangla)", available: status.nemoAvailable },
  ];

  if (status.diarization.scriptExists) {
    if (resolved.DIARIZATION_ENABLED) {
      const diarizeProbe = await probePyannoteCached(resolved);
      status.diarization.available = diarizeProbe.available;
      if (!diarizeProbe.available) {
        status.diarization.error =
          diarizeProbe.error ??
          "pyannote.audio not installed — pip install pyannote.audio (accept HF model terms + set HF_TOKEN)";
      } else if (!status.diarization.hfTokenConfigured) {
        status.diarization.error =
          "HF_TOKEN missing — create a Hugging Face token and accept pyannote/speaker-diarization-community-1 terms";
      }
    } else {
      status.diarization.available = false;
    }
  } else {
    status.diarization.error = `Diarization script missing: ${resolved.DIARIZATION_SCRIPT}`;
  }

  if (resolved.STT_PROVIDER === "nemo") {
    status.models = NEMO_MODEL_CATALOG.map((entry) => ({
      id: entry.id,
      label: entry.label,
      approxDownloadGb: entry.approxDownloadGb,
      cached: isHfRepoCachedOnDisk(entry.id),
      active: entry.id === activeModel,
      license: entry.license,
    }));
    status.modelCached = isHfRepoCachedOnDisk(activeModel);
  } else {
    status.models = WHISPER_MODEL_CATALOG.map((entry) => ({
      id: entry.id,
      label: entry.label,
      approxDownloadGb: entry.approxDownloadGb,
      cached: isWhisperModelCachedOnDisk(entry.id),
      active: entry.id === activeModel,
    }));
    status.modelCached = isWhisperModelCachedOnDisk(activeModel);
  }

  const packageOk =
    resolved.STT_PROVIDER === "nemo" ? status.nemoAvailable : status.fasterWhisperAvailable;

  status.ready =
    status.enabled && status.scriptExists && status.pythonAvailable && packageOk && status.modelCached;

  if (!status.enabled) {
    // disabled is fine
  } else if (!status.scriptExists || !status.pythonAvailable || !packageOk) {
    status.error =
      resolved.STT_PROVIDER === "nemo"
        ? status.error ??
          "NeMo ASR not ready — install with: pip install 'nemo_toolkit[asr]' (and ffmpeg)"
        : status.error ?? "faster-whisper unavailable";
  } else if (!status.modelCached) {
    status.error = `STT model "${activeModel}" is not downloaded yet — use Install below`;
  }
  return status;
}
