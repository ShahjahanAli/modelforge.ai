import { Router } from "express";
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
import { scanWeights, weightsDir } from "../lib/weights.js";

export const internalRouter = Router();
internalRouter.use(internalAuth);

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
    const byPath = new Map(registered.map((row) => [row.weightsPath, row.modelId]));
    res.json({
      weightsDir: weightsDir(),
      files: files.map((file) => ({
        ...file,
        registeredAs: byPath.get(file.relativePath) ?? null,
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
