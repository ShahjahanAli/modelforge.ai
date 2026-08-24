import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { prisma } from "@modelforge/db";
import { Boxes, Cpu } from "lucide-react";
import { authOptions } from "@/lib/auth";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { Badge, StatusBadge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";

export default async function ModelsPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user) redirect("/login");
  const customerId = (session.user as { id: string }).id;
  const sub = await prisma.subscription.findUnique({
    where: { customerId },
    include: { plan: true },
  });
  const allowed = sub?.plan.allowedModelIds ?? [];
  const models = await prisma.hostedModel.findMany({
    where: { modelId: { in: allowed } },
    orderBy: { modelId: "asc" },
  });

  return (
    <>
      <PageHeader
        eyebrow="Catalog"
        title="Available models"
        description="CPU-oriented GGUF builds served through llama.cpp. Prefer 3B–13B Q4_K_M quantizations for interactive chat latency."
      />

      {models.length === 0 ? (
        <Panel>
          <EmptyState
            icon={Boxes}
            title="No models on your plan"
            description="Upgrade your plan or ask an administrator to grant access to a hosted model."
          />
        </Panel>
      ) : (
        <div className="grid gap-3 sm:gap-4 md:grid-cols-2 2xl:grid-cols-3">
          {models.map((model) => (
            <article key={model.id} className="panel panel-hover p-4 sm:p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="text-base font-semibold tracking-tight text-content-primary">
                    {model.displayName}
                  </h2>
                  <p className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <span className="mono-chip">{model.modelId}</span>
                    {model.isPlatformDefault ? <Badge tone="info">Platform default</Badge> : null}
                  </p>
                </div>
                <StatusBadge status={model.status} />
              </div>

              <dl className="mt-4 grid grid-cols-3 gap-3 border-y border-line py-3.5 text-xs">
                <div className="min-w-0">
                  <dt className="text-content-muted">Quantization</dt>
                  <dd className="mt-0.5 truncate font-mono text-content-primary">
                    {model.quantization}
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-content-muted">Context</dt>
                  <dd className="mt-0.5 font-mono tabular-nums text-content-primary">
                    {model.contextLength.toLocaleString()}
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-content-muted">Throughput</dt>
                  <dd className="mt-0.5 font-mono tabular-nums text-content-primary">
                    {model.expectedTokPerSec ? `~${model.expectedTokPerSec} t/s` : "—"}
                  </dd>
                </div>
              </dl>

              <div className="mt-3.5 flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="flex items-center gap-1.5 text-content-muted">
                  <Cpu className="size-3.5" aria-hidden />
                  {model.nThreads} threads
                </span>
                <span className="font-mono text-content-secondary">
                  ${(model.pricePerMTokIn / 100).toFixed(2)}/M in · $
                  {(model.pricePerMTokOut / 100).toFixed(2)}/M out
                </span>
              </div>
            </article>
          ))}
        </div>
      )}
    </>
  );
}
