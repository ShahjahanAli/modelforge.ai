import { createHash, createHmac } from "node:crypto";
import { prisma } from "../packages/db/dist/index.js";

const gateway = process.env.GATEWAY_INTERNAL_URL ?? "http://localhost:3000";
const serviceToken = process.env.INTERNAL_SERVICE_TOKEN;
if (!serviceToken) throw new Error("INTERNAL_SERVICE_TOKEN is required");

const customer = await prisma.customer.findFirst({
  where: { role: "CUSTOMER", subscription: { status: "ACTIVE" } },
});
if (!customer) throw new Error("No active subscriber found");

await prisma.coreTraceSession.updateMany({
  where: { customerId: customer.id, status: "ARMED" },
  data: { status: "CANCELLED" },
});
const trace = await prisma.coreTraceSession.create({
  data: { customerId: customer.id, expiresAt: new Date(Date.now() + 600_000) },
});

try {
  const arm = await fetch(`${gateway}/internal/diagnostics/traces/${trace.id}/arm`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-internal-token": serviceToken },
    body: JSON.stringify({ customerId: customer.id }),
  });
  if (!arm.ok) throw new Error(`Arm failed: ${arm.status} ${await arm.text()}`);

  const rawKey = `mf_dash_${createHmac("sha256", serviceToken).update(customer.id).digest("hex")}`;
  const keyHash = createHash("sha256").update(rawKey).digest("hex");
  await prisma.apiKey.upsert({
    where: { keyHash },
    update: { revokedAt: null, scopes: ["chat"] },
    create: {
      customerId: customer.id,
      keyHash,
      keyPrefix: rawKey.slice(0, 12),
      label: "core-inspector-e2e",
      scopes: ["chat"],
    },
  });

  const response = await fetch(`${gateway}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${rawKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "auto",
      messages: [{ role: "user", content: "Reply with OK." }],
      max_tokens: 8,
      temperature: 0,
      stream: false,
    }),
  });
  if (!response.ok) throw new Error(`Inference failed: ${response.status} ${await response.text()}`);

  const captured = await prisma.coreTraceSession.findUnique({
    where: { id: trace.id },
    include: { events: { orderBy: { sequence: "asc" } } },
  });
  if (captured?.status !== "COMPLETED") {
    throw new Error(`Expected COMPLETED trace, received ${captured?.status ?? "missing"}`);
  }
  const kinds = captured.events.map((event) => event.kind);
  for (const required of [
    "request.received",
    "quota.reserved",
    "model.resolved",
    "engine.dispatched",
    "token.first",
    "request.completed",
  ]) {
    if (!kinds.includes(required)) throw new Error(`Missing trace event: ${required}`);
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        traceId: trace.id,
        requestId: captured.requestId,
        status: captured.status,
        events: kinds,
      },
      null,
      2,
    ),
  );
} finally {
  await prisma.$disconnect();
}
