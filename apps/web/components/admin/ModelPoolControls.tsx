"use client";

import { Loader2, Play, PowerOff } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Badge, StatusBadge } from "@/components/ui/Badge";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";
import { loadModelAction, unloadModelAction } from "@/app/(admin)/admin/infra/actions";

export interface CatalogModel {
  modelId: string;
  displayName: string;
  nThreads: number;
  contextLength: number;
  status: string;
  quantization: string;
  sizeBytes: number | null;
  isPlatformDefault: boolean;
}

interface ResidentModel {
  modelId: string;
  ramUsedMb: number;
  activeRequests: number;
}

type JobKind = "load" | "unload";

interface Job {
  kind: JobKind;
  percent: number;
  elapsedMs: number;
  /** Rough completion estimate used to pace the bar; not a hard timeout. */
  estimateMs: number;
  done: boolean;
}

const TICK_MS = 120;
const POLL_IDLE_MS = 8000;
const POLL_ACTIVE_MS = 2000;

/** Phase copy mirrors what the engine actually does during a cold start. */
const LOAD_PHASES: Array<{ upTo: number; label: string }> = [
  { upTo: 12, label: "Reserving RAM budget" },
  { upTo: 34, label: "Spawning runtime process" },
  { upTo: 82, label: "Mapping weights (mmap)" },
  { upTo: 99, label: "Warming context window" },
  { upTo: 100, label: "Resident and ready" },
];

const UNLOAD_PHASES: Array<{ upTo: number; label: string }> = [
  { upTo: 45, label: "Draining active requests" },
  { upTo: 90, label: "Releasing mapped pages" },
  { upTo: 100, label: "Slot freed" },
];

function phaseLabel(job: Job): string {
  const phases = job.kind === "load" ? LOAD_PHASES : UNLOAD_PHASES;
  return phases.find((phase) => job.percent <= phase.upTo)?.label ?? phases[phases.length - 1]!.label;
}

function formatSize(sizeBytes: number | null): string | null {
  if (!sizeBytes) return null;
  const gb = sizeBytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(sizeBytes / 1024 ** 2)} MB`;
}

/** Bigger GGUFs take longer to map and warm; keeps the bar honest-ish. */
function loadEstimateMs(sizeBytes: number | null): number {
  const gb = (sizeBytes ?? 2 * 1024 ** 3) / 1024 ** 3;
  return Math.round(4000 + gb * 2600);
}

export function ModelPoolControls({
  models,
  initialResident,
}: {
  models: CatalogModel[];
  initialResident: ResidentModel[];
}) {
  const router = useRouter();
  const toast = useToast();
  const [resident, setResident] = useState<ResidentModel[]>(initialResident);
  const [jobs, setJobs] = useState<Record<string, Job>>({});
  const [pendingUnload, setPendingUnload] = useState<CatalogModel | null>(null);
  const activeJobs = Object.keys(jobs).length > 0;

  const residentById = new Map(resident.map((entry) => [entry.modelId, entry]));

  const poll = useCallback(async () => {
    try {
      const response = await fetch("/api/admin/engine", { cache: "no-store" });
      if (!response.ok) return;
      const body = (await response.json()) as { resident?: ResidentModel[] };
      setResident(body.resident ?? []);
    } catch {
      // Transient poll failures are not worth interrupting the operator.
    }
  }, []);

  useEffect(() => {
    const handle = window.setInterval(
      () => void poll(),
      activeJobs ? POLL_ACTIVE_MS : POLL_IDLE_MS,
    );
    return () => window.clearInterval(handle);
  }, [poll, activeJobs]);

  // Paces every in-flight bar. Elapsed time is accumulated from ticks so the
  // component never reads a clock during render.
  useEffect(() => {
    if (!activeJobs) return;
    const handle = window.setInterval(() => {
      setJobs((current) => {
        let changed = false;
        const next: Record<string, Job> = {};
        for (const [modelId, job] of Object.entries(current)) {
          if (job.done) {
            next[modelId] = job;
            continue;
          }
          const elapsedMs = job.elapsedMs + TICK_MS;
          // Asymptotic easing: always moving, never claims completion early.
          const ceiling = job.kind === "load" ? 96 : 88;
          const percent = ceiling * (1 - Math.exp((-2.2 * elapsedMs) / job.estimateMs));
          next[modelId] = { ...job, elapsedMs, percent };
          changed = true;
        }
        return changed ? next : current;
      });
    }, TICK_MS);
    return () => window.clearInterval(handle);
  }, [activeJobs]);

  const finishJob = useCallback((modelId: string) => {
    setJobs((current) => {
      const job = current[modelId];
      if (!job) return current;
      return { ...current, [modelId]: { ...job, percent: 100, done: true } };
    });
    window.setTimeout(() => {
      setJobs((current) => {
        const { [modelId]: _removed, ...rest } = current;
        return rest;
      });
    }, 700);
  }, []);

  const clearJob = useCallback((modelId: string) => {
    setJobs((current) => {
      const { [modelId]: _removed, ...rest } = current;
      return rest;
    });
  }, []);

  async function runLoad(model: CatalogModel) {
    if (jobs[model.modelId]) return;
    const size = formatSize(model.sizeBytes);
    setJobs((current) => ({
      ...current,
      [model.modelId]: {
        kind: "load",
        percent: 0,
        elapsedMs: 0,
        estimateMs: loadEstimateMs(model.sizeBytes),
        done: false,
      },
    }));
    const toastId = toast.push({
      tone: "pending",
      title: `Loading ${model.displayName}`,
      description: size
        ? `Mapping ${size} of ${model.quantization} weights into the pool`
        : "Mapping weights into the pool",
      duration: 0,
    });

    const result = await loadModelAction(model.modelId);
    const seconds = (result.elapsedMs / 1000).toFixed(1);

    if (result.ok) {
      finishJob(model.modelId);
      toast.update(toastId, {
        tone: "ok",
        title: `${model.displayName} is resident`,
        description: `Ready in ${seconds}s${
          result.ramUsedMb ? ` · ${result.ramUsedMb.toLocaleString()} MB RAM` : ""
        }`,
        duration: 6000,
      });
    } else {
      clearJob(model.modelId);
      toast.update(toastId, {
        tone: "danger",
        title: `Could not load ${model.displayName}`,
        description: result.message,
        duration: 0,
      });
    }

    await poll();
    router.refresh();
  }

  async function runUnload(model: CatalogModel) {
    setPendingUnload(null);
    if (jobs[model.modelId]) return;
    setJobs((current) => ({
      ...current,
      [model.modelId]: {
        kind: "unload",
        percent: 0,
        elapsedMs: 0,
        estimateMs: 2500,
        done: false,
      },
    }));
    const toastId = toast.push({
      tone: "pending",
      title: `Ejecting ${model.displayName}`,
      description: "Stopping the runtime process and freeing mapped pages",
      duration: 0,
    });

    const result = await unloadModelAction(model.modelId);

    if (result.ok) {
      finishJob(model.modelId);
      toast.update(toastId, {
        tone: "ok",
        title: `${model.displayName} ejected`,
        description: "RAM released. The next request will trigger a cold start.",
        duration: 6000,
      });
    } else {
      clearJob(model.modelId);
      toast.update(toastId, {
        tone: "danger",
        title: `Could not eject ${model.displayName}`,
        description: result.message,
        duration: 0,
      });
    }

    await poll();
    router.refresh();
  }

  return (
    <>
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
            {models.map((model) => {
              const job = jobs[model.modelId];
              const live = residentById.get(model.modelId);
              const isResident = Boolean(live);
              // Pool residency is the operational source of truth. Reconciliation
              // persists this too, but never show a stale LOADED badge between polls.
              const effectiveStatus =
                isResident ? "LOADED" : model.status === "LOADED" ? "INACTIVE" : model.status;
              const size = formatSize(model.sizeBytes);

              return (
                <tr key={model.modelId}>
                  <td>
                    <div className="font-medium text-content-primary">{model.displayName}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      <span className="mono-chip">{model.modelId}</span>
                      {model.isPlatformDefault ? <Badge tone="info">Platform default</Badge> : null}
                      {size && <span className="text-[11px] text-content-muted">{size}</span>}
                    </div>
                  </td>
                  <td className="w-20 text-right align-top font-mono tabular-nums">
                    {model.nThreads}
                  </td>
                  <td>
                    <StatusBadge status={effectiveStatus} />
                  </td>
                  <td>
                    <Badge tone={isResident ? "ok" : "neutral"} dot pulse={isResident}>
                      {isResident ? "resident" : "cold"}
                    </Badge>
                    {live && live.activeRequests > 0 && (
                      <span className="ml-2 font-mono text-[11px] text-ok-600">
                        {live.activeRequests} active
                      </span>
                    )}
                  </td>
                  <td>
                    {job ? (
                      <ProgressCell job={job} />
                    ) : (
                      <div className="flex items-center justify-end gap-2">
                        <button
                          className="btn text-xs"
                          type="button"
                          onClick={() => void runLoad(model)}
                          disabled={isResident}
                          title={isResident ? "Already resident in the pool" : "Warm this model"}
                        >
                          <Play className="size-3.5" aria-hidden />
                          Load
                        </button>
                        <button
                          className="btn-secondary text-xs"
                          type="button"
                          onClick={() => setPendingUnload(model)}
                          disabled={!isResident}
                          title={isResident ? "Evict weights from RAM" : "Not resident"}
                        >
                          <PowerOff className="size-3.5" aria-hidden />
                          Eject
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <ConfirmDialog
        open={pendingUnload !== null}
        title={`Eject ${pendingUnload?.displayName ?? "model"}?`}
        description="This stops the model's runtime process and frees its RAM. In-flight requests on this model will fail, and the next request pays a full cold start."
        confirmLabel="Eject model"
        onCancel={() => setPendingUnload(null)}
        onConfirm={() => pendingUnload && void runUnload(pendingUnload)}
        details={
          pendingUnload && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              <dt className="text-content-muted">Model</dt>
              <dd className="font-mono">{pendingUnload.modelId}</dd>
              <dt className="text-content-muted">Resident RAM</dt>
              <dd className="font-mono">
                {residentById.get(pendingUnload.modelId)?.ramUsedMb.toLocaleString() ?? "—"} MB
              </dd>
              <dt className="text-content-muted">Active requests</dt>
              <dd className="font-mono">
                {residentById.get(pendingUnload.modelId)?.activeRequests ?? 0}
              </dd>
            </dl>
          )
        }
      />
    </>
  );
}

function ProgressCell({ job }: { job: Job }) {
  const percent = Math.min(100, Math.round(job.percent));
  const seconds = (job.elapsedMs / 1000).toFixed(1);
  const tone = job.done ? "bg-ok-500" : job.kind === "load" ? "bg-brand-600" : "bg-warn-500";

  return (
    <div className="ml-auto w-56 max-w-full">
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 text-[11px] font-medium text-content-secondary">
          {!job.done && <Loader2 className="size-3 shrink-0 animate-spin text-brand-600" aria-hidden />}
          <span className="truncate">{phaseLabel(job)}</span>
        </span>
        <span className="font-mono text-[11px] tabular-nums text-content-muted">{percent}%</span>
      </div>
      <div
        className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-3"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${job.kind === "load" ? "Loading" : "Ejecting"} model`}
      >
        <div
          className={`h-full rounded-full transition-[width] duration-150 ease-out ${tone}`}
          style={{ width: `${Math.max(percent, 3)}%` }}
        >
          {!job.done && <div className="h-full w-full progress-stripes" />}
        </div>
      </div>
      <p className="mt-1 text-right font-mono text-[10px] text-content-muted">{seconds}s elapsed</p>
    </div>
  );
}
