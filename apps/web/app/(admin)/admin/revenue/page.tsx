import { prisma } from "@modelforge/db";
import { Banknote, LineChart, Receipt, Server } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Badge } from "@/components/ui/Badge";
import { StatCard } from "@/components/ui/StatCard";
import { EmptyState } from "@/components/ui/EmptyState";

// Flat CPU cost assumption for margin illustration ($0.15/server-hour ~ $108/mo)
const MONTHLY_SERVER_COST_CENTS = 10800;

export default async function AdminRevenuePage() {
  const [paid, mrrPlans, usage, models] = await Promise.all([
    prisma.invoice.findMany({ where: { status: "PAID" } }),
    prisma.subscription.findMany({ where: { status: "ACTIVE" }, include: { plan: true } }),
    prisma.usageEvent.groupBy({
      by: ["modelSlug"],
      _sum: { promptTokens: true, completionTokens: true },
      _count: true,
    }),
    prisma.hostedModel.findMany(),
  ]);

  const modelMap = new Map(models.map((m) => [m.modelId, m]));
  const mrr = mrrPlans.reduce((sum, sub) => sum + sub.plan.priceCentsMonthly, 0);
  const paidTotal = paid.reduce((sum, invoice) => sum + invoice.amountCents, 0);
  const totalRequests = usage.reduce((sum, row) => sum + row._count, 0) || 1;

  const perModel = usage
    .map((row) => {
      const model = modelMap.get(row.modelSlug);
      const prompt = row._sum.promptTokens ?? 0;
      const completion = row._sum.completionTokens ?? 0;
      const revenueCents = model
        ? Math.round(
            (prompt / 1e6) * model.pricePerMTokIn + (completion / 1e6) * model.pricePerMTokOut,
          )
        : 0;
      const costShare = Math.round(MONTHLY_SERVER_COST_CENTS * (row._count / totalRequests));
      return {
        model: row.modelSlug,
        requests: row._count,
        tokens: prompt + completion,
        revenueCents,
        costShare,
        margin: revenueCents - costShare,
      };
    })
    .sort((a, b) => b.revenueCents - a.revenueCents);

  const usageRevenue = perModel.reduce((sum, row) => sum + row.revenueCents, 0);
  const netMargin = mrr + usageRevenue - MONTHLY_SERVER_COST_CENTS;

  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Revenue & cost to serve"
        description="Subscription MRR against metered usage revenue and an assumed flat CPU infrastructure cost."
        actions={
          <Badge tone={netMargin >= 0 ? "ok" : "danger"} dot>
            {netMargin >= 0 ? "profitable" : "under water"}
          </Badge>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 sm:gap-4 xl:grid-cols-4">
        <StatCard
          label="Subscription MRR"
          value={`$${(mrr / 100).toFixed(2)}`}
          icon={LineChart}
          accent="brand"
          hint={`${mrrPlans.length} active subscription(s)`}
        />
        <StatCard
          label="Metered usage revenue"
          value={`$${(usageRevenue / 100).toFixed(2)}`}
          icon={Banknote}
          accent="signal"
          hint={`${totalRequests.toLocaleString()} requests`}
        />
        <StatCard
          label="Collected invoices"
          value={`$${(paidTotal / 100).toFixed(2)}`}
          icon={Receipt}
          accent="ok"
          hint={`${paid.length} paid`}
        />
        <StatCard
          label="Assumed server cost"
          value={`$${(MONTHLY_SERVER_COST_CENTS / 100).toFixed(2)}`}
          icon={Server}
          accent="warn"
          hint="per month, flat CPU baseline"
        />
      </div>

      <Panel>
        <PanelHeader
          title="Cost to serve by model"
          description="Revenue attributed from catalog pricing, cost allocated by request share"
          actions={
            <span className="whitespace-nowrap font-mono text-xs text-content-secondary">
              net{" "}
              <span className={netMargin >= 0 ? "text-ok-700" : "text-danger-700"}>
                ${(netMargin / 100).toFixed(2)}
              </span>
            </span>
          }
        />
        {perModel.length === 0 ? (
          <EmptyState
            icon={LineChart}
            title="No usage to attribute"
            description="Margin analysis becomes available once inference requests are metered."
          />
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Model</th>
                  <th className="text-right">Requests</th>
                  <th className="text-right">Tokens</th>
                  <th className="text-right">Revenue</th>
                  <th className="text-right">Cost share</th>
                  <th className="text-right">Margin</th>
                </tr>
              </thead>
              <tbody>
                {perModel.map((row) => (
                  <tr key={row.model}>
                    <td>
                      <span className="mono-chip">{row.model}</span>
                    </td>
                    <td className="whitespace-nowrap text-right font-mono tabular-nums">
                      {row.requests.toLocaleString()}
                    </td>
                    <td className="whitespace-nowrap text-right font-mono tabular-nums">
                      {row.tokens.toLocaleString()}
                    </td>
                    <td className="whitespace-nowrap text-right font-mono tabular-nums text-content-primary">
                      ${(row.revenueCents / 100).toFixed(2)}
                    </td>
                    <td className="whitespace-nowrap text-right font-mono tabular-nums">
                      ${(row.costShare / 100).toFixed(2)}
                    </td>
                    <td
                      className={`whitespace-nowrap text-right font-mono font-medium tabular-nums ${
                        row.margin >= 0 ? "text-ok-700" : "text-danger-700"
                      }`}
                    >
                      {row.margin >= 0 ? "+" : "−"}${Math.abs(row.margin / 100).toFixed(2)}
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
