import { prisma, type HostedModel } from "@modelforge/db";
import { loadModel, listLoadedModels, unloadAllExcept } from "../engine/index.js";

export class AnusandhanClientError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status = 503,
  ) {
    super(message);
    this.name = "AnusandhanClientError";
  }
}

/** Anusandhan LLM calls always use the platform default — never open auto routing. */
export async function resolveAnusandhanPlatformDefault(): Promise<HostedModel> {
  const hosted = await prisma.hostedModel.findFirst({
    where: { isPlatformDefault: true },
  });
  if (!hosted) {
    throw new AnusandhanClientError(
      "No platform default model configured — set one in Admin → Model Registry",
      "NO_DEFAULT_MODEL",
      503,
    );
  }
  return hosted;
}

/**
 * Evict every other resident GGUF and warm the platform default before Anusandhan LLM work.
 * Prevents BanglaLLM / cheapest-auto models from staying loaded for this client.
 */
export async function prepareAnusandhanLlmPool(): Promise<HostedModel> {
  const hosted = await resolveAnusandhanPlatformDefault();

  if (process.env.LLAMA_SINGLE_DEFAULT !== "false") {
    const evicted = await unloadAllExcept(hosted.modelId);
    if (evicted.length > 0) {
      console.log(
        JSON.stringify({
          event: "anusandhan.pool.evicted",
          kept: hosted.modelId,
          evicted,
        }),
      );
    }
  }

  const resident = await listLoadedModels();
  if (!resident.models.some((model) => model.model_id === hosted.modelId)) {
    const result = await loadModel({
      model_id: hosted.modelId,
      weights_path: hosted.weightsPath,
      context_length: hosted.contextLength,
      n_threads: hosted.nThreads,
      quantization: hosted.quantization,
      use_mmap: process.env.USE_MMAP !== "false",
    });
    if (!result.success) {
      const detail =
        typeof (result as { message?: unknown }).message === "string" &&
        (result as { message: string }).message.length > 0
          ? (result as { message: string }).message
          : `Failed to load platform default ${hosted.modelId}`;
      throw new AnusandhanClientError(detail, "MODEL_UNAVAILABLE", 503);
    }
    await prisma.hostedModel.update({
      where: { id: hosted.id },
      data: { status: "LOADED" },
    });
  }

  return hosted;
}

export function assertAnusandhanClientHeader(req: { header(name: string): string | undefined }): void {
  const required = process.env.ANUSANDHAN_REQUIRE_CLIENT_HEADER === "true";
  if (!required) return;
  const client = (req.header("x-modelforge-client") ?? "").trim().toLowerCase();
  if (client !== "anusandhan") {
    throw new AnusandhanClientError(
      "Missing or invalid x-modelforge-client header (expected: anusandhan)",
      "invalid_client",
      403,
    );
  }
}
