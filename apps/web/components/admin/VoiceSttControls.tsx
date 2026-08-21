"use client";

import { Download, Loader2, Power } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  activateWhisperModelAction,
  getWhisperInstallJobAction,
  installWhisperModelAction,
} from "@/app/(admin)/admin/infra/actions";
import { Badge } from "@/components/ui/Badge";
import { useToast } from "@/components/ui/Toast";

export interface VoiceModelRow {
  id: string;
  label: string;
  approxDownloadGb: number;
  cached: boolean;
  active: boolean;
  license?: string;
}

export interface VoiceProviderRow {
  id: "faster-whisper" | "nemo";
  label: string;
  available: boolean;
}

const WHISPER_FALLBACK: VoiceModelRow[] = [
  { id: "tiny", label: "tiny", approxDownloadGb: 0.08, cached: false, active: false },
  { id: "base", label: "base", approxDownloadGb: 0.15, cached: false, active: false },
  { id: "small", label: "small", approxDownloadGb: 0.5, cached: false, active: false },
  { id: "medium", label: "medium", approxDownloadGb: 1.5, cached: false, active: false },
  { id: "large-v2", label: "large-v2", approxDownloadGb: 3.0, cached: false, active: false },
  { id: "large-v3", label: "large-v3", approxDownloadGb: 3.0, cached: false, active: false },
  {
    id: "distil-large-v3",
    label: "distil-large-v3",
    approxDownloadGb: 1.5,
    cached: false,
    active: false,
  },
];

const NEMO_FALLBACK: VoiceModelRow[] = [
  {
    id: "kazalbrur/bangla-stt-conformer-120m-dialects",
    label: "Bhatiyali (Bangla dialects 120M)",
    approxDownloadGb: 0.5,
    cached: false,
    active: false,
    license: "CC-BY-NC-4.0",
  },
];

export function VoiceSttControls({
  models,
  providers,
  activeProvider,
  activeModel,
  envModel,
  envProvider,
  device,
  computeType,
  modelCached,
  initialJobId,
}: {
  models: VoiceModelRow[];
  providers: VoiceProviderRow[];
  activeProvider: "faster-whisper" | "nemo";
  activeModel: string;
  envModel: string;
  envProvider: string;
  device: string;
  computeType: string;
  modelCached: boolean;
  initialJobId?: string | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const [provider, setProvider] = useState<"faster-whisper" | "nemo">(activeProvider);
  const [selected, setSelected] = useState(activeModel);
  const [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState<string | null>(initialJobId ?? null);
  const [jobMessage, setJobMessage] = useState<string | null>(null);

  useEffect(() => {
    setProvider(activeProvider);
    setSelected(activeModel);
  }, [activeProvider, activeModel]);

  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const job = await getWhisperInstallJobAction(jobId);
        if (cancelled) return;
        setJobMessage(job.message ?? job.error);
        if (job.status === "succeeded" || job.status === "failed") {
          setBusy(false);
          setJobId(null);
          toast.push({
            tone: job.status === "succeeded" ? "ok" : "danger",
            title: job.status === "succeeded" ? "STT model ready" : "Install failed",
            description: job.message ?? job.error ?? job.model,
          });
          router.refresh();
          return;
        }
      } catch {
        // Keep polling while the gateway job is still running.
      }
      if (!cancelled) window.setTimeout(() => void tick(), 2500);
    };
    setBusy(true);
    void tick();
    return () => {
      cancelled = true;
    };
  }, [jobId, router, toast]);

  const options = useMemo(() => {
    if (provider === activeProvider && models.length > 0) return models;
    return provider === "nemo" ? NEMO_FALLBACK : WHISPER_FALLBACK;
  }, [activeProvider, models, provider]);

  useEffect(() => {
    if (!options.some((row) => row.id === selected)) {
      setSelected(options[0]?.id ?? "");
    }
  }, [options, selected]);

  const selectedRow = options.find((row) => row.id === selected);
  const providerMeta = providers.find((row) => row.id === provider);

  async function install() {
    setBusy(true);
    const result = await installWhisperModelAction({
      provider,
      model: selected,
      activateOnSuccess: true,
    });
    if (!result.ok) {
      setBusy(false);
      toast.push({ tone: "danger", title: "Could not start install", description: result.message });
      return;
    }
    setJobId(result.jobId ?? null);
    setJobMessage(result.message);
    toast.push({
      tone: "ok",
      title: "Download started",
      description: `${selected} (~${selectedRow?.approxDownloadGb ?? "?"} GB). Keep this page open.`,
    });
  }

  async function activateOnly() {
    setBusy(true);
    const result = await activateWhisperModelAction({ provider, model: selected });
    setBusy(false);
    toast.push({
      tone: result.ok ? "ok" : "danger",
      title: result.ok ? "STT activated" : "Activate failed",
      description: result.message,
    });
    if (result.ok) router.refresh();
  }

  return (
    <div className="space-y-3 border-t border-line px-4 py-4 sm:px-5">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium text-content-primary">Speech-to-text model</h3>
        <Badge tone={modelCached ? "ok" : "warn"} dot>
          {modelCached ? "weights cached" : "weights missing"}
        </Badge>
        <Badge tone="neutral">
          {device}/{computeType}
        </Badge>
        {selectedRow?.license ? <Badge tone="warn">{selectedRow.license}</Badge> : null}
      </div>
      <p className="text-xs text-content-muted">
        Active:{" "}
        <span className="font-mono text-content-primary">
          {activeProvider}:{activeModel}
        </span>
        {envProvider !== activeProvider || envModel !== activeModel ? (
          <>
            {" "}
            (env <span className="font-mono">{envProvider}:{envModel}</span>)
          </>
        ) : null}
        . NeMo Bhatiyali is tuned for Bangladeshi dialects; Whisper remains best for multilingual.
      </p>

      <div className="flex flex-col gap-2 lg:flex-row lg:items-end">
        <label className="flex min-w-[10rem] flex-col gap-1 text-xs text-content-secondary">
          Provider
          <select
            className="input"
            value={provider}
            disabled={busy}
            onChange={(e) => setProvider(e.target.value as "faster-whisper" | "nemo")}
          >
            {(providers.length
              ? providers
              : [
                  { id: "faster-whisper" as const, label: "Faster-Whisper", available: true },
                  { id: "nemo" as const, label: "NeMo (Bangla)", available: false },
                ]
            ).map((row) => (
              <option key={row.id} value={row.id}>
                {row.label}
                {row.available ? "" : " (package missing)"}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-[14rem] flex-1 flex-col gap-1 text-xs text-content-secondary">
          Model
          <select
            className="input"
            value={selected}
            disabled={busy}
            onChange={(e) => setSelected(e.target.value)}
          >
            {options.map((row) => (
              <option key={row.id} value={row.id}>
                {row.label}
                {row.cached ? " (cached)" : ` (~${row.approxDownloadGb} GB)`}
                {row.active ? " — active" : ""}
              </option>
            ))}
          </select>
        </label>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn-primary"
            disabled={busy || (provider === "nemo" && providerMeta && !providerMeta.available)}
            onClick={() => void install()}
            title={
              provider === "nemo" && providerMeta && !providerMeta.available
                ? "pip install 'nemo_toolkit[asr]' first"
                : undefined
            }
          >
            {busy && jobId ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : (
              <Download className="size-3.5" aria-hidden />
            )}
            Install &amp; activate
          </button>
          <button
            type="button"
            className="btn-ghost"
            disabled={busy || (provider === activeProvider && !selectedRow?.cached)}
            onClick={() => void activateOnly()}
            title="Switch provider/model (install first if weights missing)"
          >
            <Power className="size-3.5" aria-hidden />
            Activate
          </button>
        </div>
      </div>

      {provider === "nemo" && providerMeta && !providerMeta.available ? (
        <p className="rounded-lg border border-danger-200 bg-danger-50 px-3 py-2 text-xs text-danger-700">
          NeMo package missing. Install with{" "}
          <span className="font-mono">pip install &quot;nemo_toolkit[asr]&quot;</span> and ensure{" "}
          <span className="font-mono">ffmpeg</span> is on PATH for audio resampling.
        </p>
      ) : null}

      {jobMessage ? (
        <p className="rounded-lg border border-line bg-surface-muted px-3 py-2 font-mono text-xs text-content-secondary">
          {jobMessage}
        </p>
      ) : null}
    </div>
  );
}
