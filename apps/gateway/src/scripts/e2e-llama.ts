/**
 * End-to-end check of the llama-server backend against a real GGUF.
 *
 *   pnpm --filter @modelforge/gateway e2e:llama
 *
 * Requires a running gateway and at least one GGUF under MODEL_WEIGHTS_DIR.
 */
import { prisma } from "@modelforge/db";
import { generateApiKey } from "../lib/keys.js";
import { scanWeights } from "../lib/weights.js";

const base = process.env.GATEWAY_BASE_URL ?? `http://localhost:${process.env.GATEWAY_PORT ?? 3000}`;
const internalToken = process.env.INTERNAL_SERVICE_TOKEN ?? "";

function log(step: string, detail = "") {
  console.log(`\u2022 ${step}${detail ? ` \u2014 ${detail}` : ""}`);
}

async function internal(path: string, init: RequestInit = {}) {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      "x-internal-token": internalToken,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

const health = await internal("/internal/engine/health");
log("engine health", `backend=${health.backend} cores=${health.physical_core_count}`);
if (health.backend !== "llama-server") {
  throw new Error(`Expected llama-server backend, got ${health.backend}`);
}

const discovered = await scanWeights();
if (discovered.length === 0) throw new Error("No GGUF files found under MODEL_WEIGHTS_DIR");
const target = discovered[0]!;
log("discovered weights", `${target.relativePath} (${target.quantization})`);

const registered = await internal("/internal/engine/models/register", {
  method: "POST",
  body: JSON.stringify({
    weightsPath: target.relativePath,
    modelId: target.suggestedModelId,
    displayName: target.suggestedDisplayName,
    quantization: target.quantization,
    contextLength: 4096,
    nThreads: 8,
  }),
});
const modelId: string = registered.modelId;
log("registered model", modelId);

// Entitle every plan so the test key can call the model.
const plans = await prisma.plan.findMany({ select: { id: true, allowedModelIds: true } });
await Promise.all(
  plans
    .filter((plan) => !plan.allowedModelIds.includes(modelId))
    .map((plan) =>
      prisma.plan.update({
        where: { id: plan.id },
        data: { allowedModelIds: [...plan.allowedModelIds, modelId] },
      }),
    ),
);
log("granted plan access", `${plans.length} plan(s)`);

// Must have an active subscription, otherwise auth/quota rejects the request.
const customer = await prisma.customer.findFirst({
  where: { subscription: { status: "ACTIVE" } },
  orderBy: { createdAt: "asc" },
});
if (!customer) throw new Error("No customer with an ACTIVE subscription - run pnpm db:seed");

const key = generateApiKey();
const apiKeyRow = await prisma.apiKey.create({
  data: {
    customerId: customer.id,
    keyHash: key.hash,
    keyPrefix: key.prefix,
    label: "e2e-llama",
  },
});
log("created api key", key.prefix);

async function chat(stream: boolean) {
  const started = Date.now();
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key.raw}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: "user", content: "What is the capital of France? One word." }],
      max_tokens: 300,
      temperature: 0,
      stream,
    }),
  });
  if (!res.ok) throw new Error(`chat(stream=${stream}) -> ${res.status}: ${await res.text()}`);

  if (!stream) {
    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: unknown;
    };
    return {
      content: body.choices?.[0]?.message?.content ?? "",
      usage: body.usage,
      ms: Date.now() - started,
    };
  }

  const text = await res.text();
  let content = "";
  let usage: unknown = null;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (data === "[DONE]") continue;
    const parsed = JSON.parse(data);
    content += parsed.choices?.[0]?.delta?.content ?? "";
    if (parsed.usage) usage = parsed.usage;
  }
  return { content, usage, ms: Date.now() - started };
}

try {
  const nonStream = await chat(false);
  log("non-streaming", `${nonStream.ms}ms | "${nonStream.content.trim()}"`);
  console.log("  usage:", JSON.stringify(nonStream.usage));
  if (!nonStream.content.trim()) throw new Error("Non-streaming returned empty content");

  const streamed = await chat(true);
  log("streaming", `${streamed.ms}ms | "${streamed.content.trim()}"`);
  console.log("  usage:", JSON.stringify(streamed.usage));
  if (!streamed.content.trim()) throw new Error("Streaming returned empty content");

  const loaded = await internal("/internal/engine/models");
  log("resident models", JSON.stringify(loaded.models ?? loaded));

  const usageRows = await prisma.usageEvent.count({ where: { customerId: customer.id } });
  log("usage events recorded", String(usageRows));

  console.log("\nllama-server backend E2E passed \u2713");
} finally {
  // Revoke rather than delete: usage events reference the key by foreign key.
  await prisma.apiKey
    .update({ where: { id: apiKeyRow.id }, data: { revokedAt: new Date() } })
    .catch(() => undefined);
  await prisma.$disconnect();
}
