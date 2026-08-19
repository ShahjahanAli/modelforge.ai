#!/usr/bin/env node
/**
 * Reports inference engine state and can warm a model, without the dashboard.
 *
 *   pnpm engine:status                 # health + registry + resident models
 *   pnpm engine:status <model-slug>    # also load that model
 *   pnpm engine:status <slug> --unload
 */
const base = process.env.GATEWAY_INTERNAL_URL ?? "http://localhost:9000";
const token = process.env.INTERNAL_SERVICE_TOKEN;

if (!token) {
  console.error("INTERNAL_SERVICE_TOKEN is not set. Run via: pnpm engine:status");
  process.exit(1);
}

const headers = { "x-internal-token": token, "content-type": "application/json" };
const [slug, ...flags] = process.argv.slice(2);
const unload = flags.includes("--unload");

async function call(path, init = {}) {
  const res = await fetch(`${base}${path}`, { ...init, headers });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, ok: res.ok, body };
}

function section(title) {
  console.log(`\n${title}`);
  console.log("-".repeat(title.length));
}

section("Engine health");
const health = await call("/internal/engine/health");
if (health.ok) {
  const h = health.body;
  console.log(`backend        : ${h.backend}`);
  console.log(`healthy        : ${h.healthy}`);
  console.log(`RAM budget     : ${h.used_ram_mb} / ${h.total_ram_mb} MB used`);
  console.log(`resident models: ${h.loaded_model_count}`);
  console.log(`logical CPUs   : ${h.logical_core_count ?? h.physical_core_count}`);
  if (h.cpu_model) console.log(`CPU            : ${h.cpu_model}`);
  if (h.cpu_usage_percent !== undefined)
    console.log(`CPU utilization: ${h.cpu_usage_percent}%`);
  if (h.host_total_ram_mb !== undefined)
    console.log(
      `host memory    : ${(h.host_total_ram_mb - (h.host_free_ram_mb ?? 0)).toLocaleString()} / ${h.host_total_ram_mb.toLocaleString()} MB`,
    );
  if (h.gateway_rss_mb !== undefined) console.log(`gateway RSS    : ${h.gateway_rss_mb} MB`);
  if (h.host_uptime_seconds !== undefined)
    console.log(`host uptime    : ${Math.floor(h.host_uptime_seconds / 3600)}h`);
  if (h.platform)
    console.log(`host platform  : ${h.platform} ${h.platform_release} (${h.arch})`);
} else {
  console.log(`HTTP ${health.status}`);
  console.log(health.body);
}

section("Registered models (Postgres)");
const registry = await call("/internal/engine/models/available");
if (registry.ok) {
  console.log(`weights dir: ${registry.body.weightsDir}`);
  for (const file of registry.body.files) {
    const state = file.registeredAs ? `registered as ${file.registeredAs}` : "NOT REGISTERED";
    console.log(`  ${file.relativePath}\n    ${file.quantization} | ${state}`);
  }
  if (registry.body.files.length === 0) console.log("  (no GGUF files found)");
} else {
  console.log(`HTTP ${registry.status}`);
  console.log(registry.body);
}

if (slug) {
  section(unload ? `Unloading ${slug}` : `Loading ${slug}`);
  const started = Date.now();
  const result = await call(`/internal/engine/models/${slug}/${unload ? "unload" : "load"}`, {
    method: "POST",
  });
  console.log(`HTTP ${result.status} in ${Date.now() - started}ms`);
  console.log(JSON.stringify(result.body, null, 2));
}

section("Resident in model pool");
const resident = await call("/internal/engine/models");
if (resident.ok) {
  const models = resident.body.models ?? [];
  if (models.length === 0) console.log("  (none resident)");
  for (const m of models) {
    console.log(
      `  ${m.model_id} | ${m.ram_used_mb} MB | active=${m.active_requests} | ${m.tokens_per_sec_avg} tok/s avg`,
    );
  }
} else {
  console.log(`HTTP ${resident.status}`);
  console.log(resident.body);
}
console.log();
