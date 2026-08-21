import { describe, expect, it } from "vitest";
import {
  chatCompletionRequestSchema,
  coalesceAlternatingRoles,
  normalizeMessages,
  buildCompletionResponse,
  mapEngineError,
} from "./index.js";

describe("chatCompletionRequestSchema", () => {
  it("accepts a valid OpenAI-shaped request", () => {
    const parsed = chatCompletionRequestSchema.parse({
      model: "zms-coder-7b",
      messages: [{ role: "user", content: "hello" }],
      temperature: 0.2,
      stream: true,
      stop: "END",
    });
    expect(parsed.stop).toEqual(["END"]);
    expect(parsed.max_tokens).toBe(4096);
  });

  it("accepts knowledge-base retrieval controls", () => {
    const parsed = chatCompletionRequestSchema.parse({
      model: "auto",
      messages: [{ role: "user", content: "hello" }],
      metadata: {
        modelforge: { knowledge_base_ids: ["kb_1"], rag_top_k: 4 },
      },
    });
    expect(parsed.metadata?.modelforge?.knowledge_base_ids).toEqual(["kb_1"]);
    expect(parsed.metadata?.modelforge?.rag_top_k).toBe(4);
  });

  it("rejects empty messages", () => {
    expect(() =>
      chatCompletionRequestSchema.parse({
        model: "x",
        messages: [],
      }),
    ).toThrow();
  });
});

describe("normalizeMessages", () => {
  it("flattens multimodal content parts", () => {
    const out = normalizeMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      },
    ]);
    expect(out[0]?.content).toBe("a\nb");
  });
});

describe("coalesceAlternatingRoles", () => {
  it("merges consecutive user messages", () => {
    const out = coalesceAlternatingRoles([
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Transcript text" },
      { role: "user", content: "Describe it for me" },
    ]);
    expect(out).toHaveLength(2);
    expect(out[1]?.content).toContain("Transcript text");
    expect(out[1]?.content).toContain("Describe it for me");
  });

  it("preserves alternating user/assistant turns", () => {
    const out = coalesceAlternatingRoles([
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello" },
      { role: "user", content: "Bye" },
    ]);
    expect(out).toHaveLength(3);
  });
});

describe("openai builders", () => {
  it("builds completion response", () => {
    const res = buildCompletionResponse({
      id: "chatcmpl_1",
      model: "zms-coder-7b",
      content: "hi",
      finishReason: "stop",
      promptTokens: 3,
      completionTokens: 1,
    });
    expect(res.usage.total_tokens).toBe(4);
    expect(res.choices[0]?.message.content).toBe("hi");
  });
});

describe("mapEngineError", () => {
  it("maps OOM to 503", () => {
    const err = mapEngineError("OOM", "out of memory");
    expect(err.status).toBe(503);
    expect(err.type).toBe("model_unavailable");
  });
});
