import { describe, expect, it } from "vitest";
import { wouldExceedQuota } from "./quotaLedger.js";

describe("quota ledger limits", () => {
  it("counts usage and reservations before accepting an estimate", () => {
    expect(wouldExceedQuota(60n, 20n, 21n, 100n)).toBe(true);
    expect(wouldExceedQuota(60n, 20n, 20n, 100n)).toBe(false);
  });

  it("treats a zero limit as unlimited", () => {
    expect(wouldExceedQuota(10_000n, 5_000n, 1_000n, 0n)).toBe(false);
  });
});
