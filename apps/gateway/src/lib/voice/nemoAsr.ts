import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { normalizeTranscript, type SttProvider, type TranscriptArtifact } from "./types.js";

const execFileAsync = promisify(execFile);

interface NemoAsrConfig {
  pythonBin: string;
  scriptPath: string;
  model: string;
  device: "cpu" | "cuda";
}

interface NemoOutput {
  language?: string;
  text?: string;
  confidence?: number | null;
  segments?: Array<{
    start?: number;
    end?: number;
    text?: string;
    avg_logprob?: number | null;
  }>;
  error?: string;
}

export class NemoAsrProvider implements SttProvider {
  readonly name = "nemo";

  constructor(private readonly config: NemoAsrConfig) {}

  async transcribe(filePath: string, _options?: { language?: string }): Promise<TranscriptArtifact> {
    const args = [
      this.config.scriptPath,
      "--audio",
      filePath,
      "--model",
      this.config.model,
      "--device",
      this.config.device,
    ];
    const { stdout, stderr } = await execFileAsync(this.config.pythonBin, args, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 60 * 60 * 1000,
      env: {
        ...process.env,
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8",
      },
    });
    if (stderr?.trim()) {
      console.warn("[voice.stt.nemo] stderr:", stderr.trim());
    }
    let parsed: NemoOutput;
    try {
      parsed = JSON.parse(stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "") as NemoOutput;
    } catch (error) {
      throw new Error(
        `Invalid NeMo ASR JSON output${error instanceof Error ? `: ${error.message}` : ""}`,
      );
    }
    if (parsed.error) {
      throw new Error(parsed.error);
    }
    return normalizeTranscript({
      language: parsed.language ?? "bn",
      text: parsed.text ?? "",
      confidence: parsed.confidence ?? null,
      segments: (parsed.segments ?? []).map((segment) => ({
        startSec: Number(segment.start ?? 0),
        endSec: Number(segment.end ?? 0),
        text: String(segment.text ?? ""),
        confidence: segment.avg_logprob ?? undefined,
        speaker: null,
      })),
      provider: this.name,
      model: this.config.model,
    });
  }
}
