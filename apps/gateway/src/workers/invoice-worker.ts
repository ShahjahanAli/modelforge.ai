import { Queue, Worker } from "bullmq";
import { prisma } from "@modelforge/db";
import { generateInvoice } from "@modelforge/billing";
import { INVOICE_QUEUE } from "../lib/queues.js";
import { isRedisEnabled, redisConnection } from "../lib/redis.js";

if (!isRedisEnabled()) {
  console.log("Invoice worker skipped (REDIS_ENABLED=false). Run invoices via /internal/invoices/generate.");
  process.exit(0);
}

const queue = new Queue(INVOICE_QUEUE, { connection: redisConnection() as never });

async function ensureScheduler() {
  await queue.upsertJobScheduler(
    "daily-invoice-scan",
    { every: 24 * 60 * 60 * 1000 },
    {
      name: "scan-period-ends",
      data: {},
    },
  );
}

const worker = new Worker(
  INVOICE_QUEUE,
  async () => {
    const now = new Date();
    const due = await prisma.subscription.findMany({
      where: {
        status: "ACTIVE",
        currentPeriodEnd: { lte: now },
      },
    });

    for (const sub of due) {
      await generateInvoice(sub.customerId, sub.currentPeriodStart, sub.currentPeriodEnd);
      const nextStart = sub.currentPeriodEnd;
      const nextEnd = new Date(nextStart);
      nextEnd.setMonth(nextEnd.getMonth() + 1);
      await prisma.subscription.update({
        where: { id: sub.id },
        data: {
          currentPeriodStart: nextStart,
          currentPeriodEnd: nextEnd,
        },
      });
      await prisma.quotaLedger.upsert({
        where: { customerId: sub.customerId },
        update: {
          periodStart: nextStart,
          periodEnd: nextEnd,
          tokensUsed: 0n,
        },
        create: {
          customerId: sub.customerId,
          periodStart: nextStart,
          periodEnd: nextEnd,
          tokensUsed: 0n,
        },
      });
    }
    return { processed: due.length };
  },
  { connection: redisConnection() as never, concurrency: 1 },
);

worker.on("failed", (job, err) => {
  console.error("invoice job failed", job?.id, err);
});

await ensureScheduler();
console.log("Invoice worker + daily scheduler started");
