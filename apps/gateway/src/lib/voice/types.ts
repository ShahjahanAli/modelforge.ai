export interface TranscriptSegment {
  startSec: number;
  endSec: number;
  text: string;
  /** English translation of this turn (optional; Gemini voice). */
  textEn?: string | null;
  confidence?: number;
  speaker?: string | null;
  /** Stable diarization id when speaker was remapped to a spoken name. */
  speakerId?: string | null;
}

export interface TranscriptArtifact {
  language: string;
  text: string;
  /** Full-call English translation (optional; Gemini voice). */
  textEn?: string | null;
  /**
   * Dialect / regiolect hint from Gemini (e.g. chittagong, sylhet, standard_bangla).
   * Analyst hint only — not a certified classifier.
   */
  dialectHint?: string | null;
  /** Human label e.g. "Chittagong" / "Sylhet". */
  dialectLabel?: string | null;
  /** Spoken names mapped to SPEAKER_00… when explicitly stated in-call. */
  speakerNames?: Record<string, string> | null;
  /** Proper names mentioned without a firm speaker mapping. */
  namesMentioned?: string[] | null;
  confidence: number | null;
  segments: TranscriptSegment[];
  provider: string;
  model: string;
}

export interface VoiceTranscribeOptions {
  language?: string;
  dialectHint?: string;
  /** Bias Whisper toward expected names/jargon (faster-whisper initial_prompt). */
  initialPrompt?: string;
  /** False for tiny diarization clips (avoids loop/hallucination). Default true. */
  conditionOnPreviousText?: boolean;
}

export interface SttProvider {
  readonly name: string;
  transcribe(filePath: string, options?: VoiceTranscribeOptions): Promise<TranscriptArtifact>;
}

function stripReplacementChars(text: string): string {
  return text.replace(/\uFFFD/g, "").replace(/�/g, "").trim();
}

function usesLenientHallucinationFilter(
  startSec: number,
  endSec: number,
  compactLen: number,
): boolean {
  if (startSec <= 35) return true;
  // Whisper sometimes collapses minutes of speech into a sub-second span at t≈0.
  if (startSec < 5 && endSec - startSec < 3 && compactLen > 80) return true;
  return false;
}

export function isHallucinatedTranscriptText(
  text: string,
  startSec = 0,
  endSec?: number,
): boolean {
  const clean = stripReplacementChars(text.replace(/\s+/g, " ").trim());
  if (!clean) return true;
  const compact = clean.replace(/\s+/g, "");
  const end = endSec ?? startSec;
  if (usesLenientHallucinationFilter(startSec, end, compact.length)) {
    if (compact.length > 200) {
      const unique = new Set(compact).size;
      if (unique <= 4) return true;
    }
    return false;
  }
  if (compact.length > 80) {
    const unique = new Set(compact).size;
    if (unique <= 6) return true;
  }
  if (compact.length >= 12) {
    for (const n of [2, 3, 4]) {
      if (compact.length < n * 6) continue;
      const counts = new Map<string, number>();
      for (let i = 0; i <= compact.length - n; i += 1) {
        const gram = compact.slice(i, i + n);
        counts.set(gram, (counts.get(gram) ?? 0) + 1);
      }
      let top = 0;
      for (const value of counts.values()) top = Math.max(top, value);
      if (top >= Math.max(10, Math.floor((compact.length / n) * 0.5))) return true;
    }
  }
  return false;
}

export function repairSegmentTimestamps(
  segments: TranscriptSegment[],
  durationSec?: number | null,
): TranscriptSegment[] {
  if (segments.length === 0) return segments;
  const duration = durationSec ?? segments.at(-1)?.endSec ?? 0;
  const repaired: TranscriptSegment[] = [];
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i]!;
    let start = seg.startSec;
    let end = seg.endSec;
    const compactLen = seg.text.replace(/\s+/g, "").length;
    const nextStart = i + 1 < segments.length ? segments[i + 1]!.startSec : duration;
    if (end - start < 3 && compactLen > 60) {
      end = nextStart > start ? nextStart : Math.min(duration, start + Math.max(3, compactLen / 12));
    }
    if (i + 1 < segments.length && segments[i + 1]!.startSec - end > 2) {
      end = segments[i + 1]!.startSec;
    }
    if (end <= start && duration > start) {
      end = duration;
    }
    if (duration > 0) end = Math.min(end, duration);
    repaired.push({ ...seg, startSec: start, endSec: Math.max(end, start) });
  }
  return repaired;
}

export function normalizeTranscript(input: TranscriptArtifact): TranscriptArtifact {
  const segments = input.segments
    .map((segment) => ({
      ...segment,
      text: stripReplacementChars(segment.text.replace(/\s+/g, " ").trim()),
    }))
    .filter(
      (segment) =>
        segment.text.length > 0 &&
        !isHallucinatedTranscriptText(segment.text, segment.startSec, segment.endSec),
    );

  if (segments.length === 0 && input.segments.length > 0) {
    const best = input.segments.reduce((longest, segment) =>
      stripReplacementChars(segment.text).length >= stripReplacementChars(longest.text).length
        ? segment
        : longest,
    );
    const text = stripReplacementChars(best.text.replace(/\s+/g, " ").trim());
    if (text.length >= 8) {
      return {
        ...input,
        text,
        segments: [{ ...best, text }],
      };
    }
  }

  const durationSec = segments.length ? segments.at(-1)?.endSec : null;
  const repaired = repairSegmentTimestamps(segments, durationSec);

  return {
    ...input,
    text: repaired.map((segment) => segment.text).join(" ").replace(/\s+/g, " ").trim(),
    segments: repaired,
  };
}
