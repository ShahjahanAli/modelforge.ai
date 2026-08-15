import { describe, expect, it } from "vitest";
import { hashApiKey, generateApiKey, safeEqualHex } from "./lib/keys.js";

describe("api keys", () => {
  it("hashes deterministically", () => {
    expect(hashApiKey("mf_abc")).toBe(hashApiKey("mf_abc"));
    expect(hashApiKey("mf_abc")).not.toBe(hashApiKey("mf_abd"));
  });

  it("generates prefixed keys", () => {
    const k = generateApiKey();
    expect(k.raw.startsWith("mf_")).toBe(true);
    expect(k.prefix).toBe(k.raw.slice(0, 10));
    expect(safeEqualHex(k.hash, hashApiKey(k.raw))).toBe(true);
  });
});
