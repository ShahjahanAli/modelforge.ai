import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { prisma } from "@modelforge/db";
import { summarizeUsageEvents, classifyUsageSlug, effectiveMonthlyQuota } from "@modelforge/platform";
import { Activity, Coins, Database, Gauge, Hash, Layers, Mic, Timer } from "lucide-react";
import { authOptions } from "@/lib/auth";
import { usageEventCostUsd } from "@/lib/usageCost";
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
  const [events, sub, ledger, customer, hostedModels] = await Promise.all([
    prisma.usageEvent.findMany({
      where: { customerId, createdAt: { gte: since } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.subscription.findUnique({ where: { customerId }, include: { plan: true } }),
    prisma.quotaLedger.findUnique({ where: { customerId } }),
    prisma.customer.findUnique({
      where: { id: customerId },
      select: { quotaBonusTokens: true },
    }),
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
    {
      model: string;
      requests: number;
      tokens: number;
      costCents: number;
      inputCostUsd: number;
      outputCostUsd: number;
    }
  >();

  let promptTotal = 0;
  let completionTotal = 0;
  let costCents = 0;
  const latencies: number[] = [];

  for (const event of events) {
    const kind = classifyUsageSlug(event.modelSlug);
    const day = event.createdAt.toISOString().slice(0, 10);
    // Daily chart = LLM tokenizer traffic only (STT/Neo4j use different units).
    if (kind === "llm") {
      const point = byDay.get(day) ?? { day, prompt: 0, completion: 0 };
      point.prompt += event.promptTokens;
      point.completion += event.completionTokens;
      byDay.set(day, point);
      promptTotal += event.promptTokens;
      completionTotal += event.completionTokens;
    }
    latencies.push(event.latencyMs);

    const priced = priceBySlug.get(event.modelSlug);
    const costs = usageEventCostUsd({
      promptTokens: event.promptTokens,
      completionTokens: event.completionTokens,
      pricePerMTokIn: priced?.pricePerMTokIn,
      pricePerMTokOut: priced?.pricePerMTokOut,
    });
    // Keep legacy "costCents" total as USD*100 for existing StatCard math.
    const eventCostCents = costs.totalCostUsd * 100;
    if (kind === "llm") costCents += eventCostCents;

    const row = byModel.get(event.modelSlug) ?? {
      model: event.modelSlug,
      requests: 0,
      tokens: 0,
      costCents: 0,
      inputCostUsd: 0,
      outputCostUsd: 0,
    };
    row.requests += 1;
    row.tokens += event.promptTokens + event.completionTokens;
    row.costCents += eventCostCents;
    row.inputCostUsd += costs.inputCostUsd;
    row.outputCostUsd += costs.outputCostUsd;
    byModel.set(event.modelSlug, row);
  }

  const usageSplit = summarizeUsageEvents(events);
  const chartData = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
  const totalTokens = promptTotal + completionTotal;
  const sortedLatencies = [...latencies].sort((a, b) => a - b);
  const p50 = percentile(sortedLatencies, 50);
  const p95 = percentile(sortedLatencies, 95);
  const topModels = [...byModel.values()].sort((a, b) => b.tokens - a.tokens);

  const quotaUsed = ledger ? Number(ledger.tokensUsed) : 0;
  const quotaLimit = sub
    ? Number(effectiveMonthlyQuota(sub.plan.monthlyTokenQuota, customer?.quotaBonusTokens ?? 0n))
    : 0;
  const unlimited = quotaLimit === 0;
  return (
    <>
      <PageHeader
        eyebrow={`Last ${WINDOW_DAYS} days`}
        title="Usage overview"
        description="LLM tokens, Whisper/STT audio seconds, and Neo4j graph ops — all billed to your API key."
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
          label="LLM tokens"
          value={usageSplit.llmTotal.toLocaleString()}
          icon={Hash}
          accent="brand"
          hint={
            <span className="font-mono">
              {usageSplit.llmPrompt.toLocaleString()} in · {usageSplit.llmCompletion.toLocaleString()}{" "}
              out
            </span>
          }
        />
        <StatCard
          label="STT audio"
          value={usageSplit.sttSeconds.toFixed(1)}
          unit="sec"
          icon={Mic}
          accent="signal"
          hint={
            <span className="font-mono">
              {usageSplit.sttBillable.toLocaleString()} billable units (Whisper is ASR/ML, not an LLM)
            </span>
          }
        />
        <StatCard
          label="Neo4j ops"
          value={(usageSplit.neo4jReads + usageSplit.neo4jWrites).toLocaleString()}
          icon={Database}
          accent="ok"
          hint={
            <span className="font-mono">
              {usageSplit.neo4jReads.toLocaleString()} read · {usageSplit.neo4jWrites.toLocaleString()}{" "}
              write
            </span>
          }
        />
        <StatCard
          label="Neo4j store"
          value={
            usageSplit.neo4jStoreBytes > 0
              ? `${(usageSplit.neo4jStoreBytes / (1024 * 1024)).toFixed(2)}`
              : "0"
          }
          unit="MB"
          icon={Gauge}
          accent="warn"
          hint="Latest store snapshot from GET /v1/graph/stats"
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 sm:gap-4 xl:grid-cols-4">
        <StatCard
          label="Requests"
          value={events.length.toLocaleString()}
          icon={Activity}
          accent="signal"
          hint={
            <span className="font-mono">
              {events.length > 0
                ? `${Math.round(totalTokens / Math.max(1, events.filter((e) => classifyUsageSlug(e.modelSlug) === "llm").length || 1)).toLocaleString()} tok/LLM-req avg`
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
          label="Estimated LLM spend"
          value={`$${(costCents / 100).toFixed(4)}`}
          icon={Coins}
          accent="warn"
          hint="Catalog rates (STT/Neo4j use billable units on the quota ledger)"
        />
        <StatCard
          label="Quota ledger"
          value={quotaUsed.toLocaleString()}
          icon={Layers}
          accent="brand"
          hint={
            unlimited
              ? "unlimited plan"
              : `of ${quotaLimit.toLocaleString()} (LLM + STT units + Neo4j units)`
          }
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Panel className="xl:col-span-2">
          <PanelHeader
            title="Daily LLM token throughput"
            description="Stacked prompt and completion tokens per UTC day (excludes STT/Neo4j)"
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
                title="No LLM usage recorded yet"
                description="Chat completions meter tokenizer counts. Whisper meters audio seconds; Neo4j meters read/write ops."
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
                    ? "of unlimited units (usage-based)"
                    : `of ${quotaLimit.toLocaleString()} billable units`}
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
                  <th className="text-right">Units</th>
                  <th className="text-right">Share</th>
                  <th className="text-right">Input $</th>
                  <th className="text-right">Output $</th>
                  <th className="text-right">Total $</th>
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
                        ${row.inputCostUsd.toFixed(6)}
                      </td>
                      <td className="whitespace-nowrap text-right font-mono tabular-nums">
                        ${row.outputCostUsd.toFixed(6)}
                      </td>
                      <td className="whitespace-nowrap text-right font-mono tabular-nums text-content-primary">
                        ${(row.inputCostUsd + row.outputCostUsd).toFixed(6)}
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
              .map((event) => {
                const priced = priceBySlug.get(event.modelSlug);
                const costs = usageEventCostUsd({
                  promptTokens: event.promptTokens,
                  completionTokens: event.completionTokens,
                  pricePerMTokIn: priced?.pricePerMTokIn,
                  pricePerMTokOut: priced?.pricePerMTokOut,
                });
                return {
                  id: event.id,
                  createdAt: event.createdAt.toISOString(),
                  model: event.modelSlug,
                  promptTokens: event.promptTokens,
                  completionTokens: event.completionTokens,
                  latencyMs: event.latencyMs,
                  inputCostUsd: costs.inputCostUsd,
                  outputCostUsd: costs.outputCostUsd,
                };
              })}
          />
        )}
      </Panel>
    </>
  );
}
