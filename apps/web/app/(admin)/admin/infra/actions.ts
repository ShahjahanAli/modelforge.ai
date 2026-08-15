"use server";

import { revalidatePath } from "next/cache";
import { gatewayFetch } from "@/lib/gateway";

export async function loadModelAction(formData: FormData) {
  const modelId = String(formData.get("modelId"));
  await gatewayFetch(`/internal/engine/models/${modelId}/load`, { method: "POST", body: "{}" });
  revalidatePath("/admin/infra");
  revalidatePath("/admin/models");
}

export async function unloadModelAction(formData: FormData) {
  const modelId = String(formData.get("modelId"));
  await gatewayFetch(`/internal/engine/models/${modelId}/unload`, { method: "POST", body: "{}" });
  revalidatePath("/admin/infra");
  revalidatePath("/admin/models");
}
