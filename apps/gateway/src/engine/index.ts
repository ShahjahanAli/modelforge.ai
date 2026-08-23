import * as grpcBackend from "../grpc/client.js";
import * as llamaBackend from "./llamaServer.js";
import { prisma } from "@modelforge/db";

export type { GenerateChunk, HealthStatus, LoadedModel } from "../grpc/client.js";

/**
 * Two interchangeable inference backends:
 *
 * - `llama-server` (default) spawns prebuilt llama.cpp binaries, so no C++
 *   toolchain is needed. This is how LM Studio works and is the local default.
 * - `grpc` talks to the Rust inference engine, which compiles llama.cpp in-process
 *   and adds custom continuous batching. Useful where a toolchain is available.
 */
export type InferenceBackend = "llama-server" | "grpc";

export function activeBackend(): InferenceBackend {
  return process.env.INFERENCE_BACKEND === "grpc" ? "grpc" : "llama-server";
}

const isGrpcBackend = () => activeBackend() === "grpc";

export const generateStream: typeof grpcBackend.generateStream = (req, url, options) =>
  isGrpcBackend()
    ? grpcBackend.generateStream(req, url, options)
    : llamaBackend.generateStream(req, url, options);

export const loadModel: typeof grpcBackend.loadModel = (req) =>
  isGrpcBackend() ? grpcBackend.loadModel(req) : llamaBackend.loadModel(req);

export const unloadModel: typeof grpcBackend.unloadModel = (modelId) =>
  isGrpcBackend() ? grpcBackend.unloadModel(modelId) : llamaBackend.unloadModel(modelId);

export const listLoadedModels: typeof grpcBackend.listLoadedModels = () =>
  isGrpcBackend() ? grpcBackend.listLoadedModels() : llamaBackend.listLoadedModels();

export const healthCheck: typeof grpcBackend.healthCheck = () =>
  isGrpcBackend() ? grpcBackend.healthCheck() : llamaBackend.healthCheck();

/** Makes persisted registry state match the selected backend's live pool. */
export async function reconcileModelRegistry(): Promise<void> {
  const residentIds = (await listLoadedModels()).models.map((model) => model.model_id);
  await prisma.$transaction([
    prisma.hostedModel.updateMany({
      where: {
        status: "LOADED",
        ...(residentIds.length > 0 ? { modelId: { notIn: residentIds } } : {}),
      },
      data: { status: "INACTIVE" },
    }),
    ...(residentIds.length > 0
      ? [
          prisma.hostedModel.updateMany({
            where: { modelId: { in: residentIds } },
            data: { status: "LOADED" as const },
          }),
        ]
      : []),
  ]);
}

/** Unload every resident model except `keepModelId` (best-effort). */
export async function unloadAllExcept(keepModelId: string): Promise<string[]> {
  const resident = await listLoadedModels();
  const unloaded: string[] = [];
  for (const model of resident.models) {
    if (model.model_id === keepModelId) continue;
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

/** Load the platform default into the pool if it is registered but not resident. */
export async function warmPlatformDefaultModel(): Promise<void> {
  if (process.env.LLAMA_WARM_DEFAULT === "false") return;

  const defaultModel = await prisma.hostedModel.findFirst({
    where: { isPlatformDefault: true },
  });
  if (!defaultModel) return;

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
  return isGrpcBackend() ? grpcBackend.mapGrpcError(err) : llamaBackend.mapEngineFailure(err);
}

export async function shutdownEngine(): Promise<void> {
  if (!isGrpcBackend()) await llamaBackend.shutdownAll();
}
