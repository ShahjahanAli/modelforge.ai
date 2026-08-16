import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, stat, statfs, unlink } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { prisma } from "@modelforge/db";
import { scanWeights, weightsDir } from "./weights.js";

const HF_ORIGIN = "https://huggingface.co";
const REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/;
const activeDownloads = new Map<string, DownloadState>();
const controllers = new Map<string, AbortController>();
const expectedHashes = new Map<string, string | null>();
const queuedDownloadIds: string[] = [];
const manifestCache = new Map<
  string,
  { expiresAt: number; value: { revision: string; files: HuggingFaceFile[] } }
>();

export type DownloadStatus =
  | "queued"
  | "downloading"
  | "verifying"
  | "completed"
  | "cancelled"
  | "failed";

export interface HuggingFaceModel {
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

export interface HuggingFaceFile {
  path: string;
  name: string;
  sizeBytes: number;
  sha256: string | null;
  quantization: string;
  shardIndex: number | null;
  shardCount: number;
}

export interface DownloadState {
  id: string;
  repoId: string;
  revision: string;
  filePath: string;
  fileName: string;
  destination: string;
  relativePath: string;
  status: DownloadStatus;
  downloadedBytes: number;
  totalBytes: number;
  bytesPerSecond: number;
  startedAt: string;
  updatedAt: string;
  error: string | null;
  register: boolean;
  registeredModelId: string | null;
}

interface HubModelResponse {
  id?: string;
  modelId?: string;
  author?: string;
  downloads?: number;
  likes?: number;
  lastModified?: string;
  pipeline_tag?: string;
  tags?: string[];
  gated?: boolean | string;
  private?: boolean;
  sha?: string;
  siblings?: Array<{
    rfilename?: string;
    size?: number;
    lfs?: { size?: number; sha256?: string };
  }>;
}

function hubHeaders(): Headers {
  const headers = new Headers({
    accept: "application/json",
    "user-agent": "ModelForge/0.1 (self-hosted model manager)",
  });
  const token = process.env.HF_TOKEN?.trim();
  if (token) headers.set("authorization", `Bearer ${token}`);
  return headers;
}

async function hubFetch(url: URL, init: RequestInit = {}): Promise<Response> {
  // All URLs are constructed against this fixed origin; callers cannot supply
  // an arbitrary host, which prevents the internal gateway becoming an SSRF proxy.
  if (url.origin !== HF_ORIGIN) throw new Error("Unsupported Hugging Face endpoint");
  const headers = hubHeaders();
  new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  const response = await fetch(url, { ...init, headers, redirect: "follow" });
  if (!response.ok) {
    const message =
      response.status === 401 || response.status === 403
        ? "Repository is private or gated. Configure HF_TOKEN with accepted access."
        : `Hugging Face returned ${response.status}: ${(await response.text()).slice(0, 300)}`;
    throw new Error(message);
  }
  return response;
}

function validateRepoId(repoId: string): string {
  if (!REPO_PATTERN.test(repoId)) throw new Error("Invalid Hugging Face repository id");
  return repoId;
}

function validateFilePath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  if (
    !normalized.toLowerCase().endsWith(".gguf") ||
    normalized.startsWith("/") ||
    normalized.split("/").some((part) => part === ".." || part === "" || part === ".")
  ) {
    throw new Error("Only safe relative GGUF paths can be downloaded");
  }
  return normalized;
}

function quantizationFromName(fileName: string): string {
  return (
    fileName.match(/(?:^|[._-])(IQ\d[A-Z0-9_]*|Q\d[A-Z0-9_]*|BF16|F16|F32)(?=[._-]|$)/i)?.[1]?.toUpperCase() ??
    "unknown"
  );
}

function shardInfo(fileName: string): { index: number | null; count: number } {
  const match = fileName.replace(/\.gguf$/i, "").match(/-(\d{5})-of-(\d{5})$/);
  return match ? { index: Number(match[1]), count: Number(match[2]) } : { index: null, count: 1 };
}

function bundleIdentity(filePath: string): string {
  return filePath.replace(/-\d{5}-of-\d{5}(?=\.gguf$)/i, "");
}

export async function searchHuggingFaceModels(
  query: string,
  limit = 20,
): Promise<HuggingFaceModel[]> {
  const clean = query.trim().slice(0, 100);
  if (clean.length < 2) return [];
  const url = new URL("/api/models", HF_ORIGIN);
  url.searchParams.set("search", clean);
  url.searchParams.set("filter", "gguf");
  url.searchParams.set("sort", "downloads");
  url.searchParams.set("direction", "-1");
  url.searchParams.set("limit", String(Math.min(50, Math.max(1, limit))));
  url.searchParams.set("full", "true");
  const rows = (await (await hubFetch(url)).json()) as HubModelResponse[];
  return rows
    .filter((row) => row.id || row.modelId)
    .map((row) => {
      const id = (row.id ?? row.modelId)!;
      const [author = "", ...name] = id.split("/");
      return {
        id,
        author: row.author ?? author,
        name: name.join("/"),
        downloads: row.downloads ?? 0,
        likes: row.likes ?? 0,
        lastModified: row.lastModified ?? null,
        pipelineTag: row.pipeline_tag ?? null,
        license: row.tags?.find((tag) => tag.startsWith("license:"))?.slice(8) ?? null,
        gated: row.gated ?? false,
        private: row.private ?? false,
        tags: (row.tags ?? []).slice(0, 20),
      };
    });
}

export async function listHuggingFaceGgufFiles(repoId: string): Promise<{
  revision: string;
  files: HuggingFaceFile[];
}> {
  validateRepoId(repoId);
  const cached = manifestCache.get(repoId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const url = new URL(`/api/models/${repoId}`, HF_ORIGIN);
  url.searchParams.set("blobs", "true");
  const model = (await (await hubFetch(url)).json()) as HubModelResponse;
  const files = (model.siblings ?? [])
    .filter((file) => file.rfilename?.toLowerCase().endsWith(".gguf"))
    .map((file): HuggingFaceFile => {
      const filePath = validateFilePath(file.rfilename!);
      const name = path.posix.basename(filePath);
      const shard = shardInfo(name);
      return {
        path: filePath,
        name,
        sizeBytes: file.lfs?.size ?? file.size ?? 0,
        sha256: file.lfs?.sha256 ?? null,
        quantization: quantizationFromName(name),
        shardIndex: shard.index,
        shardCount: shard.count,
      };
    })
    .sort((a, b) => a.sizeBytes - b.sizeBytes || a.name.localeCompare(b.name));
  const value = { revision: model.sha ?? "main", files };
  manifestCache.set(repoId, { expiresAt: Date.now() + 5 * 60_000, value });
  return value;
}

function safeDestination(repoId: string, filePath: string): {
  absolute: string;
  relative: string;
} {
  const [owner, repo] = validateRepoId(repoId).split("/");
  const safeFilePath = validateFilePath(filePath);
  const relative = ["huggingface", owner!, repo!, ...safeFilePath.split("/")].join("/");
  const root = weightsDir();
  const absolute = path.resolve(root, ...relative.split("/"));
  if (!absolute.startsWith(`${root}${path.sep}`)) throw new Error("Unsafe destination path");
  return { absolute, relative };
}

function serializeState(state: DownloadState): DownloadState {
  return { ...state };
}

export function listHuggingFaceDownloads(): DownloadState[] {
  return [...activeDownloads.values()]
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .map(serializeState);
}

export function getHuggingFaceDownload(id: string): DownloadState | null {
  const state = activeDownloads.get(id);
  return state ? serializeState(state) : null;
}

export async function startHuggingFaceDownload(input: {
  repoId: string;
  revision?: string;
  filePath: string;
  expectedSize?: number;
  sha256?: string | null;
  register?: boolean;
}): Promise<DownloadState> {
  const repoId = validateRepoId(input.repoId);
  const filePath = validateFilePath(input.filePath);
  // Never trust size/hash/revision supplied by the browser. Resolve the file
  // against the authenticated Hub manifest so limits and verification cannot
  // be bypassed by modifying the POST body.
  const manifest = await listHuggingFaceGgufFiles(repoId);
  const trustedFile = manifest.files.find((file) => file.path === filePath);
  if (!trustedFile) throw new Error("GGUF file is not present in the repository manifest");
  const existing = [...activeDownloads.values()].find(
    (job) =>
      job.repoId === repoId &&
      job.filePath === filePath &&
      ["queued", "downloading", "verifying"].includes(job.status),
  );
  if (existing) return serializeState(existing);

  const destination = safeDestination(repoId, filePath);
  const totalBytes = Math.max(0, trustedFile.sizeBytes);
  const maxBytes = Math.max(1, Number(process.env.HF_MAX_DOWNLOAD_GB ?? 100)) * 1024 ** 3;
  if (totalBytes > maxBytes) throw new Error("Selected file exceeds HF_MAX_DOWNLOAD_GB");

  const id = randomUUID();
  const now = new Date().toISOString();
  const state: DownloadState = {
    id,
    repoId,
    revision: manifest.revision.replace(/[^A-Za-z0-9._-]/g, "") || "main",
    filePath,
    fileName: path.posix.basename(filePath),
    destination: destination.absolute,
    relativePath: destination.relative,
    status: "queued",
    downloadedBytes: 0,
    totalBytes,
    bytesPerSecond: 0,
    startedAt: now,
    updatedAt: now,
    error: null,
    register: input.register !== false,
    registeredModelId: null,
  };
  activeDownloads.set(id, state);
  expectedHashes.set(id, trustedFile.sha256);
  queuedDownloadIds.push(id);
  pumpDownloadQueue();
  return serializeState(state);
}

export function cancelHuggingFaceDownload(id: string): boolean {
  const state = activeDownloads.get(id);
  const controller = controllers.get(id);
  if (!state || !["queued", "downloading", "verifying"].includes(state.status)) {
    return false;
  }
  state.status = "cancelled";
  state.updatedAt = new Date().toISOString();
  if (controller) {
    controller.abort();
  } else {
    const index = queuedDownloadIds.indexOf(id);
    if (index >= 0) queuedDownloadIds.splice(index, 1);
  }
  return true;
}

export function removeHuggingFaceDownload(id: string): boolean {
  const state = activeDownloads.get(id);
  if (!state || ["queued", "downloading", "verifying"].includes(state.status)) return false;
  return activeDownloads.delete(id);
}

function pumpDownloadQueue(): void {
  const maxConcurrent = Math.max(1, Number(process.env.HF_MAX_CONCURRENT_DOWNLOADS ?? 2));
  while (controllers.size < maxConcurrent && queuedDownloadIds.length > 0) {
    const id = queuedDownloadIds.shift()!;
    const state = activeDownloads.get(id);
    if (!state || state.status !== "queued") continue;
    const controller = new AbortController();
    controllers.set(id, controller);
    void runDownload(state, controller, expectedHashes.get(id) ?? null);
  }
}

async function runDownload(
  state: DownloadState,
  controller: AbortController,
  expectedSha256: string | null,
): Promise<void> {
  const partial = `${state.destination}.part`;
  try {
    await mkdir(path.dirname(state.destination), { recursive: true });
    const existingFinal = await stat(state.destination).catch(() => null);
    if (existingFinal && (!state.totalBytes || existingFinal.size === state.totalBytes)) {
      state.downloadedBytes = existingFinal.size;
      await completeDownload(state);
      return;
    }

    const partialInfo = await stat(partial).catch(() => null);
    if (partialInfo && state.totalBytes && partialInfo.size === state.totalBytes) {
      state.downloadedBytes = partialInfo.size;
      if (expectedSha256) await verifyDownloadedFile(partial, expectedSha256, state);
      await rename(partial, state.destination);
      await completeDownload(state);
      return;
    }
    if (partialInfo && state.totalBytes && partialInfo.size > state.totalBytes) {
      await unlink(partial);
    }
    let offset =
      partialInfo && (!state.totalBytes || partialInfo.size < state.totalBytes) ? partialInfo.size : 0;
    const disk = await statfs(path.dirname(state.destination));
    const freeBytes = disk.bavail * disk.bsize;
    const remaining = Math.max(0, state.totalBytes - offset);
    if (remaining && freeBytes < remaining + 512 * 1024 ** 2) {
      throw new Error(
        `Not enough disk space: ${(freeBytes / 1024 ** 3).toFixed(1)} GB free, ${(
          remaining /
          1024 ** 3
        ).toFixed(1)} GB required`,
      );
    }

    const revision = state.revision || "main";
    const url = new URL(
      `/${state.repoId}/resolve/${encodeURIComponent(revision)}/${state.filePath
        .split("/")
        .map(encodeURIComponent)
        .join("/")}`,
      HF_ORIGIN,
    );
    const headers = new Headers();
    if (offset > 0) headers.set("range", `bytes=${offset}-`);
    let response = await hubFetch(url, { headers, signal: controller.signal });
    if (offset > 0 && response.status !== 206) {
      await unlink(partial).catch(() => undefined);
      offset = 0;
      response = await hubFetch(url, { signal: controller.signal });
    }
    if (!response.body) throw new Error("Hugging Face returned an empty download body");

    const responseLength = Number(response.headers.get("content-length") ?? 0);
    const contentRange = response.headers.get("content-range");
    const rangeTotal = Number(contentRange?.match(/\/(\d+)$/)?.[1] ?? 0);
    state.totalBytes = state.totalBytes || rangeTotal || offset + responseLength;
    state.downloadedBytes = offset;
    state.status = "downloading";

    const started = Date.now();
    let downloadedThisRun = 0;
    let lastUpdate = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        downloadedThisRun += chunk.length;
        const now = Date.now();
        if (now - lastUpdate >= 200) {
          state.downloadedBytes = offset + downloadedThisRun;
          state.bytesPerSecond = Math.round((downloadedThisRun * 1000) / Math.max(1, now - started));
          state.updatedAt = new Date().toISOString();
          lastUpdate = now;
        }
        callback(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(response.body as never),
      meter,
      createWriteStream(partial, { flags: offset > 0 ? "a" : "w" }),
      { signal: controller.signal },
    );
    state.downloadedBytes = offset + downloadedThisRun;

    if (state.totalBytes && state.downloadedBytes !== state.totalBytes) {
      throw new Error(`Download incomplete: received ${state.downloadedBytes} of ${state.totalBytes} bytes`);
    }

    if (expectedSha256) {
      await verifyDownloadedFile(partial, expectedSha256, state);
    }

    await rename(partial, state.destination);
    await completeDownload(state);
  } catch (error) {
    if (controller.signal.aborted || state.status === "cancelled") {
      state.status = "cancelled";
      state.error = null;
    } else {
      state.status = "failed";
      state.error = error instanceof Error ? error.message : "Download failed";
    }
    state.updatedAt = new Date().toISOString();
  } finally {
    controllers.delete(state.id);
    expectedHashes.delete(state.id);
    pumpDownloadQueue();
  }
}

async function verifyDownloadedFile(
  filePath: string,
  expectedSha256: string,
  state: DownloadState,
): Promise<void> {
  state.status = "verifying";
  state.updatedAt = new Date().toISOString();
  const digest = createHash("sha256");
  await pipeline(createReadStream(filePath), digest);
  const actual = digest.digest("hex");
  if (actual.toLowerCase() !== expectedSha256.toLowerCase()) {
    throw new Error("SHA-256 verification failed; the partial file was retained for retry");
  }
}

async function completeDownload(state: DownloadState): Promise<void> {
  state.status = "completed";
  state.bytesPerSecond = 0;
  state.updatedAt = new Date().toISOString();
  if (!state.register) return;

  // Every shard may carry register=true. Only the final completed shard performs
  // registration, ensuring the registry never advertises an incomplete bundle.
  const identity = bundleIdentity(state.filePath);
  const bundleStillActive = [...activeDownloads.values()].some(
    (job) =>
      job.id !== state.id &&
      job.repoId === state.repoId &&
      bundleIdentity(job.filePath) === identity &&
      ["queued", "downloading", "verifying"].includes(job.status),
  );
  if (bundleStillActive) return;

  const discovered = (await scanWeights()).find(
    (file) =>
      file.relativePath === state.relativePath ||
      bundleIdentity(file.relativePath) === bundleIdentity(state.relativePath),
  );
  if (!discovered) return;
  const model = await prisma.hostedModel.upsert({
    where: { modelId: discovered.suggestedModelId },
    update: {
      displayName: discovered.suggestedDisplayName,
      weightsPath: discovered.relativePath,
      quantization: discovered.quantization,
    },
    create: {
      modelId: discovered.suggestedModelId,
      displayName: discovered.suggestedDisplayName,
      weightsPath: discovered.relativePath,
      quantization: discovered.quantization,
      contextLength: 8192,
      nThreads: Number(process.env.DEFAULT_N_THREADS ?? 8),
      gpuLayers: 0,
      pricePerMTokIn: 20,
      pricePerMTokOut: 60,
      status: "INACTIVE",
    },
  });
  state.registeredModelId = model.modelId;
}
