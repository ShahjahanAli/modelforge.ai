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
import type { TranscriptArtifact } from "./types.js";

export interface VoiceTranscribeResult {
  publicTranscript: ReturnType<typeof toPublicTranscript>;
  transcript: TranscriptArtifact;
  transcribeMs: number;
  storedPath: string;
}

export async function transcribeUploadedAudio(input: {
  audioBuffer: Buffer;
  fileName: string;
  initialPrompt?: string;
}): Promise<VoiceTranscribeResult> {
  const maxUploadMb = Math.max(1, Number(process.env.VOICE_MAX_UPLOAD_MB ?? 50));
  const rate = Number(process.env.VOICE_RATE_LIMIT_PER_HOUR ?? 20);
  const uploadDir = await ensureVoiceUploadDir(process.env.VOICE_UPLOAD_DIR ?? "./data/audio");
  const whisperScript = resolveVoicePath(
    process.env.STT_FASTER_WHISPER_SCRIPT ?? "scripts/faster-whisper-transcribe.py",
  );
  const nemoScript = resolveVoicePath(process.env.STT_NEMO_SCRIPT ?? "scripts/nemo-asr-transcribe.py");

  await cleanupOldVoiceUploads(uploadDir, Number(process.env.VOICE_RETENTION_HOURS ?? 24));

  const fileNameSafe = input.fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const storedPath = path.join(uploadDir, `${Date.now()}-${randomUUID()}-${fileNameSafe}`);
  await writeFile(storedPath, input.audioBuffer);

  const transcribeStarted = Date.now();
  const voiceEnv = await resolveVoiceEnv({
    VOICE_ENABLED: process.env.VOICE_ENABLED !== "false",
    VOICE_UPLOAD_DIR: uploadDir,
    VOICE_MAX_UPLOAD_MB: maxUploadMb,
    VOICE_RETENTION_HOURS: Number(process.env.VOICE_RETENTION_HOURS ?? 24),
    VOICE_RATE_LIMIT_PER_HOUR: rate,
    STT_PROVIDER: process.env.STT_PROVIDER === "nemo" ? "nemo" : "faster-whisper",
    STT_LANGUAGE: process.env.STT_LANGUAGE ?? "",
    STT_FASTER_WHISPER_MODEL: process.env.STT_FASTER_WHISPER_MODEL ?? "small",
    STT_FASTER_WHISPER_DEVICE: process.env.STT_FASTER_WHISPER_DEVICE === "cuda" ? "cuda" : "cpu",
    STT_FASTER_WHISPER_COMPUTE_TYPE: process.env.STT_FASTER_WHISPER_COMPUTE_TYPE ?? "int8",
    STT_FASTER_WHISPER_BEAM_SIZE: Number(process.env.STT_FASTER_WHISPER_BEAM_SIZE ?? 5),
    STT_FASTER_WHISPER_BEST_OF: Number(process.env.STT_FASTER_WHISPER_BEST_OF ?? 5),
    STT_FASTER_WHISPER_TEMPERATURE: Number(process.env.STT_FASTER_WHISPER_TEMPERATURE ?? 0),
    STT_FASTER_WHISPER_NO_SPEECH_THRESHOLD: Number(
      process.env.STT_FASTER_WHISPER_NO_SPEECH_THRESHOLD ?? 0.6,
    ),
    STT_PYTHON_BIN: process.env.STT_PYTHON_BIN ?? "python3",
    STT_FASTER_WHISPER_SCRIPT: whisperScript,
    STT_NEMO_MODEL: process.env.STT_NEMO_MODEL ?? "kazalbrur/bangla-stt-conformer-120m-dialects",
    STT_NEMO_DEVICE: process.env.STT_NEMO_DEVICE === "cuda" ? "cuda" : "cpu",
    STT_NEMO_SCRIPT: nemoScript,
    DIARIZATION_ENABLED: process.env.DIARIZATION_ENABLED === "true",
    DIARIZATION_PROVIDER: "pyannote",
    DIARIZATION_MODEL:
      process.env.DIARIZATION_MODEL ?? "pyannote/speaker-diarization-community-1",
    DIARIZATION_DEVICE: process.env.DIARIZATION_DEVICE === "cuda" ? "cuda" : "cpu",
    DIARIZATION_SCRIPT: process.env.DIARIZATION_SCRIPT ?? "scripts/pyannote-diarize.py",
    DIARIZATION_MIN_SPEAKERS: process.env.DIARIZATION_MIN_SPEAKERS
      ? Number(process.env.DIARIZATION_MIN_SPEAKERS)
      : undefined,
    DIARIZATION_MAX_SPEAKERS: process.env.DIARIZATION_MAX_SPEAKERS
      ? Number(process.env.DIARIZATION_MAX_SPEAKERS)
      : undefined,
  });
  ensureSttScript(voiceEnv);
  const activeSttModel =
    voiceEnv.STT_PROVIDER === "nemo" ? voiceEnv.STT_NEMO_MODEL : voiceEnv.STT_FASTER_WHISPER_MODEL;
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
    diarization: {
      enabled: voiceEnv.DIARIZATION_ENABLED,
      pythonBin: voiceEnv.STT_PYTHON_BIN,
      scriptPath: voiceEnv.DIARIZATION_SCRIPT,
      model: voiceEnv.DIARIZATION_MODEL,
      device: voiceEnv.DIARIZATION_DEVICE,
      minSpeakers: voiceEnv.DIARIZATION_MIN_SPEAKERS,
      maxSpeakers: voiceEnv.DIARIZATION_MAX_SPEAKERS,
    },
  });

  return {
    publicTranscript: toPublicTranscript(transcript),
    transcript,
    transcribeMs: Date.now() - transcribeStarted,
    storedPath,
  };
}
