import { describe, expect, it } from "vitest";
import { calculateUsageCents, calculateOverageCents } from "./invoice.js";

describe("calculateUsageCents", () => {
  it("rounds token pricing to cents", () => {
    const cents = calculateUsageCents([
      {
        promptTokens: 1_000_000,
        completionTokens: 500_000,
        pricePerMTokIn: 20,
        pricePerMTokOut: 60,
      },
    ]);
    // 20 + 30 = 50
    expect(cents).toBe(50);
  });
});

describe("calculateOverageCents", () => {
  it("returns 0 when under quota", () => {
    expect(
      calculateOverageCents({
        tokensUsed: 100,
        monthlyQuota: 1000,
        overagePerMTokIn: 50,
        overagePerMTokOut: 150,
      }),
    ).toBe(0);
  });
});
