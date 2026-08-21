import { Queue } from "bullmq";
import { redisConnection, isRedisEnabled } from "../lib/redis.js";
import { persistUsageEvent, type UsageJobExtended } from "../lib/usage.js";

export const USAGE_QUEUE = "usage-events";
export const INVOICE_QUEUE = "invoice-jobs";
export const EVAL_QUEUE = "eval-jobs";
export const SLO_QUEUE = "slo-jobs";

export interface UsageJob {
  customerId: string;
  apiKeyId: string;
  hostedModelId?: string;
  modelSlug: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  requestId: string;
  idempotencyKey: string;
  inferenceRequestId?: string;
  costMicros?: string;
  pricePerMTokIn?: number;
  pricePerMTokOut?: number;
}

let usageQueue: Queue<UsageJob> | null = null;

export function getUsageQueue() {
  if (!isRedisEnabled()) {
    throw new Error("Usage queue unavailable when REDIS_ENABLED=false");
  }
  if (!usageQueue) {
    usageQueue = new Queue<UsageJob>(USAGE_QUEUE, {
      connection: redisConnection() as never,
    });
  }
  return usageQueue;
}

/** Enqueue via BullMQ when Redis is on; write Postgres directly when Redis is off. */
export async function enqueueUsage(job: UsageJob) {
  if (!isRedisEnabled()) {
    await persistUsageEvent(job as UsageJobExtended);
    return;
  }

  await getUsageQueue().add("usage", job, {
    jobId: job.idempotencyKey,
    removeOnComplete: 1000,
    removeOnFail: 5000,
    attempts: 5,
    backoff: { type: "exponential", delay: 1000 },
  });
}
