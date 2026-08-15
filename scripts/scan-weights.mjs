#!/usr/bin/env node
/**
 * Prints the GGUF files ModelForge can see under MODEL_WEIGHTS_DIR.
 * Useful for confirming the path resolves before registering a model.
 *
 *   pnpm weights:scan
 */
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(process.env.MODEL_WEIGHTS_DIR ?? "./data/models");
const SHARD = /-(\d{5})-of-(\d{5})$/;

async function walk(dir, depth, out) {
  if (depth > 4) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      await walk(absolute, depth + 1, out);
    } else if (entry.name.toLowerCase().endsWith(".gguf")) {
      const shard = entry.name.replace(/\.gguf$/i, "").match(SHARD);
      if (shard && Number(shard[1]) !== 1) continue;
      const info = await stat(absolute);
      out.push({
        relativePath: path.relative(root, absolute).split(path.sep).join("/"),
        sizeGb: (info.size / 1024 ** 3).toFixed(2),
      });
    }
  }
}

const found = [];
await walk(root, 0, found);

console.log(`MODEL_WEIGHTS_DIR resolves to:\n  ${root}\n`);
if (found.length === 0) {
  console.log("No .gguf files found. Copy weights there, or fix MODEL_WEIGHTS_DIR in .env.");
  process.exitCode = 1;
} else {
  console.log(`Found ${found.length} GGUF file(s):`);
  for (const file of found.sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
    console.log(`  ${file.sizeGb.padStart(6)} GB  ${file.relativePath}`);
  }
}
