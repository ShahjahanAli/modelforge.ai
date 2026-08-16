import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { prisma } from "@modelforge/db";
import { authOptions } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  const user = session?.user as { id?: string; role?: string } | undefined;
  if (!user?.id) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const { id } = await context.params;
  const trace = await prisma.coreTraceSession.findUnique({
    where: { id },
    include: {
      events: { orderBy: { sequence: "asc" } },
      request: {
        select: {
          id: true,
          status: true,
          resolvedModelSlug: true,
          promptTokens: true,
          completionTokens: true,
          latencyMs: true,
        },
      },
    },
  });
  if (!trace || (user.role !== "ADMIN" && trace.customerId !== user.id)) {
    return NextResponse.json({ error: "Trace not found" }, { status: 404 });
  }

  const effectiveStatus =
    trace.status === "ARMED" && trace.expiresAt <= new Date() ? "EXPIRED" : trace.status;

  return NextResponse.json(
    {
      id: trace.id,
      status: effectiveStatus,
      expiresAt: trace.expiresAt.toISOString(),
      startedAt: trace.startedAt?.toISOString() ?? null,
      completedAt: trace.completedAt?.toISOString() ?? null,
      summary: trace.summary,
      request: trace.request,
      events: trace.events.map((event) => ({
        sequence: event.sequence,
        phase: event.phase,
        kind: event.kind,
        atMs: event.atMs,
        payload: event.payload,
      })),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
