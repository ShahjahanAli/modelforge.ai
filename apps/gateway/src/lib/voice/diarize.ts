import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { SttProvider, TranscriptArtifact, TranscriptSegment } from "./types.js";
import { normalizeTranscript } from "./types.js";

const execFileAsync = promisify(execFile);

function projectRoot(): string {
  return path.resolve(import.meta.dirname, "../../../../..");
}

function resolveScriptPath(inputPath: string): string {
  if (path.isAbsolute(inputPath)) return inputPath;
  return path.resolve(projectRoot(), inputPath);
}

export interface DiarizationTurn {
  start: number;
  end: number;
  speaker: string;
}

export interface DiarizationConfig {
  enabled: boolean;
  pythonBin: string;
  scriptPath: string;
  model: string;
  device: "cpu" | "cuda";
  minSpeakers?: number;
  maxSpeakers?: number;
}

function parseJsonLine(stdout: string, stderr: string): Record<string, unknown> {
  const line = [...stdout.split(/\r?\n/), ...stderr.split(/\r?\n/)]
    .map((part) => part.trim())
    .filter((part) => part.startsWith("{"))
    .at(-1);
  if (!line) throw new Error("Empty diarization output");
  return JSON.parse(line) as Record<string, unknown>;
}

export async function checkPyannoteAvailable(input: {
  pythonBin: string;
  scriptPath: string;
}): Promise<{ available: boolean; error?: string; executable?: string }> {
  const scriptPath = resolveScriptPath(input.scriptPath);
  try {
    const { stdout, stderr } = await execFileAsync(input.pythonBin, [scriptPath, "--check"], {
      maxBuffer: 4 * 1024 * 1024,
      timeout: 120_000,
      env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
    });
    const parsed = parseJsonLine(stdout, stderr);
    return {
      available: parsed.pyannoteAvailable === true,
      error: typeof parsed.error === "string" ? parsed.error : undefined,
      executable: typeof parsed.executable === "string" ? parsed.executable : undefined,
    };
  } catch (error) {
    return {
      available: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runDiarization(
  audioPath: string,
  config: DiarizationConfig,
): Promise<DiarizationTurn[]> {
  const scriptPath = resolveScriptPath(config.scriptPath);
  const args = [
    scriptPath,
    "--audio",
    audioPath,
    "--model",
    config.model,
    "--device",
    config.device,
  ];
  if (config.minSpeakers != null) args.push("--min-speakers", String(config.minSpeakers));
  if (config.maxSpeakers != null) args.push("--max-speakers", String(config.maxSpeakers));

  const { stdout, stderr } = await execFileAsync(config.pythonBin, args, {
    maxBuffer: 20 * 1024 * 1024,
    timeout: 60 * 60 * 1000,
    env: {
      ...process.env,
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8",
    },
  });
  if (stderr?.trim()) {
    console.warn("[voice.diarize] stderr:", stderr.trim().slice(0, 2000));
  }
  const parsed = parseJsonLine(stdout, stderr);
  if (parsed.ok === false) {
    throw new Error(typeof parsed.error === "string" ? parsed.error : "Diarization failed");
  }
  const turns = Array.isArray(parsed.turns) ? (parsed.turns as DiarizationTurn[]) : [];
  return turns
    .map((turn) => ({
      start: Number(turn.start),
      end: Number(turn.end),
      speaker: String(turn.speaker),
    }))
    .filter((turn) => turn.end > turn.start);
}

/** Merge adjacent same-speaker turns separated by tiny gaps. */
export function coalesceTurns(turns: DiarizationTurn[], gapSec = 0.35): DiarizationTurn[] {
  if (turns.length === 0) return [];
  const sorted = [...turns].sort((a, b) => a.start - b.start);
  const out: DiarizationTurn[] = [{ ...sorted[0]! }];
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = out[out.length - 1]!;
    const cur = sorted[i]!;
    if (cur.speaker === prev.speaker && cur.start - prev.end <= gapSec) {
      prev.end = Math.max(prev.end, cur.end);
    } else {
      out.push({ ...cur });
    }
  }
  return out;
}

async function cutTurnWav(
  sourcePath: string,
  startSec: number,
  endSec: number,
  outPath: string,
): Promise<void> {
  const duration = Math.max(0.05, endSec - startSec);
  await execFileAsync(
    "ffmpeg",
    [
      "-y",
      "-ss",
      startSec.toFixed(3),
      "-i",
      sourcePath,
      "-t",
      duration.toFixed(3),
      "-ac",
      "1",
      "-ar",
      "16000",
      "-sample_fmt",
      "s16",
      outPath,
    ],
    { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 },
  );
}

/**
 * Diarize → cut each speaker turn → ASR each clip → speaker-labeled segments.
 * Falls back to plain ASR if diarization yields no usable turns.
 */
export async function transcribeWithDiarization(input: {
  audioPath: string;
  stt: SttProvider;
  diarization: DiarizationConfig;
  language?: string;
}): Promise<TranscriptArtifact> {
  if (!input.diarization.enabled) {
    return input.stt.transcribe(input.audioPath, { language: input.language });
  }

  const rawTurns = await runDiarization(input.audioPath, input.diarization);
  const turns = coalesceTurns(rawTurns);
  if (turns.length === 0) {
    const plain = await input.stt.transcribe(input.audioPath, { language: input.language });
    return {
      ...plain,
      provider: `${plain.provider}+diarize-empty`,
    };
  }

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "mf-diarize-"));
  const segments: TranscriptSegment[] = [];
  let language = "unknown";
  let model = "diarized";
  let confidenceSum = 0;
  let confidenceCount = 0;

  try {
    for (let i = 0; i < turns.length; i += 1) {
      const turn = turns[i]!;
      if (turn.end - turn.start < 0.4) continue;
      const clipPath = path.join(tmpDir, `turn-${String(i).padStart(4, "0")}.wav`);
      try {
        await cutTurnWav(input.audioPath, turn.start, turn.end, clipPath);
      } catch (error) {
        console.warn(
          `[voice.diarize] ffmpeg cut failed for turn ${i}:`,
          error instanceof Error ? error.message : error,
        );
        continue;
      }
      const partial = await input.stt.transcribe(clipPath, { language: input.language });
      const text = partial.text.trim();
      if (!text) continue;
      if (language === "unknown" && partial.language) language = partial.language;
      if (partial.model) model = partial.model;
      if (typeof partial.confidence === "number") {
        confidenceSum += partial.confidence;
        confidenceCount += 1;
      }
      segments.push({
        startSec: turn.start,
        endSec: turn.end,
        text,
        speaker: turn.speaker,
        confidence: partial.confidence ?? undefined,
      });
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }

  if (segments.length === 0) {
    return input.stt.transcribe(input.audioPath, { language: input.language });
  }

  return normalizeTranscript({
    language,
    text: segments.map((segment) => segment.text).join(" "),
    confidence: confidenceCount > 0 ? confidenceSum / confidenceCount : null,
    segments,
    provider: `${input.stt.name}+pyannote`,
    model,
  });
}

/** Public API shape: include start/end aliases for Anusandhan and other clients. */
export function toPublicTranscript(transcript: TranscriptArtifact) {
  return {
    ...transcript,
    speakers: [
      ...new Set(
        transcript.segments
          .map((segment) => segment.speaker)
          .filter((speaker): speaker is string => Boolean(speaker)),
      ),
    ],
    segments: transcript.segments.map((segment) => ({
      start: segment.startSec,
      end: segment.endSec,
      startSec: segment.startSec,
      endSec: segment.endSec,
      text: segment.text,
      speaker: segment.speaker ?? null,
      confidence: segment.confidence ?? null,
    })),
  };
}
