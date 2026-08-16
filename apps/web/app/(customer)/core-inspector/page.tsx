import { redirect } from "next/navigation";
import { prisma } from "@modelforge/db";
import { PageHeader } from "@/components/ui/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { CoreInspector, type CoreTraceView } from "@/components/CoreInspector";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function CoreInspectorPage() {
  const user = await requireSession();
  if (user.role === "ADMIN") redirect("/admin/dashboard");

  const latest = await prisma.coreTraceSession.findFirst({
    where: { customerId: user.id },
    orderBy: { createdAt: "desc" },
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

  const initialTrace: CoreTraceView | null = latest
    ? {
        id: latest.id,
        status:
          latest.status === "ARMED" && latest.expiresAt <= new Date() ? "EXPIRED" : latest.status,
        expiresAt: latest.expiresAt.toISOString(),
        startedAt: latest.startedAt?.toISOString() ?? null,
        completedAt: latest.completedAt?.toISOString() ?? null,
        summary: latest.summary as Record<string, unknown> | null,
        request: latest.request,
        events: latest.events.map((event) => ({
          sequence: event.sequence,
          phase: event.phase,
          kind: event.kind,
          atMs: event.atMs,
          payload: event.payload as Record<string, unknown> | null,
        })),
      }
    : null;

  return (
    <>
      <PageHeader
        eyebrow="Diagnostic lab"
        title="Inference Core Inspector"
        description="Observe how a request moves through routing, model execution, token generation, and metering—without retaining prompt or response content."
        actions={
          <Badge tone="neutral" dot>
            off by default
          </Badge>
        }
      />
      <CoreInspector initialTrace={initialTrace} />
    </>
  );
}
