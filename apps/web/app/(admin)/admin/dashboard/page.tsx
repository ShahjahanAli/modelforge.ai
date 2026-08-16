import { prisma } from "@modelforge/db";
import {
  Activity,
  Clock,
  Coins,
  Cpu,
  Gauge,
  HardDrive,
  Hash,
  Layers,
  MemoryStick,
  Monitor,
  ServerCog,
  Timer,
  Users,
} from "lucide-react";
import { gatewayFetch } from "@/lib/gateway";
import { UsageChart, type UsagePoint } from "@/components/UsageChart";
import { LiveRefresh } from "@/components/LiveRefresh";
import { RecentRequestsTable } from "@/components/RecentRequestsTable";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel, PanelBody, PanelHeader } from "@/components/ui/Panel";
import { Meter, StatCard } from "@/components/ui/StatCard";

const WINDOW_DAYS = 14;
const EVENT_SAMPLE_LIMIT = 50_000;

interface EngineHealth {
  healthy?: boolean;
  backend?: string;
  total_ram_mb?: number;
  used_ram_mb?: number;
  loaded_model_count?: number;
  physical_core_count?: number;
  logical_core_count?: number;
  cpu_model?: string;
  cpu_speed_mhz?: number;
  cpu_usage_percent?: number;
  host_total_ram_mb?: number;
  host_free_ram_mb?: number;
  host_uptime_seconds?: number;
  gateway_rss_mb?: number;
  load_average_1m?: number;
  hostname?: string;
  platform?: string;
  platform_release?: string;
  arch?: string;
  node_version?: string;
  error?: string;
}

interface EngineModels {
  models?: Array<{
    model_id: string;
    ram_used_mb: number;
    active_requests: number;
    tokens_per_sec_avg: number;
  }>;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index] ?? 0;
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export default async function AdminDashboardPage() {
  const now = new Date();
  const since = new Date(now.getTime() - WINDOW_DAYS * 86_400_000);
  const minuteAgo = new Date(now.getTime() - 60_000);

  const [
    events,
    usageSummary,
    usageByModel,
    usageByCustomer,
    requestsLastMinute,
    customers,
    activeSubscriptions,
    activeKeys,
    hostedModels,
    health,
    loaded,
  ] = await Promise.all([
    prisma.usageEvent.findMany({
      where: { createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take: EVENT_SAMPLE_LIMIT,
      select: {
        id: true,
        customerId: true,
        modelSlug: true,
        promptTokens: true,
        completionTokens: true,
        latencyMs: true,
        createdAt: true,
      },
    }),
    prisma.usageEvent.aggregate({
      where: { createdAt: { gte: since } },
      _count: true,
      _sum: { promptTokens: true, completionTokens: true },
    }),
    prisma.usageEvent.groupBy({
      by: ["modelSlug"],
      where: { createdAt: { gte: since } },
      _count: true,
      _sum: { promptTokens: true, completionTokens: true },
    }),
    prisma.usageEvent.groupBy({
      by: ["customerId"],
      where: { createdAt: { gte: since } },
      _count: true,
      _sum: { promptTokens: true, completionTokens: true },
    }),
    prisma.usageEvent.count({ where: { createdAt: { gte: minuteAgo } } }),
    prisma.customer.findMany({
      where: { role: "CUSTOMER" },
      select: { id: true, email: true, name: true },
    }),
    prisma.subscription.findMany({
      where: { status: "ACTIVE" },
      include: { plan: true },
    }),
    prisma.apiKey.count({ where: { revokedAt: null } }),
    prisma.hostedModel.findMany(),
    gatewayFetch("/internal/engine/health").catch(
      (error: unknown): EngineHealth => ({
        healthy: false,
        error: error instanceof Error ? error.message : "engine unreachable",
      }),
    ) as Promise<EngineHealth>,
    gatewayFetch("/internal/engine/models").catch(
      (): EngineModels => ({ models: [] }),
    ) as Promise<EngineModels>,
  ]);

  const customerById = new Map(customers.map((customer) => [customer.id, customer]));
  const modelBySlug = new Map(hostedModels.map((model) => [model.modelId, model]));
  const residentModels = loaded.models ?? [];

  const promptTotal = usageSummary._sum.promptTokens ?? 0;
  const completionTotal = usageSummary._sum.completionTokens ?? 0;
  const totalTokens = promptTotal + completionTotal;
  const totalRequests = usageSummary._count;
  const latencies = events.map((event) => event.latencyMs);
  const p50 = percentile(latencies, 50);
  const p95 = percentile(latencies, 95);

  const byDay = new Map<string, UsagePoint>();
  for (let offset = WINDOW_DAYS - 1; offset >= 0; offset -= 1) {
    const day = new Date(now.getTime() - offset * 86_400_000).toISOString().slice(0, 10);
    byDay.set(day, { day, prompt: 0, completion: 0 });
  }
  for (const event of events) {
    const day = event.createdAt.toISOString().slice(0, 10);
    const point = byDay.get(day);
    if (!point) continue;
    point.prompt += event.promptTokens;
    point.completion += event.completionTokens;
  }
  const chartData = [...byDay.values()];

  const topModels = usageByModel
    .map((row) => {
      const prompt = row._sum.promptTokens ?? 0;
      const completion = row._sum.completionTokens ?? 0;
      const model = modelBySlug.get(row.modelSlug);
      const revenueCents = model
        ? (prompt / 1_000_000) * model.pricePerMTokIn +
          (completion / 1_000_000) * model.pricePerMTokOut
        : 0;
      return {
        slug: row.modelSlug,
        requests: row._count,
        tokens: prompt + completion,
        revenueCents,
      };
    })
    .sort((a, b) => b.tokens - a.tokens);

  const topCustomers = usageByCustomer
    .map((row) => ({
      customer: customerById.get(row.customerId),
      requests: row._count,
      tokens: (row._sum.promptTokens ?? 0) + (row._sum.completionTokens ?? 0),
    }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 8);

  const estimatedUsageRevenue = topModels.reduce((sum, row) => sum + row.revenueCents, 0);
  const mrr = activeSubscriptions.reduce((sum, sub) => sum + sub.plan.priceCentsMonthly, 0);
  const activeRequests = residentModels.reduce((sum, model) => sum + model.active_requests, 0);
  const throughput = residentModels.reduce(
    (sum, model) => sum + Number(model.tokens_per_sec_avg),
    0,
  );
  const usedRam = health.used_ram_mb ?? 0;
  const totalRam = health.total_ram_mb ?? 0;
  const hostTotalRam = health.host_total_ram_mb ?? 0;
  const hostFreeRam = health.host_free_ram_mb ?? 0;
  const hostUsedRam = Math.max(0, hostTotalRam - hostFreeRam);
  const cpuUsage = health.cpu_usage_percent ?? 0;
  const hostUptime = health.host_uptime_seconds ?? 0;

  return (
    <>
      <PageHeader
        eyebrow={`Platform · last ${WINDOW_DAYS} days`}
        title="Operations overview"
        description="Platform-wide inference activity, customer adoption, revenue, and live runtime health."
        actions={
          <div className="flex items-center gap-2">
            <LiveRefresh />
            <Badge tone={health.healthy ? "ok" : "danger"} dot pulse={health.healthy}>
              {health.healthy ? "live" : "engine down"}
            </Badge>
          </div>
        }
      />

      {health.error && (
        <p className="rounded-lg border border-danger-200 bg-danger-50 px-4 py-3 font-mono text-xs break-words text-danger-700">
          {health.error}
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2 sm:gap-4 xl:grid-cols-4">
        <StatCard
          label="Platform tokens"
          value={totalTokens.toLocaleString()}
          icon={Hash}
          accent="brand"
          hint={`${promptTotal.toLocaleString()} in · ${completionTotal.toLocaleString()} out`}
        />
        <StatCard
          label="Inference requests"
          value={totalRequests.toLocaleString()}
          icon={Activity}
          accent="signal"
          hint={`${requestsLastMinute} in the last minute`}
        />
        <StatCard
          label="Active customers"
          value={usageByCustomer.length.toLocaleString()}
          icon={Users}
          accent="ok"
          hint={`${activeSubscriptions.length} subscriptions · ${customers.length} customers`}
        />
        <StatCard
          label="Recurring revenue"
          value={money(mrr)}
          icon={Coins}
          accent="warn"
          hint={`${money(estimatedUsageRevenue)} metered usage`}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Panel className="xl:col-span-2">
          <PanelHeader
            title="Platform token throughput"
            description="All customer prompt and completion tokens per UTC day"
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
                title="No platform usage yet"
                description="Customer inference traffic will appear here after it is metered."
              />
            ) : (
              <UsageChart data={chartData} />
            )}
          </PanelBody>
        </Panel>

        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-1">
          <Panel>
            <PanelHeader
              title="Inference runtime"
              actions={
                <Badge tone={health.healthy ? "ok" : "danger"} dot>
                  {health.backend ?? "unknown"}
                </Badge>
              }
            />
            <PanelBody className="space-y-4">
              <dl className="grid grid-cols-2 gap-3 text-xs">
                <div className="rounded-lg bg-surface-2 p-3">
                  <dt className="text-content-muted">Resident</dt>
                  <dd className="mt-1 font-mono text-lg font-semibold text-content-primary">
                    {residentModels.length}
                  </dd>
                </div>
                <div className="rounded-lg bg-surface-2 p-3">
                  <dt className="text-content-muted">Active requests</dt>
                  <dd className="mt-1 font-mono text-lg font-semibold text-content-primary">
                    {activeRequests}
                  </dd>
                </div>
                <div className="rounded-lg bg-surface-2 p-3">
                  <dt className="text-content-muted">Throughput</dt>
                  <dd className="mt-1 font-mono text-lg font-semibold text-content-primary">
                    {throughput.toFixed(1)}
                    <span className="ml-1 text-[10px] font-normal text-content-muted">tok/s</span>
                  </dd>
                </div>
                <div className="rounded-lg bg-surface-2 p-3">
                  <dt className="text-content-muted">Physical cores</dt>
                  <dd className="mt-1 font-mono text-lg font-semibold text-content-primary">
                    {health.physical_core_count ?? "—"}
                  </dd>
                </div>
              </dl>
              <div>
                <div className="mb-2 flex items-center justify-between text-xs">
                  <span className="text-content-muted">RAM budget</span>
                  <span className="font-mono text-content-primary">
                    {usedRam.toLocaleString()} / {totalRam ? totalRam.toLocaleString() : "—"} MB
                  </span>
                </div>
                {totalRam > 0 && <Meter value={usedRam} max={totalRam} />}
              </div>
            </PanelBody>
          </Panel>

          <Panel>
            <PanelHeader title="Latency distribution" />
            <PanelBody>
              <dl className="space-y-3 text-xs">
                <div className="flex items-center justify-between">
                  <dt className="flex items-center gap-2 text-content-muted">
                    <Timer className="size-3.5" aria-hidden /> p50
                  </dt>
                  <dd className="font-mono text-content-primary">{p50.toLocaleString()} ms</dd>
                </div>
                <div className="flex items-center justify-between">
                  <dt className="flex items-center gap-2 text-content-muted">
                    <Gauge className="size-3.5" aria-hidden /> p95
                  </dt>
                  <dd className="font-mono text-content-primary">{p95.toLocaleString()} ms</dd>
                </div>
                <div className="flex items-center justify-between border-t border-line pt-3">
                  <dt className="text-content-muted">Average tokens/request</dt>
                  <dd className="font-mono text-content-primary">
                    {totalRequests > 0 ? Math.round(totalTokens / totalRequests).toLocaleString() : 0}
                  </dd>
                </div>
                <div className="flex items-center justify-between">
                  <dt className="text-content-muted">Active API keys</dt>
                  <dd className="font-mono text-content-primary">{activeKeys}</dd>
                </div>
              </dl>
            </PanelBody>
          </Panel>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 sm:gap-4 xl:grid-cols-4">
        <StatCard
          label="Host CPU"
          value={cpuUsage.toFixed(1)}
          unit="%"
          icon={Cpu}
          accent={cpuUsage >= 90 ? "danger" : cpuUsage >= 70 ? "warn" : "ok"}
          hint={`${health.logical_core_count ?? health.physical_core_count ?? "—"} logical CPUs · ${
            health.cpu_speed_mhz ? `${health.cpu_speed_mhz.toLocaleString()} MHz` : "clock unavailable"
          }`}
        >
          <Meter value={cpuUsage} max={100} tone="ok" />
        </StatCard>
        <StatCard
          label="Host memory"
          value={hostUsedRam.toLocaleString()}
          unit={`/ ${hostTotalRam ? hostTotalRam.toLocaleString() : "—"} MB`}
          icon={MemoryStick}
          accent={hostTotalRam > 0 && hostUsedRam / hostTotalRam >= 0.9 ? "danger" : "brand"}
          hint={`${hostFreeRam.toLocaleString()} MB available`}
        >
          {hostTotalRam > 0 && <Meter value={hostUsedRam} max={hostTotalRam} />}
        </StatCard>
        <StatCard
          label="Gateway memory"
          value={(health.gateway_rss_mb ?? 0).toLocaleString()}
          unit="MB RSS"
          icon={Monitor}
          accent="signal"
          hint={`${health.node_version ?? "Node"} · process resident set`}
        />
        <StatCard
          label="Host uptime"
          value={formatUptime(hostUptime)}
          icon={Clock}
          accent="warn"
          hint={`${health.hostname ?? "unknown host"} · load ${health.load_average_1m ?? 0}`}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel>
          <PanelHeader
            title="Host machine"
            description="Runtime host specification reported by the gateway"
            actions={
              <Badge tone={health.healthy ? "ok" : "danger"} dot>
                {health.arch ?? "unknown"}
              </Badge>
            }
          />
          <PanelBody>
            <dl className="grid gap-x-6 gap-y-4 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs text-content-muted">Processor</dt>
                <dd className="mt-1 text-content-primary">{health.cpu_model ?? "Unavailable"}</dd>
              </div>
              <div>
                <dt className="text-xs text-content-muted">Logical processors</dt>
                <dd className="mt-1 font-mono text-content-primary">
                  {health.logical_core_count ?? health.physical_core_count ?? "—"} @{" "}
                  {health.cpu_speed_mhz
                    ? `${health.cpu_speed_mhz.toLocaleString()} MHz`
                    : "unknown clock"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-content-muted">Operating system</dt>
                <dd className="mt-1 font-mono text-xs break-words text-content-primary">
                  {health.platform ?? "Unknown"} {health.platform_release ?? ""}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-content-muted">Architecture</dt>
                <dd className="mt-1 font-mono text-content-primary">{health.arch ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-xs text-content-muted">Hostname</dt>
                <dd className="mt-1 font-mono text-content-primary">
                  {health.hostname ?? "Unavailable"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-content-muted">System memory</dt>
                <dd className="mt-1 font-mono text-content-primary">
                  {hostTotalRam ? `${hostTotalRam.toLocaleString()} MB` : "Unavailable"}
                </dd>
              </div>
            </dl>
          </PanelBody>
        </Panel>

        <Panel>
          <PanelHeader
            title="Resident model performance"
            description="Live memory, concurrency, and measured generation throughput"
            actions={<Badge tone="neutral">{residentModels.length} resident</Badge>}
          />
          {residentModels.length === 0 ? (
            <EmptyState
              icon={Layers}
              title="No resident models"
              description="Performance appears after a model is loaded or receives its first request."
            />
          ) : (
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Model</th>
                    <th className="text-right">RAM</th>
                    <th className="text-right">Active</th>
                    <th className="text-right">Throughput</th>
                  </tr>
                </thead>
                <tbody>
                  {residentModels.map((model) => (
                    <tr key={model.model_id}>
                      <td>
                        <span className="mono-chip">{model.model_id}</span>
                      </td>
                      <td className="whitespace-nowrap text-right font-mono tabular-nums">
                        {model.ram_used_mb.toLocaleString()} MB
                      </td>
                      <td className="text-right font-mono tabular-nums">
                        {model.active_requests}
                      </td>
                      <td className="whitespace-nowrap text-right font-mono tabular-nums text-content-primary">
                        {Number(model.tokens_per_sec_avg).toFixed(1)} tok/s
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel>
          <PanelHeader
            title="Top models"
            description="Ranked by tokens over the reporting window"
            actions={<Badge tone="neutral">{topModels.length} active</Badge>}
          />
          {topModels.length === 0 ? (
            <EmptyState icon={Layers} title="No model activity" />
          ) : (
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Model</th>
                    <th className="text-right">Requests</th>
                    <th className="text-right">Tokens</th>
                    <th className="text-right">Usage revenue</th>
                  </tr>
                </thead>
                <tbody>
                  {topModels.slice(0, 8).map((row) => (
                    <tr key={row.slug}>
                      <td>
                        <span className="mono-chip">{row.slug}</span>
                      </td>
                      <td className="text-right font-mono tabular-nums">
                        {row.requests.toLocaleString()}
                      </td>
                      <td className="text-right font-mono tabular-nums text-content-primary">
                        {row.tokens.toLocaleString()}
                      </td>
                      <td className="text-right font-mono tabular-nums">
                        {money(row.revenueCents)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel>
          <PanelHeader
            title="Top customers"
            description="Platform consumers ranked by tokens"
            actions={<Badge tone="neutral">{usageByCustomer.length} active</Badge>}
          />
          {topCustomers.length === 0 ? (
            <EmptyState icon={Users} title="No active customers" />
          ) : (
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Customer</th>
                    <th className="text-right">Requests</th>
                    <th className="text-right">Tokens</th>
                    <th className="text-right">Share</th>
                  </tr>
                </thead>
                <tbody>
                  {topCustomers.map((row) => (
                    <tr key={row.customer?.id ?? `${row.requests}-${row.tokens}`}>
                      <td>
                        <div className="font-medium text-content-primary">
                          {row.customer?.name || row.customer?.email || "Deleted customer"}
                        </div>
                        {row.customer?.name && (
                          <div className="mt-0.5 text-xs text-content-muted">
                            {row.customer.email}
                          </div>
                        )}
                      </td>
                      <td className="text-right font-mono tabular-nums">
                        {row.requests.toLocaleString()}
                      </td>
                      <td className="text-right font-mono tabular-nums text-content-primary">
                        {row.tokens.toLocaleString()}
                      </td>
                      <td className="text-right font-mono tabular-nums">
                        {totalTokens > 0 ? `${((row.tokens / totalTokens) * 100).toFixed(1)}%` : "0%"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>

      <Panel>
        <PanelHeader
          title="Recent inference requests"
          description={`Filter the latest ${Math.min(events.length, 1_000).toLocaleString()} metered calls by local date and token size`}
          actions={
            <span className="flex items-center gap-1.5 font-mono text-xs text-content-muted">
              <ServerCog className="size-3.5" aria-hidden />
              {residentModels.length} resident
            </span>
          }
        />
        {events.length === 0 ? (
          <EmptyState icon={Gauge} title="No requests recorded" />
        ) : (
          <RecentRequestsTable
            showCustomer
            rows={events.slice(0, 1_000).map((event) => ({
              id: event.id,
              createdAt: event.createdAt.toISOString(),
              customer: customerById.get(event.customerId)?.email ?? "Deleted customer",
              model: event.modelSlug,
              promptTokens: event.promptTokens,
              completionTokens: event.completionTokens,
              latencyMs: event.latencyMs,
            }))}
          />
        )}
      </Panel>

      <p className="flex items-center gap-2 text-[11px] text-content-muted">
        <HardDrive className="size-3.5" aria-hidden />
        Usage totals are exact; chart and latency calculations use up to the latest{" "}
        {EVENT_SAMPLE_LIMIT.toLocaleString()} events.
      </p>
    </>
  );
}
