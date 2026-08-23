export interface TranscriptSegment {
  startSec: number;
  endSec: number;
  text: string;
  confidence?: number;
  speaker?: string | null;
}

export interface TranscriptArtifact {
  language: string;
  text: string;
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
}

export interface SttProvider {
  readonly name: string;
  transcribe(filePath: string, options?: VoiceTranscribeOptions): Promise<TranscriptArtifact>;
}

export function isHallucinatedTranscriptText(text: string): boolean {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return true;
  if (clean.includes("\uFFFD") || (clean.match(/�/g)?.length ?? 0) >= 2) return true;
  const compact = clean.replace(/\s+/g, "");
  if (compact.length > 80) {
    const unique = new Set(compact).size;
    if (unique <= 6) return true;
  }
  if (compact.length >= 12) {
    for (const n of [1, 2, 3, 4]) {
      if (compact.length < n * 6) continue;
      const counts = new Map<string, number>();
      for (let i = 0; i <= compact.length - n; i += 1) {
        const gram = compact.slice(i, i + n);
        counts.set(gram, (counts.get(gram) ?? 0) + 1);
      }
      let top = 0;
      for (const value of counts.values()) top = Math.max(top, value);
      if (top >= Math.max(8, Math.floor((compact.length / n) * 0.45))) return true;
    }
  }
  return false;
}

export function normalizeTranscript(input: TranscriptArtifact): TranscriptArtifact {
  const segments = input.segments
    .map((segment) => ({
      ...segment,
      text: segment.text.replace(/\s+/g, " ").trim(),
    }))
    .filter((segment) => segment.text.length > 0 && !isHallucinatedTranscriptText(segment.text));

  return {
    ...input,
    text: segments.map((segment) => segment.text).join(" ").replace(/\s+/g, " ").trim(),
    segments,
  };
}
