import Link from "next/link";
import { prisma } from "@modelforge/db";
import { ShieldCheck } from "lucide-react";
import { requireSession } from "@/lib/session";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { EmptyState } from "@/components/ui/EmptyState";
import { Badge } from "@/components/ui/Badge";

export const dynamic = "force-dynamic";

export default async function ReceiptsPage() {
  const user = await requireSession();
  const receipts = await prisma.usageReceipt.findMany({
    where: user.role === "ADMIN" ? {} : { request: { customerId: user.id } },
    include: { request: true },
    orderBy: { issuedAt: "desc" },
    take: 100,
  });

  return (
    <>
      <PageHeader
        eyebrow="Trust"
        title="Usage receipts"
        description="Ed25519-signed immutable proof of tokens, cost, and model resolution."
        actions={
          <Link className="btn-secondary" href="/verify-receipt">
            Verify receipt
          </Link>
        }
      />
      <Panel>
        <PanelHeader title="Issued receipts" actions={<Badge tone="neutral">{receipts.length}</Badge>} />
        {receipts.length === 0 ? (
          <EmptyState
            icon={ShieldCheck}
            title="No receipts yet"
            description="Receipts are issued after durable usage persistence."
          />
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Issued</th>
                  <th>Key</th>
                  <th>Model</th>
                  <th className="text-right">Hash</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {receipts.map((receipt) => (
                  <tr key={receipt.id}>
                    <td className="font-mono text-xs">
                      {receipt.issuedAt.toISOString().replace("T", " ").slice(0, 19)}
                    </td>
                    <td className="font-mono text-xs">{receipt.signingKeyId}</td>
                    <td>
                      <span className="mono-chip">
                        {receipt.request?.resolvedModelSlug ??
                          receipt.request?.requestedModelSlug ??
                          "—"}
                      </span>
                    </td>
                    <td className="max-w-40 truncate text-right font-mono text-xs">
                      {receipt.payloadHash.slice(0, 16)}…
                    </td>
                    <td className="text-right">
                      <Link className="btn-ghost text-xs" href={`/usage/receipts/${receipt.id}`}>
                        Open
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
