import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LocalFileSigningProvider,
  LocalPiiProvider,
  canonicalStringify,
  chunkText,
  prepareKnowledgeChunks,
  computeCreditMicros,
  computeWindowStatus,
  cosineSimilarity,
  evaluateRoutingPolicy,
  hashCanonicalPayload,
  lexicalOverlap,
  rankChunks,
  simpleEmbed,
  tokenize,
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

  it("keeps Bangla tokens and ranks overlapping passages first", () => {
    expect(tokenize("কিভাবে জমা দিব")).toEqual(["কিভাবে", "জমা", "দিব"]);
    expect(lexicalOverlap("মূসক রিটার্ন", "মূসক রিটার্ন জমা দিতে হয়")).toBeGreaterThan(0.5);
    const ranked = rankChunks("VAT return deadline", [
      { content: "Banana harvest calendar for hill tracts." },
      { content: "The VAT return deadline for this knowledge base is 15th of the following month." },
    ]);
    expect(ranked[0]?.content).toContain("VAT return");
  });

  it("chunks long text with optional overlap", () => {
    const chunks = chunkText("alpha bravo charlie delta echo foxtrot", 18, 6);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join(" ")).toContain("foxtrot");
  });

  it("drops overlapping sliding-window neighbors", () => {
    const ranked = rankChunks(
      "আয়কর কি",
      [
        { documentId: "faq", ordinal: 0, content: "### আয়কর কি?\nআয়কর অর্থ আয়কর আইনের অধীন কর।" },
        { documentId: "faq", ordinal: 1, content: "আয়কর অর্থ আয়কর আইনের অধীন কর।\n### আয়কর কীভাবে পরিশোধ" },
        { documentId: "other", ordinal: 0, content: "VAT is an indirect tax paid by the consumer." },
      ],
      { topK: 3, minScore: 0.01 },
    );
    expect(ranked.filter((chunk) => chunk.documentId === "faq")).toHaveLength(1);
  });

  it("chunks FAQ markdown as whole Q&A blocks", () => {
    const chunks = prepareKnowledgeChunks(
      "# FAQ\n\n### প্রশ্ন এক?\nউত্তর এক সম্পূর্ণ।\n\n### প্রশ্ন দুই?\nউত্তর দুই সম্পূর্ণ।\n\n### প্রশ্ন তিন?\nউত্তর তিন সম্পূর্ণ।",
      800,
    );
    expect(chunks).toHaveLength(3);
    expect(chunks[0]?.content).toContain("উত্তর এক সম্পূর্ণ");
    expect(chunks[1]?.content).toContain("উত্তর দুই সম্পূর্ণ");
  });

  it("keeps distinct FAQ answers from the same document", () => {
    const ranked = rankChunks(
      "আয়কর কিভাবে জমা দিব?",
      [
        {
          documentId: "faq",
          ordinal: 0,
          content: "### আয়কর নিবন্ধন কি?\nআয়কর আইন, ২০২৩ এর ধারা ১৬১ অনুসারে কোনো ব্যক্তি নিজেকে করদাতার হিসেবে নিবন্ধন করতে পারেন।",
        },
        {
          documentId: "faq",
          ordinal: 1,
          content:
            "### অনলাইনে রিটার্ন জমা দেবার প্রক্রিয়া কি?\nরিটার্ন জমা দেওয়ার ৭টি ধাপ রয়েছে, সেগুলি নিচে দেয়া হল-\ni) Assessment\nvii) Return view",
        },
        {
          documentId: "faq",
          ordinal: 2,
          content:
            "### আমি অনলাইনে রিটার্ন দাখিল করতে চাই। কিভাবে শুরু করব?\nhttps://etaxnbr.gov.bd এ User ID ও Password দিয়ে লগইন করুন।",
        },
        {
          documentId: "faq",
          ordinal: 3,
          content:
            "### অনলাইনে রিটার্ন দাখিলের পর সাপোর্টিং কাগজপত্র কোথায় জমা দিব বা কিভাবে attach করব?\nসাপোর্টিং ডকুমেন্টস অনলাইনে attach করতে হয়।",
        },
      ],
      { topK: 4, minScore: 0.01 },
    );
    const top = ranked.slice(0, 2).map((chunk) => chunk.content).join("\n");
    expect(top).toContain("৭টি ধাপ");
    expect(top).toContain("কিভাবে শুরু করব");
    expect(ranked[0]?.content).not.toContain("নিবন্ধন কি");
    expect(ranked[0]?.content).not.toContain("সাপোর্টিং");
  });
});
