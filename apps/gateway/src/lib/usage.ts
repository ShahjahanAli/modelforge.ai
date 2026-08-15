import { prisma } from "@modelforge/db";
import type { UsageJob } from "./queues.js";
import { getRedis, isRedisEnabled } from "./redis.js";

export async function persistUsageEvent(data: UsageJob): Promise<void> {
  await prisma.usageEvent.upsert({
    where: { idempotencyKey: data.idempotencyKey },
    update: {},
    create: {
      customerId: data.customerId,
      apiKeyId: data.apiKeyId,
      modelId: data.hostedModelId,
      modelSlug: data.modelSlug,
      promptTokens: data.promptTokens,
      completionTokens: data.completionTokens,
      latencyMs: data.latencyMs,
      requestId: data.requestId,
      idempotencyKey: data.idempotencyKey,
    },
  });

  const tokens = BigInt(data.promptTokens + data.completionTokens);
  await prisma.quotaLedger.upsert({
    where: { customerId: data.customerId },
    update: { tokensUsed: { increment: tokens } },
    create: {
      customerId: data.customerId,
      periodStart: new Date(),
      periodEnd: new Date(Date.now() + 30 * 86400000),
      tokensUsed: tokens,
    },
  });

  if (!isRedisEnabled()) return;

  const redis = getRedis();
  const cacheKey = `quota:${data.customerId}`;
  const ledger = await prisma.quotaLedger.findUnique({ where: { customerId: data.customerId } });
  if (ledger) {
    await redis.set(cacheKey, ledger.tokensUsed.toString(), "EX", 300);
  }
}
