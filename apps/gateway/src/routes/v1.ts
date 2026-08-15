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
import { enqueueUsage } from "../lib/queues.js";
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
  if (!req.auth!.allowedModelIds.includes(modelId)) {
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
    if (!req.auth!.allowedModelIds.includes(body.model)) {
      return res.status(404).json({
        error: { type: "model_not_found", message: `Model ${body.model} not available on your plan` },
      });
    }

    const hosted = await prisma.hostedModel.findUnique({ where: { modelId: body.model } });
    if (!hosted) {
      return res.status(404).json({ error: { type: "model_not_found", message: "Model not found" } });
    }

    const messages = normalizeMessages(body.messages);
    const completionId = `chatcmpl_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const abortController = new AbortController();
    const cancelOnDisconnect = () => {
      if (!res.writableEnded) abortController.abort();
    };
    res.once("close", cancelOnDisconnect);

    try {
      const stream = generateStream({
        model_id: body.model,
        messages,
        temperature: body.temperature,
        max_tokens: body.max_tokens,
        top_p: body.top_p,
        stop_sequences: body.stop,
        stream: body.stream,
      }, undefined, {
        signal: abortController.signal,
        deadlineMs: Number(process.env.INFERENCE_TIMEOUT_MS ?? 300_000),
      });

      let promptTokens = 0;
      let completionTokens = 0;
      let finishReason: "stop" | "length" | "error" = "stop";
      let content = "";

      if (body.stream) {
        res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.flushHeaders?.();
        res.write(toSse(buildChunk({ id: completionId, model: body.model, role: true, delta: "" })));

        for await (const chunk of stream) {
          promptTokens = chunk.prompt_tokens || promptTokens;
          completionTokens = chunk.completion_tokens || completionTokens;
          if (chunk.delta) {
            content += chunk.delta;
            res.write(
              toSse(
                buildChunk({
                  id: completionId,
                  model: body.model,
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
                  model: body.model,
                  finishReason,
                  usage: {
                    prompt_tokens: promptTokens,
                    completion_tokens: completionTokens,
                    total_tokens: promptTokens + completionTokens,
                  },
                }),
              ),
            );
            res.write("data: [DONE]\n\n");
            break;
          }
        }
        res.end();
      } else {
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
        res.json(
          buildCompletionResponse({
            id: completionId,
            model: body.model,
            content,
            finishReason,
            promptTokens,
            completionTokens,
          }),
        );
      }

      const latencyMs = Date.now() - started;
      const totalTokens = promptTokens + completionTokens;
      await enqueueUsage({
        customerId: req.auth!.customerId,
        apiKeyId: req.auth!.apiKeyId,
        hostedModelId: hosted.id,
        modelSlug: hosted.modelId,
        promptTokens,
        completionTokens,
        latencyMs,
        requestId,
        idempotencyKey: `${requestId}:usage`,
      });
      await bumpQuotaCache(req.auth!.customerId, totalTokens);
    } catch (err) {
      const mapped = mapEngineFailure(err);
      const apiErr = mapEngineError(mapped.code, mapped.message);
      if (apiErr instanceof ApiError) {
        if (apiErr.retryAfter) res.setHeader("Retry-After", String(apiErr.retryAfter));
        return res.status(apiErr.status).json(apiErr.toJSON());
      }
      return res.status(500).json({ error: { type: "server_error", message: "Inference failed" } });
    } finally {
      res.removeListener("close", cancelOnDisconnect);
    }
  },
);
