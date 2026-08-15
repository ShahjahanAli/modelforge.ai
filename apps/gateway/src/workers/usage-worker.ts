import { Worker } from "bullmq";
import { USAGE_QUEUE, type UsageJob } from "../lib/queues.js";
import { isRedisEnabled, redisConnection } from "../lib/redis.js";
import { persistUsageEvent } from "../lib/usage.js";

if (!isRedisEnabled()) {
  console.log("Usage worker skipped (REDIS_ENABLED=false). Gateway writes usage to Postgres directly.");
  process.exit(0);
}

const worker = new Worker<UsageJob>(
  USAGE_QUEUE,
  async (job) => {
    await persistUsageEvent(job.data);
  },
  { connection: redisConnection() as never, concurrency: 10 },
);

worker.on("failed", (job, err) => {
  console.error("usage job failed", job?.id, err);
});

console.log("Usage worker started");
