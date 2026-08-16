import { prisma } from "@modelforge/db";

export async function getActivePricingVersion(hostedModelId: string) {
  const now = new Date();
  const active = await prisma.pricingVersion.findFirst({
    where: {
      hostedModelId,
      effectiveFrom: { lte: now },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
    },
    orderBy: { effectiveFrom: "desc" },
  });
  if (active) return active;

  const model = await prisma.hostedModel.findUniqueOrThrow({ where: { id: hostedModelId } });
  return prisma.pricingVersion.create({
    data: {
      hostedModelId,
      pricePerMTokIn: model.pricePerMTokIn,
      pricePerMTokOut: model.pricePerMTokOut,
      effectiveFrom: now,
    },
  });
}

export function computeCostMicros(
  promptTokens: number,
  completionTokens: number,
  pricePerMTokIn: number,
  pricePerMTokOut: number,
): bigint {
  const centTokenUnits =
    BigInt(promptTokens) * BigInt(pricePerMTokIn) +
    BigInt(completionTokens) * BigInt(pricePerMTokOut);
  return (centTokenUnits + 99n) / 100n;
}
