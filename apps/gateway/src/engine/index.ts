import * as grpcBackend from "../grpc/client.js";
import * as llamaBackend from "./llamaServer.js";
import * as remoteOpenAi from "./remoteOpenAi.js";
import { prisma } from "@modelforge/db";
import { isRemoteProviderKind } from "../lib/providerCredentials.js";

export type { GenerateChunk, HealthStatus, LoadedModel } from "../grpc/client.js";

/**
 * Inference backends:
 * - `llama-server` (default) — local GGUF via prebuilt llama.cpp
 * - `grpc` — Rust in-process engine
 * - HostedModel.providerKind=OPENAI_COMPAT — Gemini / OpenRouter / OpenAI-compatible HTTP
 */
export type InferenceBackend = "llama-server" | "grpc";

export function activeBackend(): InferenceBackend {
  return process.env.INFERENCE_BACKEND === "grpc" ? "grpc" : "llama-server";
}

const isGrpcBackend = () => activeBackend() === "grpc";

async function isRemoteModel(modelId: string): Promise<boolean> {
  const hosted = await prisma.hostedModel.findUnique({
    where: { modelId },
    select: { providerKind: true },
  });
  return isRemoteProviderKind(hosted?.providerKind);
}

export function generateStream(
  req: Parameters<typeof grpcBackend.generateStream>[0],
  url?: string,
  options?: Parameters<typeof grpcBackend.generateStream>[2],
): AsyncIterable<import("../grpc/client.js").GenerateChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      if (await isRemoteModel(req.model_id)) {
        const remote = remoteOpenAi.generateStream(req, url, options);
        for await (const chunk of remote) yield chunk;
        return;
      }
      const local = isGrpcBackend()
        ? grpcBackend.generateStream(req, url, options)
        : llamaBackend.generateStream(req, url, options);
      for await (const chunk of local) yield chunk;
    },
  };
}

export const loadModel: typeof grpcBackend.loadModel = async (req) => {
  if (await isRemoteModel(req.model_id)) {
    await prisma.hostedModel.updateMany({
      where: { modelId: req.model_id },
      data: { status: "LOADED" },
    });
    return {
      success: true,
      message: "remote OpenAI-compatible model marked available (no local load)",
      ram_used_mb: 0,
    };
  }
  return isGrpcBackend() ? grpcBackend.loadModel(req) : llamaBackend.loadModel(req);
};

export const unloadModel: typeof grpcBackend.unloadModel = async (modelId) => {
  if (await isRemoteModel(modelId)) {
    await prisma.hostedModel.updateMany({
      where: { modelId },
      data: { status: "INACTIVE" },
    });
    return { success: true, message: "remote model marked inactive" };
  }
  return isGrpcBackend() ? grpcBackend.unloadModel(modelId) : llamaBackend.unloadModel(modelId);
};

export const listLoadedModels: typeof grpcBackend.listLoadedModels = async () => {
  const local = isGrpcBackend()
    ? await grpcBackend.listLoadedModels()
    : await llamaBackend.listLoadedModels();
  const remotes = await prisma.hostedModel.findMany({
    where: { providerKind: "OPENAI_COMPAT", status: "LOADED" },
    select: { modelId: true },
  });
  const remoteEntries = remotes.map((model) => ({
    model_id: model.modelId,
    ram_used_mb: 0,
    active_requests: 0,
    loaded_at_unix: Math.floor(Date.now() / 1000),
    tokens_per_sec_avg: 0,
  }));
  return {
    models: [...local.models, ...remoteEntries],
  };
};

export const healthCheck: typeof grpcBackend.healthCheck = () =>
  isGrpcBackend() ? grpcBackend.healthCheck() : llamaBackend.healthCheck();

/** Makes persisted registry state match the selected backend's live pool. */
export async function reconcileModelRegistry(): Promise<void> {
  const residentIds = (await listLoadedModels()).models.map((model) => model.model_id);
  await prisma.$transaction([
    prisma.hostedModel.updateMany({
      where: {
        providerKind: "LOCAL_GGUF",
        status: "LOADED",
        ...(residentIds.length > 0 ? { modelId: { notIn: residentIds } } : {}),
      },
      data: { status: "INACTIVE" },
    }),
    ...(residentIds.length > 0
      ? [
          prisma.hostedModel.updateMany({
            where: {
              modelId: { in: residentIds },
              providerKind: "LOCAL_GGUF",
            },
            data: { status: "LOADED" as const },
          }),
        ]
      : []),
  ]);
}

/** Unload every resident local model except `keepModelId` (best-effort). Remotes are left alone. */
export async function unloadAllExcept(keepModelId: string): Promise<string[]> {
  const resident = await listLoadedModels();
  const unloaded: string[] = [];
  for (const model of resident.models) {
    if (model.model_id === keepModelId) continue;
    if (await isRemoteModel(model.model_id)) continue;
    try {
      const result = await unloadModel(model.model_id);
      if (result.success) {
        await prisma.hostedModel.updateMany({
          where: { modelId: model.model_id },
          data: { status: "INACTIVE" },
        });
        unloaded.push(model.model_id);
      }
    } catch (error) {
      console.warn(
        `[engine] unload skipped for ${model.model_id}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  return unloaded;
}

/** Load / mark available the platform default. */
export async function warmPlatformDefaultModel(): Promise<void> {
  if (process.env.LLAMA_WARM_DEFAULT === "false") return;

  const defaultModel = await prisma.hostedModel.findFirst({
    where: { isPlatformDefault: true },
  });
  if (!defaultModel) return;

  if (isRemoteProviderKind(defaultModel.providerKind)) {
    if (process.env.LLAMA_SINGLE_DEFAULT !== "false") {
      const evicted = await unloadAllExcept(defaultModel.modelId);
      if (evicted.length > 0) {
        console.log(`[engine] evicted non-default local models: ${evicted.join(", ")}`);
      }
    }
    await prisma.hostedModel.update({
      where: { id: defaultModel.id },
      data: { status: "LOADED" },
    });
    console.log(`[engine] platform default is remote: ${defaultModel.modelId}`);
    return;
  }

  if (process.env.LLAMA_SINGLE_DEFAULT !== "false") {
    const evicted = await unloadAllExcept(defaultModel.modelId);
    if (evicted.length > 0) {
      console.log(`[engine] evicted non-default models: ${evicted.join(", ")}`);
    }
  }

  const resident = await listLoadedModels();
  if (resident.models.some((model) => model.model_id === defaultModel.modelId)) {
    if (defaultModel.status !== "LOADED") {
      await prisma.hostedModel.update({
        where: { id: defaultModel.id },
        data: { status: "LOADED" },
      });
    }
    return;
  }

  try {
    const result = await loadModel({
      model_id: defaultModel.modelId,
      weights_path: defaultModel.weightsPath,
      context_length: defaultModel.contextLength,
      n_threads: defaultModel.nThreads,
      quantization: defaultModel.quantization,
      use_mmap: true,
    });
    await prisma.hostedModel.update({
      where: { id: defaultModel.id },
      data: { status: result.success ? "LOADED" : "ERROR" },
    });
    if (result.success) {
      console.log(`[engine] platform default warmed: ${defaultModel.modelId}`);
    } else {
      console.warn(
        `[engine] platform default warm failed: ${defaultModel.modelId} — ${result.message ?? "unknown error"}`,
      );
    }
  } catch (error) {
    await prisma.hostedModel.update({
      where: { id: defaultModel.id },
      data: { status: "ERROR" },
    });
    console.warn(
      `[engine] platform default warm failed: ${defaultModel.modelId} — ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export function mapEngineFailure(err: unknown): { code: string; message: string } {
  if (err && typeof err === "object" && "name" in err && err.name === "RemoteEngineError") {
    return remoteOpenAi.mapRemoteError(err);
  }
  return isGrpcBackend() ? grpcBackend.mapGrpcError(err) : llamaBackend.mapEngineFailure(err);
}

export async function shutdownEngine(): Promise<void> {
  if (!isGrpcBackend()) await llamaBackend.shutdownAll();
}
