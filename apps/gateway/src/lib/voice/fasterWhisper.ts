import path from "node:path";
import { execFasterWhisperScript } from "./pythonExec.js";
import { normalizeTranscript, type SttProvider, type TranscriptArtifact, type VoiceTranscribeOptions } from "./types.js";

interface FasterWhisperConfig {
  pythonBin: string;
  scriptPath: string;
  model: string;
  device: "cpu" | "cuda";
  computeType: string;
  beamSize: number;
  bestOf: number;
  temperature: number;
  noSpeechThreshold: number;
}

interface FasterWhisperOutput {
  language?: string;
  text?: string;
  confidence?: number | null;
  first_segment_start_sec?: number | null;
  dropped_segment_count?: number;
  duration_sec?: number | null;
  segments?: Array<{
    start?: number;
    end?: number;
    text?: string;
    avg_logprob?: number;
  }>;
}

export class FasterWhisperProvider implements SttProvider {
  readonly name = "faster-whisper";

  constructor(private readonly config: FasterWhisperConfig) {}

  async transcribe(filePath: string, options?: VoiceTranscribeOptions): Promise<TranscriptArtifact> {
    const conditionOnPrevious = options?.conditionOnPreviousText === true;
    const repoRoot = path.resolve(path.dirname(this.config.scriptPath), "..");
    const audioRelativePath = path.relative(repoRoot, path.resolve(filePath));
    const { stdout, stderr } = await execFasterWhisperScript({
      pythonBin: this.config.pythonBin,
      scriptPath: this.config.scriptPath,
      repoRoot,
      audioRelativePath,
      model: this.config.model,
      device: this.config.device,
      computeType: this.config.computeType,
      beamSize: this.config.beamSize,
      bestOf: this.config.bestOf,
      temperature: this.config.temperature,
      noSpeechThreshold: this.config.noSpeechThreshold,
      language: options?.language,
      initialPrompt: options?.initialPrompt?.trim(),
      noVadFilter: true,
      conditionOnPreviousText: conditionOnPrevious,
    });
    if (stderr?.trim()) {
      console.warn("[voice.stt] faster-whisper stderr:", stderr.trim());
    }
    let parsed: FasterWhisperOutput;
    try {
      const line = stdout
        .split(/\r?\n/)
        .map((part) => part.trim())
        .filter(Boolean)
        .at(-1);
      parsed = JSON.parse(line ?? "") as FasterWhisperOutput;
    } catch (error) {
      throw new Error(
        `Invalid Faster-Whisper JSON output${error instanceof Error ? `: ${error.message}` : ""}`,
      );
    }
    if (
      parsed.first_segment_start_sec != null &&
      parsed.first_segment_start_sec > 5
    ) {
      console.warn(
        JSON.stringify({
          event: "voice.stt.late_start",
          first_segment_start_sec: parsed.first_segment_start_sec,
          dropped_segment_count: parsed.dropped_segment_count ?? 0,
          duration_sec: parsed.duration_sec ?? null,
        }),
      );
    }
    const transcript: TranscriptArtifact = {
      language: parsed.language ?? options?.language ?? "unknown",
      text: parsed.text ?? "",
      confidence: parsed.confidence ?? null,
      segments: (parsed.segments ?? []).map((segment) => ({
        startSec: Number(segment.start ?? 0),
        endSec: Number(segment.end ?? 0),
        text: String(segment.text ?? ""),
        confidence: segment.avg_logprob,
        speaker: null,
      })),
      provider: this.name,
      model: this.config.model,
    };
    return normalizeTranscript(transcript);
  }
}
