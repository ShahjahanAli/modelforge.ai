import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LocalFileSigningProvider,
  LocalPiiProvider,
  canonicalStringify,
  computeCreditMicros,
  computeWindowStatus,
  cosineSimilarity,
  evaluateRoutingPolicy,
  hashCanonicalPayload,
  simpleEmbed,
} from "./index.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("canonical JSON", () => {
  it("is stable across object insertion order and nested keys", () => {
    const left = { z: 1, nested: { b: true, a: [3, 2, 1] }, a: "first" };
    const right = { a: "first", nested: { a: [3, 2, 1], b: true }, z: 1 };

    expect(canonicalStringify(left)).toBe(
      '{"a":"first","nested":{"a":[3,2,1],"b":true},"z":1}',
    );
    expect(hashCanonicalPayload(left)).toBe(hashCanonicalPayload(right));
  });
});

describe("local signing", () => {
  it("persists a key and verifies a canonical payload roundtrip", () => {
    const directory = mkdtempSync(join(tmpdir(), "modelforge-signing-"));
    temporaryDirectories.push(directory);
    const signer = new LocalFileSigningProvider(directory);
    const payload = { requestId: "req_1", usage: { output: 7, input: 12 } };
    const signed = signer.signPayload(payload);

    expect(signer.verifyPayload(payload, signed)).toBe(true);
    expect(signer.verifyPayload({ ...payload, requestId: "req_2" }, signed)).toBe(
      false,
    );
    expect(new LocalFileSigningProvider(directory).keyId).toBe(signer.keyId);
  });
});

describe("routing policy", () => {
  it("resolves auto to the first eligible preferred model", () => {
    const result = evaluateRoutingPolicy(
      {
        maxCostMicros: 50,
        minQuality: 70,
        maxLatencyClass: 40,
        preferredModels: ["premium", "balanced"],
        fallbackModels: ["economy"],
      },
      {
        requestedModel: "auto",
        candidates: [
          {
            modelSlug: "premium",
            costMicros: 80,
            qualityClass: 95,
            latencyClass: 20,
          },
          {
            modelSlug: "balanced",
            costMicros: 45,
            qualityClass: 80,
            latencyClass: 30,
          },
          {
            modelSlug: "economy",
            costMicros: 20,
            qualityClass: 60,
            latencyClass: 35,
          },
        ],
      },
    );

    expect(result.resolvedModelSlug).toBe("balanced");
    expect(result.reason).toContain("preferred_model");
    expect(result.decisionHash).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("PII redaction", () => {
  it("redacts supported local patterns and reports counts", () => {
    const result = new LocalPiiProvider().redact(
      "Email me@example.com, call +1 (415) 555-2671, card 4111 1111 1111 1111.",
    );

    expect(result.text).not.toContain("me@example.com");
    expect(result.text).not.toContain("4111 1111 1111 1111");
    expect(result.text).toContain("[REDACTED_PHONE]");
    expect(result.findings).toEqual([
      { ruleId: "credit_card", count: 1 },
      { ruleId: "email", count: 1 },
      { ruleId: "phone", count: 1 },
    ]);
  });
});

describe("SLO helpers", () => {
  const targets = { availabilityPct: 99, latencyP95Ms: 500 };

  it("classifies healthy, at-risk, and breached windows", () => {
    expect(computeWindowStatus(99.9, 300, targets)).toBe("HEALTHY");
    expect(computeWindowStatus(99.2, 475, targets)).toBe("AT_RISK");
    expect(computeWindowStatus(98.9, 300, targets)).toBe("BREACHED");
    expect(computeCreditMicros("BREACHED", 25_000)).toBe(25_000n);
    expect(computeCreditMicros("HEALTHY", 25_000)).toBe(0n);
  });
});

describe("RAG helpers", () => {
  it("scores related text above unrelated text", () => {
    const source = simpleEmbed("local language model inference runtime");
    const related = simpleEmbed("language model runtime and inference");
    const unrelated = simpleEmbed("banana orchard irrigation schedule");

    expect(source).toHaveLength(64);
    expect(cosineSimilarity(source, related)).toBeGreaterThan(
      cosineSimilarity(source, unrelated),
    );
  });
});
