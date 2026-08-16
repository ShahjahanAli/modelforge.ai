import { prisma } from "@modelforge/db";
import { requireSession } from "@/lib/session";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel, PanelBody, PanelHeader } from "@/components/ui/Panel";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { Shield } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function PoliciesPage() {
  const user = await requireSession();
  const bindings = await prisma.policyBinding.findMany({
    where:
      user.role === "ADMIN"
        ? {}
        : {
            OR: [{ customerId: user.id }, { apiKey: { customerId: user.id } }],
          },
    include: {
      policy: { include: { versions: { orderBy: { version: "desc" }, take: 1 } } },
    },
    orderBy: { priority: "asc" },
    take: 50,
  });

  return (
    <>
      <PageHeader
        eyebrow="Governance"
        title="Inference policies"
        description="Versioned routing, budget, data, and tool policies bound to your tenant or API keys."
      />
      <Panel>
        <PanelHeader title="Active bindings" actions={<Badge tone="neutral">{bindings.length}</Badge>} />
        {bindings.length === 0 ? (
          <EmptyState
            icon={Shield}
            title="No tenant policies bound"
            description="Platform defaults apply until a plan, customer, or API-key policy is attached."
          />
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Policy</th>
                  <th>Kind</th>
                  <th>Scope</th>
                  <th>Version</th>
                  <th className="text-right">Priority</th>
                </tr>
              </thead>
              <tbody>
                {bindings.map((binding) => (
                  <tr key={binding.id}>
                    <td className="font-medium">{binding.policy.name}</td>
                    <td>
                      <Badge tone="info">{binding.policy.kind}</Badge>
                    </td>
                    <td className="font-mono text-xs">{binding.policy.scope}</td>
                    <td className="font-mono">
                      {binding.policy.versions[0]?.version ?? "—"}
                    </td>
                    <td className="text-right font-mono">{binding.priority}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <Panel>
        <PanelHeader title="How routing works" />
        <PanelBody className="text-sm text-content-secondary">
          Requests may use <span className="mono-chip">model: &quot;auto&quot;</span> to select the
          cheapest eligible model that satisfies quality, latency, residency, and budget constraints.
          Explicit model IDs still bypass auto-routing but remain subject to entitlements and budgets.
        </PanelBody>
      </Panel>
    </>
  );
}
