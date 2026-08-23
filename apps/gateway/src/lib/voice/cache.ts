import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Hugging Face Whisper fine-tunes stored in Transformers format (converted to local CT2). */
const TRANSFORMERS_WHISPER_HF_MODELS = new Set([
  "bengaliAI/tugstugi_bengaliai-regional-asr_whisper-medium",
]);

export function whisperHubRepoId(model: string): string {
  return model.includes("/") ? model : `Systran/faster-whisper-${model}`;
}

function repoRoot(): string {
  return path.resolve(import.meta.dirname, "../../../../..");
}

function ct2LocalDir(model: string): string {
  return path.join(repoRoot(), "data", "voice", "ct2", model.replaceAll("/", "--"));
}

function hubSnapshotsDir(repoId: string): string {
  const hfHome = process.env.HF_HOME?.trim() || path.join(os.homedir(), ".cache", "huggingface");
  const dirname = `models--${repoId.replaceAll("/", "--")}`;
  return path.join(hfHome, "hub", dirname, "snapshots");
}

function isCt2WeightsDir(root: string): boolean {
  if (existsSync(path.join(root, "model.bin"))) return true;
  const safetensors = path.join(root, "model.safetensors");
  if (!existsSync(safetensors)) return false;
  const configPath = path.join(root, "config.json");
  if (!existsSync(configPath)) return true;
  try {
    const config = JSON.parse(readFileSync(configPath, "utf8")) as { architectures?: string[] };
    const architectures = config.architectures ?? [];
    if (architectures.length === 0) return true;
    return !architectures.some((entry) => entry.includes("Whisper"));
  } catch {
    return true;
  }
}

/** True when HF hub cache already has Whisper CTranslate2 weights for this model. */
export function isWhisperModelCachedOnDisk(model: string): boolean {
  const localCt2 = ct2LocalDir(model);
  if (isCt2WeightsDir(localCt2)) return true;

  if (TRANSFORMERS_WHISPER_HF_MODELS.has(model)) {
    return false;
  }

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
    if (isCt2WeightsDir(root)) return true;
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
