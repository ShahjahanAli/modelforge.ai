import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { normalizeTranscript, type SttProvider, type TranscriptArtifact, type VoiceTranscribeOptions } from "./types.js";

export const DEFAULT_HF_SPACE_ID = "bengaliAI/regional_bengali-asr_tugstugi_whisper-medium";
export const DEFAULT_HF_SPACE_HOST =
  "https://bengaliai-regional-bengali-asr-tugstugi-whisper-medium.hf.space";

export interface HfSpaceAsrConfig {
  spaceId: string;
  spaceUrl: string;
  fnIndex: number;
  hfToken: string;
  timeoutMs: number;
}

function guessMime(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".wav") return "audio/wav";
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".m4a" || ext === ".aac") return "audio/mp4";
  if (ext === ".webm") return "audio/webm";
  if (ext === ".ogg") return "audio/ogg";
  if (ext === ".flac") return "audio/flac";
  return "application/octet-stream";
}

function spaceHostFromId(spaceId: string): string {
  // HF Space subdomains use hyphens only: owner/name_with_underscores → owner-name-with-underscores
  const slug = spaceId.trim().toLowerCase().replace(/[/_]+/g, "-");
  return `https://${slug}.hf.space`;
}

export function resolveHfSpaceAsrConfig(env: {
  STT_HF_SPACE_ID?: string;
  STT_HF_SPACE_URL?: string;
  STT_HF_SPACE_FN_INDEX?: number;
  HF_TOKEN?: string;
}): HfSpaceAsrConfig {
  const spaceId = (env.STT_HF_SPACE_ID ?? DEFAULT_HF_SPACE_ID).trim() || DEFAULT_HF_SPACE_ID;
  const spaceUrl =
    (env.STT_HF_SPACE_URL ?? "").trim().replace(/\/+$/, "") ||
    spaceHostFromId(spaceId) ||
    DEFAULT_HF_SPACE_HOST;
  const token = (
    env.HF_TOKEN ??
    process.env.HF_TOKEN ??
    process.env.HUGGING_FACE_HUB_TOKEN ??
    ""
  ).trim();
  return {
    spaceId,
    spaceUrl,
    fnIndex: Number.isFinite(env.STT_HF_SPACE_FN_INDEX) ? Number(env.STT_HF_SPACE_FN_INDEX) : 0,
    hfToken: token,
    timeoutMs: Math.max(60_000, Number(process.env.STT_HF_SPACE_TIMEOUT_MS ?? 600_000)),
  };
}

function authHeaders(token: string): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function uploadAudio(
  config: HfSpaceAsrConfig,
  filePath: string,
): Promise<{ path: string; orig_name: string; mime_type: string; size: number }> {
  const bytes = await readFile(filePath);
  const origName = path.basename(filePath);
  const mime = guessMime(filePath);
  const form = new FormData();
  form.append("files", new Blob([new Uint8Array(bytes)], { type: mime }), origName);

  const response = await fetch(`${config.spaceUrl}/gradio_api/upload`, {
    method: "POST",
    headers: authHeaders(config.hfToken),
    body: form,
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`HF Space upload failed (${response.status}): ${body.slice(0, 400)}`);
  }
  const payload = (await response.json()) as unknown;
  let uploadedPath: string | null = null;
  if (Array.isArray(payload) && typeof payload[0] === "string") {
    uploadedPath = payload[0];
  } else if (payload && typeof payload === "object" && "path" in payload) {
    uploadedPath = String((payload as { path: unknown }).path);
  }
  if (!uploadedPath) {
    throw new Error(`HF Space upload returned unexpected payload: ${JSON.stringify(payload).slice(0, 200)}`);
  }
  return {
    path: uploadedPath,
    orig_name: origName,
    mime_type: mime,
    size: bytes.byteLength,
  };
}

async function joinQueue(
  config: HfSpaceAsrConfig,
  sessionHash: string,
  fileData: Record<string, unknown>,
): Promise<void> {
  const response = await fetch(`${config.spaceUrl}/gradio_api/queue/join`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(config.hfToken),
    },
    body: JSON.stringify({
      data: [fileData],
      fn_index: config.fnIndex,
      session_hash: sessionHash,
    }),
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`HF Space queue join failed (${response.status}): ${body.slice(0, 400)}`);
  }
}

async function waitForResult(config: HfSpaceAsrConfig, sessionHash: string): Promise<string> {
  const response = await fetch(
    `${config.spaceUrl}/gradio_api/queue/data?session_hash=${encodeURIComponent(sessionHash)}`,
    {
      method: "GET",
      headers: {
        Accept: "text/event-stream",
        ...authHeaders(config.hfToken),
      },
      signal: AbortSignal.timeout(config.timeoutMs),
    },
  );
  if (!response.ok || !response.body) {
    const body = await response.text().catch(() => "");
    throw new Error(`HF Space queue stream failed (${response.status}): ${body.slice(0, 400)}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split(/\n/);
    buffer = chunks.pop() ?? "";

    for (const raw of chunks) {
      const line = raw.trim();
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      let event: {
        msg?: string;
        output?: { data?: unknown[] };
      };
      try {
        event = JSON.parse(payload) as typeof event;
      } catch {
        continue;
      }
      if (event.msg === "process_completed") {
        const data = event.output?.data ?? [];
        const text = data[0];
        return typeof text === "string" ? text : String(text ?? "");
      }
      if (event.msg === "close_stream") {
        break;
      }
    }
  }
  throw new Error("HF Space stream ended without a transcript");
}

export async function probeHfSpaceAvailable(config: HfSpaceAsrConfig): Promise<{
  available: boolean;
  error?: string;
}> {
  // Public Spaces answer /gradio_api/info without a token. Prefer probing reachability
  // first so Admin does not block solely because HF_TOKEN was not injected into the process.
  try {
    const response = await fetch(`${config.spaceUrl}/gradio_api/info`, {
      method: "GET",
      headers: authHeaders(config.hfToken),
      signal: AbortSignal.timeout(20_000),
    });
    if (response.ok) {
      return { available: true };
    }
    if (response.status === 401 || response.status === 403) {
      if (!config.hfToken) {
        return {
          available: false,
          error: `HF Space requires auth (${response.status}). Set HF_TOKEN in the root .env and restart the gateway.`,
        };
      }
      return {
        available: false,
        error: `HF Space rejected HF_TOKEN (${response.status}). Check the token at huggingface.co/settings/tokens.`,
      };
    }
    return {
      available: false,
      error: `HF Space unreachable (${response.status}) at ${config.spaceUrl}`,
    };
  } catch (error) {
    return {
      available: false,
      error: error instanceof Error ? error.message : "HF Space probe failed",
    };
  }
}

export class HfSpaceAsrProvider implements SttProvider {
  readonly name = "hf-space";

  constructor(private readonly config: HfSpaceAsrConfig) {}

  async transcribe(filePath: string, options?: VoiceTranscribeOptions): Promise<TranscriptArtifact> {
    const sessionHash = randomUUID().replace(/-/g, "");
    const uploaded = await uploadAudio(this.config, filePath);
    const fileData = {
      path: uploaded.path,
      meta: { _type: "gradio.FileData" },
      orig_name: uploaded.orig_name,
      mime_type: uploaded.mime_type,
      size: uploaded.size,
    };
    await joinQueue(this.config, sessionHash, fileData);
    const text = (await waitForResult(this.config, sessionHash)).trim();
    if (!text) {
      throw new Error("HF Space returned an empty transcript");
    }

    const transcript: TranscriptArtifact = {
      language: options?.language ?? "bn",
      text,
      confidence: null,
      segments: [
        {
          startSec: 0,
          endSec: 0,
          text,
          speaker: null,
        },
      ],
      provider: this.name,
      model: this.config.spaceId,
    };
    return normalizeTranscript(transcript);
  }
}
