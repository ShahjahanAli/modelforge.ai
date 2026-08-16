import { prisma } from "@modelforge/db";
import { requireAdmin } from "@/lib/session";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { ScrollText } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function AdminAuditPage() {
  await requireAdmin();
  const events = await prisma.auditEvent.findMany({
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  return (
    <>
      <PageHeader
        eyebrow="Security"
        title="Audit log"
        description="Append-only management and policy decisions across the control plane."
      />
      <Panel>
        <PanelHeader title="Recent events" actions={<Badge tone="neutral">{events.length}</Badge>} />
        {events.length === 0 ? (
          <EmptyState icon={ScrollText} title="No audit events yet" />
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Actor</th>
                  <th>Action</th>
                  <th>Resource</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <tr key={event.id}>
                    <td className="font-mono text-xs">
                      {event.createdAt.toISOString().replace("T", " ").slice(0, 19)}
                    </td>
                    <td className="font-mono text-xs">
                      {event.actorType}:{event.actorId ?? "—"}
                    </td>
                    <td>{event.action}</td>
                    <td className="font-mono text-xs">
                      {event.resourceType}/{event.resourceId ?? "—"}
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
