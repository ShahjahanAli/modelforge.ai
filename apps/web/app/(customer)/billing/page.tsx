import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { prisma } from "@modelforge/db";
import { Check, FileText } from "lucide-react";
import { authOptions } from "@/lib/auth";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel, PanelBody, PanelHeader } from "@/components/ui/Panel";
import { Badge, StatusBadge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { checkoutInvoiceAction } from "./actions";

export default async function BillingPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user) redirect("/login");
  const customerId = (session.user as { id: string }).id;

  const [sub, plans, invoices] = await Promise.all([
    prisma.subscription.findUnique({ where: { customerId }, include: { plan: true } }),
    prisma.plan.findMany({ orderBy: { priceCentsMonthly: "asc" } }),
    prisma.invoice.findMany({
      where: { customerId },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
  ]);

  const unpaid = invoices.filter((inv) => inv.status !== "PAID");
  const outstanding = unpaid.reduce((sum, inv) => sum + inv.amountCents, 0);

  return (
    <>
      <PageHeader
        eyebrow="Account"
        title="Billing"
        description="Subscription tier, usage overage rates, and invoice history. Payment providers run in mock mode locally."
        actions={<Badge tone="info">mock provider</Badge>}
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel className="lg:col-span-2">
          <PanelHeader
            title="Current subscription"
            actions={sub ? <StatusBadge status={sub.status} /> : undefined}
          />
          <PanelBody className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-lg font-semibold tracking-tight text-content-primary sm:text-xl">
                {sub?.plan.displayName ?? "No active plan"}
              </p>
              <p className="mt-1 font-mono text-xs text-content-muted">
                ${((sub?.plan.priceCentsMonthly ?? 0) / 100).toFixed(2)}/mo ·{" "}
                {sub?.plan.billingMode ?? "—"}
              </p>
            </div>
            {sub && (
              <p className="font-mono text-xs text-content-secondary">
                Period {sub.currentPeriodStart.toISOString().slice(0, 10)} →{" "}
                {sub.currentPeriodEnd.toISOString().slice(0, 10)}
              </p>
            )}
          </PanelBody>
        </Panel>

        <Panel>
          <PanelHeader title="Outstanding" />
          <PanelBody>
            <p className="metric">${(outstanding / 100).toFixed(2)}</p>
            <p className="mt-1 text-xs text-content-muted">
              across {unpaid.length} unpaid invoice(s)
            </p>
          </PanelBody>
        </Panel>
      </div>

      <div className="grid gap-3 sm:gap-4 md:grid-cols-2 xl:grid-cols-3">
        {plans.map((plan) => {
          const current = plan.id === sub?.planId;
          return (
            <article
              key={plan.id}
              className={`panel relative p-4 sm:p-5 ${
                current ? "border-brand-200 bg-brand-50/60" : "panel-hover"
              }`}
            >
              {current && (
                <span className="absolute right-4 top-4">
                  <Badge tone="ok" dot>
                    current
                  </Badge>
                </span>
              )}
              <h2 className="text-sm font-semibold tracking-tight text-content-primary">
                {plan.displayName}
              </h2>
              <p className="mt-2 flex items-baseline gap-1">
                <span className="metric">${(plan.priceCentsMonthly / 100).toFixed(0)}</span>
                <span className="text-xs text-content-muted">/mo</span>
              </p>
              <ul className="mt-4 space-y-2 border-t border-line pt-4 text-xs text-content-secondary">
                <li className="flex items-start gap-2">
                  <Check className="mt-0.5 size-3.5 shrink-0 text-ok-600" aria-hidden />
                  {plan.monthlyTokenQuota === 0n
                    ? "Usage-based tokens"
                    : `${Number(plan.monthlyTokenQuota).toLocaleString()} tokens / mo`}
                </li>
                <li className="flex items-start gap-2">
                  <Check className="mt-0.5 size-3.5 shrink-0 text-ok-600" aria-hidden />
                  <span>
                    <span className="font-mono">{plan.requestsPerMinute}</span> requests / min
                  </span>
                </li>
                <li className="flex items-start gap-2">
                  <Check className="mt-0.5 size-3.5 shrink-0 text-ok-600" aria-hidden />
                  <span>
                    <span className="font-mono">{plan.maxConcurrent}</span> concurrent streams
                  </span>
                </li>
                <li className="flex items-start gap-2">
                  <Check className="mt-0.5 size-3.5 shrink-0 text-ok-600" aria-hidden />
                  {plan.allowedModelIds.length} model(s) included
                </li>
              </ul>
            </article>
          );
        })}
      </div>

      <Panel>
        <PanelHeader title="Invoices" description="Most recent 20 billing periods" />
        {invoices.length === 0 ? (
          <EmptyState
            icon={FileText}
            title="No invoices yet"
            description="Invoices are generated at the end of each billing period by the invoice worker."
          />
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Period</th>
                  <th className="text-right">Amount</th>
                  <th>Status</th>
                  <th>Provider</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((inv) => (
                  <tr key={inv.id}>
                    <td className="whitespace-nowrap font-mono text-xs">
                      {inv.periodStart.toISOString().slice(0, 10)} →{" "}
                      {inv.periodEnd.toISOString().slice(0, 10)}
                    </td>
                    <td className="whitespace-nowrap text-right font-mono tabular-nums text-content-primary">
                      ${(inv.amountCents / 100).toFixed(2)}
                    </td>
                    <td>
                      <StatusBadge status={inv.status} />
                    </td>
                    <td className="font-mono text-xs">{inv.paymentProvider ?? "—"}</td>
                    <td className="text-right">
                      {inv.status !== "PAID" && (
                        <form action={checkoutInvoiceAction} className="inline-flex">
                          <input type="hidden" name="invoiceId" value={inv.id} />
                          <button className="btn-secondary text-xs" type="submit">
                            Pay now
                          </button>
                        </form>
                      )}
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
