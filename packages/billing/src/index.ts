import { prisma } from "@modelforge/db";
import { calculateUsageCents } from "./invoice.js";
import { MockPaymentAdapter, type PaymentAdapter } from "./adapters.js";
import { StripeAdapter } from "./stripe.js";
import { BkashAdapter, NagadAdapter } from "./bd-payments.js";

export async function generateInvoice(
  customerId: string,
  periodStart: Date,
  periodEnd: Date,
) {
  const events = await prisma.usageEvent.findMany({
    where: { customerId, createdAt: { gte: periodStart, lt: periodEnd } },
    include: { model: true },
  });

  const amountCents = calculateUsageCents(
    events.map((e) => ({
      promptTokens: e.promptTokens,
      completionTokens: e.completionTokens,
      pricePerMTokIn: e.model.pricePerMTokIn,
      pricePerMTokOut: e.model.pricePerMTokOut,
    })),
  );

  return prisma.invoice.upsert({
    where: {
      customerId_periodStart_periodEnd: { customerId, periodStart, periodEnd },
    },
    update: { amountCents },
    create: {
      customerId,
      periodStart,
      periodEnd,
      amountCents,
      status: "DRAFT",
    },
  });
}

export function createPaymentAdapter(
  preferred: "stripe" | "bkash" | "nagad" | "mock" = "mock",
): PaymentAdapter {
  const mode = process.env.BILLING_MODE ?? "mock";
  if (mode === "mock" || preferred === "mock") return new MockPaymentAdapter();
  if (preferred === "stripe" && process.env.STRIPE_SECRET_KEY) {
    return new StripeAdapter(process.env.STRIPE_SECRET_KEY);
  }
  if (preferred === "bkash") return new BkashAdapter();
  if (preferred === "nagad") return new NagadAdapter();
  return new MockPaymentAdapter();
}

export * from "./invoice.js";
export * from "./adapters.js";
export * from "./stripe.js";
export * from "./bd-payments.js";
