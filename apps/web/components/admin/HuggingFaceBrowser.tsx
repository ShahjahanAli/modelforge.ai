"use client";

import {
  CheckCircle2,
  CloudDownload,
  Download,
  ExternalLink,
  FileArchive,
  Heart,
  Loader2,
  RotateCcw,
  Search,
  ShieldAlert,
  X,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/Badge";
import { useToast } from "@/components/ui/Toast";

interface HubModel {
  id: string;
  author: string;
  name: string;
  downloads: number;
  likes: number;
  lastModified: string | null;
  pipelineTag: string | null;
  license: string | null;
  gated: boolean | string;
  private: boolean;
  tags: string[];
}

interface HubFile {
  path: string;
  name: string;
  sizeBytes: number;
  sha256: string | null;
  quantization: string;
  shardIndex: number | null;
  shardCount: number;
}

interface FileBundle {
  id: string;
  label: string;
  quantization: string;
  files: HubFile[];
  totalBytes: number;
  recommended: boolean;
}

interface DownloadJob {
  id: string;
  repoId: string;
  filePath?: string;
  fileName: string;
  relativePath: string;
  status: "queued" | "downloading" | "verifying" | "completed" | "cancelled" | "failed";
  downloadedBytes: number;
  totalBytes: number;
  bytesPerSecond: number;
  error: string | null;
  registeredModelId: string | null;
  attempt?: number;
}

const ACTIVE = new Set(["queued", "downloading", "verifying"]);

function formatBytes(bytes: number): string {
  if (!bytes) return "unknown size";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function bundleFiles(files: HubFile[]): FileBundle[] {
  const groups = new Map<string, HubFile[]>();
  for (const file of files) {
    const id =
      file.shardCount > 1
        ? file.path.replace(/-\d{5}-of-\d{5}(?=\.gguf$)/i, "")
        : file.path;
    groups.set(id, [...(groups.get(id) ?? []), file]);
  }
  return [...groups.entries()]
    .map(([id, grouped]) => {
      const sorted = [...grouped].sort((a, b) => (a.shardIndex ?? 0) - (b.shardIndex ?? 0));
      const quantization = sorted[0]?.quantization ?? "unknown";
      return {
        id,
        label:
          sorted.length > 1
            ? `${sorted[0]!.name.replace(/-\d{5}-of-\d{5}(?=\.gguf$)/i, "")} (${sorted.length} shards)`
            : sorted[0]!.name,
        quantization,
        files: sorted,
        totalBytes: sorted.reduce((sum, file) => sum + file.sizeBytes, 0),
        recommended: /Q4_K_M/i.test(quantization),
      };
    })
    .sort((a, b) => a.totalBytes - b.totalBytes);
}

async function readJson<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!response.ok) throw new Error(body?.error ?? `Request failed (${response.status})`);
  return body as T;
}

export function HuggingFaceBrowser() {
  const router = useRouter();
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [models, setModels] = useState<HubModel[]>([]);
  const [searching, setSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [selectedModel, setSelectedModel] = useState<HubModel | null>(null);
  const [revision, setRevision] = useState("main");
  const [files, setFiles] = useState<HubFile[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [startingBundle, setStartingBundle] = useState<string | null>(null);
  const [downloads, setDownloads] = useState<DownloadJob[]>([]);
  const previousStatuses = useRef(new Map<string, string>());
  const searchController = useRef<AbortController | null>(null);
  const toastRef = useRef(toast);
  const routerRef = useRef(router);
  toastRef.current = toast;
  routerRef.current = router;

  const bundles = useMemo(() => bundleFiles(files), [files]);
  const hasActive = downloads.some((job) => ACTIVE.has(job.status));

  const refreshDownloads = useCallback(async () => {
    try {
      const body = await readJson<{ downloads: DownloadJob[] }>(
        await fetch("/api/admin/huggingface?action=status", { cache: "no-store" }),
      );
      for (const job of body.downloads) {
        const previous = previousStatuses.current.get(job.id);
        if (previous && previous !== job.status && job.status === "completed") {
          toastRef.current.push({
            tone: "ok",
            title: `${job.fileName} downloaded`,
            description: job.registeredModelId
              ? `Registered as ${job.registeredModelId}`
              : `Saved to ${job.relativePath}`,
            duration: 7000,
          });
          routerRef.current.refresh();
        }
        if (previous && previous !== job.status && job.status === "failed") {
          toastRef.current.push({
            tone: "danger",
            title: `${job.fileName} failed`,
            description: job.error ?? "Download failed",
            duration: 0,
          });
        }
        previousStatuses.current.set(job.id, job.status);
      }
      setDownloads(body.downloads);
    } catch {
      // The browser itself reports search/download errors; polling is best effort.
    }
  }, []);

  useEffect(() => {
    void refreshDownloads();
    if (!hasActive) return;
    const handle = window.setInterval(() => {
      if (document.hidden) return;
      void refreshDownloads();
    }, 1000);
    return () => window.clearInterval(handle);
  }, [refreshDownloads, hasActive]);

  async function searchModels() {
    const clean = query.trim();
    if (clean.length < 2) return;
    searchController.current?.abort();
    const controller = new AbortController();
    searchController.current = controller;
    setSearching(true);
    setHasSearched(true);
    setSelectedModel(null);
    setFiles([]);
    try {
      const body = await readJson<{ models: HubModel[] }>(
        await fetch(`/api/admin/huggingface?action=search&q=${encodeURIComponent(clean)}`, {
          cache: "no-store",
          signal: controller.signal,
        }),
      );
      setModels(body.models);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      toast.push({
        tone: "danger",
        title: "Hugging Face search failed",
        description: error instanceof Error ? error.message : "Hub unavailable",
      });
    } finally {
      if (searchController.current === controller) setSearching(false);
    }
  }

  async function selectModel(model: HubModel) {
    setSelectedModel(model);
    setFiles([]);
    setLoadingFiles(true);
    try {
      const body = await readJson<{ revision: string; files: HubFile[] }>(
        await fetch(
          `/api/admin/huggingface?action=files&repo=${encodeURIComponent(model.id)}`,
          { cache: "no-store" },
        ),
      );
      setRevision(body.revision);
      setFiles(body.files);
    } catch (error) {
      toast.push({
        tone: "danger",
        title: "Could not list GGUF files",
        description: error instanceof Error ? error.message : "Hub unavailable",
        duration: 0,
      });
    } finally {
      setLoadingFiles(false);
    }
  }

  async function downloadBundle(bundle: FileBundle) {
    if (!selectedModel || startingBundle) return;
    setStartingBundle(bundle.id);
    let started = 0;
    try {
      for (const file of bundle.files) {
        await readJson<DownloadJob>(
          await fetch("/api/admin/huggingface", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              repoId: selectedModel.id,
              revision,
              filePath: file.path,
              expectedSize: file.sizeBytes,
              sha256: file.sha256,
              // Backend registers only after every shard in this bundle finishes.
              register: true,
            }),
          }),
        );
        started += 1;
      }
      toast.push({
        tone: "info",
        title: `Downloading ${bundle.quantization}`,
        description:
          bundle.files.length > 1
            ? `${bundle.files.length} shards queued · ${formatBytes(bundle.totalBytes)}`
            : `${formatBytes(bundle.totalBytes)} · download resumes if interrupted`,
        duration: 6000,
      });
      await refreshDownloads();
    } catch (error) {
      toast.push({
        tone: "danger",
        title: started ? "Bundle partially queued" : "Download could not start",
        description: error instanceof Error ? error.message : "Unknown error",
        duration: 0,
      });
    } finally {
      setStartingBundle(null);
    }
  }

  async function cancelDownload(id: string) {
    await fetch(`/api/admin/huggingface?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    await refreshDownloads();
  }

  async function retryDownload(id: string) {
    try {
      await readJson<DownloadJob>(
        await fetch("/api/admin/huggingface", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ retryId: id }),
        }),
      );
      toast.push({
        tone: "info",
        title: "Download resumed",
        description: "Continuing from the partial file on disk",
        duration: 5000,
      });
      await refreshDownloads();
    } catch (error) {
      toast.push({
        tone: "danger",
        title: "Could not retry download",
        description: error instanceof Error ? error.message : "Unknown error",
        duration: 0,
      });
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-line-strong bg-gradient-to-br from-surface-1 via-surface-1 to-warn-50/40 p-4 sm:p-5">
        <div className="flex items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-warn-200 bg-warn-50 text-warn-700">
            <span className="text-lg" aria-hidden>🤗</span>
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold text-content-primary">Discover on Hugging Face</h3>
            <p className="mt-1 text-xs leading-5 text-content-muted">
              Search GGUF repositories, compare quantizations, and download directly to your private
              weights folder. Downloads are resumable and SHA-256 verified when Hub metadata provides a hash.
            </p>
          </div>
        </div>

        <form
          className="mt-4 flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void searchModels();
          }}
        >
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-content-muted" aria-hidden />
            <input
              className="input !pl-9"
              value={query}
              placeholder="Search models or paste owner/repo, e.g. BanglaLLM/BanglaLLama-3.2-3b…"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <button type="submit" className="btn" disabled={searching || query.trim().length < 2}>
            {searching ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Search className="size-4" aria-hidden />}
            <span className="hidden sm:inline">Search Hub</span>
          </button>
        </form>
      </div>

      {hasSearched && !searching && models.length === 0 && (
        <div className="rounded-xl border border-dashed border-line-strong bg-surface-1 px-4 py-8 text-center text-sm text-content-muted">
          No GGUF repositories matched that query. Try the exact Hub id (`owner/repo`) or a shorter name.
        </div>
      )}

      {models.length > 0 && (
        <div className="grid gap-3 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
          <div className="max-h-[34rem] space-y-2 overflow-y-auto pr-1">
            {models.map((model) => (
              <button
                key={model.id}
                type="button"
                className={`w-full rounded-xl border p-3 text-left transition-all ${
                  selectedModel?.id === model.id
                    ? "border-brand-300 bg-brand-50 shadow-sm"
                    : "border-line bg-surface-1 hover:border-line-strong hover:bg-surface-2/60"
                }`}
                onClick={() => void selectModel(model)}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-content-primary">{model.name}</p>
                    <p className="mt-0.5 truncate font-mono text-[10px] text-content-muted">{model.author}</p>
                  </div>
                  {(model.gated || model.private) && <ShieldAlert className="size-4 shrink-0 text-warn-600" aria-label="Gated model" />}
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2 text-[10px] text-content-muted">
                  <span className="flex items-center gap-1"><Download className="size-3" aria-hidden />{formatCount(model.downloads)}</span>
                  <span className="flex items-center gap-1"><Heart className="size-3" aria-hidden />{formatCount(model.likes)}</span>
                  {model.license && <Badge tone="neutral">{model.license}</Badge>}
                  {model.pipelineTag && <span>{model.pipelineTag}</span>}
                </div>
              </button>
            ))}
          </div>

          <div className="rounded-xl border border-line bg-surface-1">
            {!selectedModel ? (
              <div className="grid min-h-64 place-items-center p-6 text-center text-sm text-content-muted">
                Select a repository to view available GGUF quantizations.
              </div>
            ) : (
              <>
                <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-content-primary">{selectedModel.id}</p>
                    <p className="mt-1 text-xs text-content-muted">
                      {loadingFiles ? "Reading repository files…" : `${bundles.length} downloadable variant(s)`}
                    </p>
                  </div>
                  <a
                    href={`https://huggingface.co/${selectedModel.id}`}
                    target="_blank"
                    rel="noreferrer"
                    className="icon-btn"
                    title="Open model card on Hugging Face"
                  >
                    <ExternalLink className="size-4" aria-hidden />
                  </a>
                </div>
                {loadingFiles ? (
                  <div className="grid min-h-56 place-items-center"><Loader2 className="size-6 animate-spin text-brand-600" aria-hidden /></div>
                ) : bundles.length === 0 ? (
                  <div className="p-6 text-center text-sm text-content-muted">No GGUF files found in this repository.</div>
                ) : (
                  <div className="max-h-[29rem] divide-y divide-line overflow-y-auto">
                    {bundles.map((bundle) => (
                      <div key={bundle.id} className="flex items-center gap-3 px-4 py-3">
                        <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-line bg-surface-2 text-content-muted">
                          <FileArchive className="size-4" aria-hidden />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="font-mono text-xs font-medium text-content-primary">{bundle.quantization}</span>
                            {bundle.recommended && <Badge tone="ok">recommended</Badge>}
                            {bundle.files.length > 1 && <Badge tone="info">{bundle.files.length} shards</Badge>}
                          </div>
                          <p className="mt-1 truncate text-[11px] text-content-muted" title={bundle.label}>
                            {bundle.label} · {formatBytes(bundle.totalBytes)}
                          </p>
                        </div>
                        <button
                          type="button"
                          className="btn text-xs"
                          onClick={() => void downloadBundle(bundle)}
                          disabled={startingBundle !== null}
                        >
                          {startingBundle === bundle.id ? (
                            <Loader2 className="size-3.5 animate-spin" aria-hidden />
                          ) : (
                            <CloudDownload className="size-3.5" aria-hidden />
                          )}
                          Download
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {downloads.length > 0 && (
        <div className="rounded-xl border border-line bg-surface-1">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <div>
              <p className="text-sm font-semibold text-content-primary">Download manager</p>
              <p className="mt-0.5 text-xs text-content-muted">Host-side transfers continue if this page is closed</p>
            </div>
            <Badge tone={hasActive ? "info" : "neutral"} dot pulse={hasActive}>
              {downloads.filter((job) => ACTIVE.has(job.status)).length} active
            </Badge>
          </div>
          <div className="divide-y divide-line">
            {downloads.slice(0, 12).map((job) => (
              <DownloadRow
                key={job.id}
                job={job}
                onCancel={() => void cancelDownload(job.id)}
                onRetry={() => void retryDownload(job.id)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function DownloadRow({
  job,
  onCancel,
  onRetry,
}: {
  job: DownloadJob;
  onCancel: () => void;
  onRetry: () => void;
}) {
  const percent = job.totalBytes > 0 ? Math.min(100, (job.downloadedBytes / job.totalBytes) * 100) : 0;
  const remaining = Math.max(0, job.totalBytes - job.downloadedBytes);
  const etaSeconds = job.bytesPerSecond > 0 ? remaining / job.bytesPerSecond : 0;
  const active = ACTIVE.has(job.status);
  const canRetry = job.status === "failed" || job.status === "cancelled";
  const showProgress = active || job.status === "completed" || job.downloadedBytes > 0;
  const statusTone =
    job.status === "completed" ? "ok" : job.status === "failed" ? "danger" : job.status === "cancelled" ? "warn" : "info";

  return (
    <div className="px-4 py-3">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg border border-line bg-surface-2">
          {job.status === "completed" ? (
            <CheckCircle2 className="size-4 text-ok-600" aria-hidden />
          ) : job.status === "failed" ? (
            <XCircle className="size-4 text-danger-600" aria-hidden />
          ) : (
            <CloudDownload className={`size-4 ${active ? "text-brand-600" : "text-content-muted"}`} aria-hidden />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-xs font-medium text-content-primary">{job.fileName}</p>
              <p className="mt-0.5 truncate font-mono text-[10px] text-content-muted">{job.repoId}</p>
            </div>
            <div className="flex items-center gap-1.5">
              <Badge tone={statusTone}>{job.status}</Badge>
              {canRetry && (
                <button type="button" className="icon-btn !size-7" onClick={onRetry} title="Retry from partial file">
                  <RotateCcw className="size-3.5" aria-hidden />
                </button>
              )}
              <button
                type="button"
                className="icon-btn !size-7"
                onClick={onCancel}
                title={active ? "Cancel download" : "Remove from history"}
              >
                <X className="size-3.5" aria-hidden />
              </button>
            </div>
          </div>
          {showProgress && (
            <>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-valuenow={Math.round(percent)}>
                <div
                  className={`h-full rounded-full transition-[width] duration-300 ${job.status === "completed" ? "bg-ok-500" : job.status === "failed" ? "bg-danger-500" : "bg-brand-600"}`}
                  style={{ width: `${job.status === "queued" ? 2 : Math.max(2, percent)}%` }}
                >
                  {active && <div className="h-full w-full progress-stripes" />}
                </div>
              </div>
              <div className="mt-1.5 flex justify-between gap-3 font-mono text-[10px] text-content-muted">
                <span>{formatBytes(job.downloadedBytes)} / {formatBytes(job.totalBytes)}</span>
                <span>
                  {job.status === "verifying"
                    ? "verifying SHA-256"
                    : job.bytesPerSecond > 0
                      ? `${formatBytes(job.bytesPerSecond)}/s${etaSeconds ? ` · ${Math.ceil(etaSeconds)}s left` : ""}`
                      : job.attempt && job.attempt > 1
                        ? `attempt ${job.attempt}`
                        : job.status}
                </span>
              </div>
            </>
          )}
          {job.error && <p className="mt-2 text-xs leading-5 text-danger-700">{job.error}</p>}
          {job.registeredModelId && (
            <p className="mt-1.5 text-xs text-ok-700">Registered as <span className="font-mono">{job.registeredModelId}</span></p>
          )}
        </div>
      </div>
    </div>
  );
}
