/**
 * Shared metering for Gemini voice bypass — records real prompt/completion tokens
 * against the hosted Gemini model (UsageEvent via BullMQ / direct write).
 */
import {
  createInferenceRequest,
  finalizeInferenceRequest,
  startAttempt,
} from "./execution.js";
import { computeCostMicros } from "./pricing.js";
import { enqueueUsage } from "./queues.js";
import { bumpQuotaCache } from "../middleware/quotaCheck.js";
import type { GeminiVoiceResult } from "./voice/geminiAudio.js";

export async function meterGeminiVoiceUsage(input: {
  auth: { customerId: string; apiKeyId: string };
  requestId?: string;
  result: GeminiVoiceResult;
}): Promise<{ executionId: string; costMicros: bigint }> {
  const { result, auth } = input;
  const execution = await createInferenceRequest({
    customerId: auth.customerId,
    apiKeyId: auth.apiKeyId,
    requestedModelSlug: result.modelSlug,
    requestedModelId: result.hostedModelId,
    stream: false,
  });

  await startAttempt(execution.id, {
    backend: "gemini-audio",
    modelSlug: result.modelSlug,
    attemptNo: 1,
  });

  const priceIn = result.pricePerMTokIn ?? 0;
  const priceOut = result.pricePerMTokOut ?? 0;
  const costMicros = computeCostMicros(
    result.usage.promptTokens,
    result.usage.completionTokens,
    priceIn,
    priceOut,
  );

  await finalizeInferenceRequest(execution.id, {
    status: "SUCCEEDED",
    promptTokens: result.usage.promptTokens,
    completionTokens: result.usage.completionTokens,
    latencyMs: result.latencyMs,
    ttftMs: result.latencyMs,
    generationMs: result.latencyMs,
    finishReason: "stop",
    pricingVersionId: result.pricingVersionId ?? null,
    costMicros,
    resolvedModelId: result.hostedModelId ?? null,
    resolvedModelSlug: result.modelSlug,
    attemptNo: 1,
  });

  await enqueueUsage({
    customerId: auth.customerId,
    apiKeyId: auth.apiKeyId,
    hostedModelId: result.hostedModelId,
    modelSlug: result.modelSlug,
    promptTokens: result.usage.promptTokens,
    completionTokens: result.usage.completionTokens,
    latencyMs: result.latencyMs,
    requestId: input.requestId ?? execution.id,
    idempotencyKey: `${execution.id}:usage`,
    inferenceRequestId: execution.id,
    costMicros: costMicros.toString(),
    pricePerMTokIn: priceIn || undefined,
    pricePerMTokOut: priceOut || undefined,
  });

  await bumpQuotaCache(
    auth.customerId,
    result.usage.promptTokens + result.usage.completionTokens,
  );

  console.log(
    JSON.stringify({
      event: "gemini.voice.metered",
      customerId: auth.customerId,
      model: result.modelSlug,
      upstreamModel: result.upstreamModel,
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
      costMicros: costMicros.toString(),
      latencyMs: result.latencyMs,
    }),
  );

  return { executionId: execution.id, costMicros };
}
