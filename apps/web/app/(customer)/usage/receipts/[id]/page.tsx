import { notFound } from "next/navigation";
import { prisma } from "@modelforge/db";
import { assertOwnership, requireSession } from "@/lib/session";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel, PanelBody, PanelHeader } from "@/components/ui/Panel";
import { Badge } from "@/components/ui/Badge";

export const dynamic = "force-dynamic";

export default async function ReceiptDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await requireSession();
  const receipt = await prisma.usageReceipt.findUnique({
    where: { id },
    include: { request: true },
  });
  if (!receipt) notFound();
  if (receipt.request) assertOwnership(receipt.request.customerId, user);

  return (
    <>
      <PageHeader
        eyebrow="Signed receipt"
        title={receipt.id}
        description="Canonical payload and detached Ed25519 signature."
        actions={<Badge tone="ok">{receipt.algorithm}</Badge>}
      />
      <div className="grid gap-4 xl:grid-cols-2">
        <Panel>
          <PanelHeader title="Signature" />
          <PanelBody className="space-y-3 text-sm">
            <div>
              <div className="text-xs text-content-muted">Key ID</div>
              <div className="mt-1 font-mono text-xs break-all">{receipt.signingKeyId}</div>
            </div>
            <div>
              <div className="text-xs text-content-muted">Payload hash</div>
              <div className="mt-1 font-mono text-xs break-all">{receipt.payloadHash}</div>
            </div>
            <div>
              <div className="text-xs text-content-muted">Signature</div>
              <div className="mt-1 font-mono text-xs break-all">{receipt.signature}</div>
            </div>
          </PanelBody>
        </Panel>
        <Panel>
          <PanelHeader title="Canonical payload" />
          <PanelBody>
            <pre className="overflow-x-auto rounded-lg border border-line bg-surface-2 p-3 font-mono text-[11px] leading-relaxed">
              {receipt.payloadCanonical}
            </pre>
          </PanelBody>
        </Panel>
      </div>
    </>
  );
}
