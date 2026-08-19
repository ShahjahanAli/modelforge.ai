import { readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";

/** Depth cap so a misconfigured weights dir can never walk an entire drive. */
const MAX_DEPTH = 4;
const SKIP_DIRS = new Set([".git", "node_modules", ".cache", "target", ".tmp"]);

const QUANT_PATTERN =
  /(IQ\d[A-Z0-9_]*|Q\d[A-Z0-9_]*(?:_[A-Z0-9]+)*|BF16|F16|F32)(?=[.\-_]|$)/i;
/** llama.cpp shard naming, e.g. model-00001-of-00003.gguf */
const SHARD_PATTERN = /-(\d{5})-of-(\d{5})$/;

export interface DiscoveredWeight {
  relativePath: string;
  fileName: string;
  sizeBytes: number;
  quantization: string;
  suggestedModelId: string;
  suggestedDisplayName: string;
  shardCount: number;
}

export function weightsDir(): string {
  return path.resolve(process.env.MODEL_WEIGHTS_DIR ?? "./data/models");
}

function toSlug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "model"
  );
}

function describe(relativePath: string, sizeBytes: number): DiscoveredWeight {
  const fileName = path.basename(relativePath);
  let base = fileName.replace(/\.gguf$/i, "");

  const shard = base.match(SHARD_PATTERN);
  const shardCount = shard ? Number(shard[2]) : 1;
  if (shard) base = base.replace(SHARD_PATTERN, "");

  const quantMatch = base.match(QUANT_PATTERN);
  const quantization = quantMatch ? quantMatch[1]!.toUpperCase() : "unknown";
  if (quantMatch) {
    base = base.slice(0, quantMatch.index).replace(/[.\-_]+$/, "") || base;
  }

  return {
    relativePath,
    fileName,
    sizeBytes,
    quantization,
    suggestedModelId: toSlug(base),
    suggestedDisplayName: base.replace(/[-_]+/g, " ").trim() || fileName,
    shardCount,
  };
}

/**
 * Recursively lists GGUF files under MODEL_WEIGHTS_DIR. Multi-part models are
 * reported once, via their first shard, since that is what llama.cpp opens.
 */
export async function scanWeights(): Promise<DiscoveredWeight[]> {
  const root = weightsDir();
  const found: DiscoveredWeight[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        await walk(absolute, depth + 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".gguf")) continue;

      const withoutExt = entry.name.replace(/\.gguf$/i, "");
      const shard = withoutExt.match(SHARD_PATTERN);
      if (shard && Number(shard[1]) !== 1) continue;

      const info = await stat(absolute).catch(() => null);
      if (!info) continue;

      const relativePath = path.relative(root, absolute).split(path.sep).join("/");
      found.push(describe(relativePath, info.size));
    }
  }

  await walk(root, 0);
  return found.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

/** Confirms a client-supplied path is a GGUF that actually exists in the scan. */
export async function isKnownWeightPath(relativePath: string): Promise<boolean> {
  const files = await scanWeights();
  return files.some((file) => file.relativePath === relativePath);
}

function resolveInsideWeightsDir(relativePath: string): string {
  const root = path.resolve(weightsDir());
  const target = path.resolve(root, relativePath);
  const inside = path.relative(root, target);
  if (!inside || inside.startsWith("..") || path.isAbsolute(inside)) {
    throw new Error("Refusing to delete weights outside MODEL_WEIGHTS_DIR");
  }
  return target;
}

/** Deletes a registered GGUF and any llama.cpp shards that share its prefix. */
export async function deleteRegisteredWeights(relativePath: string): Promise<string[]> {
  const target = resolveInsideWeightsDir(relativePath);
  const root = path.resolve(weightsDir());
  const dir = path.dirname(target);
  const fileName = path.basename(target);
  const base = fileName.replace(/\.gguf$/i, "");
  const shard = base.match(SHARD_PATTERN);
  const names = shard
    ? Array.from({ length: Number(shard[2]) }, (_, index) => {
        const n = String(index + 1).padStart(5, "0");
        return `${base.replace(SHARD_PATTERN, "")}-${n}-of-${shard[2]}.gguf`;
      })
    : [fileName];

  const deleted: string[] = [];
  for (const name of names) {
    const file = path.join(dir, name);
    const inside = path.relative(root, file);
    if (!inside || inside.startsWith("..") || path.isAbsolute(inside)) continue;
    try {
      await unlink(file);
      deleted.push(inside.split(path.sep).join("/"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return deleted;
}
