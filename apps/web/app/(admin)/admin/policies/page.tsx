import { prisma } from "@modelforge/db";
import { requireAdmin } from "@/lib/session";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { Shield } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function AdminPoliciesPage() {
  await requireAdmin();
  const policies = await prisma.policy.findMany({
    include: {
      versions: { orderBy: { version: "desc" }, take: 1 },
      bindings: true,
    },
    orderBy: { name: "asc" },
  });

  return (
    <>
      <PageHeader
        eyebrow="Governance"
        title="Platform policies"
        description="Routing, budget, data, tool, and SLO policy documents with immutable versions."
      />
      <Panel>
        <PanelHeader title="Policies" actions={<Badge tone="neutral">{policies.length}</Badge>} />
        {policies.length === 0 ? (
          <EmptyState icon={Shield} title="No policies defined" />
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Kind</th>
                  <th>Scope</th>
                  <th>Enabled</th>
                  <th className="text-right">Version</th>
                  <th className="text-right">Bindings</th>
                </tr>
              </thead>
              <tbody>
                {policies.map((policy) => (
                  <tr key={policy.id}>
                    <td className="font-medium">{policy.name}</td>
                    <td>
                      <Badge tone="info">{policy.kind}</Badge>
                    </td>
                    <td className="font-mono text-xs">{policy.scope}</td>
                    <td>
                      <Badge tone={policy.enabled ? "ok" : "neutral"}>
                        {policy.enabled ? "on" : "off"}
                      </Badge>
                    </td>
                    <td className="text-right font-mono">
                      {policy.versions[0]?.version ?? "—"}
                    </td>
                    <td className="text-right font-mono">{policy.bindings.length}</td>
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
