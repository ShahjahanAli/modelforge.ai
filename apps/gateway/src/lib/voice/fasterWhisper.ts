import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { normalizeTranscript, type SttProvider, type TranscriptArtifact, type VoiceTranscribeOptions } from "./types.js";

const execFileAsync = promisify(execFile);

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
    const args = [
      this.config.scriptPath,
      "--audio",
      filePath,
      "--model",
      this.config.model,
      "--device",
      this.config.device,
      "--compute-type",
      this.config.computeType,
      "--beam-size",
      String(this.config.beamSize),
      "--best-of",
      String(this.config.bestOf),
      "--temperature",
      String(this.config.temperature),
      "--no-speech-threshold",
      String(this.config.noSpeechThreshold),
      ...(options?.language ? ["--language", options.language] : []),
      ...(options?.initialPrompt?.trim()
        ? ["--initial-prompt", options.initialPrompt.trim()]
        : []),
    ];
    const { stdout, stderr } = await execFileAsync(this.config.pythonBin, args, {
      maxBuffer: 10 * 1024 * 1024,
      env: {
        ...process.env,
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8",
      },
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
