import { z } from "zod";

const boolish = z
  .union([z.boolean(), z.string()])
  .optional()
  .transform((v) => {
    if (v === undefined) return true;
    if (typeof v === "boolean") return v;
    return !["0", "false", "no", "off"].includes(v.trim().toLowerCase());
  });

const boolishDefaultFalse = z
  .union([z.boolean(), z.string()])
  .optional()
  .transform((v) => {
    if (v === undefined) return false;
    if (typeof v === "boolean") return v;
    return !["0", "false", "no", "off"].includes(v.trim().toLowerCase());
  });

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_ENABLED: boolish,
  REDIS_URL: z.string().default("redis://localhost:6379"),
  GATEWAY_PORT: z.coerce.number().default(9000),
  INFERENCE_ENGINE_GRPC_URL: z.string().default("localhost:9002"),
  JWT_SECRET: z.string().min(8),
  INTERNAL_SERVICE_TOKEN: z.string().min(8),
  CORS_ORIGIN: z.string().default("http://localhost:9001"),
  MODEL_WEIGHTS_DIR: z.string().default("./data/models"),
  INFERENCE_BACKEND: z.enum(["llama-server", "grpc"]).default("llama-server"),
  LLAMA_SERVER_BIN: z.string().optional(),
  LLAMA_SERVER_PORT_BASE: z.coerce.number().default(9100),
  TOTAL_RAM_BUDGET_MB: z.coerce.number().default(24000),
  VOICE_ENABLED: boolish,
  VOICE_UPLOAD_DIR: z.string().default("./data/audio"),
  VOICE_MAX_UPLOAD_MB: z.coerce.number().default(50),
  VOICE_RETENTION_HOURS: z.coerce.number().default(24),
  VOICE_RATE_LIMIT_PER_HOUR: z.coerce.number().default(20),
  STT_PROVIDER: z.enum(["faster-whisper", "nemo"]).default("faster-whisper"),
  STT_LANGUAGE: z.string().default(""),
  STT_PYTHON_BIN: z.string().default("python3"),
  STT_FASTER_WHISPER_SCRIPT: z
    .string()
    .default("scripts/faster-whisper-transcribe.py"),
  STT_FASTER_WHISPER_MODEL: z.string().default("small"),
  STT_FASTER_WHISPER_DEVICE: z.enum(["cpu", "cuda"]).default("cpu"),
  STT_FASTER_WHISPER_COMPUTE_TYPE: z.string().default("int8"),
  STT_FASTER_WHISPER_BEAM_SIZE: z.coerce.number().default(5),
  STT_FASTER_WHISPER_BEST_OF: z.coerce.number().default(5),
  STT_FASTER_WHISPER_TEMPERATURE: z.coerce.number().default(0),
  STT_FASTER_WHISPER_NO_SPEECH_THRESHOLD: z.coerce.number().default(0.6),
  STT_NEMO_SCRIPT: z.string().default("scripts/nemo-asr-transcribe.py"),
  STT_NEMO_MODEL: z
    .string()
    .default("kazalbrur/bangla-stt-conformer-120m-dialects"),
  STT_NEMO_DEVICE: z.enum(["cpu", "cuda"]).default("cpu"),
  DIARIZATION_ENABLED: boolishDefaultFalse,
  DIARIZATION_PROVIDER: z.enum(["pyannote"]).default("pyannote"),
  DIARIZATION_MODEL: z.string().default("pyannote/speaker-diarization-community-1"),
  DIARIZATION_DEVICE: z.enum(["cpu", "cuda"]).default("cpu"),
  DIARIZATION_SCRIPT: z.string().default("scripts/pyannote-diarize.py"),
  DIARIZATION_MIN_SPEAKERS: z.coerce.number().optional(),
  DIARIZATION_MAX_SPEAKERS: z.coerce.number().optional(),
  HF_TOKEN: z.string().optional(),
});

export type GatewayEnv = z.infer<typeof envSchema>;

export function loadEnv(): GatewayEnv {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error(parsed.error.flatten().fieldErrors);
    throw new Error("Invalid gateway environment");
  }
  return parsed.data;
}
