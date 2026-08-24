"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@modelforge/db";
import { gatewayFetch } from "@/lib/gateway";
import { requireAdmin } from "@/lib/session";
import { writeAuditEvent } from "@/lib/audit";
import { encryptProviderSecret } from "@/lib/providerCredentials";

export async function upsertModelAction(formData: FormData) {
  const admin = await requireAdmin();
  const modelId = String(formData.get("modelId"));
  const data = {
    displayName: String(formData.get("displayName")),
    weightsPath: String(formData.get("weightsPath")),
    quantization: String(formData.get("quantization") || "Q4_K_M"),
    contextLength: Number(formData.get("contextLength") || 8192),
    nThreads: Number(formData.get("nThreads") || 8),
    pricePerMTokIn: Number(formData.get("pricePerMTokIn") || 20),
    pricePerMTokOut: Number(formData.get("pricePerMTokOut") || 60),
    gpuLayers: 0,
    providerKind: "LOCAL_GGUF" as const,
  };
  const model = await prisma.hostedModel.upsert({
    where: { modelId },
    update: data,
    create: { modelId, ...data, status: "INACTIVE" },
  });
  await prisma.pricingVersion.create({
    data: {
      hostedModelId: model.id,
      pricePerMTokIn: data.pricePerMTokIn,
      pricePerMTokOut: data.pricePerMTokOut,
    },
  });
  await writeAuditEvent({
    actorType: "admin",
    actorId: admin.id,
    action: "model.upsert",
    resourceType: "HostedModel",
    resourceId: model.id,
    after: { modelId, ...data },
  });
  revalidatePath("/admin/models");
  revalidatePath("/admin/infra");
}

export async function upsertRemoteModelAction(formData: FormData): Promise<{
  ok: boolean;
  message: string;
}> {
  const admin = await requireAdmin();
  const modelId = String(formData.get("modelId") ?? "").trim();
  const displayName = String(formData.get("displayName") ?? "").trim();
  const remoteBaseUrl = String(formData.get("remoteBaseUrl") ?? "").trim().replace(/\/+$/, "");
  const remoteModelId = String(formData.get("remoteModelId") ?? "").trim();
  const apiKey = String(formData.get("apiKey") ?? "").trim();
  const credentialLabel =
    String(formData.get("credentialLabel") ?? "").trim() ||
    (remoteBaseUrl.includes("generativelanguage.googleapis.com")
      ? "Gemini"
      : remoteBaseUrl.includes("openrouter.ai")
        ? "OpenRouter"
        : "Remote");
  const contextLength = Number(formData.get("contextLength") || 128000);
  const pricePerMTokIn = Number(formData.get("pricePerMTokIn") || 20);
  const pricePerMTokOut = Number(formData.get("pricePerMTokOut") || 60);
  const makeDefault = String(formData.get("makeDefault") ?? "") === "on";

  if (!modelId || !displayName || !remoteBaseUrl || !remoteModelId) {
    return {
      ok: false,
      message: "modelId, displayName, remoteBaseUrl, and remoteModelId are required",
    };
  }

  try {
    let credentialId: string | undefined;
    const existing = await prisma.hostedModel.findUnique({
      where: { modelId },
      select: { credentialId: true },
    });

    if (apiKey) {
      const sealed = encryptProviderSecret(apiKey);
      if (existing?.credentialId) {
        await prisma.providerCredential.update({
          where: { id: existing.credentialId },
          data: {
            label: credentialLabel,
            ciphertext: sealed.ciphertext,
            iv: sealed.iv,
            authTag: sealed.authTag,
            keyPrefix: sealed.keyPrefix,
            providerKind: "OPENAI_COMPAT",
          },
        });
        credentialId = existing.credentialId;
      } else {
        const created = await prisma.providerCredential.create({
          data: {
            label: credentialLabel,
            providerKind: "OPENAI_COMPAT",
            ciphertext: sealed.ciphertext,
            iv: sealed.iv,
            authTag: sealed.authTag,
            keyPrefix: sealed.keyPrefix,
          },
        });
        credentialId = created.id;
      }
    } else if (existing?.credentialId) {
      credentialId = existing.credentialId;
    } else if (
      !process.env.GEMINI_API_KEY &&
      !process.env.OPENROUTER_API_KEY &&
      !process.env.REMOTE_LLM_API_KEY
    ) {
      return {
        ok: false,
        message:
          "Paste an API key, or set GEMINI_API_KEY / OPENROUTER_API_KEY / REMOTE_LLM_API_KEY in the gateway env",
      };
    }

    const data = {
      displayName,
      weightsPath: "",
      quantization: "remote",
      contextLength,
      nThreads: 0,
      gpuLayers: 0,
      pricePerMTokIn,
      pricePerMTokOut,
      providerKind: "OPENAI_COMPAT" as const,
      remoteBaseUrl,
      remoteModelId,
      status: "LOADED" as const,
      ...(credentialId ? { credentialId } : {}),
    };

    const model = await prisma.hostedModel.upsert({
      where: { modelId },
      update: data,
      create: { modelId, ...data },
    });

    await prisma.pricingVersion.create({
      data: {
        hostedModelId: model.id,
        pricePerMTokIn,
        pricePerMTokOut,
      },
    });

    const plans = await prisma.plan.findMany({ select: { id: true, allowedModelIds: true } });
    await Promise.all(
      plans
        .filter((plan) => !plan.allowedModelIds.includes(modelId))
        .map(async (plan) => {
          await prisma.plan.update({
            where: { id: plan.id },
            data: { allowedModelIds: [...plan.allowedModelIds, modelId] },
          });
          await prisma.planModelEntitlement.upsert({
            where: { planId_modelSlug: { planId: plan.id, modelSlug: modelId } },
            update: {},
            create: { planId: plan.id, modelSlug: modelId },
          });
        }),
    );

    if (makeDefault) {
      await prisma.$transaction([
        prisma.hostedModel.updateMany({
          where: { isPlatformDefault: true },
          data: { isPlatformDefault: false },
        }),
        prisma.hostedModel.update({
          where: { id: model.id },
          data: { isPlatformDefault: true },
        }),
      ]);
    }

    await writeAuditEvent({
      actorType: "admin",
      actorId: admin.id,
      action: "model.upsert_remote",
      resourceType: "HostedModel",
      resourceId: model.id,
      after: {
        modelId,
        providerKind: "OPENAI_COMPAT",
        remoteBaseUrl,
        remoteModelId,
        makeDefault,
        keyUpdated: Boolean(apiKey),
      },
    });

    revalidatePath("/admin/models");
    revalidatePath("/admin/infra");
    revalidatePath("/chat");
    revalidatePath("/models");
    return {
      ok: true,
      message: makeDefault
        ? `${displayName} registered as remote provider and set as platform default`
        : `${displayName} registered as remote OpenAI-compatible provider`,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Failed to register remote model",
    };
  }
}

export async function registerDiscoveredAction(formData: FormData) {
  const admin = await requireAdmin();
  await gatewayFetch("/internal/engine/models/register", {
    method: "POST",
    body: JSON.stringify({
      weightsPath: String(formData.get("weightsPath")),
      modelId: String(formData.get("modelId")),
      displayName: String(formData.get("displayName") || ""),
      quantization: String(formData.get("quantization") || ""),
      contextLength: Number(formData.get("contextLength") || 8192),
      nThreads: Number(formData.get("nThreads") || 8),
    }),
  });
  await writeAuditEvent({
    actorType: "admin",
    actorId: admin.id,
    action: "model.register_discovered",
    resourceType: "HostedModel",
    resourceId: String(formData.get("modelId")),
  });
  revalidatePath("/admin/models");
  revalidatePath("/admin/infra");
}

export async function updateModelPropertiesAction(formData: FormData): Promise<{
  ok: boolean;
  message: string;
}> {
  const admin = await requireAdmin();
  const modelId = String(formData.get("modelId") ?? "").trim();
  if (!modelId) return { ok: false, message: "Model id required" };

  const existing = await prisma.hostedModel.findUnique({
    where: { modelId },
    select: {
      id: true,
      modelId: true,
      displayName: true,
      providerKind: true,
      weightsPath: true,
      quantization: true,
      contextLength: true,
      nThreads: true,
      pricePerMTokIn: true,
      pricePerMTokOut: true,
      remoteBaseUrl: true,
      remoteModelId: true,
      credentialId: true,
    },
  });
  if (!existing) return { ok: false, message: "Model not found" };

  const displayName = String(formData.get("displayName") ?? "").trim();
  const contextLength = Number(formData.get("contextLength") || existing.contextLength);
  const pricePerMTokIn = Number(formData.get("pricePerMTokIn") || existing.pricePerMTokIn);
  const pricePerMTokOut = Number(formData.get("pricePerMTokOut") || existing.pricePerMTokOut);

  if (!displayName) return { ok: false, message: "Display name is required" };
  if (!Number.isFinite(contextLength) || contextLength < 512) {
    return { ok: false, message: "Context length must be at least 512" };
  }
  if (!Number.isFinite(pricePerMTokIn) || pricePerMTokIn < 0) {
    return { ok: false, message: "Input price must be a non-negative number" };
  }
  if (!Number.isFinite(pricePerMTokOut) || pricePerMTokOut < 0) {
    return { ok: false, message: "Output price must be a non-negative number" };
  }

  try {
    if (existing.providerKind === "OPENAI_COMPAT") {
      const remoteBaseUrl = String(formData.get("remoteBaseUrl") ?? "")
        .trim()
        .replace(/\/+$/, "");
      const remoteModelId = String(formData.get("remoteModelId") ?? "").trim();
      const quantization = String(
        formData.get("quantization") ?? existing.quantization ?? "remote",
      ).trim();
      const apiKey = String(formData.get("apiKey") ?? "").trim();

      if (!remoteBaseUrl || !remoteModelId) {
        return { ok: false, message: "Base URL and upstream model id are required" };
      }

      let credentialId = existing.credentialId ?? undefined;
      if (apiKey) {
        const sealed = encryptProviderSecret(apiKey);
        const credentialLabel = /generativelanguage\.googleapis\.com/i.test(remoteBaseUrl)
          ? "Gemini"
          : /openrouter\.ai/i.test(remoteBaseUrl)
            ? "OpenRouter"
            : /api\.openai\.com/i.test(remoteBaseUrl)
              ? "OpenAI"
              : "Remote";
        if (existing.credentialId) {
          await prisma.providerCredential.update({
            where: { id: existing.credentialId },
            data: {
              label: credentialLabel,
              ciphertext: sealed.ciphertext,
              iv: sealed.iv,
              authTag: sealed.authTag,
              keyPrefix: sealed.keyPrefix,
            },
          });
          credentialId = existing.credentialId;
        } else {
          const created = await prisma.providerCredential.create({
            data: {
              label: credentialLabel,
              providerKind: "OPENAI_COMPAT",
              ciphertext: sealed.ciphertext,
              iv: sealed.iv,
              authTag: sealed.authTag,
              keyPrefix: sealed.keyPrefix,
            },
          });
          credentialId = created.id;
        }
      }

      await prisma.hostedModel.update({
        where: { id: existing.id },
        data: {
          displayName,
          contextLength,
          pricePerMTokIn,
          pricePerMTokOut,
          quantization: quantization || "remote",
          remoteBaseUrl,
          remoteModelId,
          ...(credentialId ? { credentialId } : {}),
        },
      });
    } else {
      const weightsPath = String(formData.get("weightsPath") ?? "").trim();
      const quantization = String(
        formData.get("quantization") ?? existing.quantization ?? "Q4_K_M",
      ).trim();
      const nThreads = Number(formData.get("nThreads") || existing.nThreads);
      if (!weightsPath) return { ok: false, message: "GGUF path is required" };
      if (!Number.isFinite(nThreads) || nThreads < 1) {
        return { ok: false, message: "Threads must be at least 1" };
      }

      await prisma.hostedModel.update({
        where: { id: existing.id },
        data: {
          displayName,
          contextLength,
          pricePerMTokIn,
          pricePerMTokOut,
          weightsPath,
          quantization: quantization || "Q4_K_M",
          nThreads,
        },
      });
    }

    const pricesChanged =
      pricePerMTokIn !== existing.pricePerMTokIn || pricePerMTokOut !== existing.pricePerMTokOut;
    if (pricesChanged) {
      const now = new Date();
      await prisma.pricingVersion.updateMany({
        where: { hostedModelId: existing.id, effectiveTo: null },
        data: { effectiveTo: now },
      });
      await prisma.pricingVersion.create({
        data: {
          hostedModelId: existing.id,
          pricePerMTokIn,
          pricePerMTokOut,
          effectiveFrom: now,
        },
      });
    }

    await writeAuditEvent({
      actorType: "admin",
      actorId: admin.id,
      action: "model.update_properties",
      resourceType: "HostedModel",
      resourceId: existing.id,
      before: {
        displayName: existing.displayName,
        contextLength: existing.contextLength,
        pricePerMTokIn: existing.pricePerMTokIn,
        pricePerMTokOut: existing.pricePerMTokOut,
        weightsPath: existing.weightsPath,
        remoteBaseUrl: existing.remoteBaseUrl,
        remoteModelId: existing.remoteModelId,
      },
      after: {
        modelId,
        displayName,
        contextLength,
        pricePerMTokIn,
        pricePerMTokOut,
        pricesChanged,
        keyUpdated: Boolean(String(formData.get("apiKey") ?? "").trim()),
      },
    });

    revalidatePath("/admin/models");
    revalidatePath("/admin/infra");
    revalidatePath("/models");
    revalidatePath("/chat");
    return { ok: true, message: `${displayName} properties saved` };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Failed to update model",
    };
  }
}

export async function grantModelToAllPlansAction(formData: FormData) {
  const admin = await requireAdmin();
  const modelId = String(formData.get("modelId"));
  const plans = await prisma.plan.findMany({ select: { id: true, allowedModelIds: true } });
  await Promise.all(
    plans
      .filter((plan) => !plan.allowedModelIds.includes(modelId))
      .map(async (plan) => {
        await prisma.plan.update({
          where: { id: plan.id },
          data: { allowedModelIds: [...plan.allowedModelIds, modelId] },
        });
        await prisma.planModelEntitlement.upsert({
          where: { planId_modelSlug: { planId: plan.id, modelSlug: modelId } },
          update: {},
          create: { planId: plan.id, modelSlug: modelId },
        });
      }),
  );
  await writeAuditEvent({
    actorType: "admin",
    actorId: admin.id,
    action: "model.grant_all_plans",
    resourceType: "HostedModel",
    resourceId: modelId,
  });
  revalidatePath("/admin/models");
  revalidatePath("/admin/infra");
  revalidatePath("/models");
  revalidatePath("/chat");
}

export async function setPlatformDefaultModelAction(formData: FormData): Promise<{
  ok: boolean;
  message: string;
}> {
  const admin = await requireAdmin();
  const modelId = String(formData.get("modelId")).trim();
  if (!modelId) return { ok: false, message: "Model id required" };

  const model = await prisma.hostedModel.findUnique({ where: { modelId } });
  if (!model) return { ok: false, message: "Model not found" };

  await prisma.$transaction([
    prisma.hostedModel.updateMany({
      where: { isPlatformDefault: true },
      data: { isPlatformDefault: false },
    }),
    prisma.hostedModel.update({
      where: { modelId },
      data: { isPlatformDefault: true },
    }),
  ]);

  const plans = await prisma.plan.findMany({ select: { id: true, allowedModelIds: true } });
  await Promise.all(
    plans
      .filter((plan) => !plan.allowedModelIds.includes(modelId))
      .map(async (plan) => {
        await prisma.plan.update({
          where: { id: plan.id },
          data: { allowedModelIds: [...plan.allowedModelIds, modelId] },
        });
        await prisma.planModelEntitlement.upsert({
          where: { planId_modelSlug: { planId: plan.id, modelSlug: modelId } },
          update: {},
          create: { planId: plan.id, modelSlug: modelId },
        });
      }),
  );

  let loadMessage = "";
  try {
    if (model.providerKind === "OPENAI_COMPAT") {
      await prisma.hostedModel.update({
        where: { id: model.id },
        data: { status: "LOADED" },
      });
      const resident = (await gatewayFetch("/internal/engine/models")) as {
        models?: Array<{ model_id: string }>;
      };
      for (const row of resident.models ?? []) {
        if (row.model_id === modelId) continue;
        try {
          await gatewayFetch(`/internal/engine/models/${encodeURIComponent(row.model_id)}/unload`, {
            method: "POST",
            body: "{}",
          });
        } catch {
          // best-effort
        }
      }
      loadMessage = "Remote provider marked available (no local GGUF load)";
    } else {
      const resident = (await gatewayFetch("/internal/engine/models")) as {
        models?: Array<{ model_id: string }>;
      };
      for (const row of resident.models ?? []) {
        if (row.model_id === modelId) continue;
        try {
          await gatewayFetch(`/internal/engine/models/${encodeURIComponent(row.model_id)}/unload`, {
            method: "POST",
            body: "{}",
          });
        } catch {
          // Best-effort — continue loading the new default.
        }
      }

      const result = (await gatewayFetch(`/internal/engine/models/${encodeURIComponent(modelId)}/load`, {
        method: "POST",
        body: "{}",
      })) as { success?: boolean; message?: string; error?: string };
      if (result.success === false) {
        loadMessage = result.error ?? result.message ?? "Load failed";
      } else {
        loadMessage = result.message ?? "Loaded into model pool";
      }
    }
  } catch (error) {
    loadMessage = error instanceof Error ? error.message : "Load failed";
  }

  await writeAuditEvent({
    actorType: "admin",
    actorId: admin.id,
    action: "model.set_platform_default",
    resourceType: "HostedModel",
    resourceId: model.id,
    after: { modelId },
    metadata: { loadMessage: loadMessage || null },
  });
  revalidatePath("/admin/models");
  revalidatePath("/admin/infra");
  revalidatePath("/chat");
  revalidatePath("/models");

  if (loadMessage && loadMessage !== "Loaded into model pool") {
    return {
      ok: true,
      message: `${modelId} is now the platform default, but warm load failed: ${loadMessage}`,
    };
  }
  return {
    ok: true,
    message:
      model.providerKind === "OPENAI_COMPAT"
        ? `${model.displayName} is the platform default (remote OpenAI-compatible provider)`
        : `${model.displayName} is the platform default and is warming in the model pool`,
  };
}

export async function removeModelAction(modelId: string): Promise<{ ok: boolean; message: string }> {
  const admin = await requireAdmin();
  const slug = modelId.trim();
  if (!slug) return { ok: false, message: "Model id required" };

  try {
    const result = (await gatewayFetch(`/internal/engine/models/${encodeURIComponent(slug)}`, {
      method: "DELETE",
    })) as { success?: boolean; message?: string; error?: string };

    const ok = result.success !== false;
    await writeAuditEvent({
      actorType: "admin",
      actorId: admin.id,
      action: ok ? "model.remove" : "model.remove.failed",
      resourceType: "HostedModel",
      resourceId: slug,
      metadata: { message: result.message ?? result.error ?? null },
    });
    revalidatePath("/admin/models");
    revalidatePath("/admin/infra");
    revalidatePath("/models");
    revalidatePath("/chat");
    return {
      ok,
      message: result.message ?? result.error ?? (ok ? "Model removed" : "Remove failed"),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Remove failed";
    await writeAuditEvent({
      actorType: "admin",
      actorId: admin.id,
      action: "model.remove.failed",
      resourceType: "HostedModel",
      resourceId: slug,
      metadata: { message },
    });
    return { ok: false, message };
  }
}
