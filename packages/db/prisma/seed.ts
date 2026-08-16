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

  // Modern platform defaults
  for (const model of await prisma.hostedModel.findMany()) {
    await prisma.pricingVersion.create({
      data: {
        hostedModelId: model.id,
        pricePerMTokIn: model.pricePerMTokIn,
        pricePerMTokOut: model.pricePerMTokOut,
      },
    }).catch(() => undefined);
    await prisma.modelRevision.upsert({
      where: { hostedModelId_revision: { hostedModelId: model.id, revision: "v1" } },
      update: {},
      create: { hostedModelId: model.id, revision: "v1", changelog: "Seed revision" },
    });
  }

  for (const plan of [free, pro, enterprise]) {
    for (const modelSlug of plan.allowedModelIds) {
      await prisma.planModelEntitlement.upsert({
        where: { planId_modelSlug: { planId: plan.id, modelSlug } },
        update: {},
        create: { planId: plan.id, modelSlug },
      });
    }
  }

  const routingPolicy = await prisma.policy.upsert({
    where: { name_kind_scope: { name: "default-routing", kind: "ROUTING", scope: "PLATFORM" } },
    update: { enabled: true },
    create: {
      name: "default-routing",
      kind: "ROUTING",
      scope: "PLATFORM",
      enabled: true,
    },
  });
  const existingVersion = await prisma.policyVersion.findFirst({
    where: { policyId: routingPolicy.id },
    orderBy: { version: "desc" },
  });
  if (!existingVersion) {
    await prisma.policyVersion.create({
      data: {
        policyId: routingPolicy.id,
        version: 1,
        document: {
          preferredModels: ["zms-coder-7b"],
          fallbackModels: ["zms-chat-13b"],
          minQuality: 40,
        },
        checksum: "seed",
        createdBy: "seed",
      },
    });
  }

  await prisma.sloDefinition.upsert({
    where: { name: "default-chat" },
    update: {},
    create: {
      name: "default-chat",
      description: "Default chat completion latency/availability target",
      latencyP95Ms: 120_000,
      availabilityPct: 99.0,
      windowMinutes: 60,
      creditMicros: 100_000n,
    },
  });

  await prisma.runtimeNode.upsert({
    where: { name: "local-primary" },
    update: { status: "ONLINE", lastHeartbeat: new Date() },
    create: {
      name: "local-primary",
      hostname: "localhost",
      region: "local",
      status: "ONLINE",
      totalRamMb: 16384,
      freeRamMb: 8192,
      cpuCores: 8,
      trustState: "local",
      lastHeartbeat: new Date(),
    },
  });

  await prisma.evalSuite.upsert({
    where: { name: "smoke" },
    update: {},
    create: {
      name: "smoke",
      description: "Basic response non-empty check",
      cases: {
        create: [
          {
            name: "hello",
            prompt: "Say hello in one short sentence.",
            expected: "hello",
          },
        ],
      },
    },
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
