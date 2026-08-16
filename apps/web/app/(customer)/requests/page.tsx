import Link from "next/link";
import { prisma } from "@modelforge/db";
import { FileSearch } from "lucide-react";
import { requireSession } from "@/lib/session";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { EmptyState } from "@/components/ui/EmptyState";
import { Badge } from "@/components/ui/Badge";

export const dynamic = "force-dynamic";

export default async function RequestsPage() {
  const user = await requireSession();
  const where = user.role === "ADMIN" ? {} : { customerId: user.id };
  const requests = await prisma.inferenceRequest.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return (
    <>
      <PageHeader
        eyebrow="Observability"
        title="Inference requests"
        description="Immutable execution records with cost, latency stages, and receipt linkage."
      />
      <Panel>
        <PanelHeader
          title="Recent executions"
          actions={<Badge tone="neutral">{requests.length} shown</Badge>}
        />
        {requests.length === 0 ? (
          <EmptyState
            icon={FileSearch}
            title="No inference requests yet"
            description="Requests appear after the modern execution ledger starts recording completions."
          />
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Created</th>
                  <th>Status</th>
                  <th>Model</th>
                  <th className="text-right">Tokens</th>
                  <th className="text-right">Cost</th>
                  <th className="text-right">Latency</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {requests.map((row) => (
                  <tr key={row.id}>
                    <td className="whitespace-nowrap font-mono text-xs">
                      {row.createdAt.toISOString().replace("T", " ").slice(0, 19)}
                    </td>
                    <td>
                      <Badge
                        tone={
                          row.status === "SUCCEEDED"
                            ? "ok"
                            : row.status === "FAILED" || row.status === "REJECTED"
                              ? "danger"
                              : "warn"
                        }
                      >
                        {row.status}
                      </Badge>
                    </td>
                    <td>
                      <span className="mono-chip">
                        {row.resolvedModelSlug ?? row.requestedModelSlug}
                      </span>
                    </td>
                    <td className="text-right font-mono tabular-nums">
                      {(row.promptTokens + row.completionTokens).toLocaleString()}
                    </td>
                    <td className="text-right font-mono tabular-nums">
                      ${(Number(row.costMicros) / 1_000_000).toFixed(6)}
                    </td>
                    <td className="text-right font-mono tabular-nums">
                      {row.latencyMs.toLocaleString()} ms
                    </td>
                    <td className="text-right">
                      <Link className="btn-ghost text-xs" href={`/requests/${row.id}`}>
                        Debug
                      </Link>
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
