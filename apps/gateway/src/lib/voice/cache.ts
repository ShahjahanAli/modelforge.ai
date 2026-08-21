import { existsSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function whisperHubRepoId(model: string): string {
  return model.includes("/") ? model : `Systran/faster-whisper-${model}`;
}

function hubSnapshotsDir(repoId: string): string {
  const hfHome = process.env.HF_HOME?.trim() || path.join(os.homedir(), ".cache", "huggingface");
  const dirname = `models--${repoId.replaceAll("/", "--")}`;
  return path.join(hfHome, "hub", dirname, "snapshots");
}

/** True when HF hub cache already has Whisper CTranslate2 weights for this model. */
export function isWhisperModelCachedOnDisk(model: string): boolean {
  const snapshots = hubSnapshotsDir(whisperHubRepoId(model));
  if (!existsSync(snapshots)) return false;
  let snaps: string[];
  try {
    snaps = readdirSync(snapshots);
  } catch {
    return false;
  }
  for (const snap of snaps) {
    const root = path.join(snapshots, snap);
    if (existsSync(path.join(root, "model.bin")) || existsSync(path.join(root, "model.safetensors"))) {
      return true;
    }
  }
  return false;
}

/** True when a Hugging Face NeMo ASR repo snapshot is present locally. */
export function isHfRepoCachedOnDisk(repoId: string): boolean {
  const snapshots = hubSnapshotsDir(repoId);
  if (!existsSync(snapshots)) return false;
  let snaps: string[];
  try {
    snaps = readdirSync(snapshots);
  } catch {
    return false;
  }
  for (const snap of snaps) {
    const root = path.join(snapshots, snap);
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    if (entries.some((name) => name.toLowerCase().endsWith(".nemo"))) return true;
    if (
      entries.some((name) => name === "model_config.yaml" || name === "config.json") &&
      entries.some((name) =>
        [".ckpt", ".pt", ".bin", ".safetensors", ".nemo"].some((ext) => name.toLowerCase().endsWith(ext)),
      )
    ) {
      return true;
    }
    // Any large file in the snapshot tree counts as downloaded.
    try {
      for (const name of entries) {
        const full = path.join(root, name);
        try {
          if (statSync(full).isFile() && statSync(full).size > 1_000_000) return true;
        } catch {
          // continue
        }
      }
    } catch {
      // continue
    }
  }
  return false;
}
