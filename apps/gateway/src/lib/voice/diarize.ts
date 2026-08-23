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

function countSpeakers(segments: TranscriptSegment[]): number {
  return new Set(segments.map((segment) => segment.speaker).filter(Boolean)).size;
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

/** Last resort: ASR each diarization clip when overlap merge cannot split speakers. */
async function transcribePerTurn(input: {
  audioPath: string;
  stt: SttProvider;
  turns: DiarizationTurn[];
  language?: string;
  initialPrompt?: string;
}): Promise<TranscriptSegment[]> {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "mf-diarize-"));
  const segments: TranscriptSegment[] = [];

  try {
    for (let i = 0; i < input.turns.length; i += 1) {
      const turn = input.turns[i]!;
      if (turn.end - turn.start < 0.35) continue;
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
      const partial = await input.stt.transcribe(clipPath, {
        language: input.language,
        initialPrompt: input.initialPrompt,
      });
      const text = partial.text.trim();
      if (!text) continue;
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

  return segments;
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

/**
 * Full-file ASR + pyannote diarization aligned by timestamp overlap.
 * Falls back to plain ASR when diarization is disabled or yields no turns.
 */
export async function transcribeWithDiarization(input: {
  audioPath: string;
  stt: SttProvider;
  diarization: DiarizationConfig;
  language?: string;
  initialPrompt?: string;
}): Promise<TranscriptArtifact> {
  const plain = await input.stt.transcribe(input.audioPath, {
    language: input.language,
    initialPrompt: input.initialPrompt,
  });

  if (!input.diarization.enabled) {
    return plain;
  }

  let rawTurns: DiarizationTurn[];
  try {
    rawTurns = await runDiarization(input.audioPath, input.diarization);
  } catch (error) {
    console.warn(
      "[voice.diarize] failed — returning ASR without speaker labels:",
      error instanceof Error ? error.message : error,
    );
    return {
      ...plain,
      provider: `${plain.provider}+diarize-failed`,
    };
  }

  const turns = coalesceTurns(rawTurns);
  if (turns.length === 0) {
    return {
      ...plain,
      provider: `${plain.provider}+diarize-empty`,
    };
  }

  let labeledSegments = mergeAsrSegmentsIntoTurns(plain.segments, turns);
  if (labeledSegments.length === 0) {
    labeledSegments = assignSpeakersToSegments(plain.segments, turns);
  }

  let speakerIds = [
    ...new Set(
      labeledSegments
        .map((segment) => segment.speaker)
        .filter((speaker): speaker is string => Boolean(speaker)),
    ),
  ];

  const duplicatedText = hasDuplicatedTurnText(labeledSegments);
  const needsPerTurnAsr =
    turns.length >= 2 &&
    (plain.segments.length <= 1 ||
      labeledSegments.length <= 1 ||
      countSpeakers(labeledSegments) < 2 ||
      duplicatedText);

  if (needsPerTurnAsr) {
    // Do NOT pass initialPrompt into tiny clips — it gets regurgitated as the whole turn text.
    const perTurn = await transcribePerTurn({
      audioPath: input.audioPath,
      stt: input.stt,
      turns,
      language: input.language,
    });
    const perTurnDuped = hasDuplicatedTurnText(perTurn);
    if (perTurn.length > 0 && !perTurnDuped) {
      labeledSegments = perTurn;
      speakerIds = [
        ...new Set(
          labeledSegments
            .map((segment) => segment.speaker)
            .filter((speaker): speaker is string => Boolean(speaker)),
        ),
      ];
    } else if (duplicatedText) {
      // Prefer time-sliced full-file ASR over identical per-turn hallucinations.
      labeledSegments = mergeAsrSegmentsIntoTurns(plain.segments, turns);
      speakerIds = [
        ...new Set(
          labeledSegments
            .map((segment) => segment.speaker)
            .filter((speaker): speaker is string => Boolean(speaker)),
        ),
      ];
    } else if (perTurn.length > 0) {
      labeledSegments = perTurn;
      speakerIds = [
        ...new Set(
          labeledSegments
            .map((segment) => segment.speaker)
            .filter((speaker): speaker is string => Boolean(speaker)),
        ),
      ];
    }
  }

  // Final safety: collapse consecutive identical texts into one bubble.
  labeledSegments = collapseDuplicateAdjacentText(labeledSegments);

  console.log(
    JSON.stringify({
      event: "voice.diarize.aligned",
      turnCount: turns.length,
      asrSegmentCount: plain.segments.length,
      segmentCount: labeledSegments.length,
      speakerCount: speakerIds.length,
      speakers: speakerIds,
      duplicatedText,
      strategy: needsPerTurnAsr ? "per-turn-asr" : "turn-merge",
    }),
  );

  return normalizeTranscript({
    ...plain,
    text: labeledSegments.map((segment) => segment.text).join(" ") || plain.text,
    segments: labeledSegments,
    provider: `${plain.provider}+pyannote`,
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
