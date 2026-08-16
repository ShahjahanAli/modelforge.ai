import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@modelforge/db";
import { assertOwnership, requireSession } from "@/lib/session";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel, PanelBody, PanelHeader } from "@/components/ui/Panel";
import { Badge } from "@/components/ui/Badge";

export const dynamic = "force-dynamic";

export default async function RequestDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await requireSession();
  const request = await prisma.inferenceRequest.findUnique({
    where: { id },
    include: {
      attempts: { orderBy: { attemptNo: "asc" } },
      receipt: true,
      usageEvent: true,
    },
  });
  if (!request) notFound();
  assertOwnership(request.customerId, user);

  return (
    <>
      <PageHeader
        eyebrow="Cost debugger"
        title={request.id}
        description="Lifecycle, pricing snapshot, and signed usage receipt for this execution."
        actions={
          <Badge tone={request.status === "SUCCEEDED" ? "ok" : "warn"}>{request.status}</Badge>
        }
      />

      <div className="grid gap-4 xl:grid-cols-3">
        <Panel className="xl:col-span-2">
          <PanelHeader title="Lifecycle" />
          <PanelBody>
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs text-content-muted">Requested model</dt>
                <dd className="mt-1 font-mono">{request.requestedModelSlug}</dd>
              </div>
              <div>
                <dt className="text-xs text-content-muted">Resolved model</dt>
                <dd className="mt-1 font-mono">{request.resolvedModelSlug ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-xs text-content-muted">Queue</dt>
                <dd className="mt-1 font-mono">{request.queueMs} ms</dd>
              </div>
              <div>
                <dt className="text-xs text-content-muted">Cold start</dt>
                <dd className="mt-1 font-mono">{request.coldStartMs} ms</dd>
              </div>
              <div>
                <dt className="text-xs text-content-muted">Time to first token</dt>
                <dd className="mt-1 font-mono">{request.ttftMs ?? "—"} ms</dd>
              </div>
              <div>
                <dt className="text-xs text-content-muted">Generation</dt>
                <dd className="mt-1 font-mono">{request.generationMs} ms</dd>
              </div>
              <div>
                <dt className="text-xs text-content-muted">Finish reason</dt>
                <dd className="mt-1 font-mono">{request.finishReason ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-xs text-content-muted">Error</dt>
                <dd className="mt-1 font-mono text-xs break-words">
                  {request.errorCode
                    ? `${request.errorCode}: ${request.errorMessage ?? ""}`
                    : "—"}
                </dd>
              </div>
            </dl>
          </PanelBody>
        </Panel>

        <Panel>
          <PanelHeader title="Cost breakdown" />
          <PanelBody className="space-y-3 text-sm">
            <div className="flex justify-between">
              <span className="text-content-muted">Prompt tokens</span>
              <span className="font-mono">{request.promptTokens.toLocaleString()}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-content-muted">Completion tokens</span>
              <span className="font-mono">{request.completionTokens.toLocaleString()}</span>
            </div>
            <div className="flex justify-between border-t border-line pt-3">
              <span className="text-content-muted">Exact cost</span>
              <span className="font-mono">
                ${(Number(request.costMicros) / 1_000_000).toFixed(6)}
              </span>
            </div>
            {request.receipt && (
              <Link className="btn-secondary w-full" href={`/usage/receipts/${request.receipt.id}`}>
                Open signed receipt
              </Link>
            )}
          </PanelBody>
        </Panel>
      </div>

      <Panel>
        <PanelHeader title="Attempts" actions={<Badge tone="neutral">{request.attempts.length}</Badge>} />
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Backend</th>
                <th>Model</th>
                <th>Status</th>
                <th className="text-right">Tokens</th>
                <th className="text-right">TTFT</th>
              </tr>
            </thead>
            <tbody>
              {request.attempts.map((attempt) => (
                <tr key={attempt.id}>
                  <td className="font-mono">{attempt.attemptNo}</td>
                  <td className="font-mono text-xs">{attempt.backend}</td>
                  <td>
                    <span className="mono-chip">{attempt.modelSlug}</span>
                  </td>
                  <td>{attempt.status}</td>
                  <td className="text-right font-mono">
                    {(attempt.promptTokens + attempt.completionTokens).toLocaleString()}
                  </td>
                  <td className="text-right font-mono">{attempt.ttftMs ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}
