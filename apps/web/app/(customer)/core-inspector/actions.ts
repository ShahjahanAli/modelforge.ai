"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@modelforge/db";
import { gatewayFetch } from "@/lib/gateway";
import { requireSession } from "@/lib/session";
import { writeAuditEvent } from "@/lib/audit";

const TRACE_TTL_MS = 10 * 60 * 1000;

export async function armCoreInspectorAction() {
  const user = await requireSession();
  if (user.role === "ADMIN") {
    return { ok: false as const, message: "Use a subscriber account to capture inference traffic." };
  }

  await prisma.coreTraceSession.updateMany({
    where: { customerId: user.id, status: "ARMED" },
    data: { status: "CANCELLED" },
  });

  const session = await prisma.coreTraceSession.create({
    data: {
      customerId: user.id,
      expiresAt: new Date(Date.now() + TRACE_TTL_MS),
    },
  });

  try {
    await gatewayFetch(`/internal/diagnostics/traces/${session.id}/arm`, {
      method: "POST",
      body: JSON.stringify({ customerId: user.id }),
    });
  } catch (error) {
    await prisma.coreTraceSession.update({
      where: { id: session.id },
      data: { status: "CANCELLED" },
    });
    return {
      ok: false as const,
      message: error instanceof Error ? error.message : "Gateway unavailable",
    };
  }

  await writeAuditEvent({
    actorType: "customer",
    actorId: user.id,
    customerId: user.id,
    action: "core_trace.armed",
    resourceType: "CoreTraceSession",
    resourceId: session.id,
    metadata: { expiresAt: session.expiresAt.toISOString(), contentCaptured: false },
  });
  revalidatePath("/core-inspector");
  return { ok: true as const, traceId: session.id };
}

export async function cancelCoreInspectorAction(traceId: string) {
  const user = await requireSession();
  const session = await prisma.coreTraceSession.findFirst({
    where: { id: traceId, customerId: user.id, status: "ARMED" },
  });
  if (!session) return { ok: false as const, message: "Armed trace not found" };

  await gatewayFetch(`/internal/diagnostics/traces/${traceId}/arm`, {
    method: "DELETE",
    body: JSON.stringify({ customerId: user.id }),
  }).catch(() => undefined);
  await prisma.coreTraceSession.update({
    where: { id: traceId },
    data: { status: "CANCELLED" },
  });
  revalidatePath("/core-inspector");
  return { ok: true as const };
}
