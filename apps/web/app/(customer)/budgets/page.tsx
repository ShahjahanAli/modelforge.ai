import { prisma } from "@modelforge/db";
import { Wallet } from "lucide-react";
import { requireSession } from "@/lib/session";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { EmptyState } from "@/components/ui/EmptyState";
import { Badge } from "@/components/ui/Badge";
import { Meter } from "@/components/ui/StatCard";

export const dynamic = "force-dynamic";

export default async function BudgetsPage() {
  const user = await requireSession();
  const budgets = await prisma.budgetAccount.findMany({
    where: user.role === "ADMIN" ? {} : { customerId: user.id },
    orderBy: { periodStart: "desc" },
    take: 50,
  });

  return (
    <>
      <PageHeader
        eyebrow="Spend control"
        title="Budgets"
        description="Atomic per-tenant, per-key, and per-model spend ceilings with soft alerts."
      />
      <Panel>
        <PanelHeader title="Budget accounts" actions={<Badge tone="neutral">{budgets.length}</Badge>} />
        {budgets.length === 0 ? (
          <EmptyState
            icon={Wallet}
            title="No budgets configured"
            description="Create a budget to hard-cap spend before routing dispatches inference."
          />
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Model</th>
                  <th>Period</th>
                  <th className="text-right">Spent</th>
                  <th className="text-right">Limit</th>
                  <th>Utilization</th>
                </tr>
              </thead>
              <tbody>
                {budgets.map((budget) => {
                  const spent = Number(budget.spentMicros + budget.reservedMicros);
                  const limit = Number(budget.limitMicros);
                  const pct = limit > 0 ? Math.min(100, (spent / limit) * 100) : 0;
                  return (
                    <tr key={budget.id}>
                      <td className="font-medium">{budget.name}</td>
                      <td className="font-mono text-xs">{budget.modelSlug ?? "any"}</td>
                      <td className="font-mono text-xs">
                        {budget.periodStart.toISOString().slice(0, 10)} →{" "}
                        {budget.periodEnd.toISOString().slice(0, 10)}
                      </td>
                      <td className="text-right font-mono">
                        ${(spent / 1_000_000).toFixed(4)}
                      </td>
                      <td className="text-right font-mono">
                        ${(limit / 1_000_000).toFixed(4)}
                      </td>
                      <td className="min-w-40">
                        <Meter value={pct} max={100} tone={pct >= 90 ? "danger" : "ok"} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}
