"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@modelforge/db";
import { gatewayFetch } from "@/lib/gateway";
import { requireAdmin } from "@/lib/session";
import { writeAuditEvent } from "@/lib/audit";

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
    message: `${model.displayName} is the platform default and is warming in the model pool`,
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
