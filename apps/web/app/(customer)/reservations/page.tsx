import { prisma } from "@modelforge/db";
import { Server } from "lucide-react";
import { requireSession } from "@/lib/session";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { EmptyState } from "@/components/ui/EmptyState";
import { Badge } from "@/components/ui/Badge";

export const dynamic = "force-dynamic";

export default async function ReservationsPage() {
  const user = await requireSession();
  const reservations = await prisma.residencyReservation.findMany({
    where: user.role === "ADMIN" ? {} : { customerId: user.id },
    include: { model: true, node: true },
    orderBy: { startsAt: "desc" },
    take: 50,
  });

  return (
    <>
      <PageHeader
        eyebrow="Capacity"
        title="Model residency reservations"
        description="Reserve warm model capacity so LRU eviction cannot cold-start your critical traffic."
      />
      <Panel>
        <PanelHeader title="Reservations" actions={<Badge tone="neutral">{reservations.length}</Badge>} />
        {reservations.length === 0 ? (
          <EmptyState
            icon={Server}
            title="No reservations"
            description="Request a warm residency window for a model on the local runtime node."
          />
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Node</th>
                  <th>Status</th>
                  <th className="text-right">RAM</th>
                  <th className="text-right">Priority</th>
                  <th>Window</th>
                </tr>
              </thead>
              <tbody>
                {reservations.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <span className="mono-chip">{row.model.modelId}</span>
                    </td>
                    <td className="font-mono text-xs">{row.node?.name ?? "any"}</td>
                    <td>
                      <Badge tone={row.status === "ACTIVE" ? "ok" : "neutral"}>{row.status}</Badge>
                    </td>
                    <td className="text-right font-mono">{row.ramMb} MB</td>
                    <td className="text-right font-mono">{row.priority}</td>
                    <td className="font-mono text-xs">
                      {row.startsAt.toISOString().slice(0, 16)} → {row.endsAt.toISOString().slice(0, 16)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}
