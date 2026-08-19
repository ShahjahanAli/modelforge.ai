import { Router } from "express";
import path from "node:path";
import { prisma } from "@modelforge/db";
import { createPaymentAdapter, generateInvoice } from "@modelforge/billing";
import { generateApiKey } from "../lib/keys.js";
import { internalAuth } from "../middleware/auth.js";
import {
  activeBackend,
  healthCheck,
  listLoadedModels,
  loadModel,
  unloadModel,
} from "../engine/index.js";
import { scanWeights, weightsDir, deleteRegisteredWeights } from "../lib/weights.js";
import { armCoreTrace, disarmCoreTrace } from "../lib/coreTrace.js";
import {
  cancelHuggingFaceDownload,
  getHuggingFaceDownload,
  listHuggingFaceDownloads,
  listHuggingFaceGgufFiles,
  removeHuggingFaceDownload,
  retryHuggingFaceDownload,
  searchHuggingFaceModels,
  startHuggingFaceDownload,
} from "../lib/huggingFace.js";

export const internalRouter = Router();
internalRouter.use(internalAuth);

function normalizedWeightPath(value: string): string {
  const root = weightsDir();
  const relative = path.isAbsolute(value) ? path.relative(root, value) : value;
  const normalized = relative.replaceAll("\\", "/").replace(/^\.\/+/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

internalRouter.get("/huggingface/search", async (req, res) => {
  try {
    const query = String(req.query.q ?? "");
    const models = await searchHuggingFaceModels(query, Number(req.query.limit ?? 20));
    res.json({ models });
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : "Hub search failed" });
  }
});

internalRouter.get("/huggingface/files", async (req, res) => {
  try {
    const repoId = String(req.query.repo ?? "");
    res.json(await listHuggingFaceGgufFiles(repoId));
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : "File listing failed" });
  }
});

internalRouter.get("/huggingface/downloads", (_req, res) => {
  res.json({ downloads: listHuggingFaceDownloads() });
});

internalRouter.post("/huggingface/downloads", async (req, res) => {
  try {
    const body = req.body as {
      repoId?: string;
      revision?: string;
      filePath?: string;
      expectedSize?: number;
      sha256?: string | null;
      register?: boolean;
    };
    if (!body.repoId || !body.filePath) {
      return res.status(400).json({ error: "repoId and filePath are required" });
    }
    const download = await startHuggingFaceDownload({
      repoId: body.repoId,
      revision: body.revision,
      filePath: body.filePath,
      expectedSize: body.expectedSize,
      sha256: body.sha256,
      register: body.register,
    });
    res.status(202).json(download);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Download failed to start" });
  }
});

internalRouter.post("/huggingface/downloads/:id/retry", async (req, res) => {
  try {
    res.status(202).json(await retryHuggingFaceDownload(req.params.id!));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Retry failed" });
  }
});

internalRouter.get("/huggingface/downloads/:id", (req, res) => {
  const download = getHuggingFaceDownload(req.params.id!);
  if (!download) return res.status(404).json({ error: "Download not found" });
  res.json(download);
});

internalRouter.delete("/huggingface/downloads/:id", (req, res) => {
  const cancelled = cancelHuggingFaceDownload(req.params.id!);
  const removed = cancelled ? false : removeHuggingFaceDownload(req.params.id!);
  res.status(cancelled || removed ? 200 : 409).json({ cancelled, removed });
});

internalRouter.post("/diagnostics/traces/:traceId/arm", async (req, res) => {
  const traceId = req.params.traceId!;
  const customerId = String(req.body?.customerId ?? "");
  if (!customerId) {
    return res.status(400).json({ error: { type: "invalid_request", message: "customerId required" } });
  }
  const trace = await prisma.coreTraceSession.findFirst({
    where: { id: traceId, customerId, status: "ARMED", expiresAt: { gt: new Date() } },
    select: { id: true },
  });
  if (!trace) {
    return res.status(404).json({ error: { type: "not_found", message: "Active trace not found" } });
  }
  armCoreTrace(customerId, traceId);
  res.json({ armed: true, traceId });
});

internalRouter.delete("/diagnostics/traces/:traceId/arm", async (req, res) => {
  const traceId = req.params.traceId!;
  const customerId = String(req.body?.customerId ?? "");
  disarmCoreTrace(customerId, traceId);
  res.json({ armed: false, traceId });
});

internalRouter.post("/keys", async (req, res) => {
  const { customerId, label } = req.body as { customerId?: string; label?: string };
  if (!customerId) {
    return res.status(400).json({ error: { type: "invalid_request", message: "customerId required" } });
  }
  const customer = await prisma.customer.findUnique({ where: { id: customerId } });
  if (!customer) {
    return res.status(404).json({ error: { type: "invalid_request", message: "customer not found" } });
  }
  const key = generateApiKey();
  const row = await prisma.apiKey.create({
    data: {
      customerId,
      keyHash: key.hash,
      keyPrefix: key.prefix,
      label: label ?? null,
    },
  });
  res.status(201).json({
    id: row.id,
    keyPrefix: row.keyPrefix,
    label: row.label,
    rawKey: key.raw,
    createdAt: row.createdAt,
  });
});

internalRouter.delete("/keys/:id", async (req, res) => {
  const id = req.params.id!;
  const row = await prisma.apiKey.update({
    where: { id },
    data: { revokedAt: new Date() },
  });
  res.json({ id: row.id, revokedAt: row.revokedAt });
});

internalRouter.get("/usage", async (req, res) => {
  const customerId = String(req.query.customerId ?? "");
  const from = req.query.from ? new Date(String(req.query.from)) : new Date(Date.now() - 30 * 86400000);
  const to = req.query.to ? new Date(String(req.query.to)) : new Date();
  if (!customerId) {
    return res.status(400).json({ error: { type: "invalid_request", message: "customerId required" } });
  }
  const events = await prisma.usageEvent.findMany({
    where: { customerId, createdAt: { gte: from, lt: to } },
    orderBy: { createdAt: "asc" },
    take: 5000,
  });
  const prompt = events.reduce((s, e) => s + e.promptTokens, 0);
  const completion = events.reduce((s, e) => s + e.completionTokens, 0);
  res.json({
    customerId,
    from,
    to,
    requestCount: events.length,
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: prompt + completion,
    events,
  });
});

internalRouter.get("/engine/health", async (_req, res) => {
  try {
    const health = await healthCheck();
    res.json({ ...health, backend: activeBackend() });
  } catch (err) {
    res.status(503).json({
      healthy: false,
      backend: activeBackend(),
      error: err instanceof Error ? err.message : "engine unreachable",
    });
  }
});

internalRouter.get("/engine/models", async (_req, res) => {
  try {
    const list = await listLoadedModels();
    res.json(list);
  } catch (err) {
    res.status(503).json({ error: err instanceof Error ? err.message : "engine unreachable" });
  }
});

/**
 * Filesystem discovery of GGUF weights. The gateway owns this because the
 * weights directory is host-local infrastructure; the control plane never
 * touches the filesystem directly.
 */
internalRouter.get("/engine/models/available", async (_req, res) => {
  try {
    const [files, registered] = await Promise.all([
      scanWeights(),
      prisma.hostedModel.findMany({ select: { modelId: true, weightsPath: true } }),
    ]);
    const byPath = new Map(
      registered.map((row) => [normalizedWeightPath(row.weightsPath), row.modelId]),
    );
    res.json({
      weightsDir: weightsDir(),
      files: files.map((file) => ({
        ...file,
        registeredAs: byPath.get(normalizedWeightPath(file.relativePath)) ?? null,
      })),
    });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : "scan failed",
      weightsDir: weightsDir(),
      files: [],
    });
  }
});

internalRouter.post("/engine/models/register", async (req, res) => {
  const body = req.body as {
    weightsPath?: string;
    modelId?: string;
    displayName?: string;
    quantization?: string;
    contextLength?: number;
    nThreads?: number;
    pricePerMTokIn?: number;
    pricePerMTokOut?: number;
  };

  if (!body.weightsPath || !body.modelId) {
    return res.status(400).json({
      error: { type: "invalid_request", message: "weightsPath and modelId required" },
    });
  }

  const discovered = (await scanWeights()).find(
    (file) => file.relativePath === body.weightsPath,
  );
  if (!discovered) {
    return res.status(400).json({
      error: {
        type: "invalid_request",
        message: "weightsPath is not a GGUF file inside MODEL_WEIGHTS_DIR",
      },
    });
  }

  const data = {
    displayName: body.displayName?.trim() || discovered.suggestedDisplayName,
    weightsPath: discovered.relativePath,
    quantization: body.quantization?.trim() || discovered.quantization,
    contextLength: Number(body.contextLength) || 8192,
    nThreads: Number(body.nThreads) || 8,
    pricePerMTokIn: Number(body.pricePerMTokIn) || 20,
    pricePerMTokOut: Number(body.pricePerMTokOut) || 60,
    gpuLayers: 0,
  };

  const row = await prisma.hostedModel.upsert({
    where: { modelId: body.modelId },
    update: data,
    create: { modelId: body.modelId, ...data, status: "INACTIVE" },
  });

  res.status(201).json({ modelId: row.modelId, weightsPath: row.weightsPath });
});

internalRouter.post("/engine/models/:modelId/load", async (req, res) => {
  const modelId = req.params.modelId!;
  const hosted = await prisma.hostedModel.findUnique({ where: { modelId } });
  if (!hosted) {
    return res.status(404).json({ error: { type: "model_not_found", message: "Unknown model" } });
  }
  try {
    const result = await loadModel({
      model_id: hosted.modelId,
      weights_path: hosted.weightsPath,
      context_length: hosted.contextLength,
      n_threads: hosted.nThreads,
      quantization: hosted.quantization,
      use_mmap: true,
    });
    if (result.success) {
      await prisma.hostedModel.update({
        where: { id: hosted.id },
        data: { status: "LOADED" },
      });
    } else {
      await prisma.hostedModel.update({
        where: { id: hosted.id },
        data: { status: "ERROR" },
      });
    }
    res.json(result);
  } catch (err) {
    await prisma.hostedModel.update({
      where: { id: hosted.id },
      data: { status: "ERROR" },
    });
    res.status(503).json({
      success: false,
      error: err instanceof Error ? err.message : "load failed",
    });
  }
});

internalRouter.post("/engine/models/:modelId/unload", async (req, res) => {
  const modelId = req.params.modelId!;
  try {
    const result = await unloadModel(modelId);
    if (result.success) {
      await prisma.hostedModel.updateMany({
        where: { modelId },
        data: { status: "INACTIVE" },
      });
    }
    res.json(result);
  } catch (err) {
    res.status(503).json({
      success: false,
      error: err instanceof Error ? err.message : "unload failed",
    });
  }
});

internalRouter.delete("/engine/models/:modelId", async (req, res) => {
  const modelId = req.params.modelId!;
  const hosted = await prisma.hostedModel.findUnique({ where: { modelId } });
  if (!hosted) {
    return res.status(404).json({ error: { type: "model_not_found", message: "Unknown model" } });
  }

  try {
    await unloadModel(modelId);
  } catch (err) {
    return res.status(503).json({
      success: false,
      error: err instanceof Error ? err.message : "unload failed",
    });
  }

  const plans = await prisma.plan.findMany({ select: { id: true, allowedModelIds: true } });
  await Promise.all(
    plans
      .filter((plan) => plan.allowedModelIds.includes(modelId))
      .map((plan) =>
        prisma.plan.update({
          where: { id: plan.id },
          data: { allowedModelIds: plan.allowedModelIds.filter((id) => id !== modelId) },
        }),
      ),
  );
  await prisma.planModelEntitlement.deleteMany({ where: { modelSlug: modelId } });

  const others = await prisma.hostedModel.count({
    where: { id: { not: hosted.id }, weightsPath: hosted.weightsPath },
  });
  const weightsPath = hosted.weightsPath;
  await prisma.hostedModel.delete({ where: { id: hosted.id } });

  let deletedFiles: string[] = [];
  let fileError: string | undefined;
  if (others === 0) {
    try {
      deletedFiles = await deleteRegisteredWeights(weightsPath);
    } catch (err) {
      fileError = err instanceof Error ? err.message : "failed to delete weights";
    }
  }

  res.json({
    success: true,
    modelId,
    deletedFiles,
    message: fileError
      ? `Model removed from the registry, but weights were not deleted: ${fileError}`
      : deletedFiles.length
        ? "Model removed from the registry and weights deleted"
        : "Model removed from the registry",
  });
});

internalRouter.post("/invoices/generate", async (req, res) => {
  const { customerId, periodStart, periodEnd } = req.body as {
    customerId?: string;
    periodStart?: string;
    periodEnd?: string;
  };
  if (!customerId || !periodStart || !periodEnd) {
    return res.status(400).json({ error: { message: "customerId, periodStart, periodEnd required" } });
  }
  const invoice = await generateInvoice(customerId, new Date(periodStart), new Date(periodEnd));
  res.json(invoice);
});

internalRouter.post("/invoices/:id/checkout", async (req, res) => {
  const id = req.params.id!;
  const provider = (req.body?.provider as "stripe" | "bkash" | "nagad" | "mock") ?? "mock";
  const customerId = typeof req.body?.customerId === "string" ? req.body.customerId : null;
  const invoice = await prisma.invoice.findUnique({ where: { id } });
  if (!invoice) return res.status(404).json({ error: { message: "invoice not found" } });
  if (customerId && invoice.customerId !== customerId) {
    return res.status(403).json({ error: { message: "invoice ownership mismatch" } });
  }
  const adapter = createPaymentAdapter(provider);
  const checkout = await adapter.createCheckout({
    customerId: invoice.customerId,
    invoiceId: invoice.id,
    amountCents: invoice.amountCents,
    description: `ModelForge invoice ${invoice.id}`,
  });
  await prisma.invoice.update({
    where: { id },
    data: {
      status: "SENT",
      paymentProvider: checkout.provider,
      paymentRef: checkout.externalId,
    },
  });
  res.json(checkout);
});
