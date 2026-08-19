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
