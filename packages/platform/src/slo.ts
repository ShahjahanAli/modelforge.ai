export type SloWindowStatus = "HEALTHY" | "AT_RISK" | "BREACHED";
export type SloStatus = SloWindowStatus;

export interface SloTargets {
  availabilityPct: number;
  latencyP95Ms: number;
  atRiskAvailabilityPct?: number;
  atRiskLatencyP95Ms?: number;
}

export function computeWindowStatus(
  availabilityPct: number,
  p95: number,
  targets: SloTargets,
): SloWindowStatus {
  if (
    !Number.isFinite(availabilityPct) ||
    availabilityPct < 0 ||
    availabilityPct > 100 ||
    !Number.isFinite(p95) ||
    p95 < 0
  ) {
    throw new RangeError("SLO measurements must be finite and non-negative");
  }
  if (
    targets.availabilityPct < 0 ||
    targets.availabilityPct > 100 ||
    targets.latencyP95Ms < 0
  ) {
    throw new RangeError("SLO targets are outside their valid range");
  }

  if (
    availabilityPct < targets.availabilityPct ||
    p95 > targets.latencyP95Ms
  ) {
    return "BREACHED";
  }

  const atRiskAvailability =
    targets.atRiskAvailabilityPct ??
    targets.availabilityPct + (100 - targets.availabilityPct) / 2;
  const atRiskLatency =
    targets.atRiskLatencyP95Ms ?? targets.latencyP95Ms * 0.9;

  if (availabilityPct < atRiskAvailability || p95 > atRiskLatency) {
    return "AT_RISK";
  }
  return "HEALTHY";
}

/**
 * Returns the configured per-window credit only for breached SLO windows.
 */
export interface CreditCalculationInput {
  breached: boolean;
  creditMicros: number | bigint;
  severity?: number;
}

export function computeCreditMicros(
  status: SloWindowStatus,
  configuredCreditMicros: number | bigint,
): bigint;
export function computeCreditMicros(input: CreditCalculationInput): bigint;
export function computeCreditMicros(
  statusOrInput: SloWindowStatus | CreditCalculationInput,
  configuredCreditMicros?: number | bigint,
): bigint {
  const breached =
    typeof statusOrInput === "string"
      ? statusOrInput === "BREACHED"
      : statusOrInput.breached;
  const creditValue =
    typeof statusOrInput === "string"
      ? configuredCreditMicros
      : statusOrInput.creditMicros;
  if (creditValue === undefined) {
    throw new TypeError("configuredCreditMicros is required");
  }
  const credit = BigInt(creditValue);
  if (credit < 0n) {
    throw new RangeError("configuredCreditMicros must be non-negative");
  }
  if (!breached) {
    return 0n;
  }
  const severity =
    typeof statusOrInput === "string"
      ? 1
      : Math.max(1, Math.min(3, Math.trunc(statusOrInput.severity ?? 1)));
  return credit * BigInt(severity);
}
