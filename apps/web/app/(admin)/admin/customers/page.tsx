import { prisma } from "@modelforge/db";
import { Users } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Badge, StatusBadge } from "@/components/ui/Badge";
import { StatCard } from "@/components/ui/StatCard";
import { EmptyState } from "@/components/ui/EmptyState";

export default async function AdminCustomersPage() {
  const customers = await prisma.customer.findMany({
    include: {
      subscription: { include: { plan: true } },
      quotaLedger: true,
      _count: { select: { apiKeys: true, usageEvents: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  const activeSubs = customers.filter((c) => c.subscription?.status === "ACTIVE").length;
  const totalEvents = customers.reduce((sum, c) => sum + c._count.usageEvents, 0);

  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Customers"
        description="Tenant roster with plan assignment, quota consumption, and credential counts."
        actions={<Badge tone="neutral">{customers.length} tenants</Badge>}
      />

      <div className="grid gap-3 sm:grid-cols-3 sm:gap-4">
        <StatCard label="Total customers" value={customers.length} icon={Users} accent="brand" />
        <StatCard label="Active subscriptions" value={activeSubs} accent="ok" />
        <StatCard label="Metered events" value={totalEvents.toLocaleString()} accent="signal" />
      </div>

      <Panel>
        <PanelHeader title="Roster" description="Ordered by signup date, newest first" />
        {customers.length === 0 ? (
          <EmptyState icon={Users} title="No customers yet" />
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Plan</th>
                  <th>Subscription</th>
                  <th className="text-right">Tokens used</th>
                  <th className="text-right">Keys</th>
                  <th className="text-right">Events</th>
                </tr>
              </thead>
              <tbody>
                {customers.map((customer) => (
                  <tr key={customer.id}>
                    <td className="whitespace-nowrap text-content-primary">{customer.email}</td>
                    <td>
                      <Badge tone={customer.role === "ADMIN" ? "info" : "neutral"}>
                        {customer.role}
                      </Badge>
                    </td>
                    <td className="whitespace-nowrap font-mono text-xs">
                      {customer.subscription?.plan.name ?? "—"}
                    </td>
                    <td>
                      {customer.subscription ? (
                        <StatusBadge status={customer.subscription.status} />
                      ) : (
                        <span className="text-content-muted">—</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap text-right font-mono tabular-nums">
                      {customer.quotaLedger
                        ? Number(customer.quotaLedger.tokensUsed).toLocaleString()
                        : "0"}
                    </td>
                    <td className="text-right font-mono tabular-nums">{customer._count.apiKeys}</td>
                    <td className="text-right font-mono tabular-nums">
                      {customer._count.usageEvents}
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
