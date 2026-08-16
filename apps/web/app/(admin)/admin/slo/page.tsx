import { prisma } from "@modelforge/db";
import { requireAdmin } from "@/lib/session";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { Gauge } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function AdminSloPage() {
  await requireAdmin();
  const definitions = await prisma.sloDefinition.findMany({
    include: { windows: { orderBy: { windowStart: "desc" }, take: 1 } },
    orderBy: { name: "asc" },
  });

  return (
    <>
      <PageHeader
        eyebrow="Reliability"
        title="SLO definitions"
        description="Latency and availability targets that drive admission control and service credits."
      />
      <Panel>
        <PanelHeader title="Definitions" actions={<Badge tone="neutral">{definitions.length}</Badge>} />
        {definitions.length === 0 ? (
          <EmptyState icon={Gauge} title="No SLO definitions" />
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th className="text-right">p95 target</th>
                  <th className="text-right">Availability</th>
                  <th className="text-right">Window</th>
                  <th>Latest</th>
                </tr>
              </thead>
              <tbody>
                {definitions.map((def) => (
                  <tr key={def.id}>
                    <td className="font-medium">{def.name}</td>
                    <td className="text-right font-mono">{def.latencyP95Ms} ms</td>
                    <td className="text-right font-mono">{def.availabilityPct}%</td>
                    <td className="text-right font-mono">{def.windowMinutes}m</td>
                    <td>
                      <Badge
                        tone={
                          def.windows[0]?.status === "BREACHED"
                            ? "danger"
                            : def.windows[0]?.status === "AT_RISK"
                              ? "warn"
                              : "ok"
                        }
                      >
                        {def.windows[0]?.status ?? "n/a"}
                      </Badge>
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
