import { describe, expect, it } from "vitest";
import {
  applyRetrievalContext,
  clampMaxTokens,
  fitHitsToBudget,
  isKnowledgeCatalogQuery,
  lastUserQuery,
  prefersBanglaReply,
  publicRetrievalHits,
  type RetrievalHit,
} from "./retrieval.js";

function hit(overrides: Partial<RetrievalHit> = {}): RetrievalHit {
  return {
    chunkId: "c1",
    knowledgeBaseId: "kb1",
    knowledgeBaseName: "Primary knowledge",
    documentId: "d1",
    documentTitle: "NBR FAQ",
    ordinal: 0,
    content: "আয়কর অর্থ আয়কর আইনের অধীন আরোপযোগ্য কর।",
    score: 0.9,
    ...overrides,
  };
}

describe("retrieval prompt", () => {
  it("reads the latest user turn", () => {
    expect(
      lastUserQuery([
        { role: "system", content: "rules" },
        { role: "user", content: "first" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "মূসক কী?" },
      ]),
    ).toBe("মূসক কী?");
  });

  it("replaces extra system prompts with one grounded message", () => {
    const messages = applyRetrievalContext(
      [
        { role: "system", content: "Be helpful." },
        { role: "user", content: "What is the check code?" },
      ],
      [
        hit({
          documentTitle: "Retrieval check",
          content: "The retrieval check code is MF-RAG-7719.",
        }),
      ],
    );

    expect(messages.filter((message) => message.role === "system")).toHaveLength(1);
    expect(messages[0]?.content).toContain("MF-RAG-7719");
    expect(messages[0]?.content).toContain("in the same language as the user");
    expect(messages[0]?.content).not.toContain('say you do not know');
    expect(messages.at(-1)?.content).toBe("What is the check code?");
  });

  it("uses a catalog prompt when the user asks what is in the knowledge base", () => {
    const [grounded] = applyRetrievalContext(
      [{ role: "user", content: "আমার নলেজ বেসে কী আছে?" }],
      [
        hit({
          documentTitle: "NBR FAQ (nbr.gov.bd/all-faq/eng)",
          content: 'This document is in knowledge base "Primary knowledge".',
        }),
      ],
      "catalog",
    );
    expect(grounded?.content).toContain("what is in their knowledge base");
    expect(grounded?.content).toContain("Primary knowledge");
    expect(grounded?.content).toContain("Knowledge catalog");
    expect(grounded?.content).toContain("Do not say you do not know");
  });

  it("locks Bangla output after the passages when the user wrote Bangla", () => {
    const [grounded] = applyRetrievalContext(
      [{ role: "user", content: "আমি অনলাইনে রিটার্ন জমা করতে চাই, আমাকে বলো কি ভাবে করতে হয়" }],
      [hit()],
    );
    const content = grounded?.content ?? "";
    expect(content.indexOf("Knowledge passages")).toBeLessThan(content.indexOf("Language lock"));
    expect(content).toContain("Write the entire answer in Bangla script");
    expect(content).toContain("Address the user as আপনি, never as আমি");
    expect(content).toContain("ব্যবহারকারীকে আপনি বলে সম্বোধন করুন, আমি নয়");
    expect(content.endsWith("প্রশ্নের আমি কপি করবেন না।")).toBe(true);
  });

  it("does not force Bangla when the user wrote English", () => {
    const [grounded] = applyRetrievalContext(
      [{ role: "user", content: "How do I file an online return?" }],
      [hit()],
    );
    expect(grounded?.content).toContain("Reply in the same language as the user");
    expect(grounded?.content).not.toContain("Write the entire answer in Bangla script");
  });
});

describe("knowledge catalog queries", () => {
  it("detects inventory questions in Bangla and English", () => {
    expect(isKnowledgeCatalogQuery("আমার নলেজ বেসে কী আছে?")).toBe(true);
    expect(isKnowledgeCatalogQuery("What is in my knowledge base?")).toBe(true);
    expect(isKnowledgeCatalogQuery("আয়কর কিভাবে জমা দিব?")).toBe(false);
    expect(isKnowledgeCatalogQuery("What is income tax?")).toBe(false);
  });

  it("treats Bangla-script questions as Bangla replies", () => {
    expect(prefersBanglaReply("আমি অনলাইনে রিটার্ন জমা করতে চাই")).toBe(true);
    expect(prefersBanglaReply("How do I file an online return?")).toBe(false);
  });
});

describe("retrieval budget", () => {
  it("keeps only as many passages as the context window can hold", () => {
    const fitted = fitHitsToBudget(
      [
        hit({ chunkId: "a", content: "A".repeat(500) }),
        hit({ chunkId: "b", content: "B".repeat(500) }),
        hit({ chunkId: "c", content: "C".repeat(500) }),
      ],
      1_000,
    );
    expect(fitted).toHaveLength(1);
    expect(fitted[0]?.chunkId).toBe("a");
  });

  it("reserves completion tokens so max_tokens cannot consume the whole context", () => {
    const maxTokens = clampMaxTokens(
      4096,
      [{ role: "system", content: "x".repeat(6_000) }, { role: "user", content: "আয়কর কী?" }],
      4096,
    );
    expect(maxTokens).toBeLessThan(4096);
    expect(maxTokens).toBeGreaterThanOrEqual(48);
  });

  it("deduplicates sources by document", () => {
    const publicHits = publicRetrievalHits([
      hit({ chunkId: "1", ordinal: 0, score: 0.9 }),
      hit({ chunkId: "2", ordinal: 1, score: 0.8 }),
    ]);
    expect(publicHits).toHaveLength(1);
    expect(publicHits[0]?.title).toBe("NBR FAQ");
    expect(publicHits[0]?.excerpt).toContain("আয়কর");
  });
});
