/**
 * Prints the model registry and plan entitlements straight from Postgres.
 *
 *   pnpm --filter @modelforge/gateway registry:status
 */
import { prisma } from "@modelforge/db";

const models = await prisma.hostedModel.findMany({
  select: {
    modelId: true,
    displayName: true,
    status: true,
    quantization: true,
    contextLength: true,
    expectedTokPerSec: true,
    weightsPath: true,
  },
  orderBy: { createdAt: "asc" },
});

console.log("\nHosted models");
console.table(
  models.map((m) => ({
    slug: m.modelId,
    name: m.displayName,
    status: m.status,
    quant: m.quantization,
    ctx: m.contextLength,
    "tok/s": m.expectedTokPerSec ?? "(unset)",
  })),
);

const plans = await prisma.plan.findMany({
  select: { name: true, allowedModelIds: true },
  orderBy: { name: "asc" },
});

console.log("Plan entitlements");
console.table(plans.map((p) => ({ plan: p.name, allowedModels: p.allowedModelIds.join(", ") })));

const customers = await prisma.customer.findMany({
  select: {
    email: true,
    role: true,
    subscription: { select: { status: true, plan: { select: { name: true } } } },
  },
  orderBy: { createdAt: "asc" },
});

console.log("Customers");
console.table(
  customers.map((c) => ({
    email: c.email,
    role: c.role,
    plan: c.subscription?.plan.name ?? "(no subscription)",
    subscription: c.subscription?.status ?? "-",
  })),
);

await prisma.$disconnect();
