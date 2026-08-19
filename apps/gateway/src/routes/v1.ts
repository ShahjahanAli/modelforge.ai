import { Router } from "express";
import { prisma } from "@modelforge/db";
import {
  ApiError,
  buildChunk,
  buildCompletionResponse,
  chatCompletionRequestSchema,
  mapEngineError,
  normalizeMessages,
  toSse,
} from "@modelforge/engine";
import { randomUUID } from "node:crypto";
import { generateStream, mapEngineFailure } from "../engine/index.js";
import {
  createInferenceRequest,
  finalizeInferenceRequest,
  startAttempt,
  writeAuditEvent,
} from "../lib/execution.js";
import { commitQuota, QuotaExceededError, releaseQuota, reserveQuota } from "../lib/quotaLedger.js";
import { resolveModelForRequest } from "../lib/policyRouter.js";
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
import { rateLimitMiddleware } from "../middleware/quota.js";
import { bumpQuotaCache, quotaMiddleware } from "../middleware/quotaCheck.js";

export const v1Router = Router();

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
    const messages = normalizeMessages(body.messages);
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
  hostedId: string;
  modelSlug: string;
  pricingVersionId: string;
  priceIn: number;
  priceOut: number;
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
