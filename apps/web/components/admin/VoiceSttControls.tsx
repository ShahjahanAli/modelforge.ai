"use client";

import { Check, Download, HardDrive, Loader2, Mic, Power, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  activateWhisperModelAction,
  getWhisperInstallJobAction,
  installWhisperModelAction,
} from "@/app/(admin)/admin/infra/actions";
import { Badge } from "@/components/ui/Badge";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";

type PendingSttSwitch = {
  kind: "activate" | "install";
  model: VoiceModelRow;
};

export interface VoiceModelRow {
  id: string;
  label: string;
  approxDownloadGb: number;
  cached: boolean;
  active: boolean;
  license?: string;
}

export interface VoiceProviderRow {
  id: "faster-whisper" | "nemo" | "hf-space";
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
  {
    id: "bengaliAI/tugstugi_bengaliai-regional-asr_whisper-medium",
    label: "BengaliAI Regional ASR (Whisper medium)",
    approxDownloadGb: 3.0,
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

const HF_SPACE_FALLBACK: VoiceModelRow[] = [
  {
    id: "bengaliAI/regional_bengali-asr_tugstugi_whisper-medium",
    label: "BengaliAI Regional ASR (HF Space)",
    approxDownloadGb: 0,
    cached: true,
    active: false,
    license: "Remote Space",
  },
];

function shortModelLabel(id: string, label: string): string {
  if (id.includes("regional_bengali-asr")) return "BengaliAI HF Space";
  if (id.includes("bengaliAI") || id.includes("tugstugi")) return "BengaliAI Regional";
  if (id.includes("bhatiyali") || id.includes("kazalbrur")) return "Bhatiyali Dialect";
  return label;
}

function isDialectModel(id: string): boolean {
  return /bengali|bangla|tugstugi|bhatiyali|kazalbrur/i.test(id);
}

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
  activeProvider: "faster-whisper" | "nemo" | "hf-space";
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
  const [provider, setProvider] = useState<"faster-whisper" | "nemo" | "hf-space">(activeProvider);
  const [selected, setSelected] = useState(activeModel);
  const [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState<string | null>(initialJobId ?? null);
  const [jobMessage, setJobMessage] = useState<string | null>(null);
  const [pendingSwitch, setPendingSwitch] = useState<PendingSttSwitch | null>(null);

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
    if (provider === "nemo") return NEMO_FALLBACK;
    if (provider === "hf-space") return HF_SPACE_FALLBACK;
    return WHISPER_FALLBACK;
  }, [activeProvider, models, provider]);

  useEffect(() => {
    if (!options.some((row) => row.id === selected)) {
      setSelected(options[0]?.id ?? "");
    }
  }, [options, selected]);

  const selectedRow = options.find((row) => row.id === selected);
  const providerMeta = providers.find((row) => row.id === provider);
  const nemoBlocked = Boolean(provider === "nemo" && providerMeta && !providerMeta.available);
  const hfSpaceBlocked = Boolean(provider === "hf-space" && providerMeta && !providerMeta.available);
  const envDiverges = envProvider !== activeProvider || envModel !== activeModel;
  const selectionIsActive = provider === activeProvider && selected === activeModel;

  const providerList = providers.length
    ? providers
    : [
        { id: "faster-whisper" as const, label: "Faster-Whisper", available: true },
        { id: "nemo" as const, label: "NeMo (Bangla)", available: false },
        { id: "hf-space" as const, label: "HF Space (BengaliAI)", available: false },
      ];

  function requestSwitch(kind: "activate" | "install", model: VoiceModelRow) {
    setSelected(model.id);
    const isLive = provider === activeProvider && model.id === activeModel;
    if (isLive && kind === "activate") return;
    setPendingSwitch({ kind, model });
  }

  async function runActivate(model: VoiceModelRow) {
    setBusy(true);
    setPendingSwitch(null);
    const result = await activateWhisperModelAction({ provider, model: model.id });
    setBusy(false);
    toast.push({
      tone: result.ok ? "ok" : "danger",
      title: result.ok ? "STT activated" : "Activate failed",
      description: result.message,
    });
    if (result.ok) router.refresh();
  }

  async function runInstall(model: VoiceModelRow) {
    setBusy(true);
    setPendingSwitch(null);
    const result = await installWhisperModelAction({
      provider,
      model: model.id,
      activateOnSuccess: true,
    });
    if (!result.ok) {
      setBusy(false);
      toast.push({
        tone: "danger",
        title: "Could not start install",
        description: result.message,
      });
      return;
    }
    setJobId(result.jobId ?? null);
    setJobMessage(result.message);
    toast.push({
      tone: "ok",
      title: "Download started",
      description: `${model.id} (~${model.approxDownloadGb} GB). Keep this page open.`,
    });
  }

  async function confirmPendingSwitch() {
    if (!pendingSwitch) return;
    if (pendingSwitch.kind === "activate") {
      await runActivate(pendingSwitch.model);
      return;
    }
    await runInstall(pendingSwitch.model);
  }

  return (
    <div className="space-y-4 border-t border-line bg-gradient-to-b from-surface-2/60 to-transparent px-4 py-5 sm:px-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex size-7 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
              <Mic className="size-3.5" aria-hidden />
            </span>
            <h3 className="text-sm font-semibold tracking-tight text-content-primary">
              Speech-to-text model
            </h3>
            <Badge tone={modelCached ? "ok" : "warn"} dot>
              {modelCached ? "Weights cached" : "Weights missing"}
            </Badge>
            <Badge tone="neutral">
              {device.toUpperCase()} · {computeType.toUpperCase()}
            </Badge>
            {selectedRow?.license ? <Badge tone="warn">{selectedRow.license}</Badge> : null}
          </div>
          <p className="max-w-2xl text-xs leading-relaxed text-content-muted">
            Dialect models (BengaliAI, Bhatiyali) suit Sylheti / Chittagonian calls. Use{" "}
            <strong>HF Space (BengaliAI)</strong> to call the hosted Gradio Space remotely (no local
            Whisper weights). Standard Whisper sizes remain better for multilingual audio.
          </p>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-line bg-surface-1 shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
        <div className="flex flex-col gap-3 border-b border-line bg-surface-2/40 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 space-y-1">
            <p className="text-[11px] font-medium uppercase tracking-wide text-content-muted">
              Currently active
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-ok-50 px-2.5 py-1 text-xs font-medium text-ok-700 ring-1 ring-inset ring-ok-200">
                <span className="size-1.5 rounded-full bg-ok-500" aria-hidden />
                Live
              </span>
              <p className="truncate text-sm font-medium text-content-primary">
                {shortModelLabel(activeModel, activeModel)}
              </p>
              {isDialectModel(activeModel) ? (
                <span className="inline-flex items-center gap-1 rounded-md bg-brand-50 px-2 py-0.5 text-[11px] font-medium text-brand-700">
                  <Sparkles className="size-3" aria-hidden />
                  Dialect-tuned
                </span>
              ) : null}
            </div>
            <p className="truncate font-mono text-[11px] text-content-muted">
              {activeProvider}:{activeModel}
            </p>
          </div>
          {envDiverges ? (
            <div className="shrink-0 rounded-lg border border-line bg-surface-1 px-3 py-2 text-[11px] text-content-muted">
              <span className="font-medium text-content-secondary">Env default</span>
              <p className="mt-0.5 font-mono">
                {envProvider}:{envModel}
              </p>
            </div>
          ) : null}
        </div>

        <div className="space-y-4 p-4">
          <div className="space-y-2">
            <p className="text-[11px] font-medium uppercase tracking-wide text-content-muted">
              Provider
            </p>
            <div
              className="inline-flex w-full flex-col gap-1 rounded-xl border border-line bg-surface-2 p-1 sm:w-auto sm:flex-row"
              role="tablist"
              aria-label="STT provider"
            >
              {providerList.map((row) => {
                const selectedProvider = provider === row.id;
                return (
                  <button
                    key={row.id}
                    type="button"
                    role="tab"
                    aria-selected={selectedProvider}
                    disabled={busy}
                    onClick={() => setProvider(row.id)}
                    className={`inline-flex flex-1 items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition-colors ${
                      selectedProvider
                        ? "bg-surface-1 text-content-primary shadow-sm ring-1 ring-line"
                        : "text-content-secondary hover:text-content-primary"
                    } disabled:opacity-50`}
                  >
                    {row.label}
                    {!row.available ? (
                      <span className="text-[10px] font-normal text-content-muted">missing</span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] font-medium uppercase tracking-wide text-content-muted">
                Models
              </p>
              <p className="text-[11px] text-content-muted">
                {options.filter((row) => row.cached).length} cached · {options.length} available
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {options.map((row) => {
                const isSelected = selected === row.id;
                const isLive = row.active || (provider === activeProvider && row.id === activeModel);
                const installingThis = busy && jobId && isSelected;
                return (
                  <div
                    key={row.id}
                    role="button"
                    tabIndex={busy ? -1 : 0}
                    aria-pressed={isSelected}
                    onClick={() => {
                      if (!busy) setSelected(row.id);
                    }}
                    onKeyDown={(event) => {
                      if (busy) return;
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setSelected(row.id);
                      }
                    }}
                    className={`flex min-h-[9.5rem] flex-col rounded-xl border p-3.5 transition-all outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40 ${
                      isLive
                        ? "border-ok-200 bg-ok-50/80 shadow-[0_0_0_1px_rgba(16,185,129,0.12)]"
                        : isSelected
                          ? "border-brand-200 bg-brand-50/40 shadow-sm"
                          : "border-line bg-surface-1 hover:border-line-strong hover:bg-surface-2/40"
                    } ${busy ? "cursor-default opacity-70" : "cursor-pointer"}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 space-y-1.5">
                        <div className="flex flex-wrap items-center gap-1.5">
                          {isLive ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-ok-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ok-700 ring-1 ring-inset ring-ok-200">
                              <span className="size-1.5 rounded-full bg-ok-500" aria-hidden />
                              Active
                            </span>
                          ) : provider === "hf-space" ? (
                            <span className="inline-flex items-center rounded-full bg-brand-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand-700 ring-1 ring-inset ring-brand-100">
                              Remote
                            </span>
                          ) : row.cached ? (
                            <span className="inline-flex items-center rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-content-muted ring-1 ring-inset ring-line">
                              Cached
                            </span>
                          ) : (
                            <span className="inline-flex items-center rounded-full bg-warn-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-warn-700 ring-1 ring-inset ring-warn-200">
                              Not installed
                            </span>
                          )}
                          {isDialectModel(row.id) ? (
                            <span className="inline-flex items-center gap-0.5 rounded-full bg-brand-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand-700 ring-1 ring-inset ring-brand-100">
                              <Sparkles className="size-2.5" aria-hidden />
                              Dialect
                            </span>
                          ) : null}
                          {isSelected && !isLive ? (
                            <span className="inline-flex items-center gap-0.5 rounded-full bg-brand-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand-700">
                              <Check className="size-2.5 stroke-[3]" aria-hidden />
                              Selected
                            </span>
                          ) : null}
                        </div>
                        <p className="text-sm font-semibold leading-snug text-content-primary">
                          {shortModelLabel(row.id, row.label)}
                        </p>
                      </div>
                    </div>

                    <p className="mt-2 line-clamp-2 font-mono text-[10px] leading-relaxed text-content-muted">
                      {row.id}
                    </p>

                    <div className="mt-auto flex items-end justify-between gap-2 pt-3">
                      <p className="inline-flex items-center gap-1 text-[11px] text-content-muted">
                        <HardDrive className="size-3 shrink-0" aria-hidden />
                        {provider === "hf-space"
                          ? "Remote Space"
                          : row.cached
                            ? "On disk"
                            : `~${row.approxDownloadGb} GB`}
                        {row.license ? ` · ${row.license}` : ""}
                      </p>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <button
                          type="button"
                          className="inline-flex size-8 items-center justify-center rounded-lg border border-line bg-surface-1 text-content-secondary transition-colors hover:bg-surface-2 hover:text-content-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40 disabled:cursor-not-allowed disabled:opacity-40"
                          disabled={
                            busy ||
                            nemoBlocked ||
                            hfSpaceBlocked ||
                            isLive ||
                            (provider !== "hf-space" && !row.cached)
                          }
                          title={
                            isLive
                              ? "Already active"
                              : hfSpaceBlocked
                                ? "HF_TOKEN missing or Space unreachable"
                                : provider !== "hf-space" && !row.cached
                                  ? "Install weights first"
                                  : "Activate this model"
                          }
                          aria-label={`Activate ${shortModelLabel(row.id, row.label)}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            requestSwitch("activate", row);
                          }}
                        >
                          <Power className="size-3.5" aria-hidden />
                        </button>
                        <button
                          type="button"
                          className="inline-flex size-8 items-center justify-center rounded-lg bg-brand-600 text-content-inverse transition-colors hover:bg-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/45 disabled:cursor-not-allowed disabled:opacity-40"
                          disabled={busy || nemoBlocked || hfSpaceBlocked}
                          title={
                            nemoBlocked
                              ? 'pip install "nemo_toolkit[asr]" first'
                              : hfSpaceBlocked
                                ? "Set HF_TOKEN and ensure the Space is awake"
                                : provider === "hf-space"
                                  ? "Connect & activate remote Space"
                                  : "Install & activate"
                          }
                          aria-label={`${provider === "hf-space" ? "Connect" : "Install"} and activate ${shortModelLabel(row.id, row.label)}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            requestSwitch("install", row);
                          }}
                        >
                          {installingThis ? (
                            <Loader2 className="size-3.5 animate-spin" aria-hidden />
                          ) : (
                            <Download className="size-3.5" aria-hidden />
                          )}
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="text-xs text-content-muted">
              {selectionIsActive
                ? "Selected model is already live for ASR."
                : provider === "hf-space"
                  ? "Connect activates the remote Hugging Face Space for Anusandhan ASR (requires HF_TOKEN)."
                  : selectedRow?.cached
                    ? "Power activates a cached model. Download installs weights, then activates."
                    : "Download installs missing weights and activates the model."}
            </p>
          </div>
        </div>
      </div>

      {nemoBlocked ? (
        <p className="rounded-xl border border-danger-200 bg-danger-50 px-3.5 py-2.5 text-xs text-danger-700">
          NeMo package missing. Install with{" "}
          <span className="font-mono">pip install &quot;nemo_toolkit[asr]&quot;</span> and ensure{" "}
          <span className="font-mono">ffmpeg</span> is on PATH for audio resampling.
        </p>
      ) : null}

      {hfSpaceBlocked ? (
        <p className="rounded-xl border border-danger-200 bg-danger-50 px-3.5 py-2.5 text-xs text-danger-700">
          Hugging Face Space unreachable right now. Confirm the Space is awake at{" "}
          <span className="font-mono">bengaliAI/regional_bengali-asr_tugstugi_whisper-medium</span>
          , then refresh this page. For private Spaces, set <span className="font-mono">HF_TOKEN</span>{" "}
          in the root <span className="font-mono">.env</span> and restart the gateway (
          <span className="font-mono">pnpm dev</span> from repo root so dotenv loads).
        </p>
      ) : null}

      {jobMessage ? (
        <div className="flex items-start gap-2 rounded-xl border border-brand-200 bg-brand-50/70 px-3.5 py-2.5">
          {busy && jobId ? (
            <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin text-brand-600" aria-hidden />
          ) : null}
          <p className="font-mono text-xs text-brand-700">{jobMessage}</p>
        </div>
      ) : null}

      <ConfirmDialog
        open={pendingSwitch !== null}
        tone="warn"
        title={
          pendingSwitch?.kind === "install"
            ? provider === "hf-space"
              ? `Connect & switch to ${shortModelLabel(pendingSwitch.model.id, pendingSwitch.model.label)}?`
              : `Install & switch to ${shortModelLabel(pendingSwitch.model.id, pendingSwitch.model.label)}?`
            : `Switch ASR to ${pendingSwitch ? shortModelLabel(pendingSwitch.model.id, pendingSwitch.model.label) : "model"}?`
        }
        description={
          pendingSwitch?.kind === "install"
            ? provider === "hf-space"
              ? "This connects the remote Hugging Face Space and replaces the live speech-to-text provider. New Anusandhan / voice jobs will call the Space immediately."
              : "This downloads weights if needed and replaces the live speech-to-text model. New Anusandhan / voice jobs will use the selected model immediately."
            : "This replaces the live speech-to-text model. New Anusandhan / voice jobs will use the selected model immediately."
        }
        confirmLabel={
          pendingSwitch?.kind === "install"
            ? provider === "hf-space"
              ? "Connect & switch"
              : "Install & switch"
            : "Switch model"
        }
        busy={busy}
        onCancel={() => {
          if (!busy) setPendingSwitch(null);
        }}
        onConfirm={() => void confirmPendingSwitch()}
        details={
          pendingSwitch && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              <dt className="text-content-muted">From</dt>
              <dd className="break-all font-mono">
                {activeProvider}:{activeModel}
              </dd>
              <dt className="text-content-muted">To</dt>
              <dd className="break-all font-mono">
                {provider}:{pendingSwitch.model.id}
              </dd>
              {pendingSwitch.kind === "install" ? (
                <>
                  <dt className="text-content-muted">Download</dt>
                  <dd className="font-mono">
                    {pendingSwitch.model.cached
                      ? "Already cached"
                      : `~${pendingSwitch.model.approxDownloadGb} GB`}
                  </dd>
                </>
              ) : null}
            </dl>
          )
        }
      />
    </div>
  );
}
