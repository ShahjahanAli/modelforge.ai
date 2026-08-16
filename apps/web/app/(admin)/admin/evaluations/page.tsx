import { prisma } from "@modelforge/db";
import { requireAdmin } from "@/lib/session";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { FlaskConical } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function AdminEvaluationsPage() {
  await requireAdmin();
  const [suites, runs, canaries] = await Promise.all([
    prisma.evalSuite.findMany({ include: { cases: true }, orderBy: { name: "asc" } }),
    prisma.evalRun.findMany({
      include: { suite: true, revision: true },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
    prisma.canaryChannel.findMany({ include: { model: true }, orderBy: { name: "asc" } }),
  ]);

  return (
    <>
      <PageHeader
        eyebrow="Quality"
        title="Evaluations & canaries"
        description="Model revision gates, suite runs, and traffic-split canary channels."
      />
      <div className="grid gap-4 xl:grid-cols-2">
        <Panel>
          <PanelHeader title="Suites" actions={<Badge tone="neutral">{suites.length}</Badge>} />
          {suites.length === 0 ? (
            <EmptyState icon={FlaskConical} title="No evaluation suites" />
          ) : (
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th className="text-right">Cases</th>
                  </tr>
                </thead>
                <tbody>
                  {suites.map((suite) => (
                    <tr key={suite.id}>
                      <td className="font-medium">{suite.name}</td>
                      <td className="text-right font-mono">{suite.cases.length}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
        <Panel>
          <PanelHeader title="Canaries" actions={<Badge tone="neutral">{canaries.length}</Badge>} />
          {canaries.length === 0 ? (
            <EmptyState icon={FlaskConical} title="No canary channels" />
          ) : (
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Model</th>
                    <th className="text-right">Traffic</th>
                    <th>Enabled</th>
                  </tr>
                </thead>
                <tbody>
                  {canaries.map((canary) => (
                    <tr key={canary.id}>
                      <td>{canary.name}</td>
                      <td>
                        <span className="mono-chip">{canary.model.modelId}</span>
                      </td>
                      <td className="text-right font-mono">{canary.trafficPct}%</td>
                      <td>
                        <Badge tone={canary.enabled ? "ok" : "neutral"}>
                          {canary.enabled ? "on" : "off"}
                        </Badge>
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
        <PanelHeader title="Recent runs" />
        {runs.length === 0 ? (
          <EmptyState icon={FlaskConical} title="No evaluation runs" />
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Suite</th>
                  <th>Revision</th>
                  <th>Status</th>
                  <th className="text-right">Score</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id}>
                    <td>{run.suite.name}</td>
                    <td className="font-mono text-xs">{run.revision.revision}</td>
                    <td>
                      <Badge tone={run.status === "SUCCEEDED" ? "ok" : "warn"}>{run.status}</Badge>
                    </td>
                    <td className="text-right font-mono">
                      {run.score === null ? "—" : run.score.toFixed(3)}
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
