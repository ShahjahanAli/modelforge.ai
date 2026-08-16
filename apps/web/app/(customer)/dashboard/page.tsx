import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { prisma } from "@modelforge/db";
import { Activity, Coins, Gauge, Hash, Layers, Timer } from "lucide-react";
import { authOptions } from "@/lib/auth";
import { UsageChart, type UsagePoint } from "@/components/UsageChart";
import { RecentRequestsTable } from "@/components/RecentRequestsTable";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel, PanelBody, PanelHeader } from "@/components/ui/Panel";
import { Badge } from "@/components/ui/Badge";
import { StatCard, Meter } from "@/components/ui/StatCard";
import { EmptyState } from "@/components/ui/EmptyState";

const WINDOW_DAYS = 14;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index];
}

export default async function DashboardPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user) redirect("/login");
  if (session.user.role === "ADMIN") redirect("/admin/dashboard");
  const customerId = (session.user as { id: string }).id;

  // Server-side reporting window intentionally uses the request time.
  // eslint-disable-next-line react-hooks/purity
  const since = new Date(Date.now() - WINDOW_DAYS * 86400000);
  const [events, sub, ledger, hostedModels] = await Promise.all([
    prisma.usageEvent.findMany({
      where: { customerId, createdAt: { gte: since } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.subscription.findUnique({ where: { customerId }, include: { plan: true } }),
    prisma.quotaLedger.findUnique({ where: { customerId } }),
    prisma.hostedModel.findMany(),
  ]);

  const priceBySlug = new Map(hostedModels.map((m) => [m.modelId, m]));

  const byDay = new Map<string, UsagePoint>();
  for (let offset = WINDOW_DAYS - 1; offset >= 0; offset -= 1) {
    const day = new Date(since.getTime() + (WINDOW_DAYS - offset) * 86400000)
      .toISOString()
      .slice(0, 10);
    byDay.set(day, { day, prompt: 0, completion: 0 });
  }

  const byModel = new Map<
    string,
    { model: string; requests: number; tokens: number; costCents: number }
  >();

  let promptTotal = 0;
  let completionTotal = 0;
  let costCents = 0;
  const latencies: number[] = [];

  for (const event of events) {
    const day = event.createdAt.toISOString().slice(0, 10);
    const point = byDay.get(day) ?? { day, prompt: 0, completion: 0 };
    point.prompt += event.promptTokens;
    point.completion += event.completionTokens;
    byDay.set(day, point);

    promptTotal += event.promptTokens;
    completionTotal += event.completionTokens;
    latencies.push(event.latencyMs);

    const priced = priceBySlug.get(event.modelSlug);
    const eventCost = priced
      ? (event.promptTokens / 1e6) * priced.pricePerMTokIn +
        (event.completionTokens / 1e6) * priced.pricePerMTokOut
      : 0;
    costCents += eventCost;

    const row = byModel.get(event.modelSlug) ?? {
      model: event.modelSlug,
      requests: 0,
      tokens: 0,
      costCents: 0,
    };
    row.requests += 1;
    row.tokens += event.promptTokens + event.completionTokens;
    row.costCents += eventCost;
    byModel.set(event.modelSlug, row);
  }

  const chartData = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
  const totalTokens = promptTotal + completionTotal;
  const sortedLatencies = [...latencies].sort((a, b) => a - b);
  const p50 = percentile(sortedLatencies, 50);
  const p95 = percentile(sortedLatencies, 95);
  const topModels = [...byModel.values()].sort((a, b) => b.tokens - a.tokens);

  const quotaUsed = ledger ? Number(ledger.tokensUsed) : 0;
  const quotaLimit = sub ? Number(sub.plan.monthlyTokenQuota) : 0;
  const unlimited = quotaLimit === 0;
  return (
    <>
      <PageHeader
        eyebrow={`Last ${WINDOW_DAYS} days`}
        title="Usage overview"
        description="Token throughput, latency distribution, and estimated spend across your OpenAI-compatible endpoints."
        actions={
          <>
            <Badge tone="info">{sub?.plan.displayName ?? "No plan"}</Badge>
            <Badge tone={sub?.status === "ACTIVE" ? "ok" : "warn"} dot>
              {sub?.status ?? "inactive"}
            </Badge>
          </>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 sm:gap-4 xl:grid-cols-4">
        <StatCard
          label="Total tokens"
          value={totalTokens.toLocaleString()}
          icon={Hash}
          accent="brand"
          hint={
            <span className="font-mono">
              {promptTotal.toLocaleString()} in · {completionTotal.toLocaleString()} out
            </span>
          }
        />
        <StatCard
          label="Requests"
          value={events.length.toLocaleString()}
          icon={Activity}
          accent="signal"
          hint={
            <span className="font-mono">
              {events.length > 0
                ? `${Math.round(totalTokens / events.length).toLocaleString()} tok/req avg`
                : "no traffic yet"}
            </span>
          }
        />
        <StatCard
          label="Latency p50"
          value={p50.toLocaleString()}
          unit="ms"
          icon={Timer}
          accent={p95 > 20000 ? "warn" : "ok"}
          hint={<span className="font-mono">p95 {p95.toLocaleString()} ms</span>}
        />
        <StatCard
          label="Estimated spend"
          value={`$${(costCents / 100).toFixed(4)}`}
          icon={Coins}
          accent="warn"
          hint="Metered from catalog rates"
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Panel className="xl:col-span-2">
          <PanelHeader
            title="Daily token throughput"
            description="Stacked prompt and completion tokens per UTC day"
            actions={
              <div className="flex items-center gap-3 text-[11px] text-content-muted">
                <span className="flex items-center gap-1.5">
                  <span className="size-1.5 rounded-full bg-signal-500" /> prompt
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="size-1.5 rounded-full bg-brand-500" /> completion
                </span>
              </div>
            }
          />
          <PanelBody className="pl-1 pr-3 sm:pl-2 sm:pr-4">
            {totalTokens === 0 ? (
              <EmptyState
                icon={Activity}
                title="No usage recorded yet"
                description="Send a request to /v1/chat/completions with your API key and metrics will appear here within seconds."
              />
            ) : (
              <UsageChart data={chartData} />
            )}
          </PanelBody>
        </Panel>

        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-1">
          <Panel>
            <PanelHeader title="Billing period quota" />
            <PanelBody className="space-y-4">
              <div>
                <p className="metric">{quotaUsed.toLocaleString()}</p>
                <p className="mt-0.5 text-xs text-content-muted">
                  {unlimited
                    ? "of unlimited tokens (usage-based)"
                    : `of ${quotaLimit.toLocaleString()} tokens`}
                </p>
              </div>
              {!unlimited && <Meter value={quotaUsed} max={quotaLimit} />}
              <dl className="space-y-2.5 border-t border-line pt-4 text-xs">
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-content-muted">Rate limit</dt>
                  <dd className="font-mono text-content-primary">
                    {sub?.plan.requestsPerMinute ?? 0} rpm
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-content-muted">Max concurrency</dt>
                  <dd className="font-mono text-content-primary">{sub?.plan.maxConcurrent ?? 0}</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="shrink-0 text-content-muted">Overage per M tok</dt>
                  <dd className="text-right font-mono text-content-primary">
                    ${((sub?.plan.overagePerMTokIn ?? 0) / 100).toFixed(2)} in · $
                    {((sub?.plan.overagePerMTokOut ?? 0) / 100).toFixed(2)} out
                  </dd>
                </div>
              </dl>
            </PanelBody>
          </Panel>

          <Panel>
            <PanelHeader title="Quick start" />
            <PanelBody>
              <pre className="overflow-x-auto rounded-lg border border-line bg-surface-2 p-3 font-mono text-[11px] leading-relaxed text-content-secondary">
                <code>{`curl $BASE_URL/v1/chat/completions \\
  -H "Authorization: Bearer $KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"${topModels[0]?.model ?? "zms-coder-7b"}",
       "messages":[{"role":"user",
       "content":"Hello"}]}'`}</code>
              </pre>
            </PanelBody>
          </Panel>
        </div>
      </div>

      <Panel>
        <PanelHeader
          title="Usage by model"
          description={`Aggregated over the last ${WINDOW_DAYS} days`}
          actions={<Badge tone="neutral">{topModels.length} active</Badge>}
        />
        {topModels.length === 0 ? (
          <EmptyState
            icon={Layers}
            title="No model activity"
            description="Model-level breakdowns appear once requests are metered."
          />
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Model</th>
                  <th className="text-right">Requests</th>
                  <th className="text-right">Tokens</th>
                  <th className="text-right">Share</th>
                  <th className="text-right">Spend</th>
                </tr>
              </thead>
              <tbody>
                {topModels.map((row) => {
                  const share = totalTokens > 0 ? (row.tokens / totalTokens) * 100 : 0;
                  return (
                    <tr key={row.model}>
                      <td>
                        <span className="mono-chip">{row.model}</span>
                      </td>
                      <td className="whitespace-nowrap text-right font-mono tabular-nums">
                        {row.requests.toLocaleString()}
                      </td>
                      <td className="whitespace-nowrap text-right font-mono tabular-nums text-content-primary">
                        {row.tokens.toLocaleString()}
                      </td>
                      <td className="text-right">
                        <div className="flex items-center justify-end gap-2">
                          <span className="hidden h-1 w-16 overflow-hidden rounded-full bg-surface-3 sm:block">
                            <span
                              className="block h-full rounded-full bg-brand-500"
                              style={{ width: `${share}%` }}
                            />
                          </span>
                          <span className="w-10 font-mono text-xs tabular-nums">
                            {share.toFixed(0)}%
                          </span>
                        </div>
                      </td>
                      <td className="whitespace-nowrap text-right font-mono tabular-nums">
                        ${(row.costCents / 100).toFixed(4)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel>
        <PanelHeader
          title="Recent requests"
          description={`Filter the latest ${Math.min(events.length, 1_000).toLocaleString()} metered calls by local date and token size`}
          actions={<Gauge className="size-4 text-content-muted" aria-hidden />}
        />
        {events.length === 0 ? (
          <EmptyState icon={Gauge} title="No requests yet" />
        ) : (
          <RecentRequestsTable
            rows={[...events]
              .reverse()
              .slice(0, 1_000)
              .map((event) => ({
                id: event.id,
                createdAt: event.createdAt.toISOString(),
                model: event.modelSlug,
                promptTokens: event.promptTokens,
                completionTokens: event.completionTokens,
                latencyMs: event.latencyMs,
              }))}
          />
        )}
      </Panel>
    </>
  );
}
