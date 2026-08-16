import { prisma } from "@modelforge/db";
import { requireAdmin } from "@/lib/session";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { Network } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function AdminNodesPage() {
  await requireAdmin();
  const nodes = await prisma.runtimeNode.findMany({
    include: { deployments: true, reservations: true },
    orderBy: { name: "asc" },
  });

  return (
    <>
      <PageHeader
        eyebrow="Fleet"
        title="Runtime nodes"
        description="Local and federated compute nodes with heartbeats, deployments, and capacity."
      />
      <Panel>
        <PanelHeader title="Nodes" actions={<Badge tone="neutral">{nodes.length}</Badge>} />
        {nodes.length === 0 ? (
          <EmptyState
            icon={Network}
            title="No nodes registered"
            description="The gateway will register the local node on startup once modern residency is enabled."
          />
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Host</th>
                  <th>Region</th>
                  <th>Status</th>
                  <th className="text-right">RAM</th>
                  <th className="text-right">Deployments</th>
                  <th className="text-right">Reservations</th>
                </tr>
              </thead>
              <tbody>
                {nodes.map((node) => (
                  <tr key={node.id}>
                    <td className="font-medium">{node.name}</td>
                    <td className="font-mono text-xs">{node.hostname}</td>
                    <td className="font-mono text-xs">{node.region}</td>
                    <td>
                      <Badge tone={node.status === "ONLINE" ? "ok" : "warn"}>{node.status}</Badge>
                    </td>
                    <td className="text-right font-mono">
                      {node.freeRamMb}/{node.totalRamMb} MB
                    </td>
                    <td className="text-right font-mono">{node.deployments.length}</td>
                    <td className="text-right font-mono">{node.reservations.length}</td>
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
