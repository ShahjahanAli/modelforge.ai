import { describe, expect, it, afterAll } from "vitest";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  generateStream,
  healthCheck,
  listLoadedModels,
  loadModel,
  shutdownAll,
  unloadModel,
} from "./llamaServer.js";
import { scanWeights, weightsDir } from "../lib/weights.js";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const binary =
  process.env.LLAMA_SERVER_BIN ??
  path.join(
    repoRoot,
    "vendor",
    "llama.cpp",
    os.platform() === "win32" ? "llama-server.exe" : "llama-server",
  );

process.env.LLAMA_SERVER_BIN = binary;
process.env.MODEL_WEIGHTS_DIR ??= path.join(repoRoot, "data", "models");

const weights = existsSync(weightsDir()) ? await scanWeights() : [];
const canRun = existsSync(binary) && weights.length > 0;

afterAll(async () => {
  await shutdownAll();
});

describe.skipIf(!canRun)("llama-server backend", () => {
  const target = weights[0]!;
  const modelId = "e2e-test-model";

  it("loads a GGUF into its own process", async () => {
    const result = await loadModel({
      model_id: modelId,
      weights_path: target.relativePath,
      context_length: 2048,
      n_threads: 4,
      quantization: target.quantization,
      use_mmap: true,
    });

    expect(result.success).toBe(true);
    expect(result.ram_used_mb).toBeGreaterThan(0);
  }, 300_000);

  it("reports the model as resident", async () => {
    const { models } = await listLoadedModels();
    expect(models.map((m) => m.model_id)).toContain(modelId);
  });

  it("reports healthy with a RAM budget", async () => {
    const health = await healthCheck();
    expect(health.healthy).toBe(true);
    expect(health.loaded_model_count).toBeGreaterThan(0);
    expect(health.used_ram_mb).toBeGreaterThan(0);
  });

  it("completes a non-streaming request", async () => {
    let content = "";
    let final: { prompt_tokens: number; completion_tokens: number } | null = null;

    for await (const chunk of generateStream({
      model_id: modelId,
      messages: [{ role: "user", content: "Reply with exactly: ok" }],
      temperature: 0,
      max_tokens: 200,
      top_p: 1,
      stop_sequences: [],
      stream: false,
    })) {
      content += chunk.delta;
      if (chunk.is_final) final = chunk;
    }

    expect(content.length).toBeGreaterThan(0);
    expect(final?.prompt_tokens).toBeGreaterThan(0);
    expect(final?.completion_tokens).toBeGreaterThan(0);
  }, 240_000);

  it("streams deltas and ends with usage", async () => {
    const deltas: string[] = [];
    let final: { completion_tokens: number; finish_reason: string } | null = null;

    for await (const chunk of generateStream({
      model_id: modelId,
      messages: [{ role: "user", content: "Count: 1 2 3" }],
      temperature: 0,
      max_tokens: 200,
      top_p: 1,
      stop_sequences: [],
      stream: true,
    })) {
      if (chunk.is_final) final = chunk;
      else if (chunk.delta) deltas.push(chunk.delta);
    }

    expect(deltas.length).toBeGreaterThan(1);
    expect(final?.completion_tokens).toBeGreaterThan(0);
    expect(final?.finish_reason).toBeTruthy();
  }, 240_000);

  it("unloads and frees the slot", async () => {
    await unloadModel(modelId);
    const { models } = await listLoadedModels();
    expect(models.map((m) => m.model_id)).not.toContain(modelId);
  }, 30_000);
});
