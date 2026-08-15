import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { scanWeights, isKnownWeightPath } from "./weights.js";

let dir: string;
const originalEnv = process.env.MODEL_WEIGHTS_DIR;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "mf-weights-"));
  process.env.MODEL_WEIGHTS_DIR = dir;

  await mkdir(path.join(dir, "LiquidAI", "LFM2.5-2.6B-GGUF"), { recursive: true });
  await writeFile(
    path.join(dir, "LiquidAI", "LFM2.5-2.6B-GGUF", "LFM2.5-2.6B-Q5_K_M.gguf"),
    "x",
  );
  await writeFile(path.join(dir, "qwen2.5-7b-instruct-q4_k_m.gguf"), "x");
  await writeFile(path.join(dir, "notes.txt"), "ignore me");

  // Sharded model: only the first part should be surfaced.
  await writeFile(path.join(dir, "big-model-Q4_K_M-00001-of-00003.gguf"), "x");
  await writeFile(path.join(dir, "big-model-Q4_K_M-00002-of-00003.gguf"), "x");
  await writeFile(path.join(dir, "big-model-Q4_K_M-00003-of-00003.gguf"), "x");
});

afterAll(async () => {
  process.env.MODEL_WEIGHTS_DIR = originalEnv;
  await rm(dir, { recursive: true, force: true });
});

describe("scanWeights", () => {
  it("finds GGUF files in nested folders and ignores other files", async () => {
    const files = await scanWeights();
    const paths = files.map((f) => f.relativePath);

    expect(paths).toContain("LiquidAI/LFM2.5-2.6B-GGUF/LFM2.5-2.6B-Q5_K_M.gguf");
    expect(paths).toContain("qwen2.5-7b-instruct-q4_k_m.gguf");
    expect(paths.some((p) => p.endsWith("notes.txt"))).toBe(false);
  });

  it("infers quantization, slug, and display name", async () => {
    const files = await scanWeights();
    const liquid = files.find((f) => f.fileName.startsWith("LFM2.5"))!;

    expect(liquid.quantization).toBe("Q5_K_M");
    expect(liquid.suggestedModelId).toBe("lfm2-5-2-6b");
    expect(liquid.suggestedDisplayName).toBe("LFM2.5 2.6B");
  });

  it("reports a sharded model once with its shard count", async () => {
    const files = await scanWeights();
    const shards = files.filter((f) => f.fileName.startsWith("big-model"));

    expect(shards).toHaveLength(1);
    expect(shards[0]!.shardCount).toBe(3);
    expect(shards[0]!.quantization).toBe("Q4_K_M");
  });

  it("validates paths against the scan", async () => {
    expect(await isKnownWeightPath("qwen2.5-7b-instruct-q4_k_m.gguf")).toBe(true);
    expect(await isKnownWeightPath("../../../etc/passwd")).toBe(false);
  });
});
