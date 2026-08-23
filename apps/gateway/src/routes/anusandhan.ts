/**
 * Dedicated Anusandhan client API — isolated from open /v1/auto routing.
 *
 * - POST /voice/transcribe  → ASR + diarization only (never loads GGUF LLM)
 * - POST /chat/completions  → platform default LLM only (evicts other models)
 * - GET  /models            → platform default metadata
 */
import express, { Router } from "express";
import { randomUUID } from "node:crypto";
import {
  buildCompletionResponse,
  chatCompletionRequestSchema,
  coalesceAlternatingRoles,
  normalizeMessages,
} from "@modelforge/engine";
import { generateStream } from "../engine/index.js";
import {
  AnusandhanClientError,
  assertAnusandhanClientHeader,
  prepareAnusandhanLlmPool,
  resolveAnusandhanPlatformDefault,
} from "../lib/anusandhanClient.js";
import {
  createInferenceRequest,
  finalizeInferenceRequest,
  startAttempt,
} from "../lib/execution.js";
import { audioDurationSec, sttBillableUnits } from "../lib/metering.js";
import { computeCostMicros, getActivePricingVersion } from "../lib/pricing.js";
import { enqueueUsage } from "../lib/queues.js";
import { transcribeUploadedAudio } from "../lib/voice/transcribeUploadedAudio.js";
import { authMiddleware } from "../middleware/auth.js";
import { rateLimitMiddleware, rateLimitRpmMiddleware } from "../middleware/quota.js";
import { quotaMiddleware } from "../middleware/quotaCheck.js";

export const anusandhanRouter = Router();
const voiceWindow = new Map<string, { count: number; resetAt: number }>();

function anusandhanMiddleware(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  try {
    assertAnusandhanClientHeader(req);
    next();
  } catch (error) {
    if (error instanceof AnusandhanClientError) {
      return res.status(error.status).json({
        error: { type: error.code, message: error.message },
      });
    }
    next(error);
  }
}

anusandhanRouter.use(authMiddleware, anusandhanMiddleware);

anusandhanRouter.get("/models", async (_req, res) => {
  try {
    const hosted = await resolveAnusandhanPlatformDefault();
    res.json({
      object: "list",
      client: "anusandhan",
      data: [
        {
          id: hosted.modelId,
          object: "model",
          created: Math.floor(hosted.createdAt.getTime() / 1000),
          owned_by: "modelforge",
          context_length: hosted.contextLength,
          status: hosted.status,
          is_default: true,
          pricing: {
            input_per_mtok_cents: hosted.pricePerMTokIn,
            output_per_mtok_cents: hosted.pricePerMTokOut,
          },
        },
      ],
    });
  } catch (error) {
    if (error instanceof AnusandhanClientError) {
      return res.status(error.status).json({ error: { type: error.code, message: error.message } });
    }
    throw error;
  }
});

anusandhanRouter.post(
  "/voice/transcribe",
  rateLimitRpmMiddleware,
  (req, res, next) => {
    const maxUploadMb = Math.max(1, Number(process.env.VOICE_MAX_UPLOAD_MB ?? 50));
    express.raw({ type: "*/*", limit: `${maxUploadMb}mb` })(req, res, next);
  },
  async (req, res) => {
    try {
      if (process.env.VOICE_ENABLED === "false") {
        return res.status(403).json({
          error: { type: "feature_disabled", message: "Voice pipeline is disabled" },
        });
      }

      const audioBuffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from([]);
      if (!audioBuffer.length) {
        return res.status(400).json({
          error: { type: "invalid_request", message: "Missing audio binary body" },
        });
      }

      const maxUploadMb = Math.max(1, Number(process.env.VOICE_MAX_UPLOAD_MB ?? 50));
      if (audioBuffer.length > maxUploadMb * 1024 * 1024) {
        return res.status(413).json({
          error: { type: "payload_too_large", message: `Audio exceeds ${maxUploadMb}MB` },
        });
      }

      const mimeType = String(req.header("x-audio-mime") ?? req.header("content-type") ?? "");
      const allowed = new Set([
        "audio/webm",
        "audio/wav",
        "audio/mpeg",
        "audio/mp3",
        "audio/mp4",
        "audio/x-m4a",
        "audio/ogg",
      ]);
      if (mimeType && !allowed.has(mimeType)) {
        return res.status(415).json({
          error: { type: "unsupported_media_type", message: `Unsupported audio type: ${mimeType}` },
        });
      }

      const hourMs = 60 * 60 * 1000;
      const rate = Number(process.env.VOICE_RATE_LIMIT_PER_HOUR ?? 20);
      const now = Date.now();
      const key = `${req.auth!.customerId}:anusandhan:voice`;
      const current = voiceWindow.get(key);
      if (!current || current.resetAt <= now) {
        voiceWindow.set(key, { count: 1, resetAt: now + hourMs });
      } else if (current.count >= rate) {
        return res.status(429).json({
          error: { type: "rate_limit_exceeded", message: "Voice upload hourly limit exceeded" },
        });
      } else {
        current.count += 1;
      }

      const fileName = String(req.header("x-audio-filename") ?? "audio.webm");
      const rawPromptHeader = String(req.header("x-asr-initial-prompt") ?? "").trim();
      let headerPrompt = "";
      if (rawPromptHeader) {
        try {
          headerPrompt = decodeURIComponent(rawPromptHeader);
        } catch {
          headerPrompt = rawPromptHeader;
        }
      }
      const initialPrompt =
        headerPrompt ||
        (typeof req.query.initial_prompt === "string" ? req.query.initial_prompt.trim() : "") ||
        undefined;
      const { publicTranscript, transcript, transcribeMs } = await transcribeUploadedAudio({
        audioBuffer,
        fileName,
        initialPrompt,
      });

      const durationSec = audioDurationSec({
        segments: transcript.segments,
        text: transcript.text,
        bytes: audioBuffer.length,
      });

      console.log(
        JSON.stringify({
          event: "anusandhan.voice.transcribed",
          customerId: req.auth!.customerId,
          requestId: req.requestId,
          bytes: audioBuffer.length,
          transcribeMs,
          speakerCount: publicTranscript.speakers.length,
          segmentCount: publicTranscript.segments.length,
          provider: transcript.provider,
          sttModel: transcript.model,
        }),
      );

      return res.json({
        client: "anusandhan",
        transcript: publicTranscript,
        analysis: "",
        metrics: {
          transcribeMs,
          audioDurationSec: Number(durationSec.toFixed(2)),
          sttBillableUnits: sttBillableUnits(durationSec),
          diarizationEnabled: process.env.DIARIZATION_ENABLED === "true",
          speakerCount: publicTranscript.speakers.length,
          analysisModel: null,
          llmUsed: false,
        },
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "anusandhan.voice.error",
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      return res.status(500).json({
        error: {
          type: "voice_pipeline_error",
          message: error instanceof Error ? error.message : "Voice transcribe failed",
        },
      });
    }
  },
);

anusandhanRouter.post(
  "/chat/completions",
  rateLimitMiddleware,
  quotaMiddleware,
  async (req, res) => {
    const started = Date.now();
    const requestId = req.requestId ?? randomUUID();
    let executionId: string | undefined;

    try {
      const parsed = chatCompletionRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: {
            type: "invalid_request",
            message: parsed.error.issues.map((i) => i.message).join("; "),
          },
        });
      }

      const body = parsed.data;
      if (body.stream) {
        return res.status(400).json({
          error: {
            type: "invalid_request",
            message: "Anusandhan client endpoint supports stream=false only",
          },
        });
      }

      const hosted = await prepareAnusandhanLlmPool();
      const modelId = hosted.modelId;
      const messages = coalesceAlternatingRoles(normalizeMessages(body.messages));

      const execution = await createInferenceRequest({
        customerId: req.auth!.customerId,
        apiKeyId: req.auth!.apiKeyId,
        requestedModelSlug: modelId,
        requestedModelId: hosted.id,
        stream: false,
      });
      executionId = execution.id;
      res.setHeader("x-request-id", execution.id);
      res.setHeader("x-modelforge-client", "anusandhan");
      res.setHeader("x-modelforge-resolved-model", modelId);

      await startAttempt(execution.id, {
        backend: process.env.INFERENCE_BACKEND ?? "llama-server",
        modelSlug: modelId,
        attemptNo: 1,
      });

      const pricing = await getActivePricingVersion(hosted.id);
      const completionId = `chatcmpl_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
      const generationStarted = Date.now();

      const stream = generateStream(
        {
          model_id: modelId,
          messages,
          temperature: body.temperature,
          max_tokens: body.max_tokens,
          top_p: body.top_p,
          stop_sequences: body.stop,
          stream: false,
        },
        undefined,
        { deadlineMs: Number(process.env.INFERENCE_TIMEOUT_MS ?? 900_000) },
      );

      let promptTokens = 0;
      let completionTokens = 0;
      let finishReason: "stop" | "length" | "error" = "stop";
      let content = "";

      for await (const chunk of stream) {
        promptTokens = chunk.prompt_tokens || promptTokens;
        completionTokens = chunk.completion_tokens || completionTokens;
        if (chunk.delta) content += chunk.delta;
        if (chunk.is_final) {
          finishReason =
            chunk.finish_reason === "length" || chunk.finish_reason === "error"
              ? chunk.finish_reason
              : "stop";
        }
      }

      if (promptTokens + completionTokens === 0) {
        const chars = messages.reduce((n, m) => n + m.content.length, 0) + content.length;
        promptTokens = Math.max(1, Math.ceil(chars / 4));
        completionTokens = Math.max(1, Math.ceil(content.length / 4));
      }

      const latencyMs = Date.now() - started;
      const costMicros = computeCostMicros(
        promptTokens,
        completionTokens,
        pricing.pricePerMTokIn,
        pricing.pricePerMTokOut,
      );

      await finalizeInferenceRequest(execution.id, {
        status: "SUCCEEDED",
        promptTokens,
        completionTokens,
        latencyMs,
        ttftMs: Date.now() - generationStarted,
        generationMs: Date.now() - generationStarted,
        finishReason,
        pricingVersionId: pricing.id,
        costMicros,
        resolvedModelId: hosted.id,
        resolvedModelSlug: modelId,
        attemptNo: 1,
      });

      await enqueueUsage({
        customerId: req.auth!.customerId,
        apiKeyId: req.auth!.apiKeyId,
        hostedModelId: hosted.id,
        modelSlug: modelId,
        promptTokens,
        completionTokens,
        latencyMs,
        requestId: execution.id,
        idempotencyKey: `${execution.id}:usage`,
        inferenceRequestId: execution.id,
        costMicros: costMicros.toString(),
        pricePerMTokIn: pricing.pricePerMTokIn,
        pricePerMTokOut: pricing.pricePerMTokOut,
      });

      console.log(
        JSON.stringify({
          event: "anusandhan.chat.completed",
          customerId: req.auth!.customerId,
          requestId: execution.id,
          model: modelId,
          promptTokens,
          completionTokens,
          latencyMs,
        }),
      );

      return res.json({
        ...buildCompletionResponse({
          id: completionId,
          model: modelId,
          content,
          finishReason,
          promptTokens,
          completionTokens,
        }),
        client: "anusandhan",
        requested_model_ignored: body.model !== modelId ? body.model : undefined,
      });
    } catch (error) {
      if (executionId) {
        await finalizeInferenceRequest(executionId, {
          status: "FAILED",
          error: {
            code: "inference_error",
            message: error instanceof Error ? error.message : "Inference failed",
          },
          attemptNo: 1,
        }).catch(() => undefined);
      }
      if (error instanceof AnusandhanClientError) {
        return res.status(error.status).json({ error: { type: error.code, message: error.message } });
      }
      return res.status(500).json({
        error: {
          type: "server_error",
          message: error instanceof Error ? error.message : "Inference failed",
        },
      });
    }
  },
);
