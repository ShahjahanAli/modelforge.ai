import { Worker } from "bullmq";
import { isRedisEnabled, redisConnection } from "../lib/redis.js";
import { rollupSloWindows, runEvalSuite } from "../lib/modernJobs.js";
import { EVAL_QUEUE, SLO_QUEUE } from "../lib/queues.js";

if (!isRedisEnabled()) {
  console.log("Modern workers skipped (REDIS_ENABLED=false). Call rollup/eval helpers directly.");
} else {
  const connection = redisConnection() as never;
  new Worker(
    SLO_QUEUE,
    async () => {
      await rollupSloWindows();
    },
    { connection },
  );
  new Worker(
    EVAL_QUEUE,
    async (job) => {
      const suiteId = String(job.data.suiteId ?? "");
      const revisionId = String(job.data.revisionId ?? "");
      if (!suiteId || !revisionId) throw new Error("suiteId and revisionId required");
      return runEvalSuite(suiteId, revisionId);
    },
    { connection },
  );
  console.log("SLO and evaluation workers started");
}
