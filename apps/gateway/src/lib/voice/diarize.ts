import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { SttProvider, TranscriptArtifact, TranscriptSegment } from "./types.js";
import { normalizeTranscript } from "./types.js";
import { runPyannoteCloudDiarization } from "./pyannoteCloud.js";

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
  /** local = pyannote.audio script; cloud = pyannoteAI API (Precision-2). */
  backend: "local" | "cloud";
  /** Primary strategy: diarize first, ASR each turn (recommended). */
  mode: "per-turn" | "merge";
  pythonBin: string;
  scriptPath: string;
  /** Local HF model id, or cloud model alias (precision-2 / community-1). */
  model: string;
  device: "cpu" | "cuda";
  minSpeakers?: number;
  maxSpeakers?: number;
  /** pyannoteAI API key (cloud backend). */
  apiKey?: string;
  /** Expand each turn before ffmpeg cut (ms). */
  turnPadMs?: number;
  /** Parallel per-turn ASR jobs. */
  asrConcurrency?: number;
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
  if (config.backend === "cloud") {
    return runPyannoteCloudDiarization({
      audioPath,
      apiKey: config.apiKey ?? "",
      model: config.model,
      minSpeakers: config.minSpeakers,
      maxSpeakers: config.maxSpeakers,
    });
  }

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

/** Overlap duration between an ASR segment and a diarization turn (seconds). */
export function segmentTurnOverlap(
  segStart: number,
  segEnd: number,
  turnStart: number,
  turnEnd: number,
): number {
  return Math.max(0, Math.min(segEnd, turnEnd) - Math.max(segStart, turnStart));
}

/**
 * Assign pyannote speaker labels to full-file ASR segments by timestamp overlap.
 * Commercial stacks transcribe once, then align diarization — not ASR-per-turn.
 */
export function assignSpeakersToSegments(
  segments: TranscriptSegment[],
  turns: DiarizationTurn[],
): TranscriptSegment[] {
  if (turns.length === 0) return segments;

  const sortedTurns = [...turns].sort((a, b) => a.start - b.start);

  return segments.map((segment) => {
    let bestSpeaker: string | null = null;
    let bestOverlap = 0;

    for (const turn of sortedTurns) {
      const overlap = segmentTurnOverlap(
        segment.startSec,
        segment.endSec,
        turn.start,
        turn.end,
      );
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestSpeaker = turn.speaker;
      }
    }

    if (!bestSpeaker || bestOverlap <= 0) {
      const mid = (segment.startSec + segment.endSec) / 2;
      for (const turn of sortedTurns) {
        if (mid >= turn.start && mid <= turn.end) {
          bestSpeaker = turn.speaker;
          break;
        }
      }
      if (!bestSpeaker) {
        let bestDist = Infinity;
        for (const turn of sortedTurns) {
          const dist =
            mid < turn.start ? turn.start - mid : mid > turn.end ? mid - turn.end : 0;
          if (dist < bestDist) {
            bestDist = dist;
            bestSpeaker = turn.speaker;
          }
        }
      }
    }

    return { ...segment, speaker: bestSpeaker };
  });
}

/**
 * Approximate the portion of `text` that falls inside [sliceStart, sliceEnd]
 * within a longer ASR span [segStart, segEnd]. Uses word boundaries.
 */
export function sliceTextByTimeOverlap(
  text: string,
  segStart: number,
  segEnd: number,
  sliceStart: number,
  sliceEnd: number,
): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  const segDur = Math.max(0.01, segEnd - segStart);
  const overlapStart = Math.max(segStart, sliceStart);
  const overlapEnd = Math.min(segEnd, sliceEnd);
  if (overlapEnd <= overlapStart) return "";

  // If the ASR span is mostly inside this turn, keep the whole text.
  const overlap = overlapEnd - overlapStart;
  if (overlap / segDur >= 0.85) return words.join(" ");

  const startRatio = (overlapStart - segStart) / segDur;
  const endRatio = (overlapEnd - segStart) / segDur;
  let i0 = Math.floor(startRatio * words.length);
  let i1 = Math.ceil(endRatio * words.length);
  i0 = Math.max(0, Math.min(words.length - 1, i0));
  i1 = Math.max(i0 + 1, Math.min(words.length, i1));
  return words.slice(i0, i1).join(" ").trim();
}

/**
 * Build one transcript segment per diarization turn by joining overlapping ASR spans.
 * Long Whisper segments that span many turns are time-sliced — never pasted whole onto each turn.
 */
export function mergeAsrSegmentsIntoTurns(
  segments: TranscriptSegment[],
  turns: DiarizationTurn[],
): TranscriptSegment[] {
  if (turns.length === 0) return segments;

  const sortedTurns = [...turns].sort((a, b) => a.start - b.start);
  const out: TranscriptSegment[] = [];

  for (const turn of sortedTurns) {
    const parts: string[] = [];
    const overlapping = segments
      .filter(
        (segment) =>
          segmentTurnOverlap(segment.startSec, segment.endSec, turn.start, turn.end) > 0.05,
      )
      .sort((a, b) => a.startSec - b.startSec);

    for (const segment of overlapping) {
      const sliced = sliceTextByTimeOverlap(
        segment.text,
        segment.startSec,
        segment.endSec,
        turn.start,
        turn.end,
      );
      if (sliced) parts.push(sliced);
    }

    if (parts.length === 0) continue;

    out.push({
      startSec: turn.start,
      endSec: turn.end,
      text: parts.join(" ").replace(/\s+/g, " ").trim(),
      speaker: turn.speaker,
    });
  }

  return out.filter((segment) => segment.text.length > 0);
}

/** True when many turns share the exact same (or near-identical) text — classic merge bug. */
export function hasDuplicatedTurnText(segments: TranscriptSegment[], minDupes = 3): boolean {
  if (segments.length < minDupes) return false;
  const counts = new Map<string, number>();
  for (const segment of segments) {
    const key = segment.text.replace(/\s+/g, " ").trim();
    if (key.length < 20) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const count of counts.values()) {
    if (count >= minDupes) return true;
  }
  return false;
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

/** Diarize-first: ASR each diarization clip (padded), then combine chronologically. */
async function transcribePerTurn(input: {
  audioPath: string;
  stt: SttProvider;
  turns: DiarizationTurn[];
  language?: string;
  turnPadMs?: number;
  concurrency?: number;
}): Promise<{ segments: TranscriptSegment[]; model: string; language: string }> {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "mf-diarize-"));
  const padSec = Math.max(0, (input.turnPadMs ?? 200) / 1000);
  const concurrency = Math.max(1, Math.min(8, input.concurrency ?? 2));
  const eligible = input.turns
    .map((turn, index) => ({ turn, index }))
    .filter(({ turn }) => turn.end - turn.start >= 0.35);

  const results: Array<TranscriptSegment | null> = new Array(eligible.length).fill(null);
  let model = "unknown";
  let language = input.language ?? "unknown";

  try {
    let next = 0;
    async function worker() {
      while (next < eligible.length) {
        const slot = next;
        next += 1;
        const item = eligible[slot]!;
        const turn = item.turn;
        const cutStart = Math.max(0, turn.start - padSec);
        const cutEnd = turn.end + padSec;
        const clipPath = path.join(tmpDir, `turn-${String(item.index).padStart(4, "0")}.wav`);
        try {
          await cutTurnWav(input.audioPath, cutStart, cutEnd, clipPath);
        } catch (error) {
          console.warn(
            `[voice.diarize] ffmpeg cut failed for turn ${item.index}:`,
            error instanceof Error ? error.message : error,
          );
          continue;
        }
        try {
          // Do NOT pass initialPrompt into tiny clips — it gets regurgitated as the whole turn.
          const partial = await input.stt.transcribe(clipPath, {
            language: input.language,
            conditionOnPreviousText: false,
          });
          model = partial.model || model;
          language = partial.language || language;
          const text = partial.text.trim();
          if (!text) continue;
          results[slot] = {
            startSec: turn.start,
            endSec: turn.end,
            text,
            speaker: turn.speaker,
            confidence: partial.confidence ?? undefined,
          };
        } catch (error) {
          console.warn(
            `[voice.diarize] per-turn ASR failed for turn ${item.index}:`,
            error instanceof Error ? error.message : error,
          );
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, eligible.length) }, () => worker()));
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }

  const segments = results
    .filter((segment): segment is TranscriptSegment => Boolean(segment))
    .sort((a, b) => a.startSec - b.startSec);

  return { segments, model, language };
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

function diarizeProviderTag(config: DiarizationConfig): string {
  if (config.backend === "cloud") {
    return config.model.toLowerCase().includes("community")
      ? "pyannoteAI-community-1"
      : "pyannoteAI-precision-2";
  }
  return "pyannote-local";
}

/**
 * Diarize first (local pyannote or pyannoteAI cloud), then ASR each turn and combine.
 * Falls back to full-file ASR + turn merge when per-turn ASR yields nothing.
 */
export async function transcribeWithDiarization(input: {
  audioPath: string;
  stt: SttProvider;
  diarization: DiarizationConfig;
  language?: string;
  initialPrompt?: string;
}): Promise<TranscriptArtifact> {
  if (!input.diarization.enabled) {
    return input.stt.transcribe(input.audioPath, {
      language: input.language,
      initialPrompt: input.initialPrompt,
    });
  }

  let rawTurns: DiarizationTurn[];
  try {
    rawTurns = await runDiarization(input.audioPath, input.diarization);
  } catch (error) {
    console.warn(
      "[voice.diarize] failed — falling back to full-file ASR without speaker labels:",
      error instanceof Error ? error.message : error,
    );
    const plain = await input.stt.transcribe(input.audioPath, {
      language: input.language,
      initialPrompt: input.initialPrompt,
    });
    return {
      ...plain,
      provider: `${plain.provider}+diarize-failed`,
    };
  }

  const turns = coalesceTurns(rawTurns);
  if (turns.length === 0) {
    const plain = await input.stt.transcribe(input.audioPath, {
      language: input.language,
      initialPrompt: input.initialPrompt,
    });
    return {
      ...plain,
      provider: `${plain.provider}+diarize-empty`,
    };
  }

  const mode = input.diarization.mode ?? "per-turn";
  const tag = diarizeProviderTag(input.diarization);
  let labeledSegments: TranscriptSegment[] = [];
  let strategy: "per-turn-asr" | "turn-merge" | "assign-overlap" = "per-turn-asr";
  let sttModel = "unknown";
  let language = input.language ?? "unknown";
  let confidence: number | null = null;

  if (mode === "per-turn") {
    const perTurn = await transcribePerTurn({
      audioPath: input.audioPath,
      stt: input.stt,
      turns,
      language: input.language,
      turnPadMs: input.diarization.turnPadMs,
      concurrency: input.diarization.asrConcurrency,
    });
    if (perTurn.segments.length > 0 && !hasDuplicatedTurnText(perTurn.segments)) {
      labeledSegments = collapseDuplicateAdjacentText(perTurn.segments);
      sttModel = perTurn.model;
      language = perTurn.language;
      strategy = "per-turn-asr";
    } else if (perTurn.segments.length > 0) {
      // Prefer chronological per-turn even if some duplication — still better for chat UI.
      labeledSegments = collapseDuplicateAdjacentText(perTurn.segments);
      sttModel = perTurn.model;
      language = perTurn.language;
      strategy = "per-turn-asr";
    }
  }

  if (labeledSegments.length === 0) {
    const plain = await input.stt.transcribe(input.audioPath, {
      language: input.language,
      initialPrompt: input.initialPrompt,
    });
    sttModel = plain.model;
    language = plain.language;
    confidence = plain.confidence;
    labeledSegments = mergeAsrSegmentsIntoTurns(plain.segments, turns);
    strategy = "turn-merge";
    if (labeledSegments.length === 0) {
      labeledSegments = assignSpeakersToSegments(plain.segments, turns);
      strategy = "assign-overlap";
    }
    labeledSegments = collapseDuplicateAdjacentText(labeledSegments);
  }

  const speakerIds = [
    ...new Set(
      labeledSegments
        .map((segment) => segment.speaker)
        .filter((speaker): speaker is string => Boolean(speaker)),
    ),
  ];

  console.log(
    JSON.stringify({
      event: "voice.diarize.aligned",
      backend: input.diarization.backend,
      mode,
      strategy,
      turnCount: turns.length,
      segmentCount: labeledSegments.length,
      speakerCount: speakerIds.length,
      speakers: speakerIds,
    }),
  );

  return normalizeTranscript({
    language,
    text: labeledSegments.map((segment) => segment.text).join(" "),
    confidence,
    model: sttModel,
    segments: labeledSegments,
    provider: `${input.stt.name}+${tag}`,
  });
}

/** Drop consecutive bubbles that regurgitate the same long string. */
export function collapseDuplicateAdjacentText(segments: TranscriptSegment[]): TranscriptSegment[] {
  if (segments.length === 0) return segments;
  const out: TranscriptSegment[] = [];
  for (const segment of segments) {
    const prev = out[out.length - 1];
    const cur = segment.text.replace(/\s+/g, " ").trim();
    const prevText = prev?.text.replace(/\s+/g, " ").trim() ?? "";
    if (prev && cur.length >= 40 && cur === prevText) {
      prev.endSec = Math.max(prev.endSec, segment.endSec);
      continue;
    }
    out.push({ ...segment });
  }
  return out;
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
