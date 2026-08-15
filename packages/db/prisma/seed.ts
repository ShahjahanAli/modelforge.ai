import { createHash, randomBytes } from "node:crypto";
import { PrismaClient, UserRole, BillingMode, SubscriptionStatus } from "@prisma/client";

const prisma = new PrismaClient();

function hashPassword(password: string): string {
  // Seed accounts: verified by web auth via seedsha256: prefix
  return `seedsha256:${createHash("sha256").update(`modelforge-seed:${password}`).digest("hex")}`;
}

function hashApiKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

async function main() {
  const free = await prisma.plan.upsert({
    where: { name: "free" },
    update: {},
    create: {
      name: "free",
      displayName: "Free",
      monthlyTokenQuota: 100_000n,
      requestsPerMinute: 10,
      maxConcurrent: 1,
      priceCentsMonthly: 0,
      billingMode: BillingMode.SUBSCRIPTION,
      allowedModelIds: ["zms-coder-7b"],
    },
  });

  const pro = await prisma.plan.upsert({
    where: { name: "pro" },
    update: {},
    create: {
      name: "pro",
      displayName: "Pro",
      monthlyTokenQuota: 5_000_000n,
      requestsPerMinute: 60,
      maxConcurrent: 2,
      priceCentsMonthly: 4900,
      overagePerMTokIn: 50,
      overagePerMTokOut: 150,
      billingMode: BillingMode.SUBSCRIPTION,
      allowedModelIds: ["zms-coder-7b", "zms-chat-13b"],
    },
  });

  const enterprise = await prisma.plan.upsert({
    where: { name: "enterprise" },
    update: {},
    create: {
      name: "enterprise",
      displayName: "Enterprise",
      monthlyTokenQuota: 0n,
      requestsPerMinute: 300,
      maxConcurrent: 8,
      priceCentsMonthly: 0,
      billingMode: BillingMode.USAGE,
      allowedModelIds: ["zms-coder-7b", "zms-chat-13b"],
    },
  });

  const coder = await prisma.hostedModel.upsert({
    where: { modelId: "zms-coder-7b" },
    update: {},
    create: {
      modelId: "zms-coder-7b",
      displayName: "ZMS Coder 7B",
      weightsPath: "zms-coder-7b.Q4_K_M.gguf",
      quantization: "Q4_K_M",
      contextLength: 8192,
      nThreads: 8,
      gpuLayers: 0,
      status: "INACTIVE",
      pricePerMTokIn: 20,
      pricePerMTokOut: 60,
      expectedTokPerSec: 18,
    },
  });

  await prisma.hostedModel.upsert({
    where: { modelId: "zms-chat-13b" },
    update: {},
    create: {
      modelId: "zms-chat-13b",
      displayName: "ZMS Chat 13B",
      weightsPath: "zms-chat-13b.Q4_K_M.gguf",
      quantization: "Q4_K_M",
      contextLength: 8192,
      nThreads: 10,
      gpuLayers: 0,
      status: "INACTIVE",
      pricePerMTokIn: 40,
      pricePerMTokOut: 120,
      expectedTokPerSec: 8,
    },
  });

  const admin = await prisma.customer.upsert({
    where: { email: "admin@modelforge.local" },
    update: {},
    create: {
      email: "admin@modelforge.local",
      name: "Admin",
      passwordHash: hashPassword("admin123"),
      role: UserRole.ADMIN,
    },
  });

  const customer = await prisma.customer.upsert({
    where: { email: "demo@modelforge.local" },
    update: {},
    create: {
      email: "demo@modelforge.local",
      name: "Demo Customer",
      passwordHash: hashPassword("demo123"),
      role: UserRole.CUSTOMER,
    },
  });

  const now = new Date();
  const periodEnd = new Date(now);
  periodEnd.setMonth(periodEnd.getMonth() + 1);

  await prisma.subscription.upsert({
    where: { customerId: customer.id },
    update: {},
    create: {
      customerId: customer.id,
      planId: pro.id,
      status: SubscriptionStatus.ACTIVE,
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
    },
  });

  await prisma.quotaLedger.upsert({
    where: { customerId: customer.id },
    update: {},
    create: {
      customerId: customer.id,
      periodStart: now,
      periodEnd,
      tokensUsed: 0n,
    },
  });

  const rawKey = `mf_${randomBytes(24).toString("hex")}`;
  const existingKey = await prisma.apiKey.findFirst({
    where: { customerId: customer.id, label: "seed-demo" },
  });
  if (!existingKey) {
    await prisma.apiKey.create({
      data: {
        customerId: customer.id,
        keyHash: hashApiKey(rawKey),
        keyPrefix: rawKey.slice(0, 10),
        label: "seed-demo",
      },
    });
  }

  console.log("Seed complete");
  console.log(`Admin: admin@modelforge.local / admin123 (${admin.id})`);
  console.log(`Customer: demo@modelforge.local / demo123 (${customer.id})`);
  console.log(`Plans: free=${free.id}, pro=${pro.id}, enterprise=${enterprise.id}`);
  console.log(`Model: ${coder.modelId}`);
  if (!existingKey) {
    console.log(`Demo API key (store now, shown once): ${rawKey}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
