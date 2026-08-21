import { prisma } from "@modelforge/db";
import { effectiveMonthlyQuota } from "@modelforge/platform";
import { Users } from "lucide-react";
import { AdjustCustomerQuota } from "@/components/admin/AdjustCustomerQuota";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Badge, StatusBadge } from "@/components/ui/Badge";
import { StatCard } from "@/components/ui/StatCard";
import { EmptyState } from "@/components/ui/EmptyState";
import { requireAdmin } from "@/lib/session";

export default async function AdminCustomersPage() {
  await requireAdmin();

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
        description="Tenant roster with plan assignment, quota grants, and credential counts."
        actions={<Badge tone="neutral">{customers.length} tenants</Badge>}
      />

      <div className="grid gap-3 sm:grid-cols-3 sm:gap-4">
        <StatCard label="Total customers" value={customers.length} icon={Users} accent="brand" />
        <StatCard label="Active subscriptions" value={activeSubs} accent="ok" />
        <StatCard label="Metered events" value={totalEvents.toLocaleString()} accent="signal" />
      </div>

      <Panel>
        <PanelHeader
          title="Roster"
          description="Increase a subscriber’s monthly billable units or reset period usage after quota_exceeded"
        />
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
                  <th>Quota</th>
                  <th className="text-right">Keys</th>
                  <th className="text-right">Events</th>
                </tr>
              </thead>
              <tbody>
                {customers.map((customer) => {
                  const planQuota = customer.subscription
                    ? Number(customer.subscription.plan.monthlyTokenQuota)
                    : 0;
                  const bonus = Number(customer.quotaBonusTokens);
                  const used = customer.quotaLedger
                    ? Number(customer.quotaLedger.tokensUsed)
                    : 0;
                  const effective = Number(
                    effectiveMonthlyQuota(
                      customer.subscription?.plan.monthlyTokenQuota ?? 0n,
                      customer.quotaBonusTokens,
                    ),
                  );

                  return (
                    <tr key={customer.id}>
                      <td className="whitespace-nowrap text-content-primary">{customer.email}</td>
                      <td>
                        <Badge tone={customer.role === "ADMIN" ? "info" : "neutral"}>
                          {customer.role}
                        </Badge>
                      </td>
                      <td className="whitespace-nowrap font-mono text-xs">
                        {customer.subscription?.plan.name ?? "—"}
                        {planQuota > 0 ? (
                          <div className="text-content-muted">
                            base {planQuota.toLocaleString()}
                            {effective !== planQuota
                              ? ` → ${effective.toLocaleString()}`
                              : ""}
                          </div>
                        ) : null}
                      </td>
                      <td>
                        {customer.subscription ? (
                          <StatusBadge status={customer.subscription.status} />
                        ) : (
                          <span className="text-content-muted">—</span>
                        )}
                      </td>
                      <td className="align-top">
                        {customer.role === "CUSTOMER" && customer.subscription ? (
                          <AdjustCustomerQuota
                            customerId={customer.id}
                            email={customer.email}
                            planQuota={planQuota}
                            bonusTokens={bonus}
                            tokensUsed={used}
                          />
                        ) : (
                          <span className="font-mono text-xs tabular-nums text-content-muted">
                            {used.toLocaleString()}
                            {planQuota > 0 ? ` / ${effective.toLocaleString()}` : ""}
                          </span>
                        )}
                      </td>
                      <td className="text-right font-mono tabular-nums">{customer._count.apiKeys}</td>
                      <td className="text-right font-mono tabular-nums">
                        {customer._count.usageEvents}
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
