"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@modelforge/db";
import { requireAdmin } from "@/lib/session";
import { writeAuditEvent } from "@/lib/audit";

export type AdjustQuotaResult =
  | {
      ok: true;
      message: string;
      quotaBonusTokens: string;
      tokensUsed: string;
    }
  | { ok: false; message: string };

/**
 * Admin: grant extra monthly billable units and/or reset period usage so
 * subscribers can continue after quota_exceeded.
 */
export async function adjustCustomerQuotaAction(input: {
  customerId: string;
  addTokens: number;
  resetUsage?: boolean;
}): Promise<AdjustQuotaResult> {
  const admin = await requireAdmin();
  const customerId = input.customerId?.trim();
  if (!customerId) return { ok: false, message: "Customer id is required" };

  const addTokens = Math.floor(Number(input.addTokens) || 0);
  const resetUsage = Boolean(input.resetUsage);
  if (addTokens < 0) return { ok: false, message: "addTokens must be >= 0" };
  if (addTokens === 0 && !resetUsage) {
    return { ok: false, message: "Add tokens and/or reset usage" };
  }
  if (addTokens > 1_000_000_000_000) {
    return { ok: false, message: "addTokens is unreasonably large" };
  }

  const existing = await prisma.customer.findUnique({
    where: { id: customerId },
    include: { quotaLedger: true, subscription: { include: { plan: true } } },
  });
  if (!existing) return { ok: false, message: "Customer not found" };

  const before = {
    quotaBonusTokens: existing.quotaBonusTokens.toString(),
    tokensUsed: existing.quotaLedger?.tokensUsed.toString() ?? "0",
  };

  const updated = await prisma.$transaction(async (tx) => {
    const customer =
      addTokens > 0
        ? await tx.customer.update({
            where: { id: customerId },
            data: { quotaBonusTokens: { increment: BigInt(addTokens) } },
          })
        : await tx.customer.findUniqueOrThrow({ where: { id: customerId } });

    let tokensUsed = existing.quotaLedger?.tokensUsed ?? 0n;
    if (resetUsage) {
      const ledger = await tx.quotaLedger.upsert({
        where: { customerId },
        create: {
          customerId,
          periodStart: existing.subscription?.currentPeriodStart ?? new Date(),
          periodEnd: existing.subscription?.currentPeriodEnd ?? new Date(),
          tokensUsed: 0n,
        },
        update: { tokensUsed: 0n },
      });
      tokensUsed = ledger.tokensUsed;
    } else if (existing.quotaLedger) {
      tokensUsed = existing.quotaLedger.tokensUsed;
    }

    return { customer, tokensUsed };
  });

  await writeAuditEvent({
    actorType: "admin",
    actorId: admin.id,
    customerId,
    action: "customer.quota.adjust",
    resourceType: "Customer",
    resourceId: customerId,
    before,
    after: {
      quotaBonusTokens: updated.customer.quotaBonusTokens.toString(),
      tokensUsed: updated.tokensUsed.toString(),
      addTokens,
      resetUsage,
    },
    metadata: {
      email: existing.email,
      planQuota: existing.subscription?.plan.monthlyTokenQuota.toString() ?? null,
    },
  });

  revalidatePath("/admin/customers");
  revalidatePath("/dashboard");

  const parts: string[] = [];
  if (addTokens > 0) parts.push(`added ${addTokens.toLocaleString()} bonus units`);
  if (resetUsage) parts.push("reset period usage to 0");
  return {
    ok: true,
    message: `Quota updated for ${existing.email}: ${parts.join("; ")}.`,
    quotaBonusTokens: updated.customer.quotaBonusTokens.toString(),
    tokensUsed: updated.tokensUsed.toString(),
  };
}
