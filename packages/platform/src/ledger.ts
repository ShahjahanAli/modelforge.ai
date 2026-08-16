export interface QuotaReserveInput {
  customerId: string;
  requestId: string;
  idempotencyKey: string;
  estimatedTokens: number;
}

export interface QuotaFinalizeDelta {
  deltaTokens: bigint;
  reservedDelta: bigint;
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

/**
 * Estimates request cost in millionths of the billing currency. Prices are
 * expressed as micros per one million tokens, matching HostedModel pricing.
 */
export function estimateCostMicros(
  promptTokens: number,
  completionTokens: number,
  priceIn: number,
  priceOut: number,
): number {
  assertNonNegativeInteger(promptTokens, "promptTokens");
  assertNonNegativeInteger(completionTokens, "completionTokens");
  assertNonNegativeInteger(priceIn, "priceIn");
  assertNonNegativeInteger(priceOut, "priceOut");
  return Math.ceil(
    (promptTokens * priceIn + completionTokens * priceOut) / 1_000_000,
  );
}

/**
 * Produces the append-only ledger deltas needed to finalize a reservation.
 * `deltaTokens` records actual usage while the negative `reservedDelta`
 * releases the full reservation. Apply both in the same database transaction.
 */
export function finalizeQuotaDelta(
  reservedTokens: number | bigint,
  actualTokens: number | bigint,
): QuotaFinalizeDelta {
  const reserved = BigInt(reservedTokens);
  const actual = BigInt(actualTokens);
  if (reserved < 0n || actual < 0n) {
    throw new RangeError("Token counts must be non-negative");
  }
  return {
    deltaTokens: actual,
    reservedDelta: -reserved,
  };
}

/**
 * Produces the ledger delta for canceling a request before usage is recorded.
 */
export function releaseQuotaReservation(
  reservedTokens: number | bigint,
): QuotaFinalizeDelta {
  return finalizeQuotaDelta(reservedTokens, 0);
}
