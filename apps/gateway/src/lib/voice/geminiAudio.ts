/**
 * Gemini multimodal voice bypass — send audio directly to Gemini for
 * ASR + speaker diarization (+ optional analysis) in a single generateContent call.
 * Uses native Generative Language API (not OpenAI-compat) so audio tokens are returned.
 */
import path from "node:path";
import { prisma } from "@modelforge/db";
import { decryptProviderSecret } from "../providerCredentials.js";
import { getActivePricingVersion } from "../pricing.js";
import { normalizeTranscript, type TranscriptArtifact, type TranscriptSegment } from "./types.js";
import { toPublicTranscript } from "./diarize.js";

const GEMINI_API_ROOT = "https://generativelanguage.googleapis.com";
/** Prefer Files API above this size — inline base64 bloats the request. */
const INLINE_MAX_BYTES = 15 * 1024 * 1024;

export type GeminiVoiceMode = "transcribe" | "analyze";

export interface GeminiVoiceUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface GeminiVoiceResult {
  transcript: TranscriptArtifact;
  publicTranscript: ReturnType<typeof toPublicTranscript>;
  analysis: string;
  usage: GeminiVoiceUsage;
  /** Upstream Gemini model id (e.g. gemini-2.5-flash). */
  upstreamModel: string;
  /** HostedModel.modelId when resolved from registry; else gemini:{upstream}. */
  modelSlug: string;
  hostedModelId?: string;
  pricePerMTokIn?: number;
  pricePerMTokOut?: number;
  pricingVersionId?: string;
  latencyMs: number;
}

export function isGeminiVoicePipeline(): boolean {
  const v = (process.env.VOICE_PIPELINE ?? "").trim().toLowerCase();
  return v === "gemini" || v === "gemini-audio" || v === "bypass";
}

function guessMime(fileName: string, headerMime?: string): string {
  const fromHeader = (headerMime ?? "").split(";")[0]?.trim().toLowerCase();
  if (fromHeader && fromHeader !== "application/octet-stream") return fromHeader;
  const ext = path.extname(fileName).toLowerCase();
  if (ext === ".wav") return "audio/wav";
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".m4a" || ext === ".aac") return "audio/mp4";
  if (ext === ".webm") return "audio/webm";
  if (ext === ".ogg") return "audio/ogg";
  if (ext === ".flac") return "audio/flac";
  return "audio/wav";
}

async function resolveGeminiVoiceAuth(): Promise<{
  apiKey: string;
  upstreamModel: string;
  modelSlug: string;
  hostedModelId?: string;
  pricePerMTokIn?: number;
  pricePerMTokOut?: number;
  pricingVersionId?: string;
}> {
  const envKey = process.env.GEMINI_API_KEY?.trim() || "";
  const envModel =
    process.env.GEMINI_VOICE_MODEL?.trim() ||
    process.env.GEMINI_MODEL?.trim() ||
    "gemini-2.5-flash";

  const platformDefault = await prisma.hostedModel.findFirst({
    where: { isPlatformDefault: true, providerKind: "OPENAI_COMPAT" },
    include: { credential: true },
  });
  const geminiHosted =
    platformDefault &&
    /generativelanguage\.googleapis\.com/i.test(platformDefault.remoteBaseUrl ?? "")
      ? platformDefault
      : await prisma.hostedModel.findFirst({
          where: {
            providerKind: "OPENAI_COMPAT",
            remoteBaseUrl: { contains: "generativelanguage.googleapis.com" },
          },
          include: { credential: true },
          orderBy: { updatedAt: "desc" },
        });
  const hosted = geminiHosted;

  let apiKey = envKey;
  if (hosted?.credential) {
    try {
      const decrypted = decryptProviderSecret(hosted.credential);
      if (decrypted.trim()) apiKey = decrypted.trim();
    } catch {
      /* keep env key */
    }
  }
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY missing — set it in .env or assign a Gemini ProviderCredential on a remote model",
    );
  }

  const upstreamModel =
    process.env.GEMINI_VOICE_MODEL?.trim() ||
    hosted?.remoteModelId?.trim() ||
    envModel;

  let pricingVersionId: string | undefined;
  let pricePerMTokIn: number | undefined;
  let pricePerMTokOut: number | undefined;
  if (hosted) {
    const pricing = await getActivePricingVersion(hosted.id);
    pricingVersionId = pricing.id;
    pricePerMTokIn = pricing.pricePerMTokIn;
    pricePerMTokOut = pricing.pricePerMTokOut;
  }

  return {
    apiKey,
    upstreamModel,
    modelSlug: hosted?.modelId ?? `gemini:${upstreamModel}`,
    hostedModelId: hosted?.id,
    pricePerMTokIn,
    pricePerMTokOut,
    pricingVersionId,
  };
}

interface GeminiFileRef {
  uri: string;
  mimeType: string;
  name?: string;
}

async function uploadGeminiFile(
  apiKey: string,
  audio: Buffer,
  mimeType: string,
  displayName: string,
): Promise<GeminiFileRef> {
  const start = await fetch(`${GEMINI_API_ROOT}/upload/v1beta/files?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: {
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(audio.byteLength),
      "X-Goog-Upload-Header-Content-Type": mimeType,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: displayName.slice(0, 120) } }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!start.ok) {
    const body = await start.text().catch(() => "");
    throw new Error(`Gemini file upload start failed (${start.status}): ${body.slice(0, 400)}`);
  }
  const uploadUrl = start.headers.get("x-goog-upload-url");
  if (!uploadUrl) {
    throw new Error("Gemini file upload did not return x-goog-upload-url");
  }

  const put = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Length": String(audio.byteLength),
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize",
    },
    body: new Uint8Array(audio),
    signal: AbortSignal.timeout(600_000),
  });
  if (!put.ok) {
    const body = await put.text().catch(() => "");
    throw new Error(`Gemini file upload failed (${put.status}): ${body.slice(0, 400)}`);
  }
  const payload = (await put.json()) as {
    file?: { uri?: string; mimeType?: string; name?: string; state?: string };
  };
  const file = payload.file;
  if (!file?.uri) {
    throw new Error(`Gemini file upload returned no uri: ${JSON.stringify(payload).slice(0, 300)}`);
  }

  // Wait until ACTIVE (processing).
  const name = file.name;
  if (name && file.state && file.state !== "ACTIVE") {
    for (let i = 0; i < 60; i += 1) {
      await new Promise((r) => setTimeout(r, 1000));
      const poll = await fetch(
        `${GEMINI_API_ROOT}/v1beta/${name}?key=${encodeURIComponent(apiKey)}`,
        { signal: AbortSignal.timeout(30_000) },
      );
      if (!poll.ok) continue;
      const meta = (await poll.json()) as { state?: string; uri?: string; mimeType?: string };
      if (meta.state === "ACTIVE") {
        return { uri: meta.uri || file.uri, mimeType: meta.mimeType || mimeType, name };
      }
      if (meta.state === "FAILED") {
        throw new Error("Gemini file processing failed");
      }
    }
  }

  return { uri: file.uri, mimeType: file.mimeType || mimeType, name: file.name };
}

async function deleteGeminiFile(apiKey: string, name?: string): Promise<void> {
  if (!name) return;
  try {
    await fetch(`${GEMINI_API_ROOT}/v1beta/${name}?key=${encodeURIComponent(apiKey)}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    /* best-effort cleanup */
  }
}

function buildSystemPrompt(mode: GeminiVoiceMode, languageHint?: string): string {
  const lang = languageHint?.trim() || "bn";
  const analysisRule =
    mode === "analyze"
      ? `Also set "analysis" to a concise investigator-facing summary (speakers, topics, phone numbers/names mentioned, actionable items). Use the same language as the call when possible.`
      : `Set "analysis" to an empty string.`;

  return `You are an investigative call ASR + diarization engine.
Listen to the audio and return ONLY valid JSON (no markdown) with this shape:
{
  "language": "${lang}",
  "segments": [
    { "speaker": "SPEAKER_00", "startSec": 0.0, "endSec": 1.2, "text": "..." }
  ],
  "text": "full transcript concatenating segments in order",
  "analysis": "..."
}

Rules:
- Transcribe faithfully (Bangla / Bangla–English code-switch OK). Do not invent words.
- Diarize speakers as SPEAKER_00, SPEAKER_01, … (two-party calls are common).
- startSec/endSec are approximate seconds from the start of the file.
- Keep street register; do not over-normalize dialect.
- ${analysisRule}
- If audio is silent/unusable, return empty segments and text "".`;
}

export function parseGeminiVoiceJson(raw: string): {
  language: string;
  text: string;
  segments: TranscriptSegment[];
  analysis: string;
} {
  let cleaned = (raw || "").trim();
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) cleaned = fence[1]!.trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("Gemini voice response did not contain a JSON object");
  }
  const parsed = JSON.parse(cleaned.slice(start, end + 1)) as {
    language?: string;
    text?: string;
    analysis?: string;
    segments?: Array<{
      speaker?: string;
      startSec?: number;
      start?: number;
      endSec?: number;
      end?: number;
      text?: string;
    }>;
  };

  const segments: TranscriptSegment[] = (parsed.segments ?? [])
    .map((s) => {
      const startSec = Number(s.startSec ?? s.start ?? 0);
      const endSec = Number(s.endSec ?? s.end ?? startSec);
      const text = String(s.text ?? "").replace(/\s+/g, " ").trim();
      const speaker = String(s.speaker ?? "SPEAKER_00").trim() || "SPEAKER_00";
      return { startSec, endSec: Math.max(endSec, startSec), text, speaker };
    })
    .filter((s) => s.text.length > 0);

  const text =
    String(parsed.text ?? "")
      .replace(/\s+/g, " ")
      .trim() || segments.map((s) => s.text).join(" ").trim();

  return {
    language: String(parsed.language ?? "bn").trim() || "bn",
    text,
    segments,
    analysis: String(parsed.analysis ?? "").trim(),
  };
}

export async function runGeminiVoicePipeline(input: {
  audioBuffer: Buffer;
  fileName: string;
  mimeType?: string;
  mode: GeminiVoiceMode;
  languageHint?: string;
  analysisHint?: string;
}): Promise<GeminiVoiceResult> {
  const auth = await resolveGeminiVoiceAuth();
  const mimeType = guessMime(input.fileName, input.mimeType);
  const started = Date.now();

  let fileRef: GeminiFileRef | null = null;
  let inlinePart: { inline_data: { mime_type: string; data: string } } | null = null;

  try {
    if (input.audioBuffer.byteLength <= INLINE_MAX_BYTES) {
      inlinePart = {
        inline_data: {
          mime_type: mimeType,
          data: input.audioBuffer.toString("base64"),
        },
      };
    } else {
      fileRef = await uploadGeminiFile(auth.apiKey, input.audioBuffer, mimeType, input.fileName);
    }

    const userBits = [
      "Transcribe and diarize this call audio.",
      input.languageHint ? `Language hint: ${input.languageHint}` : "",
      input.mode === "analyze" && input.analysisHint
        ? `Analysis focus: ${input.analysisHint}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");

    const parts: Array<Record<string, unknown>> = [{ text: userBits }];
    if (inlinePart) {
      parts.push(inlinePart);
    } else if (fileRef) {
      parts.push({
        file_data: {
          file_uri: fileRef.uri,
          mime_type: fileRef.mimeType,
        },
      });
    }

    const url = `${GEMINI_API_ROOT}/v1beta/models/${encodeURIComponent(auth.upstreamModel)}:generateContent?key=${encodeURIComponent(auth.apiKey)}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: buildSystemPrompt(input.mode, input.languageHint) }],
        },
        contents: [{ role: "user", parts }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: Number(process.env.GEMINI_VOICE_MAX_OUTPUT_TOKENS ?? 8192),
          responseMimeType: "application/json",
        },
      }),
      signal: AbortSignal.timeout(Number(process.env.GEMINI_VOICE_TIMEOUT_MS ?? 600_000)),
    });

    const bodyText = await response.text();
    if (!response.ok) {
      throw new Error(`Gemini generateContent failed (${response.status}): ${bodyText.slice(0, 600)}`);
    }

    const body = JSON.parse(bodyText) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        totalTokenCount?: number;
      };
    };

    const textParts = body.candidates?.[0]?.content?.parts ?? [];
    const raw = textParts.map((p) => p.text ?? "").join("\n").trim();
    if (!raw) {
      throw new Error("Gemini returned an empty voice response");
    }

    const parsed = parseGeminiVoiceJson(raw);
    const transcript = normalizeTranscript({
      language: parsed.language,
      text: parsed.text,
      confidence: null,
      segments:
        parsed.segments.length > 0
          ? parsed.segments
          : parsed.text
            ? [{ startSec: 0, endSec: 0, text: parsed.text, speaker: "SPEAKER_00" }]
            : [],
      provider: "gemini",
      model: auth.upstreamModel,
    });

    const usageMeta = body.usageMetadata ?? {};
    let promptTokens = Math.max(0, Number(usageMeta.promptTokenCount ?? 0));
    let completionTokens = Math.max(0, Number(usageMeta.candidatesTokenCount ?? 0));
    if (promptTokens + completionTokens === 0) {
      // Fallback estimate — audio dominates; still record something for the ledger.
      promptTokens = Math.max(1, Math.ceil(input.audioBuffer.byteLength / 1024));
      completionTokens = Math.max(1, Math.ceil(raw.length / 4));
    }

    return {
      transcript,
      publicTranscript: toPublicTranscript(transcript),
      analysis: input.mode === "analyze" ? parsed.analysis : "",
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: Math.max(
          promptTokens + completionTokens,
          Number(usageMeta.totalTokenCount ?? 0),
        ),
      },
      upstreamModel: auth.upstreamModel,
      modelSlug: auth.modelSlug,
      hostedModelId: auth.hostedModelId,
      pricePerMTokIn: auth.pricePerMTokIn,
      pricePerMTokOut: auth.pricePerMTokOut,
      pricingVersionId: auth.pricingVersionId,
      latencyMs: Date.now() - started,
    };
  } finally {
    await deleteGeminiFile(auth.apiKey, fileRef?.name);
  }
}
