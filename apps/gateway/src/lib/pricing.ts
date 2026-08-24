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
  // price* is ¢ per million tokens (may be fractional, e.g. 0.75).
  // micros = tokens/1e6 * ¢ * 10_000 = tokens * ¢ / 100
  const micros =
    (promptTokens * pricePerMTokIn + completionTokens * pricePerMTokOut) / 100;
  return BigInt(Math.max(0, Math.round(micros)));
}
