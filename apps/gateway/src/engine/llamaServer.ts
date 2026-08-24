import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { prisma } from "@modelforge/db";
import { weightsDir } from "../lib/weights.js";
import type { GenerateChunk, HealthStatus, LoadedModel } from "../grpc/client.js";

/**
 * Runs each model in its own prebuilt `llama-server` process and proxies
 * OpenAI-compatible HTTP to it. This keeps ModelForge free of a C++ toolchain:
 * llama.cpp ships binaries, so there is nothing to compile on the host.
 *
 * Process isolation is preserved — every model is a separate OS process bound to
 * loopback only, never a public interface.
 */

interface Instance {
  modelId: string;
  port: number;
  child: ChildProcess;
  ramMb: number;
  loadedAtUnix: number;
  lastUsedAt: number;
  activeRequests: number;
  generatedTokens: number;
  generationMs: number;
  ready: Promise<void>;
  stderrTail: string[];
}

const instances = new Map<string, Instance>();
const modelLoadLocks = new Map<
  string,
  Promise<{ success: boolean; message: string; ram_used_mb: number }>
>();

async function setRegistryStatus(
  modelId: string,
  status: "INACTIVE" | "LOADED" | "ERROR",
): Promise<void> {
  // Engine-only tests can run without the application database.
  if (!process.env.DATABASE_URL) return;
  await prisma.hostedModel
    .updateMany({ where: { modelId }, data: { status } })
    .catch((error: unknown) => {
      console.warn(`Could not set registry status for ${modelId} to ${status}:`, error);
    });
}

export function isModelProtectedFromEviction(modelId: string): boolean {
  const protectedModels = (process.env.MODELFORGE_PROTECTED_MODELS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return protectedModels.includes(modelId);
}

interface CpuSnapshot {
  idle: number;
  total: number;
}

function cpuSnapshot(): CpuSnapshot {
  return os.cpus().reduce(
    (sum, cpu) => {
      const total = Object.values(cpu.times).reduce((value, time) => value + time, 0);
      return { idle: sum.idle + cpu.times.idle, total: sum.total + total };
    },
    { idle: 0, total: 0 },
  );
}

let previousCpuSnapshot = cpuSnapshot();

function cpuUsagePercent(): number {
  const current = cpuSnapshot();
  const idleDelta = current.idle - previousCpuSnapshot.idle;
  const totalDelta = current.total - previousCpuSnapshot.total;
  previousCpuSnapshot = current;
  if (totalDelta <= 0) return 0;
  return Number((Math.max(0, 1 - idleDelta / totalDelta) * 100).toFixed(1));
}

export class EngineError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "EngineError";
  }
}

function serverBinary(): string {
  const configured = process.env.LLAMA_SERVER_BIN;
  if (configured) return configured;
  const name = os.platform() === "win32" ? "llama-server.exe" : "llama-server";
  return path.resolve(process.cwd(), "../../vendor/llama.cpp", name);
}

function ramBudgetMb(): number {
  return Number(process.env.TOTAL_RAM_BUDGET_MB ?? 24000);
}

function usedRamMb(): number {
  let total = 0;
  for (const instance of instances.values()) total += instance.ramMb;
  return total;
}

async function freePort(): Promise<number> {
  const base = Number(process.env.LLAMA_SERVER_PORT_BASE ?? 9100);
  for (let candidate = base; candidate < base + 200; candidate += 1) {
    const taken = [...instances.values()].some((i) => i.port === candidate);
    if (taken) continue;
    const available = await new Promise<boolean>((resolve) => {
      const probe = createServer();
      probe.once("error", () => resolve(false));
      probe.once("listening", () => probe.close(() => resolve(true)));
      probe.listen(candidate, "127.0.0.1");
    });
    if (available) return candidate;
  }
  throw new EngineError("INTERNAL", "No free port for llama-server");
}

async function waitForHealth(port: number, instance: Instance, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (instance.child.exitCode !== null || instance.child.signalCode !== null) {
      throw new EngineError(
        "MODEL_UNAVAILABLE",
        `llama-server exited during startup: ${instance.stderrTail.join(" ").slice(-400)}`,
      );
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        const body = (await res.json()) as { status?: string };
        if (body.status === "ok") return;
      }
    } catch {
      // Server is still starting; keep polling.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new EngineError("MODEL_UNAVAILABLE", "llama-server did not become healthy in time");
}

/** Frees RAM by stopping least-recently-used idle models until `needMb` fits. */
async function evictForBudget(needMb: number): Promise<void> {
  const budget = ramBudgetMb();
  if (usedRamMb() + needMb <= budget) return;

  let reservedSlugs = new Set<string>();
  try {
    const { prisma } = await import("@modelforge/db");
    const active = await prisma.residencyReservation.findMany({
      where: {
        status: "ACTIVE",
        startsAt: { lte: new Date() },
        endsAt: { gt: new Date() },
        preemptible: false,
      },
      include: { model: true },
    });
    reservedSlugs = new Set(active.map((row) => row.model.modelId));
  } catch {
    // DB may be unavailable during early boot; fall back to env protections only.
  }

  const candidates = [...instances.values()]
    .filter(
      (instance) =>
        instance.activeRequests === 0 &&
        !isModelProtectedFromEviction(instance.modelId) &&
        !reservedSlugs.has(instance.modelId),
    )
    .sort((a, b) => a.lastUsedAt - b.lastUsedAt);

  for (const candidate of candidates) {
    if (usedRamMb() + needMb <= budget) return;
    await unloadModel(candidate.modelId);
  }

  if (usedRamMb() + needMb > budget) {
    throw new EngineError(
      "OOM",
      `Need ${needMb} MB but only ${budget - usedRamMb()} MB of the ${budget} MB budget is free`,
    );
  }
}

async function loadModelUnlocked(req: {
  model_id: string;
  weights_path: string;
  context_length: number;
  n_threads: number;
  quantization: string;
  use_mmap: boolean;
}): Promise<{ success: boolean; message: string; ram_used_mb: number }> {
  const existing = instances.get(req.model_id);
  if (existing) {
    return { success: true, message: "already loaded", ram_used_mb: existing.ramMb };
  }

  const binary = serverBinary();
  if (!existsSync(binary)) {
    throw new EngineError(
      "MODEL_UNAVAILABLE",
      `llama-server not found at ${binary}. Run: pnpm llama:fetch`,
    );
  }

  const absoluteWeights = path.isAbsolute(req.weights_path)
    ? req.weights_path
    : path.join(weightsDir(), req.weights_path);
  const info = await stat(absoluteWeights).catch(() => null);
  if (!info) {
    throw new EngineError("MODEL_NOT_FOUND", `Weights not found: ${absoluteWeights}`);
  }

  // mmap keeps resident size close to the file size; add headroom for KV cache.
  const ramMb = Math.round((info.size / 1024 ** 2) * 1.1 + req.context_length / 8);
  await evictForBudget(ramMb);

  const port = await freePort();
  const args = [
    "-m",
    absoluteWeights,
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "-c",
    String(req.context_length),
    "-t",
    String(req.n_threads),
    "--parallel",
    String(process.env.MAX_CONCURRENT_PER_MODEL ?? 2),
    // Thinking is off by default so the completion budget is spent on the
    // answer, and any thoughts that do leak stay in `content` instead of being
    // split into a field OpenAI clients ignore.
    "--reasoning",
    process.env.LLAMA_REASONING ?? "off",
    "--reasoning-format",
    process.env.LLAMA_REASONING_FORMAT ?? "none",
    "--no-webui",
  ];
  if (req.use_mmap === false) args.push("--no-mmap");

  const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });

  const instance: Instance = {
    modelId: req.model_id,
    port,
    child,
    ramMb,
    loadedAtUnix: Math.floor(Date.now() / 1000),
    lastUsedAt: Date.now(),
    activeRequests: 0,
    generatedTokens: 0,
    generationMs: 0,
    ready: Promise.resolve(),
    stderrTail: [],
  };

  child.stderr?.on("data", (buf: Buffer) => {
    instance.stderrTail.push(buf.toString());
    if (instance.stderrTail.length > 40) instance.stderrTail.shift();
  });
  child.stdout?.resume();
  child.once("exit", () => {
    // unloadModel removes the instance first; if it is still present, the child
    // exited unexpectedly and the persisted registry must not remain LOADED.
    if (instances.get(req.model_id) === instance) {
      instances.delete(req.model_id);
      void setRegistryStatus(req.model_id, "ERROR");
    }
  });

  instances.set(req.model_id, instance);

  const startupTimeout = Number(process.env.LLAMA_SERVER_STARTUP_TIMEOUT_MS ?? 300_000);
  instance.ready = waitForHealth(port, instance, startupTimeout);

  try {
    await instance.ready;
  } catch (err) {
    child.kill();
    instances.delete(req.model_id);
    await setRegistryStatus(req.model_id, "ERROR");
    throw err;
  }

  await setRegistryStatus(req.model_id, "LOADED");
  return { success: true, message: `listening on 127.0.0.1:${port}`, ram_used_mb: ramMb };
}

export function loadModel(req: {
  model_id: string;
  weights_path: string;
  context_length: number;
  n_threads: number;
  quantization: string;
  use_mmap: boolean;
}): Promise<{ success: boolean; message: string; ram_used_mb: number }> {
  const existingLock = modelLoadLocks.get(req.model_id);
  if (existingLock) return existingLock;

  const loading = loadModelUnlocked(req).finally(() => {
    if (modelLoadLocks.get(req.model_id) === loading) modelLoadLocks.delete(req.model_id);
  });
  modelLoadLocks.set(req.model_id, loading);
  return loading;
}

export async function unloadModel(model_id: string): Promise<{ success: boolean; message: string }> {
  const instance = instances.get(model_id);
  if (!instance) {
    await setRegistryStatus(model_id, "INACTIVE");
    return { success: true, message: "not loaded" };
  }

  instances.delete(model_id);
  await new Promise<void>((resolve) => {
    instance.child.once("exit", () => resolve());
    instance.child.kill();
    setTimeout(() => {
      if (instance.child.exitCode === null) instance.child.kill("SIGKILL");
      resolve();
    }, 5000);
  });
  await setRegistryStatus(model_id, "INACTIVE");
  return { success: true, message: "unloaded" };
}

export async function listLoadedModels(): Promise<{ models: LoadedModel[] }> {
  return {
    models: [...instances.values()].map((instance) => ({
      model_id: instance.modelId,
      ram_used_mb: instance.ramMb,
      loaded_at_unix: instance.loadedAtUnix,
      active_requests: instance.activeRequests,
      tokens_per_sec_avg:
        instance.generationMs > 0
          ? Number(((instance.generatedTokens / instance.generationMs) * 1000).toFixed(2))
          : 0,
    })),
  };
}

export async function healthCheck(): Promise<HealthStatus> {
  const binary = serverBinary();
  if (!existsSync(binary)) {
    throw new EngineError(
      "MODEL_UNAVAILABLE",
      `llama-server binary missing at ${binary}. Run: pnpm llama:fetch`,
    );
  }
  const cpus = os.cpus();
  const totalHostRam = os.totalmem();
  const freeHostRam = os.freemem();
  const averageSpeed =
    cpus.length > 0 ? Math.round(cpus.reduce((sum, cpu) => sum + cpu.speed, 0) / cpus.length) : 0;

  return {
    healthy: true,
    total_ram_mb: ramBudgetMb(),
    used_ram_mb: usedRamMb(),
    loaded_model_count: instances.size,
    // Node exposes logical processors portably; retained for gRPC compatibility.
    physical_core_count: cpus.length,
    logical_core_count: cpus.length,
    cpu_model: cpus[0]?.model.trim() ?? "Unknown CPU",
    cpu_speed_mhz: averageSpeed,
    cpu_usage_percent: cpuUsagePercent(),
    host_total_ram_mb: Math.round(totalHostRam / 1024 ** 2),
    host_free_ram_mb: Math.round(freeHostRam / 1024 ** 2),
    host_uptime_seconds: Math.round(os.uptime()),
    gateway_rss_mb: Math.round(process.memoryUsage().rss / 1024 ** 2),
    load_average_1m: Number((os.loadavg()[0] ?? 0).toFixed(2)),
    hostname: os.hostname(),
    platform: os.type(),
    platform_release: os.release(),
    arch: os.arch(),
    node_version: process.version,
  };
}

/** Loads the model on first use, the way LM Studio warms a model on demand. */
async function ensureLoaded(modelId: string): Promise<Instance> {
  const existing = instances.get(modelId);
  if (existing) {
    await existing.ready;
    return existing;
  }

  if (process.env.LLAMA_AUTO_LOAD === "false") {
    throw new EngineError("MODEL_UNAVAILABLE", `Model ${modelId} is not loaded`);
  }

  const hosted = await prisma.hostedModel.findUnique({ where: { modelId } });
  if (!hosted) throw new EngineError("MODEL_NOT_FOUND", `Unknown model ${modelId}`);

  await loadModel({
    model_id: hosted.modelId,
    weights_path: hosted.weightsPath,
    context_length: hosted.contextLength,
    n_threads: hosted.nThreads,
    quantization: hosted.quantization,
    use_mmap: process.env.USE_MMAP !== "false",
  });
  const loaded = instances.get(modelId);
  if (!loaded) throw new EngineError("INTERNAL", `Model ${modelId} vanished after load`);
  return loaded;
}

interface UpstreamPart {
  content?: string | null;
  reasoning_content?: string | null;
}

interface UpstreamChoice {
  delta?: UpstreamPart;
  message?: UpstreamPart;
  finish_reason?: string | null;
}

interface UpstreamResponse {
  choices?: UpstreamChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * Reasoning models spend their token budget inside a thought block that
 * llama.cpp reports separately as `reasoning_content`. If generation is cut off
 * before the block closes, `content` is empty even though tokens were billed,
 * so fall back to the reasoning text rather than returning nothing — except in
 * JSON mode, where reasoning must not be mistaken for the structured payload.
 */
function partText(
  part: UpstreamPart | undefined,
  opts?: { preferContentOnly?: boolean },
): string {
  const content = part?.content ?? "";
  if (opts?.preferContentOnly) return content;
  return content.length ? content : (part?.reasoning_content ?? "");
}

export function generateStream(
  req: {
    model_id: string;
    messages: Array<{ role: string; content: string }>;
    temperature: number;
    max_tokens: number;
    top_p: number;
    stop_sequences: string[];
    stream: boolean;
    response_format?: { type: "text" | "json_object" };
  },
  _url?: string,
  options?: { signal?: AbortSignal; deadlineMs?: number },
): AsyncIterable<GenerateChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      const instance = await ensureLoaded(req.model_id);
      instance.activeRequests += 1;
      instance.lastUsedAt = Date.now();
      const startedAt = Date.now();

      const timeout = AbortSignal.timeout(options?.deadlineMs ?? 300_000);
      const signal = options?.signal
        ? AbortSignal.any([options.signal, timeout])
        : timeout;
      const jsonMode = req.response_format?.type === "json_object";

      const payload = {
        model: req.model_id,
        messages: req.messages,
        temperature: req.temperature,
        max_tokens: req.max_tokens,
        top_p: req.top_p,
        ...(req.stop_sequences.length > 0 ? { stop: req.stop_sequences } : {}),
        stream: req.stream,
        ...(req.stream ? { stream_options: { include_usage: true } } : {}),
        ...(req.response_format ? { response_format: req.response_format } : {}),
      };

      try {
        const res = await fetch(`http://127.0.0.1:${instance.port}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal,
        });

        if (!res.ok) {
          throw new EngineError("INTERNAL", `llama-server ${res.status}: ${await res.text()}`);
        }

        let promptTokens = 0;
        let completionTokens = 0;

        if (!req.stream) {
          const body = (await res.json()) as UpstreamResponse;
          promptTokens = body.usage?.prompt_tokens ?? 0;
          completionTokens = body.usage?.completion_tokens ?? 0;
          instance.generatedTokens += completionTokens;
          instance.generationMs += Date.now() - startedAt;
          yield {
            delta: partText(body.choices?.[0]?.message, { preferContentOnly: jsonMode }),
            is_final: true,
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            finish_reason: body.choices?.[0]?.finish_reason ?? "stop",
          };
          return;
        }

        if (!res.body) throw new EngineError("INTERNAL", "llama-server returned no body");

        const decoder = new TextDecoder();
        let buffer = "";
        let finishReason = "stop";

        for await (const bytes of res.body as unknown as AsyncIterable<Uint8Array>) {
          buffer += decoder.decode(bytes, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const data = trimmed.slice(5).trim();
            if (data === "[DONE]") continue;

            let parsed: UpstreamResponse;
            try {
              parsed = JSON.parse(data) as UpstreamResponse;
            } catch {
              continue;
            }

            if (parsed.usage) {
              promptTokens = parsed.usage.prompt_tokens ?? promptTokens;
              completionTokens = parsed.usage.completion_tokens ?? completionTokens;
            }
            const choice = parsed.choices?.[0];
            if (choice?.finish_reason) finishReason = choice.finish_reason;

            const delta = partText(choice?.delta, { preferContentOnly: jsonMode });
            if (delta) {
              yield {
                delta,
                is_final: false,
                prompt_tokens: promptTokens,
                completion_tokens: completionTokens,
                finish_reason: "",
              };
            }
          }
        }

        instance.generatedTokens += completionTokens;
        instance.generationMs += Date.now() - startedAt;

        yield {
          delta: "",
          is_final: true,
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          finish_reason: finishReason,
        };
      } finally {
        instance.activeRequests = Math.max(0, instance.activeRequests - 1);
        instance.lastUsedAt = Date.now();
      }
    },
  };
}

export function mapEngineFailure(err: unknown): { code: string; message: string } {
  if (err instanceof EngineError) return { code: err.code, message: err.message };
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      return { code: "DEADLINE_EXCEEDED", message: "Inference timed out" };
    }
    return { code: "INTERNAL", message: err.message };
  }
  return { code: "INTERNAL", message: "unknown engine error" };
}

export async function shutdownAll(): Promise<void> {
  await Promise.all([...instances.keys()].map((modelId) => unloadModel(modelId)));
}
