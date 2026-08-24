import { randomUUID } from "node:crypto";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import {
  createSttProvider,
  ensureSttScript,
  ensureVoiceUploadDir,
  resolveSttLanguageHint,
  resolveVoiceEnv,
  resolveVoicePath,
  cleanupOldVoiceUploads,
} from "./index.js";
import { toPublicTranscript, transcribeWithDiarization } from "./diarize.js";
import { diarizationConfigFromEnv, diarizationVoiceEnvFields } from "./diarizationConfig.js";
import {
  isGeminiVoicePipeline,
  runGeminiVoicePipeline,
  type GeminiVoiceResult,
} from "./geminiAudio.js";
import type { TranscriptArtifact } from "./types.js";

export interface VoiceTranscribeResult {
  publicTranscript: ReturnType<typeof toPublicTranscript>;
  transcript: TranscriptArtifact;
  transcribeMs: number;
  storedPath: string;
  /** Present when VOICE_PIPELINE=gemini. */
  gemini?: GeminiVoiceResult;
  analysis?: string;
}

export async function transcribeUploadedAudio(input: {
  audioBuffer: Buffer;
  fileName: string;
  initialPrompt?: string;
  mimeType?: string;
  /** analyze = include investigator summary in the same Gemini call. */
  geminiMode?: "transcribe" | "analyze";
  analysisHint?: string;
}): Promise<VoiceTranscribeResult> {
  const maxUploadMb = Math.max(1, Number(process.env.VOICE_MAX_UPLOAD_MB ?? 50));
  const rate = Number(process.env.VOICE_RATE_LIMIT_PER_HOUR ?? 20);
  const uploadDir = await ensureVoiceUploadDir(process.env.VOICE_UPLOAD_DIR ?? "./data/audio");

  await cleanupOldVoiceUploads(uploadDir, Number(process.env.VOICE_RETENTION_HOURS ?? 24));

  const fileNameSafe = input.fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const storedPath = path.join(uploadDir, `${Date.now()}-${randomUUID()}-${fileNameSafe}`);
  await writeFile(storedPath, input.audioBuffer);

  const transcribeStarted = Date.now();

  if (isGeminiVoicePipeline()) {
    const gemini = await runGeminiVoicePipeline({
      audioBuffer: input.audioBuffer,
      fileName: input.fileName,
      mimeType: input.mimeType,
      mode: input.geminiMode ?? "transcribe",
      languageHint: process.env.STT_LANGUAGE || "bn",
      analysisHint: input.analysisHint,
    });
    return {
      publicTranscript: gemini.publicTranscript,
      transcript: gemini.transcript,
      transcribeMs: Date.now() - transcribeStarted,
      storedPath,
      gemini,
      analysis: gemini.analysis,
    };
  }

  const whisperScript = resolveVoicePath(
    process.env.STT_FASTER_WHISPER_SCRIPT ?? "scripts/faster-whisper-transcribe.py",
  );
  const nemoScript = resolveVoicePath(process.env.STT_NEMO_SCRIPT ?? "scripts/nemo-asr-transcribe.py");

  const voiceEnv = await resolveVoiceEnv({
    VOICE_ENABLED: process.env.VOICE_ENABLED !== "false",
    VOICE_UPLOAD_DIR: uploadDir,
    VOICE_MAX_UPLOAD_MB: maxUploadMb,
    VOICE_RETENTION_HOURS: Number(process.env.VOICE_RETENTION_HOURS ?? 24),
    VOICE_RATE_LIMIT_PER_HOUR: rate,
    STT_PROVIDER:
      process.env.STT_PROVIDER === "nemo"
        ? "nemo"
        : process.env.STT_PROVIDER === "hf-space"
          ? "hf-space"
          : "faster-whisper",
    STT_LANGUAGE: process.env.STT_LANGUAGE ?? "",
    STT_FASTER_WHISPER_MODEL: process.env.STT_FASTER_WHISPER_MODEL ?? "small",
    STT_FASTER_WHISPER_DEVICE: process.env.STT_FASTER_WHISPER_DEVICE === "cuda" ? "cuda" : "cpu",
    STT_FASTER_WHISPER_COMPUTE_TYPE: process.env.STT_FASTER_WHISPER_COMPUTE_TYPE ?? "int8",
    STT_FASTER_WHISPER_BEAM_SIZE: Number(process.env.STT_FASTER_WHISPER_BEAM_SIZE ?? 5),
    STT_FASTER_WHISPER_BEST_OF: Number(process.env.STT_FASTER_WHISPER_BEST_OF ?? 5),
    STT_FASTER_WHISPER_TEMPERATURE: Number(process.env.STT_FASTER_WHISPER_TEMPERATURE ?? 0),
    STT_FASTER_WHISPER_NO_SPEECH_THRESHOLD: Number(
      process.env.STT_FASTER_WHISPER_NO_SPEECH_THRESHOLD ?? 0.35,
    ),
    STT_PYTHON_BIN: process.env.STT_PYTHON_BIN ?? "python3",
    STT_FASTER_WHISPER_SCRIPT: whisperScript,
    STT_NEMO_MODEL: process.env.STT_NEMO_MODEL ?? "kazalbrur/bangla-stt-conformer-120m-dialects",
    STT_NEMO_DEVICE: process.env.STT_NEMO_DEVICE === "cuda" ? "cuda" : "cpu",
    STT_NEMO_SCRIPT: nemoScript,
    STT_HF_SPACE_ID:
      process.env.STT_HF_SPACE_ID ?? "bengaliAI/regional_bengali-asr_tugstugi_whisper-medium",
    STT_HF_SPACE_URL: process.env.STT_HF_SPACE_URL ?? "",
    STT_HF_SPACE_FN_INDEX: Number(process.env.STT_HF_SPACE_FN_INDEX ?? 0),
    HF_TOKEN: process.env.HF_TOKEN ?? process.env.HUGGING_FACE_HUB_TOKEN ?? "",
    ...diarizationVoiceEnvFields(),
  });
  ensureSttScript(voiceEnv);
  const activeSttModel =
    voiceEnv.STT_PROVIDER === "nemo"
      ? voiceEnv.STT_NEMO_MODEL
      : voiceEnv.STT_PROVIDER === "hf-space"
        ? voiceEnv.STT_HF_SPACE_ID
        : voiceEnv.STT_FASTER_WHISPER_MODEL;
  const sttLanguageHint = resolveSttLanguageHint(process.env.STT_LANGUAGE, activeSttModel);
  const stt = createSttProvider(voiceEnv);
  const initialPrompt =
    input.initialPrompt?.trim() ||
    process.env.STT_INITIAL_PROMPT?.trim() ||
    undefined;

  const transcript = await transcribeWithDiarization({
    audioPath: storedPath,
    stt,
    language: sttLanguageHint,
    initialPrompt,
    diarization: diarizationConfigFromEnv(),
  });

  return {
    publicTranscript: toPublicTranscript(transcript),
    transcript,
    transcribeMs: Date.now() - transcribeStarted,
    storedPath,
  };
}
