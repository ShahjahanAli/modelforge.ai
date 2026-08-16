"use server";

import { revalidatePath } from "next/cache";
import { gatewayFetch } from "@/lib/gateway";
import { requireAdmin } from "@/lib/session";
import { writeAuditEvent } from "@/lib/audit";

export async function loadModelAction(formData: FormData) {
  const admin = await requireAdmin();
  const modelId = String(formData.get("modelId"));
  await gatewayFetch(`/internal/engine/models/${modelId}/load`, { method: "POST", body: "{}" });
  await writeAuditEvent({
    actorType: "admin",
    actorId: admin.id,
    action: "model.load",
    resourceType: "HostedModel",
    resourceId: modelId,
  });
  revalidatePath("/admin/infra");
  revalidatePath("/admin/models");
}

export async function unloadModelAction(formData: FormData) {
  const admin = await requireAdmin();
  const modelId = String(formData.get("modelId"));
  await gatewayFetch(`/internal/engine/models/${modelId}/unload`, { method: "POST", body: "{}" });
  await writeAuditEvent({
    actorType: "admin",
    actorId: admin.id,
    action: "model.unload",
    resourceType: "HostedModel",
    resourceId: modelId,
  });
  revalidatePath("/admin/infra");
  revalidatePath("/admin/models");
}
