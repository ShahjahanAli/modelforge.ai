import { prisma } from "@modelforge/db";
import { Cpu, FolderSearch, Info, Plus } from "lucide-react";
import { gatewayFetch } from "@/lib/gateway";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel, PanelBody, PanelHeader } from "@/components/ui/Panel";
import { Badge, StatusBadge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { HuggingFaceBrowser } from "@/components/admin/HuggingFaceBrowser";
import {
  grantModelToAllPlansAction,
  registerDiscoveredAction,
  upsertModelAction,
} from "./actions";

interface DiscoveredWeight {
  relativePath: string;
  fileName: string;
  sizeBytes: number;
  quantization: string;
  suggestedModelId: string;
  suggestedDisplayName: string;
  shardCount: number;
  registeredAs: string | null;
}

interface AvailableResponse {
  weightsDir: string;
  files: DiscoveredWeight[];
  error?: string;
}

const fields = [
  { name: "modelId", label: "Public slug", placeholder: "zms-coder-7b", required: true },
  { name: "displayName", label: "Display name", placeholder: "ZMS Coder 7B", required: true },
  { name: "weightsPath", label: "GGUF path", placeholder: "sub/dir/model.Q4_K_M.gguf", required: true },
  { name: "quantization", label: "Quantization", defaultValue: "Q4_K_M" },
  { name: "contextLength", label: "Context length", type: "number", defaultValue: 8192 },
  { name: "nThreads", label: "Threads", type: "number", defaultValue: 8 },
  { name: "pricePerMTokIn", label: "Price ¢ / M input", type: "number", defaultValue: 20 },
  { name: "pricePerMTokOut", label: "Price ¢ / M output", type: "number", defaultValue: 60 },
];

function formatGb(bytes: number): string {
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(2)} GB`
    : `${Math.round(bytes / 1024 ** 2)} MB`;
}

export default async function AdminModelsPage() {
  const [models, plans, available] = await Promise.all([
    prisma.hostedModel.findMany({ orderBy: { createdAt: "desc" } }),
    prisma.plan.findMany({ select: { allowedModelIds: true } }),
    gatewayFetch("/internal/engine/models/available").catch(
      (error: unknown): AvailableResponse => ({
        weightsDir: "unknown",
        files: [],
        error: error instanceof Error ? error.message : "scan unavailable",
      }),
    ) as Promise<AvailableResponse>,
  ]);

  const entitledSlugs = new Set(plans.flatMap((plan) => plan.allowedModelIds));
  const unregistered = available.files.filter((file) => !file.registeredAs);

  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Model registry"
        description="Register GGUF weights and pricing. Files are discovered under MODEL_WEIGHTS_DIR; registration is what makes a model callable."
        actions={
          <Badge tone={unregistered.length > 0 ? "warn" : "neutral"} dot={unregistered.length > 0}>
            {unregistered.length} unregistered on disk
          </Badge>
        }
      />

      <Panel>
        <PanelHeader
          title="Hugging Face model browser"
          description="Search and download GGUF models directly to this host"
          actions={
            <Badge tone="info" dot>
              GGUF only
            </Badge>
          }
        />
        <PanelBody>
          <HuggingFaceBrowser />
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader
          title="Discovered on disk"
          description={
            available.error ? "Gateway unreachable — cannot scan" : `Scanning ${available.weightsDir}`
          }
          actions={
            <span className="flex items-center gap-1.5 font-mono text-[11px] text-content-muted">
              <FolderSearch className="size-3.5" aria-hidden />
              {available.files.length} GGUF file(s)
            </span>
          }
        />
        {available.error ? (
          <PanelBody>
            <p className="danger-note">
              <Info className="size-4 shrink-0" aria-hidden />
              <span className="break-all">{available.error}</span>
            </p>
          </PanelBody>
        ) : available.files.length === 0 ? (
          <EmptyState
            icon={FolderSearch}
            title="No GGUF files found"
            description={`Copy a .gguf into ${available.weightsDir} (subfolders are scanned) and reload this page.`}
          />
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>File</th>
                  <th>Quant</th>
                  <th className="text-right">Size</th>
                  <th>Suggested slug</th>
                  <th className="text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {available.files.map((file) => (
                  <tr key={file.relativePath}>
                    <td>
                      <div className="font-medium text-content-primary">
                        {file.suggestedDisplayName}
                      </div>
                      <div className="mt-1 font-mono text-[11px] break-all text-content-muted">
                        {file.relativePath}
                        {file.shardCount > 1 && ` (+${file.shardCount - 1} shards)`}
                      </div>
                    </td>
                    <td className="whitespace-nowrap font-mono text-xs">{file.quantization}</td>
                    <td className="whitespace-nowrap text-right font-mono tabular-nums">
                      {formatGb(file.sizeBytes)}
                    </td>
                    <td>
                      {file.registeredAs ? (
                        <span className="mono-chip">{file.registeredAs}</span>
                      ) : (
                        <span className="font-mono text-xs text-content-muted">
                          {file.suggestedModelId}
                        </span>
                      )}
                    </td>
                    <td className="text-right">
                      {file.registeredAs ? (
                        <Badge tone="ok" dot>
                          registered
                        </Badge>
                      ) : (
                        <form action={registerDiscoveredAction} className="inline-flex">
                          <input type="hidden" name="weightsPath" value={file.relativePath} />
                          <input type="hidden" name="modelId" value={file.suggestedModelId} />
                          <input
                            type="hidden"
                            name="displayName"
                            value={file.suggestedDisplayName}
                          />
                          <input type="hidden" name="quantization" value={file.quantization} />
                          <button className="btn text-xs" type="submit">
                            <Plus className="size-3.5" aria-hidden />
                            Register
                          </button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <p className="flex items-start gap-2.5 rounded-lg border border-brand-100 bg-brand-50 px-4 py-3 text-xs leading-relaxed text-content-secondary">
        <Info className="mt-0.5 size-4 shrink-0 text-brand-600" aria-hidden />
        <span>
          CPU sizing guide — <strong className="text-content-primary">7B Q4_K_M</strong> is
          fast/interactive, <strong className="text-content-primary">13B Q4_K_M</strong> is
          moderate, and <strong className="text-content-primary">30B+</strong> should be reserved
          for batch or async workloads. Context length is not read from GGUF metadata, so adjust it
          after registering if the model supports more.
        </span>
      </p>

      <Panel>
        <PanelHeader
          title="Register manually"
          description="Upserts by public slug — use this to override inferred values"
        />
        <PanelBody>
          <form action={upsertModelAction} className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {fields.map((field) => (
              <div key={field.name}>
                <label className="field-label" htmlFor={field.name}>
                  {field.label}
                </label>
                <input
                  id={field.name}
                  className="input"
                  name={field.name}
                  type={field.type ?? "text"}
                  placeholder={field.placeholder}
                  defaultValue={field.defaultValue}
                  required={field.required}
                />
              </div>
            ))}
            <div className="sm:col-span-2 xl:col-span-4">
              <button className="btn w-full sm:w-auto" type="submit">
                Save model
              </button>
            </div>
          </form>
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader title="Registered models" description={`${models.length} total`} />
        {models.length === 0 ? (
          <EmptyState icon={Cpu} title="No models registered yet" />
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Weights</th>
                  <th>Quant / ctx</th>
                  <th className="text-right">Threads</th>
                  <th className="text-right">Pricing ¢/M</th>
                  <th>Status</th>
                  <th>Plan access</th>
                </tr>
              </thead>
              <tbody>
                {models.map((model) => (
                  <tr key={model.id}>
                    <td>
                      <div className="font-medium text-content-primary">{model.displayName}</div>
                      <div className="mt-1">
                        <span className="mono-chip">{model.modelId}</span>
                      </div>
                    </td>
                    <td className="max-w-56 truncate font-mono text-xs">{model.weightsPath}</td>
                    <td className="whitespace-nowrap font-mono text-xs">
                      {model.quantization} · {model.contextLength.toLocaleString()}
                    </td>
                    <td className="text-right font-mono tabular-nums">{model.nThreads}</td>
                    <td className="whitespace-nowrap text-right font-mono tabular-nums text-content-primary">
                      {model.pricePerMTokIn} / {model.pricePerMTokOut}
                    </td>
                    <td>
                      <StatusBadge status={model.status} />
                    </td>
                    <td>
                      {entitledSlugs.has(model.modelId) ? (
                        <Badge tone="ok" dot>
                          on a plan
                        </Badge>
                      ) : (
                        <form action={grantModelToAllPlansAction} className="inline-flex">
                          <input type="hidden" name="modelId" value={model.modelId} />
                          <button className="btn-secondary text-xs" type="submit">
                            Grant to all plans
                          </button>
                        </form>
                      )}
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
