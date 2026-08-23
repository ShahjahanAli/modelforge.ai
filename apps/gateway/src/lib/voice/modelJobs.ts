import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { SttProviderId } from "./runtimeConfig.js";
import { writeVoiceRuntimeConfig } from "./runtimeConfig.js";

const execFileAsync = promisify(execFile);

function resolveScriptPath(inputPath: string): string {
  if (path.isAbsolute(inputPath)) return inputPath;
  return path.resolve(import.meta.dirname, "../../../../..", inputPath);
}

export const WHISPER_MODEL_CATALOG = [
  { id: "tiny", label: "tiny", approxDownloadGb: 0.08 },
  { id: "base", label: "base", approxDownloadGb: 0.15 },
  { id: "small", label: "small", approxDownloadGb: 0.5 },
  { id: "medium", label: "medium", approxDownloadGb: 1.5 },
  { id: "large-v2", label: "large-v2", approxDownloadGb: 3.0 },
  { id: "large-v3", label: "large-v3", approxDownloadGb: 3.0 },
  { id: "distil-large-v3", label: "distil-large-v3", approxDownloadGb: 1.5 },
  {
    id: "bengaliAI/tugstugi_bengaliai-regional-asr_whisper-medium",
    label: "BengaliAI Regional ASR (Whisper medium)",
    approxDownloadGb: 3.0,
  },
] as const;

export const NEMO_MODEL_CATALOG = [
  {
    id: "kazalbrur/bangla-stt-conformer-120m-dialects",
    label: "Bhatiyali (Bangla dialects 120M)",
    approxDownloadGb: 0.5,
    license: "CC-BY-NC-4.0",
  },
] as const;

export interface VoiceModelJob {
  id: string;
  provider: SttProviderId;
  model: string;
  status: "queued" | "downloading" | "succeeded" | "failed";
  activateOnSuccess: boolean;
  message: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

const jobs = new Map<string, VoiceModelJob>();
let activeInstallId: string | null = null;

export function catalogForProvider(provider: SttProviderId) {
  return provider === "nemo" ? NEMO_MODEL_CATALOG : WHISPER_MODEL_CATALOG;
}

function isAllowedModel(provider: SttProviderId, model: string): boolean {
  return catalogForProvider(provider).some((entry) => entry.id === model);
}

export function getVoiceModelJob(id: string): VoiceModelJob | undefined {
  return jobs.get(id);
}

export function getActiveVoiceModelInstall(): VoiceModelJob | null {
  if (!activeInstallId) return null;
  return jobs.get(activeInstallId) ?? null;
}

async function runPythonJson(
  pythonBin: string,
  scriptPath: string,
  args: string[],
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const { stdout, stderr } = await execFileAsync(pythonBin, [scriptPath, ...args], {
    maxBuffer: 10 * 1024 * 1024,
    timeout: timeoutMs,
    env: {
      ...process.env,
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8",
    },
  });
  if (stderr?.trim()) {
    console.warn("[voice.model] stderr:", stderr.trim());
  }
  const line = stdout
    .split(/\r?\n/)
    .map((part) => part.trim())
    .filter(Boolean)
    .at(-1);
  if (!line) throw new Error("Empty Python output");
  return JSON.parse(line) as Record<string, unknown>;
}

export async function startSttModelInstall(input: {
  provider: SttProviderId;
  pythonBin: string;
  scriptPath: string;
  model: string;
  device: string;
  computeType?: string;
  activateOnSuccess?: boolean;
}): Promise<VoiceModelJob> {
  const provider = input.provider;
  const model = input.model.trim();
  if (!isAllowedModel(provider, model)) {
    throw new Error(`Unsupported ${provider} model: ${model}`);
  }
  if (activeInstallId) {
    const current = jobs.get(activeInstallId);
    if (current && (current.status === "queued" || current.status === "downloading")) {
      throw new Error(`Install already in progress for ${current.provider}:${current.model}`);
    }
  }

  const job: VoiceModelJob = {
    id: randomUUID(),
    provider,
    model,
    status: "queued",
    activateOnSuccess: input.activateOnSuccess !== false,
    message: `Queued download for ${provider}:${model}`,
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  jobs.set(job.id, job);
  activeInstallId = job.id;

  void (async () => {
    job.status = "downloading";
    job.message =
      provider === "nemo"
        ? `Downloading NeMo ASR ${model} (first run may take several minutes)`
        : `Downloading / warming Whisper ${model}`;
    try {
      const scriptPath = resolveScriptPath(input.scriptPath);
      const args =
        provider === "nemo"
          ? ["--preload", "--model", model, "--device", input.device]
          : [
              "--preload",
              "--model",
              model,
              "--device",
              input.device,
              "--compute-type",
              input.computeType ?? "int8",
            ];
      await runPythonJson(input.pythonBin, scriptPath, args, 60 * 60 * 1000);
      if (job.activateOnSuccess) {
        await writeVoiceRuntimeConfig({ provider, model });
        const { resetSttProviderCache } = await import("./index.js");
        resetSttProviderCache();
        job.message = `${provider}:${model} installed and activated`;
      } else {
        job.message = `${provider}:${model} installed (not activated)`;
      }
      job.status = "succeeded";
      job.finishedAt = new Date().toISOString();
    } catch (error) {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : "Install failed";
      job.message = job.error;
      job.finishedAt = new Date().toISOString();
    } finally {
      if (activeInstallId === job.id) activeInstallId = null;
    }
  })();

  return job;
}

/** @deprecated */
export async function startWhisperModelInstall(
  input: Parameters<typeof startSttModelInstall>[0] & { provider?: SttProviderId },
) {
  return startSttModelInstall({ ...input, provider: "faster-whisper" });
}
