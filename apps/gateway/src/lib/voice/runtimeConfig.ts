import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type SttProviderId = "faster-whisper" | "nemo";

export interface VoiceRuntimeConfig {
  provider: SttProviderId;
  model: string;
  updatedAt: string;
}

const RUNTIME_RELATIVE = "./data/voice/runtime.json";

function projectRoot(): string {
  return path.resolve(import.meta.dirname, "../../../../..");
}

export function voiceRuntimeConfigPath(): string {
  return path.resolve(projectRoot(), RUNTIME_RELATIVE);
}

function asProvider(value: unknown): SttProviderId | null {
  if (value === "faster-whisper" || value === "nemo") return value;
  return null;
}

export async function readVoiceRuntimeConfig(): Promise<VoiceRuntimeConfig | null> {
  try {
    const raw = await readFile(voiceRuntimeConfigPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<VoiceRuntimeConfig> & { model?: string };
    if (!parsed.model || typeof parsed.model !== "string") return null;
    return {
      provider: asProvider(parsed.provider) ?? "faster-whisper",
      model: parsed.model.trim(),
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

export async function writeVoiceRuntimeConfig(input: {
  provider: SttProviderId;
  model: string;
}): Promise<VoiceRuntimeConfig> {
  const next: VoiceRuntimeConfig = {
    provider: input.provider,
    model: input.model.trim(),
    updatedAt: new Date().toISOString(),
  };
  const filePath = voiceRuntimeConfigPath();
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

/** @deprecated Prefer writeVoiceRuntimeConfig({ provider, model }) */
export async function writeVoiceRuntimeModelOnly(model: string): Promise<VoiceRuntimeConfig> {
  const existing = await readVoiceRuntimeConfig();
  return writeVoiceRuntimeConfig({
    provider: existing?.provider ?? "faster-whisper",
    model,
  });
}

export async function resolveActiveSttSelection(defaults: {
  provider: SttProviderId;
  whisperModel: string;
  nemoModel: string;
}): Promise<{ provider: SttProviderId; model: string }> {
  const runtime = await readVoiceRuntimeConfig();
  if (runtime?.model) {
    return { provider: runtime.provider, model: runtime.model };
  }
  if (defaults.provider === "nemo") {
    return { provider: "nemo", model: defaults.nemoModel.trim() || defaults.whisperModel };
  }
  return {
    provider: "faster-whisper",
    model: defaults.whisperModel.trim() || "small",
  };
}
