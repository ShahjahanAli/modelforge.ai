import { createHash, randomUUID } from "node:crypto";
import { prisma } from "@modelforge/db";
import { computeCreditMicros, computeWindowStatus } from "@modelforge/platform";

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

export async function rollupSloWindows(now = new Date()) {
  const definitions = await prisma.sloDefinition.findMany({ where: { enabled: true } });
  for (const definition of definitions) {
    const windowMs = definition.windowMinutes * 60_000;
    const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
    const windowEnd = new Date(windowStart.getTime() + windowMs);
    const requests = await prisma.inferenceRequest.findMany({
      where: { createdAt: { gte: windowStart, lt: windowEnd } },
      select: { id: true, customerId: true, status: true, latencyMs: true },
    });
    const byCustomer = new Map<string | null, typeof requests>();
    byCustomer.set(null, requests);
    for (const request of requests) {
      const bucket = byCustomer.get(request.customerId) ?? [];
      bucket.push(request);
      byCustomer.set(request.customerId, bucket);
    }

    for (const [customerId, rows] of byCustomer) {
      const successCount = rows.filter((row) => row.status === "SUCCEEDED").length;
      const availabilityPct = rows.length === 0 ? 100 : (successCount / rows.length) * 100;
      const p95LatencyMs = percentile(
        rows.filter((row) => row.status === "SUCCEEDED").map((row) => row.latencyMs),
        95,
      );
      const status = computeWindowStatus(availabilityPct, p95LatencyMs, {
        availabilityPct: definition.availabilityPct,
        latencyP95Ms: definition.latencyP95Ms,
      });
      const payload = {
        windowEnd,
        requestCount: rows.length,
        successCount,
        breachCount: status === "BREACHED" ? 1 : 0,
        p95LatencyMs,
        availabilityPct,
        status,
      };

      if (customerId) {
        await prisma.sloWindow.upsert({
          where: {
            definitionId_customerId_windowStart: {
              definitionId: definition.id,
              customerId,
              windowStart,
            },
          },
          update: payload,
          create: {
            definitionId: definition.id,
            customerId,
            windowStart,
            ...payload,
          },
        });
      } else {
        const existing = await prisma.sloWindow.findFirst({
          where: { definitionId: definition.id, customerId: null, windowStart },
        });
        if (existing) {
          await prisma.sloWindow.update({ where: { id: existing.id }, data: payload });
        } else {
          await prisma.sloWindow.create({
            data: {
              definitionId: definition.id,
              customerId: null,
              windowStart,
              ...payload,
            },
          });
        }
      }

      if (status === "BREACHED" && customerId) {
        const amount = computeCreditMicros({
          breached: true,
          creditMicros: definition.creditMicros,
        });
        const reason = `SLO ${definition.name} breached for window ${windowStart.toISOString()}`;
        const existing = await prisma.serviceCredit.findFirst({
          where: { customerId, reason },
        });
        if (!existing && amount > 0n) {
          await prisma.serviceCredit.create({
            data: {
              customerId,
              amountMicros: amount,
              reason,
            },
          });
        }
      }
    }
  }
}

export async function runEvalSuite(suiteId: string, revisionId: string) {
  const suite = await prisma.evalSuite.findUniqueOrThrow({
    where: { id: suiteId },
    include: { cases: true },
  });
  const run = await prisma.evalRun.create({
    data: { suiteId, revisionId, status: "RUNNING" },
  });
  let passed = 0;
  for (const evalCase of suite.cases) {
    const output = `echo:${evalCase.prompt.slice(0, 64)}`;
    const ok = !evalCase.expected || output.toLowerCase().includes(evalCase.expected.toLowerCase());
    if (ok) passed += 1;
    await prisma.evalResult.create({
      data: {
        runId: run.id,
        caseName: evalCase.name,
        passed: ok,
        score: ok ? 1 : 0,
        output,
        latencyMs: 1,
      },
    });
  }
  const score = suite.cases.length === 0 ? 0 : passed / suite.cases.length;
  return prisma.evalRun.update({
    where: { id: run.id },
    data: {
      status: "SUCCEEDED",
      score,
      summary: { passed, total: suite.cases.length },
      completedAt: new Date(),
    },
  });
}

export async function ingestTextDocument(input: {
  knowledgeBaseId: string;
  title: string;
  content: string;
}) {
  const { chunkText, simpleEmbed } = await import("@modelforge/platform");
  const checksum = createHash("sha256").update(input.content).digest("hex");
  const document = await prisma.knowledgeDocument.create({
    data: {
      knowledgeBaseId: input.knowledgeBaseId,
      title: input.title,
      status: "RUNNING",
      contentType: "text/plain",
    },
  });
  const version = await prisma.documentVersion.create({
    data: {
      documentId: document.id,
      version: 1,
      checksum,
      storageKey: `local://${document.id}/v1.txt`,
      byteSize: Buffer.byteLength(input.content),
    },
  });
  const chunks = chunkText(input.content, 2_000);
  for (const [ordinal, content] of chunks.entries()) {
    await prisma.knowledgeChunk.create({
      data: {
        versionId: version.id,
        ordinal,
        content,
        tokenCount: Math.ceil(content.length / 4),
        embedding: simpleEmbed(content),
      },
    });
  }
  await prisma.knowledgeDocument.update({
    where: { id: document.id },
    data: { status: "SUCCEEDED" },
  });
  return { documentId: document.id, versionId: version.id, chunks: chunks.length };
}

export async function ensureLocalNode() {
  const os = await import("node:os");
  const totalRamMb = Math.round(os.totalmem() / 1024 / 1024);
  const freeRamMb = Math.round(os.freemem() / 1024 / 1024);
  return prisma.runtimeNode.upsert({
    where: { name: "local-primary" },
    update: {
      hostname: os.hostname(),
      status: "ONLINE",
      totalRamMb,
      freeRamMb,
      cpuCores: os.cpus().length,
      lastHeartbeat: new Date(),
    },
    create: {
      name: "local-primary",
      hostname: os.hostname(),
      region: "local",
      status: "ONLINE",
      totalRamMb,
      freeRamMb,
      cpuCores: os.cpus().length,
      trustState: "local",
      lastHeartbeat: new Date(),
      capabilities: { backend: process.env.INFERENCE_BACKEND ?? "llama-server" },
    },
  });
}

export async function createFederationOffer(input: {
  modelSlug: string;
  capacity: number;
  priceMicros: bigint;
  region?: string;
}) {
  return prisma.federationOffer.create({
    data: {
      nodeName: "local-primary",
      modelSlug: input.modelSlug,
      capacity: input.capacity,
      priceMicros: input.priceMicros,
      region: input.region ?? "local",
      expiresAt: new Date(Date.now() + 15 * 60_000),
    },
  });
}

export function newIdempotencyKey(prefix = "job") {
  return `${prefix}:${randomUUID()}`;
}
