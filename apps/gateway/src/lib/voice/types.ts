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
}

export interface SttProvider {
  readonly name: string;
  transcribe(filePath: string, options?: VoiceTranscribeOptions): Promise<TranscriptArtifact>;
}

export function normalizeTranscript(input: TranscriptArtifact): TranscriptArtifact {
  const collapsed = input.text.replace(/\s+/g, " ").trim();
  return {
    ...input,
    text: collapsed,
    segments: input.segments
      .map((segment) => ({
        ...segment,
        text: segment.text.replace(/\s+/g, " ").trim(),
      }))
      .filter((segment) => segment.text.length > 0),
  };
}
