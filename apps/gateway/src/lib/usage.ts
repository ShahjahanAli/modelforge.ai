import { prisma } from "@modelforge/db";
import type { UsageJob } from "./queues.js";
import { getRedis, isRedisEnabled } from "./redis.js";
import { issueUsageReceipt } from "./receipts.js";

export type UsageJobExtended = UsageJob & {
  inferenceRequestId?: string;
  costMicros?: string;
  pricePerMTokIn?: number;
  pricePerMTokOut?: number;
};

export async function persistUsageEvent(data: UsageJobExtended): Promise<void> {
  const tokens = BigInt(data.promptTokens + data.completionTokens);
  const commitKey = `${data.idempotencyKey}:commit`;

  await prisma.$transaction(async (tx) => {
    const existingEvent = await tx.usageEvent.findUnique({
      where: { idempotencyKey: data.idempotencyKey },
    });
    if (existingEvent) return;

    const periodStart = new Date();
    const periodEnd = new Date(periodStart.getTime() + 30 * 86_400_000);
    const ledger = await tx.quotaLedger.upsert({
      where: { customerId: data.customerId },
      update: {},
      create: {
        customerId: data.customerId,
        periodStart,
        periodEnd,
      },
    });

    const inserted = await tx.quotaLedgerEntry.createMany({
      data: {
        ledgerId: ledger.id,
        idempotencyKey: commitKey,
        deltaTokens: tokens,
        reservedDelta: 0n,
        reason: "USAGE_COMMIT",
        requestId: data.inferenceRequestId ?? data.requestId,
      },
      skipDuplicates: true,
    });

    await tx.usageEvent.upsert({
      where: { idempotencyKey: data.idempotencyKey },
      update: {},
      create: {
        customerId: data.customerId,
        apiKeyId: data.apiKeyId,
        modelId: data.hostedModelId || null,
        modelSlug: data.modelSlug,
        promptTokens: data.promptTokens,
        completionTokens: data.completionTokens,
        latencyMs: data.latencyMs,
        requestId: data.requestId,
        idempotencyKey: data.idempotencyKey,
        inferenceRequestId: data.inferenceRequestId,
      },
    });

    if (inserted.count === 1) {
      await tx.quotaLedger.update({
        where: { id: ledger.id },
        data: { tokensUsed: { increment: tokens } },
      });
    }
  });

  console.log(
    JSON.stringify({
      event: "usage.persisted",
      customerId: data.customerId,
      apiKeyId: data.apiKeyId,
      modelSlug: data.modelSlug,
      promptTokens: data.promptTokens,
      completionTokens: data.completionTokens,
      tokens: data.promptTokens + data.completionTokens,
      idempotencyKey: data.idempotencyKey,
    }),
  );
  if (data.inferenceRequestId) {
    const request = await prisma.inferenceRequest.findUnique({
      where: { id: data.inferenceRequestId },
    });
    const usageEvent = await prisma.usageEvent.findUnique({
      where: { idempotencyKey: data.idempotencyKey },
    });
    if (request && usageEvent) {
      await issueUsageReceipt({ request, usageEventId: usageEvent.id }).catch((error) => {
        console.error("receipt issuance failed", error);
      });
    }
  }

  if (!isRedisEnabled()) return;
  const redis = getRedis();
  const cacheKey = `quota:${data.customerId}`;
  const ledger = await prisma.quotaLedger.findUnique({ where: { customerId: data.customerId } });
  if (ledger) {
    await redis.set(cacheKey, ledger.tokensUsed.toString(), "EX", 300);
  }
}
