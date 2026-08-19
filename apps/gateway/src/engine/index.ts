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

export function mapEngineFailure(err: unknown): { code: string; message: string } {
  return isGrpcBackend() ? grpcBackend.mapGrpcError(err) : llamaBackend.mapEngineFailure(err);
}

export async function shutdownEngine(): Promise<void> {
  if (!isGrpcBackend()) await llamaBackend.shutdownAll();
}
