#!/usr/bin/env node
/**
 * Downloads prebuilt llama.cpp binaries so ModelForge can serve models without a
 * C++ toolchain. This is the LM Studio approach: ship/fetch binaries rather than
 * compiling llama.cpp on the user's machine.
 *
 *   pnpm llama:fetch              # latest CPU build for this platform
 *   LLAMA_RELEASE_TAG=b10441 pnpm llama:fetch
 *
 * Set LLAMA_VARIANT to pick an accelerated build (e.g. cuda-12.4, vulkan).
 */
import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile, readdir, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const REPO = "ggml-org/llama.cpp";
const root = path.resolve(import.meta.dirname, "..");
const vendorDir = path.join(root, "vendor", "llama.cpp");
const variant = process.env.LLAMA_VARIANT ?? "cpu";

function assetPattern() {
  const arch = os.arch() === "arm64" ? "arm64" : "x64";
  switch (os.platform()) {
    case "win32":
      return new RegExp(`bin-win-${variant}-${arch}\\.zip$`);
    case "linux": {
      const variantPart = variant === "cpu" ? "" : `${variant}-`;
      return new RegExp(`bin-ubuntu-${variantPart}${arch}\\.tar\\.gz$`);
    }
    case "darwin":
      return new RegExp(`bin-macos-${arch}\\.tar\\.gz$`);
    default:
      throw new Error(`Unsupported platform: ${os.platform()}`);
  }
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "modelforge-setup",
      ...(process.env.GITHUB_TOKEN
        ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
        : {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
  return res.json();
}

function extract(archivePath, destination) {
  if (os.platform() === "win32") {
    execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${destination}' -Force`,
      ],
      { stdio: "inherit" },
    );
  } else if (archivePath.endsWith(".tar.gz") || archivePath.endsWith(".tgz")) {
    execFileSync("tar", ["-xzf", archivePath, "-C", destination], { stdio: "inherit" });
  } else {
    execFileSync("unzip", ["-o", "-q", archivePath, "-d", destination], { stdio: "inherit" });
  }
}

/** llama.cpp zips are sometimes flat, sometimes nested in build/bin. */
async function findServerBinary(dir) {
  const target = os.platform() === "win32" ? "llama-server.exe" : "llama-server";
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(absolute);
      else if (entry.name === target) return absolute;
    }
  }
  return null;
}

const pattern = assetPattern();

/**
 * ggml-org/llama.cpp marks a semantic tag (e.g. v0.2.0) as GitHub "latest", but
 * the shippable binaries live on numbered builds (b9876, …). Prefer an explicit
 * LLAMA_RELEASE_TAG; otherwise scan recent releases for a matching asset.
 */
async function resolveReleaseWithAsset() {
  const tag = process.env.LLAMA_RELEASE_TAG;
  if (tag) {
    const release = await fetchJson(
      `https://api.github.com/repos/${REPO}/releases/tags/${tag}`,
    );
    const asset = release.assets.find((a) => pattern.test(a.name));
    if (!asset) {
      console.error(`No asset matching ${pattern} in release ${release.tag_name}.`);
      console.error("Available:", release.assets.map((a) => a.name).join("\n  "));
      process.exit(1);
    }
    return { release, asset };
  }

  const pages = [
    `https://api.github.com/repos/${REPO}/releases?per_page=40`,
  ];
  for (const url of pages) {
    const releases = await fetchJson(url);
    for (const release of releases) {
      const asset = release.assets?.find((a) => pattern.test(a.name));
      if (asset) return { release, asset };
    }
  }

  console.error(`No recent ${REPO} release has an asset matching ${pattern}.`);
  console.error("Set LLAMA_RELEASE_TAG=bNNNN (e.g. b9876) and retry.");
  process.exit(1);
}

const { release, asset } = await resolveReleaseWithAsset();

console.log(`Release ${release.tag_name}`);
console.log(`Asset    ${asset.name} (${(asset.size / 1024 ** 2).toFixed(1)} MB)`);

await rm(vendorDir, { recursive: true, force: true });
await mkdir(vendorDir, { recursive: true });

const zipPath = path.join(os.tmpdir(), asset.name);
console.log("Downloading...");
const download = await fetch(asset.browser_download_url, {
  headers: { "User-Agent": "modelforge-setup" },
});
if (!download.ok) throw new Error(`Download failed: ${download.status}`);
await writeFile(zipPath, Buffer.from(await download.arrayBuffer()));

console.log("Extracting...");
extract(zipPath, vendorDir);
await rm(zipPath, { force: true });

const binary = await findServerBinary(vendorDir);
if (!binary) {
  console.error("llama-server binary not found in the extracted archive.");
  process.exit(1);
}
if (os.platform() !== "win32") await chmod(binary, 0o755);

await writeFile(
  path.join(vendorDir, "RELEASE.json"),
  `${JSON.stringify({ tag: release.tag_name, asset: asset.name, variant, binary }, null, 2)}\n`,
);

console.log(`\nReady: ${binary}`);
if (!existsSync(path.join(root, ".env"))) {
  console.log("Reminder: create .env from .env.example.");
}
console.log("Set LLAMA_SERVER_BIN in .env to the path above if it differs from the default.");
