"use server";

import { revalidatePath } from "next/cache";
import { gatewayFetch } from "@/lib/gateway";
import { requireAdmin } from "@/lib/session";
import { writeAuditEvent } from "@/lib/audit";

export interface ModelPoolResult {
  ok: boolean;
  message: string;
  ramUsedMb?: number;
  elapsedMs: number;
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return "Engine request failed";
  // gatewayFetch surfaces `Gateway 503: {json}` — unwrap it for readable toasts.
  const match = error.message.match(/^Gateway \d+: (.*)$/s);
  if (!match) return error.message;
  try {
    const body = JSON.parse(match[1]!) as { error?: string | { message?: string } };
    const detail = typeof body.error === "string" ? body.error : body.error?.message;
    return detail ?? match[1]!;
  } catch {
    return match[1]!;
  }
}

export async function loadModelAction(modelId: string): Promise<ModelPoolResult> {
  const admin = await requireAdmin();
  const startedAt = Date.now();

  try {
    const result = (await gatewayFetch(`/internal/engine/models/${modelId}/load`, {
      method: "POST",
      body: "{}",
    })) as { success?: boolean; message?: string; ram_used_mb?: number; error?: string };

    const ok = result.success !== false;
    await writeAuditEvent({
      actorType: "admin",
      actorId: admin.id,
      action: ok ? "model.load" : "model.load.failed",
      resourceType: "HostedModel",
      resourceId: modelId,
      metadata: { message: result.message ?? result.error ?? null },
    });

    revalidatePath("/admin/infra");
    revalidatePath("/admin/models");

    return {
      ok,
      message: result.message ?? result.error ?? (ok ? "Model resident in pool" : "Load failed"),
      ramUsedMb: result.ram_used_mb,
      elapsedMs: Date.now() - startedAt,
    };
  } catch (error) {
    const message = describeError(error);
    await writeAuditEvent({
      actorType: "admin",
      actorId: admin.id,
      action: "model.load.failed",
      resourceType: "HostedModel",
      resourceId: modelId,
      metadata: { message },
    });
    revalidatePath("/admin/infra");
    return { ok: false, message, elapsedMs: Date.now() - startedAt };
  }
}

export async function unloadModelAction(modelId: string): Promise<ModelPoolResult> {
  const admin = await requireAdmin();
  const startedAt = Date.now();

  try {
    const result = (await gatewayFetch(`/internal/engine/models/${modelId}/unload`, {
      method: "POST",
      body: "{}",
    })) as { success?: boolean; message?: string; error?: string };

    const ok = result.success !== false;
    await writeAuditEvent({
      actorType: "admin",
      actorId: admin.id,
      action: ok ? "model.unload" : "model.unload.failed",
      resourceType: "HostedModel",
      resourceId: modelId,
      metadata: { message: result.message ?? result.error ?? null },
    });

    revalidatePath("/admin/infra");
    revalidatePath("/admin/models");

    return {
      ok,
      message: result.message ?? result.error ?? (ok ? "Weights evicted" : "Unload failed"),
      elapsedMs: Date.now() - startedAt,
    };
  } catch (error) {
    const message = describeError(error);
    await writeAuditEvent({
      actorType: "admin",
      actorId: admin.id,
      action: "model.unload.failed",
      resourceType: "HostedModel",
      resourceId: modelId,
      metadata: { message },
    });
    revalidatePath("/admin/infra");
    return { ok: false, message, elapsedMs: Date.now() - startedAt };
  }
}

export interface VoiceModelActionResult {
  ok: boolean;
  message: string;
  jobId?: string;
}

export async function installWhisperModelAction(input: {
  model: string;
  provider?: "faster-whisper" | "nemo";
  activateOnSuccess?: boolean;
}): Promise<VoiceModelActionResult> {
  const admin = await requireAdmin();
  try {
    const result = (await gatewayFetch("/internal/voice/models/install", {
      method: "POST",
      body: JSON.stringify({
        provider: input.provider ?? "faster-whisper",
        model: input.model,
        activateOnSuccess: input.activateOnSuccess !== false,
      }),
    })) as { id?: string; model?: string; status?: string; error?: string };

    await writeAuditEvent({
      actorType: "admin",
      actorId: admin.id,
      action: "voice.model.install",
      resourceType: "VoiceSttModel",
      resourceId: input.model,
      metadata: { jobId: result.id ?? null, provider: input.provider ?? "faster-whisper" },
    });
    revalidatePath("/admin/infra");
    return {
      ok: true,
      message: `Started install for ${input.provider ?? "faster-whisper"}:${input.model}`,
      jobId: result.id,
    };
  } catch (error) {
    return { ok: false, message: describeError(error) };
  }
}

export async function activateWhisperModelAction(input: {
  model: string;
  provider?: "faster-whisper" | "nemo";
}): Promise<VoiceModelActionResult> {
  const admin = await requireAdmin();
  const model = input.model;
  const provider = input.provider ?? "faster-whisper";
  try {
    await gatewayFetch("/internal/voice/models/activate", {
      method: "POST",
      body: JSON.stringify({ model, provider }),
    });
    await writeAuditEvent({
      actorType: "admin",
      actorId: admin.id,
      action: "voice.model.activate",
      resourceType: "VoiceSttModel",
      resourceId: model,
      metadata: { provider },
    });
    revalidatePath("/admin/infra");
    return { ok: true, message: `Active STT set to ${provider}:${model}` };
  } catch (error) {
    return { ok: false, message: describeError(error) };
  }
}

export async function getWhisperInstallJobAction(jobId: string) {
  await requireAdmin();
  return gatewayFetch(`/internal/voice/models/jobs/${jobId}`) as Promise<{
    id: string;
    model: string;
    status: string;
    message: string | null;
    error: string | null;
  }>;
}
