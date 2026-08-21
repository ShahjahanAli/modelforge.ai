import { Activity, AudioLines, Cpu, HardDrive, Layers, ServerCog, Users } from "lucide-react";
import { gatewayFetch } from "@/lib/gateway";
import { prisma } from "@modelforge/db";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Badge } from "@/components/ui/Badge";
import { StatCard, Meter } from "@/components/ui/StatCard";
import { EmptyState } from "@/components/ui/EmptyState";
import { ModelPoolControls, type CatalogModel } from "@/components/admin/ModelPoolControls";
import { VoiceSttControls, type VoiceModelRow } from "@/components/admin/VoiceSttControls";

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
  files?: Array<{ relativePath: string; sizeBytes: number; registeredAs?: string | null }>;
}

interface VoiceStatus {
  enabled?: boolean;
  provider?: string;
  language?: string;
  configuredModel?: string;
  envModel?: string;
  envProvider?: string;
  device?: string;
  computeType?: string;
  modelCached?: boolean;
  models?: VoiceModelRow[];
  providers?: Array<{ id: "faster-whisper" | "nemo"; label: string; available: boolean }>;
  activeInstall?: {
    id: string;
    provider?: string;
    model: string;
    status: string;
    message: string | null;
  } | null;
  uploadDir?: string;
  scriptPath?: string;
  scriptExists?: boolean;
  pythonBin?: string;
  pythonAvailable?: boolean;
  pythonVersion?: string | null;
  fasterWhisperAvailable?: boolean;
  nemoAvailable?: boolean;
  diarization?: {
    enabled?: boolean;
    provider?: string;
    model?: string;
    device?: string;
    available?: boolean;
    scriptExists?: boolean;
    hfTokenConfigured?: boolean;
    error?: string;
  };
  ready?: boolean;
  error?: string;
}

export default async function AdminInfraPage() {
  const health: EngineHealth = await gatewayFetch("/internal/engine/health").catch(
    (error: unknown) => ({
      healthy: false,
      error: error instanceof Error ? error.message : "unreachable",
    }),
  );
  const loaded: EngineModels = await gatewayFetch("/internal/engine/models").catch(() => ({ models: [] }));
  // Weight file sizes let the client pace its load progress bar per model.
  const available: AvailableWeights = await gatewayFetch(
    "/internal/engine/models/available",
  ).catch(() => ({ files: [] }));
  const voice: VoiceStatus = await gatewayFetch("/internal/voice/status").catch((error: unknown) => ({
    ready: false,
    enabled: false,
    error: error instanceof Error ? error.message : "unreachable",
  }));

  const catalog = await prisma.hostedModel.findMany({ orderBy: { modelId: "asc" } });
  const residentModels = loaded.models ?? [];
  const usedRam = health.used_ram_mb ?? 0;
  const totalRam = health.total_ram_mb ?? 0;

  const sizeByPath = new Map((available.files ?? []).map((file) => [file.relativePath, file.sizeBytes]));
  const sizeByModelId = new Map(
    (available.files ?? [])
      .filter(
        (file): file is typeof file & { registeredAs: string } =>
          typeof file.registeredAs === "string",
      )
      .map((file) => [file.registeredAs, file.sizeBytes]),
  );
  const catalogModels: CatalogModel[] = catalog.map((model) => ({
    modelId: model.modelId,
    displayName: model.displayName,
    nThreads: model.nThreads,
    contextLength: model.contextLength,
    status: model.status,
    quantization: model.quantization,
    sizeBytes: sizeByModelId.get(model.modelId) ?? sizeByPath.get(model.weightsPath) ?? null,
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
          title="Voice STT status"
          description="Upload STT (Whisper / NeMo) with optional pyannote speaker diarization"
          actions={
            <Badge tone={voice.ready ? "ok" : voice.enabled ? "warn" : "neutral"} dot pulse={voice.ready}>
              {voice.ready ? "ready" : voice.enabled ? "needs attention" : "disabled"}
            </Badge>
          }
        />
        <div className="grid gap-3 p-4 sm:grid-cols-2 sm:p-5 xl:grid-cols-5">
          <StatCard
            label="Voice pipeline"
            value={voice.enabled ? "ENABLED" : "DISABLED"}
            icon={AudioLines}
            accent={voice.ready ? "ok" : voice.enabled ? "warn" : "danger"}
            hint={voice.provider ?? "faster-whisper"}
          />
          <StatCard
            label="Configured model"
            value={voice.configuredModel ?? "—"}
            icon={Layers}
            accent={voice.modelCached ? "brand" : "warn"}
            hint={
              voice.modelCached
                ? `language ${voice.language ?? "auto"} · cached`
                : `language ${voice.language ?? "auto"} · not downloaded`
            }
          />
          <StatCard
            label="Python runtime"
            value={voice.pythonAvailable ? "AVAILABLE" : "MISSING"}
            icon={Cpu}
            accent={voice.pythonAvailable ? "ok" : "danger"}
            hint={voice.pythonVersion ?? voice.pythonBin ?? "python3"}
          />
          <StatCard
            label="STT packages"
            value={
              voice.provider === "nemo"
                ? voice.nemoAvailable
                  ? "NEMO OK"
                  : "NEMO MISSING"
                : voice.fasterWhisperAvailable
                  ? "WHISPER OK"
                  : "WHISPER MISSING"
            }
            icon={ServerCog}
            accent={
              (voice.provider === "nemo" ? voice.nemoAvailable : voice.fasterWhisperAvailable)
                ? "ok"
                : "danger"
            }
            hint={
              voice.scriptExists
                ? `fw=${voice.fasterWhisperAvailable ? "yes" : "no"} · nemo=${voice.nemoAvailable ? "yes" : "no"}`
                : "script missing"
            }
          />
          <StatCard
            label="Diarization"
            value={
              !voice.diarization?.enabled
                ? "OFF"
                : voice.diarization.available
                  ? "PYANNOTE ON"
                  : "NOT READY"
            }
            icon={Users}
            accent={
              !voice.diarization?.enabled
                ? "brand"
                : voice.diarization.available
                  ? "ok"
                  : "warn"
            }
            hint={
              voice.diarization?.enabled
                ? `${voice.diarization.model ?? "pyannote"} · ${
                    voice.diarization.hfTokenConfigured ? "HF_TOKEN ok" : "HF_TOKEN missing"
                  }`
                : "set DIARIZATION_ENABLED=true"
            }
          />
        </div>
        <VoiceSttControls
          models={voice.models ?? []}
          providers={voice.providers ?? []}
          activeProvider={voice.provider === "nemo" ? "nemo" : "faster-whisper"}
          activeModel={voice.configuredModel ?? "small"}
          envModel={voice.envModel ?? voice.configuredModel ?? "small"}
          envProvider={voice.envProvider === "nemo" ? "nemo" : "faster-whisper"}
          device={voice.device ?? "cpu"}
          computeType={voice.computeType ?? "int8"}
          modelCached={Boolean(voice.modelCached)}
          initialJobId={
            voice.activeInstall &&
            (voice.activeInstall.status === "queued" || voice.activeInstall.status === "downloading")
              ? voice.activeInstall.id
              : null
          }
        />
        <div className="grid gap-2 border-t border-line px-4 py-3 text-xs text-content-muted sm:grid-cols-2 sm:px-5">
          <p>
            <strong className="text-content-primary">Upload dir:</strong> {voice.uploadDir ?? "—"}
          </p>
          <p>
            <strong className="text-content-primary">Script:</strong> {voice.scriptPath ?? "—"}
          </p>
          <p>
            <strong className="text-content-primary">Diarization:</strong>{" "}
            {voice.diarization?.enabled
              ? voice.diarization.available
                ? `ON · ${voice.diarization.model ?? "pyannote"}`
                : "ON · not ready"
              : "OFF"}
            {voice.diarization?.hfTokenConfigured === false
              ? " · HF_TOKEN missing"
              : voice.diarization?.enabled
                ? " · HF_TOKEN ok"
                : ""}
          </p>
          <p className="sm:col-span-2">
            <strong className="text-content-primary">Python bin:</strong>{" "}
            <span className="font-mono break-all">{voice.pythonBin ?? "—"}</span>
            {voice.pythonVersion ? ` · ${voice.pythonVersion}` : ""}
          </p>
          {voice.diarization?.error && (
            <p className="sm:col-span-2 rounded-lg border border-warn-200 bg-warn-50 px-3 py-2 text-warn-700">
              Diarization: {voice.diarization.error}
            </p>
          )}
          {voice.error && (
            <p className="sm:col-span-2 rounded-lg border border-danger-200 bg-danger-50 px-3 py-2 text-danger-700">
              {voice.error}
            </p>
          )}
        </div>
      </Panel>

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
