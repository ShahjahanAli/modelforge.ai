import { prisma } from "@modelforge/db";
import { Activity } from "lucide-react";
import { requireSession } from "@/lib/session";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel, PanelBody, PanelHeader } from "@/components/ui/Panel";
import { EmptyState } from "@/components/ui/EmptyState";
import { Badge } from "@/components/ui/Badge";
import { StatCard } from "@/components/ui/StatCard";

export const dynamic = "force-dynamic";

export default async function ReliabilityPage() {
  const user = await requireSession();
  const [windows, credits, violations] = await Promise.all([
    prisma.sloWindow.findMany({
      where: user.role === "ADMIN" ? {} : { customerId: user.id },
      include: { definition: true },
      orderBy: { windowStart: "desc" },
      take: 24,
    }),
    prisma.serviceCredit.findMany({
      where: user.role === "ADMIN" ? {} : { customerId: user.id },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
    prisma.sloViolation.findMany({
      orderBy: { createdAt: "desc" },
      take: 20,
      include: { definition: true },
    }),
  ]);

  const latest = windows[0];
  const openCredits = credits
    .filter((c) => !c.applied)
    .reduce((sum, c) => sum + Number(c.amountMicros), 0);

  return (
    <>
      <PageHeader
        eyebrow="Reliability"
        title="SLO & credits"
        description="Latency and availability error budgets with automatic service credits."
      />
      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard
          label="Latest window"
          value={latest?.status ?? "—"}
          icon={Activity}
          accent={latest?.status === "BREACHED" ? "danger" : "ok"}
          hint={latest ? `${latest.availabilityPct.toFixed(2)}% availability` : "No rollups yet"}
        />
        <StatCard
          label="p95 latency"
          value={(latest?.p95LatencyMs ?? 0).toLocaleString()}
          unit="ms"
          accent="signal"
        />
        <StatCard
          label="Open credits"
          value={`$${(openCredits / 1_000_000).toFixed(4)}`}
          accent="warn"
          hint={`${credits.length} credit ledger rows`}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel>
          <PanelHeader title="SLO windows" />
          {windows.length === 0 ? (
            <EmptyState icon={Activity} title="No SLO windows rolled up yet" />
          ) : (
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>SLO</th>
                    <th>Status</th>
                    <th className="text-right">Availability</th>
                    <th className="text-right">p95</th>
                  </tr>
                </thead>
                <tbody>
                  {windows.map((window) => (
                    <tr key={window.id}>
                      <td>{window.definition.name}</td>
                      <td>
                        <Badge
                          tone={
                            window.status === "HEALTHY"
                              ? "ok"
                              : window.status === "AT_RISK"
                                ? "warn"
                                : "danger"
                          }
                        >
                          {window.status}
                        </Badge>
                      </td>
                      <td className="text-right font-mono">
                        {window.availabilityPct.toFixed(2)}%
                      </td>
                      <td className="text-right font-mono">{window.p95LatencyMs} ms</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel>
          <PanelHeader title="Service credits" />
          <PanelBody className="space-y-3">
            {credits.length === 0 ? (
              <p className="text-sm text-content-muted">No credits issued.</p>
            ) : (
              credits.map((credit) => (
                <div
                  key={credit.id}
                  className="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2 text-sm"
                >
                  <div>
                    <div className="font-medium">{credit.reason}</div>
                    <div className="text-xs text-content-muted">
                      {credit.createdAt.toISOString().slice(0, 19)}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-mono">
                      ${(Number(credit.amountMicros) / 1_000_000).toFixed(4)}
                    </div>
                    <Badge tone={credit.applied ? "neutral" : "ok"}>
                      {credit.applied ? "applied" : "open"}
                    </Badge>
                  </div>
                </div>
              ))
            )}
          </PanelBody>
        </Panel>
      </div>

      <Panel>
        <PanelHeader title="Recent violations" actions={<Badge tone="neutral">{violations.length}</Badge>} />
        {violations.length === 0 ? (
          <EmptyState icon={Activity} title="No violations recorded" />
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>SLO</th>
                  <th>Reason</th>
                  <th className="text-right">Latency</th>
                </tr>
              </thead>
              <tbody>
                {violations.map((row) => (
                  <tr key={row.id}>
                    <td className="font-mono text-xs">
                      {row.createdAt.toISOString().replace("T", " ").slice(0, 19)}
                    </td>
                    <td>{row.definition.name}</td>
                    <td>{row.reason}</td>
                    <td className="text-right font-mono">{row.latencyMs ?? "—"}</td>
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
