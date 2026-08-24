/**
 * Convert registry ¢/MTok pricing into USD for a token count.
 * priceCentsPerMillion is HostedModel.pricePerMTokIn/Out (fractional OK, e.g. 0.75).
 */
export function tokensToUsd(tokens: number, priceCentsPerMillion: number): number {
  if (!Number.isFinite(tokens) || !Number.isFinite(priceCentsPerMillion)) return 0;
  if (tokens <= 0 || priceCentsPerMillion <= 0) return 0;
  return (tokens / 1_000_000) * (priceCentsPerMillion / 100);
}

export function usageEventCostUsd(input: {
  promptTokens: number;
  completionTokens: number;
  pricePerMTokIn?: number | null;
  pricePerMTokOut?: number | null;
}): { inputCostUsd: number; outputCostUsd: number; totalCostUsd: number } {
  const inputCostUsd = tokensToUsd(input.promptTokens, input.pricePerMTokIn ?? 0);
  const outputCostUsd = tokensToUsd(input.completionTokens, input.pricePerMTokOut ?? 0);
  return {
    inputCostUsd,
    outputCostUsd,
    totalCostUsd: inputCostUsd + outputCostUsd,
  };
}
