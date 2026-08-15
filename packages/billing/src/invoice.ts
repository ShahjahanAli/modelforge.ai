export interface UsageLine {
  promptTokens: number;
  completionTokens: number;
  pricePerMTokIn: number;
  pricePerMTokOut: number;
}

/** Compute usage amount in cents from token lines. */
export function calculateUsageCents(lines: UsageLine[]): number {
  const amount = lines.reduce((sum, e) => {
    const inCost = (e.promptTokens / 1_000_000) * e.pricePerMTokIn;
    const outCost = (e.completionTokens / 1_000_000) * e.pricePerMTokOut;
    return sum + inCost + outCost;
  }, 0);
  return Math.max(0, Math.round(amount));
}

export function calculateOverageCents(input: {
  tokensUsed: number;
  monthlyQuota: number;
  overagePerMTokIn: number;
  overagePerMTokOut: number;
  /** Approximate split when only aggregate tokens are known */
  inRatio?: number;
}): number {
  const overage = Math.max(0, input.tokensUsed - input.monthlyQuota);
  if (overage <= 0) return 0;
  const inRatio = input.inRatio ?? 0.3;
  const inTok = overage * inRatio;
  const outTok = overage * (1 - inRatio);
  return Math.round(
    (inTok / 1_000_000) * input.overagePerMTokIn +
      (outTok / 1_000_000) * input.overagePerMTokOut,
  );
}
