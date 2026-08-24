/**
 * pyannoteAI cloud diarization (Precision-2 / Community-1).
 * Upload local audio → media:// key → POST /v1/diarize → poll /v1/jobs/{id}.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { DiarizationTurn } from "./diarize.js";

const API_BASE = "https://api.pyannote.ai/v1";

export type PyannoteCloudModel = "precision-2" | "community-1";

export function resolvePyannoteCloudModel(raw: string | undefined): PyannoteCloudModel {
  const v = (raw ?? "precision-2").trim().toLowerCase();
  if (v.includes("community")) return "community-1";
  return "precision-2";
}

export async function checkPyannoteCloudAvailable(apiKey: string): Promise<{
  available: boolean;
  error?: string;
}> {
  const key = apiKey.trim();
  if (!key) return { available: false, error: "PYANNOTE_API_KEY missing" };
  try {
    const res = await fetch(`${API_BASE}/test`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const body = await res.text();
      return {
        available: false,
        error: `pyannoteAI test ${res.status}: ${body.slice(0, 200)}`,
      };
    }
    return { available: true };
  } catch (error) {
    return {
      available: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function createMediaInput(apiKey: string, objectKey: string): Promise<string> {
  const res = await fetch(`${API_BASE}/media/input`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ url: `media://${objectKey}` }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`pyannoteAI media/input ${res.status}: ${(await res.text()).slice(0, 400)}`);
  }
  const data = (await res.json()) as { url?: string };
  if (!data.url) throw new Error("pyannoteAI media/input returned no upload URL");
  return data.url;
}

async function putMedia(presignedUrl: string, audioPath: string): Promise<void> {
  const bytes = await readFile(audioPath);
  const res = await fetch(presignedUrl, {
    method: "PUT",
    headers: { "content-type": "application/octet-stream" },
    body: bytes,
    signal: AbortSignal.timeout(10 * 60_000),
  });
  if (!res.ok) {
    throw new Error(`pyannoteAI media upload ${res.status}: ${(await res.text()).slice(0, 400)}`);
  }
}

async function submitDiarizeJob(input: {
  apiKey: string;
  mediaUrl: string;
  model: PyannoteCloudModel;
  minSpeakers?: number;
  maxSpeakers?: number;
}): Promise<string> {
  const body: Record<string, unknown> = {
    url: input.mediaUrl,
    model: input.model,
    exclusive: true,
  };
  if (
    input.minSpeakers != null &&
    input.maxSpeakers != null &&
    input.minSpeakers === input.maxSpeakers &&
    input.minSpeakers > 0
  ) {
    body.numSpeakers = input.minSpeakers;
  } else {
    if (input.minSpeakers != null) body.minSpeakers = input.minSpeakers;
    if (input.maxSpeakers != null) body.maxSpeakers = input.maxSpeakers;
  }

  const res = await fetch(`${API_BASE}/diarize`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`pyannoteAI diarize ${res.status}: ${(await res.text()).slice(0, 400)}`);
  }
  const data = (await res.json()) as { jobId?: string; status?: string };
  if (!data.jobId) throw new Error("pyannoteAI diarize returned no jobId");
  return data.jobId;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseTurns(output: unknown): DiarizationTurn[] {
  if (!output || typeof output !== "object") return [];
  const obj = output as {
    exclusiveDiarization?: Array<{ speaker?: string; start?: number; end?: number }>;
    diarization?: Array<{ speaker?: string; start?: number; end?: number }>;
  };
  const rows = Array.isArray(obj.exclusiveDiarization)
    ? obj.exclusiveDiarization
    : Array.isArray(obj.diarization)
      ? obj.diarization
      : [];
  return rows
    .map((row) => ({
      start: Number(row.start),
      end: Number(row.end),
      speaker: String(row.speaker ?? "SPEAKER_00"),
    }))
    .filter((turn) => Number.isFinite(turn.start) && Number.isFinite(turn.end) && turn.end > turn.start);
}

async function pollJob(apiKey: string, jobId: string, timeoutMs = 30 * 60_000): Promise<DiarizationTurn[]> {
  const started = Date.now();
  let delayMs = 2_000;
  while (Date.now() - started < timeoutMs) {
    const res = await fetch(`${API_BASE}/jobs/${encodeURIComponent(jobId)}`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      throw new Error(`pyannoteAI job ${res.status}: ${(await res.text()).slice(0, 400)}`);
    }
    const data = (await res.json()) as {
      status?: string;
      output?: unknown;
    };
    const status = data.status ?? "";
    if (status === "succeeded") {
      const turns = parseTurns(data.output);
      if (turns.length === 0) {
        throw new Error("pyannoteAI job succeeded but returned no diarization segments");
      }
      return turns;
    }
    if (status === "failed" || status === "canceled") {
      const err =
        data.output && typeof data.output === "object" && "error" in data.output
          ? String((data.output as { error?: string }).error ?? status)
          : status;
      throw new Error(`pyannoteAI job ${err}`);
    }
    await sleep(delayMs);
    delayMs = Math.min(10_000, Math.round(delayMs * 1.35));
  }
  throw new Error(`pyannoteAI job timed out after ${Math.round(timeoutMs / 1000)}s`);
}

/** Upload local audio and run cloud diarization (Precision-2 by default). */
export async function runPyannoteCloudDiarization(input: {
  audioPath: string;
  apiKey: string;
  model?: string;
  minSpeakers?: number;
  maxSpeakers?: number;
}): Promise<DiarizationTurn[]> {
  const apiKey = input.apiKey.trim();
  if (!apiKey) throw new Error("PYANNOTE_API_KEY is required for cloud diarization");

  const cloudModel = resolvePyannoteCloudModel(input.model);
  const base = path.basename(input.audioPath).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
  const objectKey = `modelforge/${Date.now()}-${randomUUID().slice(0, 8)}-${base}`;

  console.info(
    JSON.stringify({
      event: "voice.diarize.cloud.upload",
      objectKey,
      model: cloudModel,
    }),
  );

  const presigned = await createMediaInput(apiKey, objectKey);
  await putMedia(presigned, input.audioPath);
  const jobId = await submitDiarizeJob({
    apiKey,
    mediaUrl: `media://${objectKey}`,
    model: cloudModel,
    minSpeakers: input.minSpeakers,
    maxSpeakers: input.maxSpeakers,
  });

  console.info(
    JSON.stringify({
      event: "voice.diarize.cloud.job",
      jobId,
      model: cloudModel,
    }),
  );

  const turns = await pollJob(apiKey, jobId);
  console.info(
    JSON.stringify({
      event: "voice.diarize.cloud.done",
      jobId,
      turnCount: turns.length,
      speakers: [...new Set(turns.map((t) => t.speaker))],
    }),
  );
  return turns;
}
