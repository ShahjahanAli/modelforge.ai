"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@modelforge/db";
import { gatewayFetch } from "@/lib/gateway";

export async function upsertModelAction(formData: FormData) {
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
  await prisma.hostedModel.upsert({
    where: { modelId },
    update: data,
    create: { modelId, ...data, status: "INACTIVE" },
  });
  revalidatePath("/admin/models");
  revalidatePath("/admin/infra");
}

/**
 * Registers a GGUF that the gateway found on disk. The gateway re-validates the
 * path against MODEL_WEIGHTS_DIR, so an arbitrary path cannot be injected here.
 */
export async function registerDiscoveredAction(formData: FormData) {
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
  revalidatePath("/admin/models");
  revalidatePath("/admin/infra");
}

/** Grants every plan access to a model slug so customers can actually call it. */
export async function grantModelToAllPlansAction(formData: FormData) {
  const modelId = String(formData.get("modelId"));
  const plans = await prisma.plan.findMany({ select: { id: true, allowedModelIds: true } });
  await Promise.all(
    plans
      .filter((plan) => !plan.allowedModelIds.includes(modelId))
      .map((plan) =>
        prisma.plan.update({
          where: { id: plan.id },
          data: { allowedModelIds: [...plan.allowedModelIds, modelId] },
        }),
      ),
  );
  revalidatePath("/admin/models");
  revalidatePath("/models");
}
