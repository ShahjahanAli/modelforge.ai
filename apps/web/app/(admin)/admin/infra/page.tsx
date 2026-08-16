import { Activity, Cpu, HardDrive, Layers, ServerCog } from "lucide-react";
import { gatewayFetch } from "@/lib/gateway";
import { prisma } from "@modelforge/db";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Badge, StatusBadge } from "@/components/ui/Badge";
import { StatCard, Meter } from "@/components/ui/StatCard";
import { EmptyState } from "@/components/ui/EmptyState";
import { loadModelAction, unloadModelAction } from "./actions";

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

  const catalog = await prisma.hostedModel.findMany({ orderBy: { modelId: "asc" } });
  const residentModels = loaded.models ?? [];
  const residentIds = new Set(residentModels.map((m) => m.model_id));
  const usedRam = health.used_ram_mb ?? 0;
  const totalRam = health.total_ram_mb ?? 0;

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
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Model</th>
                  <th className="text-right">Threads</th>
                  <th>Registry status</th>
                  <th>Pool</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {catalog.map((model) => (
                  <tr key={model.id}>
                    <td>
                      <div className="font-medium text-content-primary">{model.displayName}</div>
                      <div className="mt-1">
                        <span className="mono-chip">{model.modelId}</span>
                      </div>
                    </td>
                    <td className="text-right font-mono tabular-nums">{model.nThreads}</td>
                    <td>
                      <StatusBadge status={model.status} />
                    </td>
                    <td>
                      <Badge
                        tone={residentIds.has(model.modelId) ? "ok" : "neutral"}
                        dot
                        pulse={residentIds.has(model.modelId)}
                      >
                        {residentIds.has(model.modelId) ? "resident" : "cold"}
                      </Badge>
                    </td>
                    <td>
                      <div className="flex items-center justify-end gap-2">
                        <form action={loadModelAction}>
                          <input type="hidden" name="modelId" value={model.modelId} />
                          <button className="btn text-xs" type="submit">
                            Load
                          </button>
                        </form>
                        <form action={unloadModelAction}>
                          <input type="hidden" name="modelId" value={model.modelId} />
                          <button className="btn-secondary text-xs" type="submit">
                            Unload
                          </button>
                        </form>
                      </div>
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
