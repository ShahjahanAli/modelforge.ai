import { Activity, Cpu, HardDrive, Layers, ServerCog } from "lucide-react";
import { gatewayFetch } from "@/lib/gateway";
import { prisma } from "@modelforge/db";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Badge } from "@/components/ui/Badge";
import { StatCard, Meter } from "@/components/ui/StatCard";
import { EmptyState } from "@/components/ui/EmptyState";
import { ModelPoolControls, type CatalogModel } from "@/components/admin/ModelPoolControls";

interface EngineHealth {
  healthy?: boolean;
  backend?: string;
  total_ram_mb?: number;
  used_ram_mb?: number;
  loaded_model_count?: number;
  physical_core_count?: number;
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

interface AvailableWeights {
  files?: Array<{ relativePath: string; sizeBytes: number }>;
}

export default async function AdminInfraPage() {
  const health: EngineHealth = await gatewayFetch("/internal/engine/health").catch(
    (error: unknown) => ({
      healthy: false,
      error: error instanceof Error ? error.message : "unreachable",
    }),
  );
  const loaded: EngineModels = await gatewayFetch("/internal/engine/models").catch(() => ({
    models: [],
  }));
  // Weight file sizes let the client pace its load progress bar per model.
  const available: AvailableWeights = await gatewayFetch(
    "/internal/engine/models/available",
  ).catch(() => ({ files: [] }));

  const catalog = await prisma.hostedModel.findMany({ orderBy: { modelId: "asc" } });
  const residentModels = loaded.models ?? [];
  const usedRam = health.used_ram_mb ?? 0;
  const totalRam = health.total_ram_mb ?? 0;

  const sizeByPath = new Map((available.files ?? []).map((file) => [file.relativePath, file.sizeBytes]));
  const catalogModels: CatalogModel[] = catalog.map((model) => ({
    modelId: model.modelId,
    displayName: model.displayName,
    nThreads: model.nThreads,
    contextLength: model.contextLength,
    status: model.status,
    quantization: model.quantization,
    sizeBytes: sizeByPath.get(model.weightsPath) ?? null,
  }));

  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Inference infrastructure"
        description="Live view of the active inference backend, model pool, RAM budget, and per-model throughput."
        actions={
          <Badge tone={health.healthy ? "ok" : "danger"} dot pulse={health.healthy}>
            {health.healthy ? "engine healthy" : "engine down"}
          </Badge>
        }
      />

      {health.error && (
        <p className="rounded-lg border border-danger-200 bg-danger-50 px-4 py-3 font-mono text-xs break-words text-danger-700">
          {health.error}
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2 sm:gap-4 xl:grid-cols-4">
        <StatCard
          label="Engine status"
          value={health.healthy ? "ONLINE" : "OFFLINE"}
          icon={ServerCog}
          accent={health.healthy ? "ok" : "danger"}
          hint={health.backend ?? "backend unavailable"}
        />
        <StatCard
          label="RAM budget"
          value={usedRam.toLocaleString()}
          unit={`/ ${totalRam ? totalRam.toLocaleString() : "—"} MB`}
          icon={HardDrive}
          accent="brand"
        >
          {totalRam > 0 && <Meter value={usedRam} max={totalRam} />}
        </StatCard>
        <StatCard
          label="Resident models"
          value={health.loaded_model_count ?? 0}
          icon={Layers}
          accent="signal"
          hint={`${catalog.length} in catalog`}
        />
        <StatCard
          label="Physical cores"
          value={health.physical_core_count ?? "—"}
          icon={Cpu}
          accent="warn"
          hint="thread budget per model"
        />
      </div>

      <Panel>
        <PanelHeader
          title="Resident in model pool"
          description="mmap-backed weights currently held in RAM"
          actions={<Badge tone="neutral">{residentModels.length} loaded</Badge>}
        />
        {residentModels.length === 0 ? (
          <EmptyState
            icon={Layers}
            title="No models resident"
            description="Load a model from the catalog below to warm the pool."
          />
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Model</th>
                  <th className="text-right">RAM</th>
                  <th className="text-right">Active requests</th>
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
                    <td className="text-right">
                      <span
                        className={`font-mono tabular-nums ${
                          model.active_requests > 0 ? "text-ok-600" : "text-content-muted"
                        }`}
                      >
                        {model.active_requests}
                      </span>
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

      <Panel>
        <PanelHeader
          title="Catalog controls"
          description="Warm or evict weights without restarting the engine"
          actions={<Activity className="size-4 text-content-muted" aria-hidden />}
        />
        {catalog.length === 0 ? (
          <EmptyState
            icon={Cpu}
            title="Catalog is empty"
            description="Register a GGUF model in the model registry first."
          />
        ) : (
          <ModelPoolControls
            models={catalogModels}
            initialResident={residentModels.map((model) => ({
              modelId: model.model_id,
              ramUsedMb: model.ram_used_mb,
              activeRequests: model.active_requests,
            }))}
          />
        )}
      </Panel>
    </>
  );
}
