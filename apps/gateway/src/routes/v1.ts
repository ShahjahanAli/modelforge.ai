import express, { Router } from "express";
import { prisma } from "@modelforge/db";
import {
  ApiError,
  buildChunk,
  buildCompletionResponse,
  chatCompletionRequestSchema,
  mapEngineError,
  normalizeMessages,
  coalesceAlternatingRoles,
  toSse,
} from "@modelforge/engine";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { generateStream, mapEngineFailure } from "../engine/index.js";
import {
  createInferenceRequest,
  finalizeInferenceRequest,
  startAttempt,
  writeAuditEvent,
} from "../lib/execution.js";
import { commitQuota, QuotaExceededError, releaseQuota, reserveQuota } from "../lib/quotaLedger.js";
import { resolveModelForRequest, resolveVoiceAnalysisModel } from "../lib/policyRouter.js";
import { computeCostMicros, getActivePricingVersion } from "../lib/pricing.js";
import { enqueueUsage } from "../lib/queues.js";
import { claimCoreTrace, type CoreTraceRecorder } from "../lib/coreTrace.js";
import {
  applyRetrievalContext,
  lastUserQuery,
  persistRetrievalRun,
  publicRetrievalHits,
  retrieveCustomerKnowledge,
  RetrievalError,
  clampMaxTokens,
  type RetrievalResult,
} from "../lib/retrieval.js";
import { authMiddleware } from "../middleware/auth.js";
import { rateLimitMiddleware, rateLimitRpmMiddleware } from "../middleware/quota.js";
import { bumpQuotaCache, quotaMiddleware } from "../middleware/quotaCheck.js";
import {
  audioDurationSec,
  sttBillableUnits,
} from "../lib/metering.js";
import { neo4jConfigured, neo4jStoreStats, runCypher } from "../lib/neo4j.js";
import {
  buildVoiceAnalysisPrompt,
  buildVoiceAnalysisSystemPrompt,
  cleanupOldVoiceUploads,
  createSttProvider,
  ensureVoiceUploadDir,
  ensureSttScript,
  resolveSttLanguageHint,
  resolveVoiceEnv,
  resolveVoicePath,
} from "../lib/voice/index.js";
import { toPublicTranscript, transcribeWithDiarization } from "../lib/voice/diarize.js";
import {
  diarizationConfigFromEnv,
  diarizationVoiceEnvFields,
} from "../lib/voice/diarizationConfig.js";

export const v1Router = Router();
const voiceWindow = new Map<string, { count: number; resetAt: number }>();

v1Router.get("/models", authMiddleware, async (req, res) => {
  const allowed = new Set(req.auth!.allowedModelIds);
  const models = await prisma.hostedModel.findMany({
    where: { modelId: { in: [...allowed] } },
    orderBy: { modelId: "asc" },
  });
  res.json({
    object: "list",
    data: models.map((m) => ({
      id: m.modelId,
      object: "model",
      created: Math.floor(m.createdAt.getTime() / 1000),
      owned_by: "modelforge",
      context_length: m.contextLength,
      status: m.status,
      is_default: m.isPlatformDefault,
      pricing: {
        input_per_mtok_cents: m.pricePerMTokIn,
        output_per_mtok_cents: m.pricePerMTokOut,
      },
    })),
  });
});

v1Router.get("/models/:modelId", authMiddleware, async (req, res) => {
  const modelId = String(req.params.modelId ?? "");
  if (!req.auth!.allowedModelIds.includes(modelId) && modelId !== "auto") {
    return res.status(404).json({ error: { type: "model_not_found", message: "Model not found" } });
  }
  const m = await prisma.hostedModel.findUnique({ where: { modelId } });
  if (!m) {
    return res.status(404).json({ error: { type: "model_not_found", message: "Model not found" } });
  }
  res.json({
    id: m.modelId,
    object: "model",
    created: Math.floor(m.createdAt.getTime() / 1000),
    owned_by: "modelforge",
    context_length: m.contextLength,
    quantization: m.quantization,
    expected_tok_per_sec: m.expectedTokPerSec,
    status: m.status,
    is_default: m.isPlatformDefault,
  });
});

v1Router.get("/requests/:id", authMiddleware, async (req, res) => {
  const id = String(req.params.id ?? "");
  const request = await prisma.inferenceRequest.findUnique({
    where: { id },
    include: { attempts: true, receipt: true },
  });
  if (!request || request.customerId !== req.auth!.customerId) {
    return res.status(404).json({ error: { type: "not_found", message: "Request not found" } });
  }
  res.json({
    ...request,
    costMicros: request.costMicros.toString(),
    attempts: request.attempts.map((attempt) => ({
      ...attempt,
      costMicros: attempt.costMicros.toString(),
    })),
  });
});

v1Router.get("/usage/receipts/:requestId", authMiddleware, async (req, res) => {
  const requestId = String(req.params.requestId ?? "");
  const receipt = await prisma.usageReceipt.findUnique({
    where: { requestId },
    include: { request: true },
  });
  if (!receipt || receipt.request?.customerId !== req.auth!.customerId) {
    return res.status(404).json({ error: { type: "not_found", message: "Receipt not found" } });
  }
  res.json(receipt);
});

v1Router.post(
  "/voice/analyze",
  authMiddleware,
  rateLimitRpmMiddleware,
  (req, res, next) => {
    const maxUploadMb = Math.max(1, Number(process.env.VOICE_MAX_UPLOAD_MB ?? 50));
    // Parser limit must match (or exceed) VOICE_MAX_UPLOAD_MB or Express rejects before the handler.
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
        "audio/m4a",
        "audio/aac",
        "audio/x-aac",
        "audio/ogg",
        "application/octet-stream",
      ]);
      const fileNameHint = String(req.header("x-audio-filename") ?? "").toLowerCase();
      const aacByName = /\.(aac|m4a)$/i.test(fileNameHint);
      if (
        mimeType &&
        !allowed.has(mimeType.split(";")[0]!.trim().toLowerCase()) &&
        !(aacByName && mimeType.includes("octet-stream"))
      ) {
        return res.status(415).json({
          error: { type: "unsupported_media_type", message: `Unsupported audio type: ${mimeType}` },
        });
      }

      const hourMs = 60 * 60 * 1000;
      const rate = Number(process.env.VOICE_RATE_LIMIT_PER_HOUR ?? 20);
      const now = Date.now();
      const key = `${req.auth!.customerId}:voice`;
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

      const uploadDir = await ensureVoiceUploadDir(process.env.VOICE_UPLOAD_DIR ?? "./data/audio");
      const whisperScript = resolveVoicePath(
        process.env.STT_FASTER_WHISPER_SCRIPT ?? "scripts/faster-whisper-transcribe.py",
      );
      const nemoScript = resolveVoicePath(
        process.env.STT_NEMO_SCRIPT ?? "scripts/nemo-asr-transcribe.py",
      );
      const deleted = await cleanupOldVoiceUploads(
        uploadDir,
        Number(process.env.VOICE_RETENTION_HOURS ?? 24),
      );
      if (deleted > 0) {
        console.log(`[voice.cleanup] removed=${deleted}`);
      }

      const fileNameRaw = String(req.header("x-audio-filename") ?? "audio.webm");
      const fileNameSafe = fileNameRaw.replace(/[^a-zA-Z0-9._-]/g, "_");
      const storedPath = path.join(uploadDir, `${Date.now()}-${randomUUID()}-${fileNameSafe}`);
      await writeFile(storedPath, audioBuffer);

      const transcribeStarted = Date.now();
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
        STT_FASTER_WHISPER_DEVICE:
          process.env.STT_FASTER_WHISPER_DEVICE === "cuda" ? "cuda" : "cpu",
        STT_FASTER_WHISPER_COMPUTE_TYPE: process.env.STT_FASTER_WHISPER_COMPUTE_TYPE ?? "int8",
        STT_FASTER_WHISPER_BEAM_SIZE: Number(process.env.STT_FASTER_WHISPER_BEAM_SIZE ?? 5),
        STT_FASTER_WHISPER_BEST_OF: Number(process.env.STT_FASTER_WHISPER_BEST_OF ?? 5),
        STT_FASTER_WHISPER_TEMPERATURE: Number(process.env.STT_FASTER_WHISPER_TEMPERATURE ?? 0),
        STT_FASTER_WHISPER_NO_SPEECH_THRESHOLD: Number(
          process.env.STT_FASTER_WHISPER_NO_SPEECH_THRESHOLD ?? 0.35,
        ),
        STT_PYTHON_BIN: process.env.STT_PYTHON_BIN ?? "python3",
        STT_FASTER_WHISPER_SCRIPT: whisperScript,
        STT_NEMO_MODEL:
          process.env.STT_NEMO_MODEL ?? "kazalbrur/bangla-stt-conformer-120m-dialects",
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

      const transcript = await transcribeWithDiarization({
        audioPath: storedPath,
        stt,
        language: sttLanguageHint,
        diarization: diarizationConfigFromEnv(),
      });
      const publicTranscript = toPublicTranscript(transcript);
      const transcribeMs = Date.now() - transcribeStarted;

      // Whisper/faster-whisper is ASR (ML), not an LLM — bill by audio seconds → ledger units.
      const sttSlug = `stt:${transcript.model || process.env.STT_FASTER_WHISPER_MODEL || "faster-whisper"}`;
      const durationSec = audioDurationSec({
        segments: transcript.segments,
        text: transcript.text,
        bytes: audioBuffer.length,
      });
      const sttUnits = sttBillableUnits(durationSec);
      const sttExecution = await createInferenceRequest({
        customerId: req.auth!.customerId,
        apiKeyId: req.auth!.apiKeyId,
        requestedModelSlug: sttSlug,
        stream: false,
      });
      await startAttempt(sttExecution.id, {
        backend: "faster-whisper",
        modelSlug: sttSlug,
        attemptNo: 1,
      });
      await finalizeAndMeter({
        executionId: sttExecution.id,
        auth: req.auth!,
        modelSlug: sttSlug,
        promptTokens: sttUnits,
        completionTokens: 0,
        latencyMs: transcribeMs,
        ttftMs: null,
        generationMs: transcribeMs,
        queueMs: 0,
        finishReason: "stop",
        requestId: req.requestId ?? sttExecution.id,
        reservedTokens: 0,
        costMicros: 0n,
      });
      console.log(
        JSON.stringify({
          event: "stt.metered",
          customerId: req.auth!.customerId,
          model: sttSlug,
          durationSec: Number(durationSec.toFixed(2)),
          billableUnits: sttUnits,
        }),
      );

      if (voiceEnv.DIARIZATION_ENABLED) {
        const diarizeModel =
          voiceEnv.DIARIZATION_BACKEND === "cloud"
            ? voiceEnv.DIARIZATION_CLOUD_MODEL
            : voiceEnv.DIARIZATION_MODEL;
        const diarizeSlug = `diarize:${diarizeModel}`;
        const diarizeUnits = Math.max(1, Math.ceil(durationSec * 5));
        const diarizeExecution = await createInferenceRequest({
          customerId: req.auth!.customerId,
          apiKeyId: req.auth!.apiKeyId,
          requestedModelSlug: diarizeSlug,
          stream: false,
        });
        await startAttempt(diarizeExecution.id, {
          backend:
            voiceEnv.DIARIZATION_BACKEND === "cloud" ? "pyannoteAI" : "pyannote",
          modelSlug: diarizeSlug,
          attemptNo: 1,
        });
        await finalizeAndMeter({
          executionId: diarizeExecution.id,
          auth: req.auth!,
          modelSlug: diarizeSlug,
          promptTokens: diarizeUnits,
          completionTokens: 0,
          latencyMs: transcribeMs,
          ttftMs: null,
          generationMs: transcribeMs,
          queueMs: 0,
          finishReason: "stop",
          requestId: req.requestId ?? diarizeExecution.id,
          reservedTokens: 0,
          costMicros: 0n,
        });
      }

      const userAnalysisPrompt =
        typeof req.query.prompt === "string" ? req.query.prompt.trim() : "";
      const analysisPrompt = userAnalysisPrompt
        ? buildVoiceAnalysisPrompt(transcript, userAnalysisPrompt)
        : null;

      let analysis = "";
      let analysisModel: string | null = null;
      if (analysisPrompt) {
        analysisModel = await resolveVoiceAnalysisModel({
          auth: {
            customerId: req.auth!.customerId,
            apiKeyId: req.auth!.apiKeyId,
            allowedModelIds: req.auth!.allowedModelIds,
            planId: req.auth!.planId,
          },
          requestedModel: typeof req.query.model === "string" ? req.query.model : undefined,
        });
        const upstream = await fetch(`http://127.0.0.1:${process.env.GATEWAY_PORT ?? "9000"}/v1/chat/completions`, {
          method: "POST",
          headers: {
            authorization: req.header("authorization") ?? "",
            "content-type": "application/json",
            "x-modelforge-orchestration": "voice-analyze",
          },
          body: JSON.stringify({
            model: analysisModel,
            stream: false,
            max_tokens: Number(req.query.max_tokens ?? 1200),
            temperature: 0.2,
            messages: [
              {
                role: "system",
                content: buildVoiceAnalysisSystemPrompt(transcript),
              },
              { role: "user", content: analysisPrompt },
            ],
          }),
        });
        const analysisJson = (await upstream.json().catch(() => null)) as
          | { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } }
          | null;
        if (!upstream.ok) {
          return res.status(upstream.status).json({
            error: {
              type: "analysis_failed",
              message: analysisJson?.error?.message ?? "Transcript analysis failed",
            },
          });
        }
        analysis = analysisJson?.choices?.[0]?.message?.content ?? "";
      }
      console.log(
        JSON.stringify({
          event: "voice.analyzed",
          customerId: req.auth!.customerId,
          requestId: req.requestId,
          bytes: audioBuffer.length,
          transcribeMs,
          transcriptChars: transcript.text.length,
          analysisChars: analysis.length,
          provider: transcript.provider,
          model: transcript.model,
          speakers: publicTranscript.speakers,
          segmentCount: publicTranscript.segments.length,
          diarization: voiceEnv.DIARIZATION_ENABLED,
          analysisModel,
        }),
      );
      return res.json({
        transcript: publicTranscript,
        analysis,
        metrics: {
          transcribeMs,
          audioDurationSec: Number(durationSec.toFixed(2)),
          sttBillableUnits: sttUnits,
          diarizationEnabled: voiceEnv.DIARIZATION_ENABLED,
          speakerCount: publicTranscript.speakers.length,
          analysisModel,
        },
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "voice.pipeline_error",
          message: error instanceof Error ? error.message : String(error),
          requestId: req.requestId,
        }),
      );
      return res.status(500).json({
        error: {
          type: "voice_pipeline_error",
          message: error instanceof Error ? error.message : "Voice pipeline failed",
        },
      });
    }
  },
);

/** Neo4j graph API — ModelForge-hosted; meters read/write/storage for the API key owner. */
v1Router.get("/graph/stats", authMiddleware, rateLimitRpmMiddleware, async (req, res) => {
  try {
    if (!neo4jConfigured()) {
      return res.status(503).json({
        error: { type: "service_unavailable", message: "Neo4j is not configured on ModelForge" },
      });
    }
    const stats = await neo4jStoreStats();
    const execution = await createInferenceRequest({
      customerId: req.auth!.customerId,
      apiKeyId: req.auth!.apiKeyId,
      requestedModelSlug: "neo4j:storage",
      stream: false,
    });
    await startAttempt(execution.id, {
      backend: "neo4j",
      modelSlug: "neo4j:storage",
      attemptNo: 1,
    });
    const storeUnits = Math.min(2_147_483_647, Math.max(0, Math.floor(stats.storeSizeBytes)));
    await finalizeAndMeter({
      executionId: execution.id,
      auth: req.auth!,
      modelSlug: "neo4j:storage",
      promptTokens: storeUnits,
      completionTokens: 0,
      latencyMs: stats.tookMs,
      ttftMs: null,
      generationMs: stats.tookMs,
      queueMs: 0,
      finishReason: "stop",
      requestId: req.requestId ?? execution.id,
      reservedTokens: 0,
      costMicros: 0n,
    });
    res.json({
      nodeCount: stats.nodeCount,
      relationshipCount: stats.relationshipCount,
      storeSizeBytes: stats.storeSizeBytes,
      tookMs: stats.tookMs,
    });
  } catch (error) {
    res.status(500).json({
      error: {
        type: "neo4j_error",
        message: error instanceof Error ? error.message : "Neo4j stats failed",
      },
    });
  }
});

v1Router.post("/graph/query", authMiddleware, rateLimitMiddleware, quotaMiddleware, async (req, res) => {
  try {
    if (!neo4jConfigured()) {
      return res.status(503).json({
        error: { type: "service_unavailable", message: "Neo4j is not configured on ModelForge" },
      });
    }
    const cypher = typeof req.body?.cypher === "string" ? req.body.cypher.trim() : "";
    if (!cypher) {
      return res.status(400).json({ error: { type: "invalid_request", message: "cypher required" } });
    }
    const params =
      req.body?.params && typeof req.body.params === "object" && !Array.isArray(req.body.params)
        ? (req.body.params as Record<string, unknown>)
        : {};
    const result = await runCypher({ cypher, params });
    const slug = result.kind === "write" ? "neo4j:write" : "neo4j:read";
    const execution = await createInferenceRequest({
      customerId: req.auth!.customerId,
      apiKeyId: req.auth!.apiKeyId,
      requestedModelSlug: slug,
      stream: false,
    });
    await startAttempt(execution.id, {
      backend: "neo4j",
      modelSlug: slug,
      attemptNo: 1,
    });
    await finalizeAndMeter({
      executionId: execution.id,
      auth: req.auth!,
      modelSlug: slug,
      promptTokens: result.billableUnits,
      completionTokens: 0,
      latencyMs: result.tookMs,
      ttftMs: null,
      generationMs: result.tookMs,
      queueMs: 0,
      finishReason: "stop",
      requestId: req.requestId ?? execution.id,
      reservedTokens: 0,
      costMicros: 0n,
    });
    res.json({
      kind: result.kind,
      billableUnits: result.billableUnits,
      tookMs: result.tookMs,
      records: result.records,
    });
  } catch (error) {
    res.status(500).json({
      error: {
        type: "neo4j_error",
        message: error instanceof Error ? error.message : "Neo4j query failed",
      },
    });
  }
});

v1Router.post(
  "/chat/completions",
  authMiddleware,
  rateLimitMiddleware,
  quotaMiddleware,
  async (req, res) => {
    const started = Date.now();
    const requestId = req.requestId ?? randomUUID();
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
    const messages = coalesceAlternatingRoles(normalizeMessages(body.messages));
    const requestedKnowledgeBaseIds = body.metadata?.modelforge?.knowledge_base_ids ?? [];
    const ragTopK = body.metadata?.modelforge?.rag_top_k ?? 4;
    const estimatedTokens =
      Math.max(64, Math.ceil(messages.reduce((n, m) => n + m.content.length, 0) / 4)) +
      body.max_tokens +
      (requestedKnowledgeBaseIds.length > 0 ? 1_024 : 0);

    let executionId: string | undefined;
    let reservedTokens = 0;
    let headersStarted = false;
    let resolvedSlug = body.model;
    let coreTrace: CoreTraceRecorder | null = null;

    try {
      const requestedHosted =
        body.model === "auto"
          ? null
          : await prisma.hostedModel.findUnique({ where: { modelId: body.model } });
      const execution = await createInferenceRequest({
        customerId: req.auth!.customerId,
        apiKeyId: req.auth!.apiKeyId,
        requestedModelSlug: body.model,
        requestedModelId: requestedHosted?.id,
        stream: body.stream,
      });
      executionId = execution.id;
      res.setHeader("x-request-id", execution.id);
      coreTrace = await claimCoreTrace({
        customerId: req.auth!.customerId,
        requestId: execution.id,
        startedAtMs: started,
        explicitTraceId: body.metadata?.modelforge?.trace_session_id,
        requestSnapshot: {
          requestedModel: body.model,
          stream: body.stream,
          messageCount: messages.length,
          roles: messages.map((message) => message.role),
          promptCharacters: messages.reduce((sum, message) => sum + message.content.length, 0),
          estimatedPromptTokens: estimatedTokens - body.max_tokens,
          maxOutputTokens: body.max_tokens,
          sampling: { temperature: body.temperature, topP: body.top_p },
          contentCaptured: false,
        },
      });

      if (req.auth!.billingMode !== "USAGE" && req.auth!.monthlyTokenQuota > 0n) {
        await reserveQuota({
          customerId: req.auth!.customerId,
          requestId: execution.id,
          estimatedTokens,
          idempotencyKey: `${execution.id}:reserve`,
          limit: req.auth!.monthlyTokenQuota,
          periodStart: req.auth!.periodStart,
          periodEnd: req.auth!.periodEnd,
        });
        reservedTokens = estimatedTokens;
      }
      await coreTrace?.event({
        phase: "admission",
        kind: "quota.reserved",
        payload: {
          estimatedTotalTokens: estimatedTokens,
          reservedTokens,
          billingMode: req.auth!.billingMode,
        },
      });

      const routed = await resolveModelForRequest({
        auth: {
          customerId: req.auth!.customerId,
          apiKeyId: req.auth!.apiKeyId,
          allowedModelIds: req.auth!.allowedModelIds,
          planId: req.auth!.planId,
        },
        requestedModel: body.model,
        maxTokens: body.max_tokens,
        messages,
        applyPii: process.env.MODELFORGE_PII_REDACT !== "false",
      });
      resolvedSlug = routed.resolvedModelSlug;
      await coreTrace?.event({
        phase: "routing",
        kind: "model.resolved",
        payload: {
          requestedModel: body.model,
          resolvedModel: routed.resolvedModelSlug,
          policyVersionId: routed.policyVersionId ?? null,
          decisionHash: routed.decisionHash ?? null,
          piiRedactionApplied: Boolean(routed.redactedMessages),
          model: {
            quantization: routed.hosted.quantization,
            contextLength: routed.hosted.contextLength,
            threads: routed.hosted.nThreads,
            gpuLayers: routed.hosted.gpuLayers,
            qualityClass: routed.hosted.qualityClass,
            latencyClass: routed.hosted.latencyClass,
            supportsTools: routed.hosted.supportsTools,
          },
        },
      });

      const pricing = await getActivePricingVersion(routed.hosted.id);
      await startAttempt(execution.id, {
        backend: process.env.INFERENCE_BACKEND ?? "llama-server",
        modelSlug: routed.resolvedModelSlug,
        attemptNo: 1,
      });
      await coreTrace?.event({
        phase: "runtime",
        kind: "engine.dispatched",
        payload: {
          backend: process.env.INFERENCE_BACKEND ?? "llama-server",
          mmap: process.env.USE_MMAP !== "false",
          model: routed.resolvedModelSlug,
        },
      });

      let inferenceMessages = routed.redactedMessages ?? messages;
      let retrieval: RetrievalResult | null = null;
      if (requestedKnowledgeBaseIds.length > 0) {
        const query = lastUserQuery(inferenceMessages);
        retrieval = await retrieveCustomerKnowledge({
          customerId: req.auth!.customerId,
          query,
          knowledgeBaseIds: requestedKnowledgeBaseIds,
          topK: ragTopK,
          contextLength: routed.hosted.contextLength,
        });
        inferenceMessages = applyRetrievalContext(
          inferenceMessages,
          retrieval.hits,
          retrieval.mode,
        );
        await persistRetrievalRun({ requestId: execution.id, result: retrieval });
        await coreTrace?.event({
          phase: "retrieval",
          kind: "knowledge.retrieved",
          payload: {
            knowledgeBaseIds: retrieval.knowledgeBaseIds,
            topK: retrieval.topK,
            hitCount: retrieval.hits.length,
            titles: retrieval.hits.map((hit) => hit.documentTitle),
          },
        });
      }

      const completionId = `chatcmpl_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
      const abortController = new AbortController();
      const cancelOnDisconnect = () => {
        if (!res.writableEnded) abortController.abort();
      };
      res.once("close", cancelOnDisconnect);

      const completionTokensLimit = clampMaxTokens(
        routed.hosted.contextLength,
        inferenceMessages,
        body.max_tokens,
      );

      const stream = generateStream(
        {
          model_id: routed.resolvedModelSlug,
          messages: inferenceMessages,
          temperature: body.temperature,
          max_tokens: completionTokensLimit,
          top_p: body.top_p,
          stop_sequences: body.stop,
          stream: body.stream,
          response_format: body.response_format,
        },
        undefined,
        {
          signal: abortController.signal,
          deadlineMs: Number(process.env.INFERENCE_TIMEOUT_MS ?? 900_000),
        },
      );

      let promptTokens = 0;
      let completionTokens = 0;
      let finishReason: "stop" | "length" | "error" = "stop";
      let content = "";
      let ttftMs: number | null = null;
      const generationStarted = Date.now();
      let tracedCharacters = 0;
      let traceChunkCount = 0;
      let lastTraceEventAt = generationStarted;

      const traceDelta = async (delta: string) => {
        if (!coreTrace) return;
        const now = Date.now();
        tracedCharacters += delta.length;
        traceChunkCount += 1;
        if (traceChunkCount === 1) {
          await coreTrace.event({
            phase: "generation",
            kind: "token.first",
            payload: { ttftMs, characters: delta.length },
          });
          lastTraceEventAt = now;
          return;
        }
        // Batches avoid a database write per streamed chunk while still making
        // the live inspector visibly update during long generations.
        if (traceChunkCount % 16 === 0 || now - lastTraceEventAt >= 500) {
          await coreTrace.event({
            phase: "generation",
            kind: "token.batch",
            payload: {
              chunks: traceChunkCount,
              characters: tracedCharacters,
              elapsedMs: now - generationStarted,
              approximateTokens: Math.max(1, Math.round(tracedCharacters / 4)),
            },
          });
          lastTraceEventAt = now;
        }
      };

      const completeCoreTrace = async (input: {
        promptTokens: number;
        completionTokens: number;
        latencyMs: number;
        costMicros: bigint;
        finishReason: string;
      }) => {
        await coreTrace?.complete({
          model: routed.resolvedModelSlug,
          status: "SUCCEEDED",
          promptTokens: input.promptTokens,
          completionTokens: input.completionTokens,
          ttftMs,
          generationMs: Date.now() - generationStarted,
          latencyMs: input.latencyMs,
          finishReason: input.finishReason,
          costMicros: input.costMicros.toString(),
          expertRouting: {
            available: false,
            reason: "The active llama-server adapter does not expose per-token MoE router choices.",
          },
          attentionMaps: {
            available: false,
            reason:
              "Attention tensors require an instrumented debug runtime and are intentionally disabled.",
          },
        });
      };

      res.setHeader("x-modelforge-request-id", execution.id);
      res.setHeader("x-modelforge-resolved-model", routed.resolvedModelSlug);
      if (retrieval) {
        res.setHeader("x-modelforge-retrieval-hits", String(retrieval.hits.length));
      }

      try {
        if (body.stream) {
          headersStarted = true;
          res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
          res.setHeader("Cache-Control", "no-cache, no-transform");
          res.setHeader("Connection", "keep-alive");
          res.setHeader("Trailer", "x-modelforge-cost-micros");
          res.flushHeaders?.();
          res.write(
            toSse(
              buildChunk({
                id: completionId,
                model: routed.resolvedModelSlug,
                role: true,
                delta: "",
              }),
            ),
          );
          if (retrieval) {
            res.write(
              toSse({
                modelforge: {
                  retrieval: {
                    knowledge_base_ids: retrieval.knowledgeBaseIds,
                    hits: publicRetrievalHits(retrieval.hits),
                  },
                },
              }),
            );
          }

          for await (const chunk of stream) {
            promptTokens = chunk.prompt_tokens || promptTokens;
            completionTokens = chunk.completion_tokens || completionTokens;
            if (chunk.delta) {
              if (ttftMs === null) ttftMs = Date.now() - generationStarted;
              content += chunk.delta;
              await traceDelta(chunk.delta);
              res.write(
                toSse(
                  buildChunk({
                    id: completionId,
                    model: routed.resolvedModelSlug,
                    delta: chunk.delta,
                  }),
                ),
              );
            }
            if (chunk.is_final) {
              finishReason =
                chunk.finish_reason === "length" || chunk.finish_reason === "error"
                  ? chunk.finish_reason
                  : "stop";
              // Prefer engine usage; fall back so subscriber quota still moves.
              if (promptTokens + completionTokens === 0) {
                const estimated = estimateChatTokens(messages, content);
                promptTokens = estimated.promptTokens;
                completionTokens = estimated.completionTokens;
              }
              res.write(
                toSse(
                  buildChunk({
                    id: completionId,
                    model: routed.resolvedModelSlug,
                    finishReason,
                    usage: {
                      prompt_tokens: promptTokens,
                      completion_tokens: completionTokens,
                      total_tokens: promptTokens + completionTokens,
                    },
                  }),
                ),
              );
              break;
            }
          }
        } else {
          for await (const chunk of stream) {
            promptTokens = chunk.prompt_tokens || promptTokens;
            completionTokens = chunk.completion_tokens || completionTokens;
            if (chunk.delta) {
              if (ttftMs === null) ttftMs = Date.now() - generationStarted;
              content += chunk.delta;
              await traceDelta(chunk.delta);
            }
            if (chunk.is_final) {
              finishReason =
                chunk.finish_reason === "length" || chunk.finish_reason === "error"
                  ? chunk.finish_reason
                  : "stop";
            }
          }
          if (promptTokens + completionTokens === 0) {
            const estimated = estimateChatTokens(messages, content);
            promptTokens = estimated.promptTokens;
            completionTokens = estimated.completionTokens;
          }
          const latencyMs = Date.now() - started;
          const costMicros = computeCostMicros(
            promptTokens,
            completionTokens,
            pricing.pricePerMTokIn,
            pricing.pricePerMTokOut,
          );
          res.setHeader("x-modelforge-finish-reason", finishReason);
          res.setHeader("x-modelforge-cost-micros", costMicros.toString());
          if (finishReason === "length") res.setHeader("x-modelforge-truncated", "true");
          await finalizeAndMeter({
            executionId: execution.id,
            auth: req.auth!,
            hostedId: routed.hosted.id,
            modelSlug: routed.resolvedModelSlug,
            pricingVersionId: pricing.id,
            priceIn: pricing.pricePerMTokIn,
            priceOut: pricing.pricePerMTokOut,
            promptTokens,
            completionTokens,
            latencyMs,
            ttftMs,
            generationMs: Date.now() - generationStarted,
            queueMs: generationStarted - started,
            finishReason,
            requestId,
            reservedTokens,
            policyVersionId: routed.policyVersionId,
            policyDecisionHash: routed.decisionHash,
            costMicros,
          });
          await completeCoreTrace({
            promptTokens,
            completionTokens,
            latencyMs,
            costMicros,
            finishReason,
          });
          res.json({
            ...buildCompletionResponse({
              id: completionId,
              model: routed.resolvedModelSlug,
              content,
              finishReason,
              promptTokens,
              completionTokens,
            }),
            ...(retrieval
              ? {
                  modelforge: {
                    retrieval: {
                      knowledge_base_ids: retrieval.knowledgeBaseIds,
                      hits: publicRetrievalHits(retrieval.hits),
                    },
                  },
                }
              : {}),
          });
          return;
        }

        const latencyMs = Date.now() - started;
        const costMicros = computeCostMicros(
          promptTokens,
          completionTokens,
          pricing.pricePerMTokIn,
          pricing.pricePerMTokOut,
        );
        await finalizeAndMeter({
          executionId: execution.id,
          auth: req.auth!,
          hostedId: routed.hosted.id,
          modelSlug: routed.resolvedModelSlug,
          pricingVersionId: pricing.id,
          priceIn: pricing.pricePerMTokIn,
          priceOut: pricing.pricePerMTokOut,
          promptTokens,
          completionTokens,
          latencyMs,
          ttftMs,
          generationMs: Date.now() - generationStarted,
          queueMs: generationStarted - started,
          finishReason,
          requestId,
          reservedTokens,
          policyVersionId: routed.policyVersionId,
          policyDecisionHash: routed.decisionHash,
          costMicros,
        });
        await completeCoreTrace({
          promptTokens,
          completionTokens,
          latencyMs,
          costMicros,
          finishReason,
        });
        res.write("data: [DONE]\n\n");
        res.addTrailers({ "x-modelforge-cost-micros": costMicros.toString() });
        res.end();
      } finally {
        res.removeListener("close", cancelOnDisconnect);
      }
    } catch (err) {
      await coreTrace
        ?.fail(err instanceof Error ? err.message : "Inference failed")
        .catch(() => undefined);
      if (executionId && reservedTokens > 0) {
        await releaseQuota({
          customerId: req.auth!.customerId,
          requestId: executionId,
          reservedTokens,
          idempotencyKey: `${executionId}:release`,
        }).catch(() => undefined);
      }
      if (executionId) {
        await finalizeInferenceRequest(executionId, {
          status: err instanceof QuotaExceededError ? "REJECTED" : "FAILED",
          error: {
            code: err instanceof QuotaExceededError ? "quota_exceeded" : "inference_error",
            message: err instanceof Error ? err.message : "Inference failed",
          },
          resolvedModelSlug: resolvedSlug,
          attemptNo: 1,
        }).catch(() => undefined);
      }

      if (err instanceof RetrievalError) {
        return res.status(err.status).json({
          error: { type: err.type, message: err.message },
        });
      }

      if (err instanceof QuotaExceededError) {
        return res.status(429).json({
          error: { type: "quota_exceeded", message: err.message },
        });
      }

      const mapped = mapEngineFailure(err);
      const apiErr = mapEngineError(mapped.code, mapped.message);
      if (headersStarted) {
        if (!res.writableEnded) {
          res.write(
            toSse({
              error: {
                type: apiErr instanceof ApiError ? apiErr.type : "server_error",
                message: apiErr instanceof ApiError ? apiErr.message : mapped.message,
              },
            }),
          );
          res.write("data: [DONE]\n\n");
          res.end();
        }
        return;
      }
      if (apiErr instanceof ApiError) {
        if (apiErr.retryAfter) res.setHeader("Retry-After", String(apiErr.retryAfter));
        return res.status(apiErr.status).json(apiErr.toJSON());
      }
      const code = (err as { code?: string }).code;
      if (code === "MODEL_NOT_FOUND") {
        return res.status(404).json({
          error: { type: "model_not_found", message: err instanceof Error ? err.message : "Model not found" },
        });
      }
      return res.status(500).json({ error: { type: "server_error", message: "Inference failed" } });
    }
  },
);

async function finalizeAndMeter(input: {
  executionId: string;
  auth: NonNullable<Express.Request["auth"]>;
  hostedId?: string;
  modelSlug: string;
  pricingVersionId?: string;
  priceIn?: number;
  priceOut?: number;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  ttftMs: number | null;
  generationMs: number;
  queueMs: number;
  finishReason: string;
  requestId: string;
  reservedTokens: number;
  policyVersionId?: string;
  policyDecisionHash?: string;
  costMicros: bigint;
}) {
  await finalizeInferenceRequest(input.executionId, {
    status: "SUCCEEDED",
    promptTokens: input.promptTokens,
    completionTokens: input.completionTokens,
    latencyMs: input.latencyMs,
    ttftMs: input.ttftMs,
    generationMs: input.generationMs,
    queueMs: input.queueMs,
    finishReason: input.finishReason,
    pricingVersionId: input.pricingVersionId,
    costMicros: input.costMicros,
    resolvedModelId: input.hostedId,
    resolvedModelSlug: input.modelSlug,
    policyVersionId: input.policyVersionId,
    policyDecisionHash: input.policyDecisionHash,
    attemptNo: 1,
  });

  if (input.reservedTokens > 0) {
    await commitQuota({
      customerId: input.auth.customerId,
      requestId: input.executionId,
      actualTokens: input.promptTokens + input.completionTokens,
      idempotencyKey: `${input.executionId}:usage:commit`,
    });
  }

  try {
    await enqueueUsage({
      customerId: input.auth.customerId,
      apiKeyId: input.auth.apiKeyId,
      hostedModelId: input.hostedId,
      modelSlug: input.modelSlug,
      promptTokens: input.promptTokens,
      completionTokens: input.completionTokens,
      latencyMs: input.latencyMs,
      requestId: input.requestId,
      idempotencyKey: `${input.executionId}:usage`,
      inferenceRequestId: input.executionId,
      costMicros: input.costMicros.toString(),
      pricePerMTokIn: input.priceIn,
      pricePerMTokOut: input.priceOut,
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "usage.persist_failed",
        executionId: input.executionId,
        customerId: input.auth.customerId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    throw error;
  }
  await bumpQuotaCache(input.auth.customerId, input.promptTokens + input.completionTokens);
  await writeAuditEvent({
    actorType: "api_key",
    actorId: input.auth.apiKeyId,
    customerId: input.auth.customerId,
    action: "inference.completed",
    resourceType: "InferenceRequest",
    resourceId: input.executionId,
    requestId: input.requestId,
    metadata: {
      model: input.modelSlug,
      tokens: input.promptTokens + input.completionTokens,
      costMicros: input.costMicros.toString(),
    },
  });
}

/** Rough token estimate when llama-server omits usage (keeps subscriber quota accurate). */
function estimateChatTokens(
  messages: Array<{ role: string; content: string }>,
  completion: string,
): { promptTokens: number; completionTokens: number } {
  const promptChars = messages.reduce((sum, message) => sum + message.content.length, 0);
  return {
    promptTokens: Math.max(1, Math.ceil(promptChars / 4)),
    completionTokens: Math.max(0, Math.ceil(completion.length / 4)),
  };
}
