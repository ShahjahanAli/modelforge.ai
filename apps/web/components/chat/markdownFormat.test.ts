import { describe, expect, it } from "vitest";
import { normalizeChatMarkdown, parseChatMarkdown, splitInline } from "./markdownFormat";

const sample = `আমি কৃত্রিম বুদ্ধিমত্তা শিখতে চাই
কৃত্রিম বুদ্ধিমত্তা (AI) শিখতে পারো, তবে এটি একটি জটিল প্রক্রিয়া হতে পারে। আমি আপনাকে কিছু ধাপে ধাপে উপায় তুলে ধরব যাতে আপনি সহজে শিখতে পারবেন। নিম্নে কিছু ধাপের পরামর্শ: ### ১. প্রয়োজনীয় প্ল্যাটফর্ম নির্বাচন করুন: - **বিস্তারিত অনলাইন শিক্ষা প্ল্যাটফর্ম:** Coursera, Udacity, edX - **হাইপার্টিউনিভার্সিটি (Hyperskill)**: বিশেষভাবে ডেভেলপমেন্ট এবং প্রোগ্রামিং শিখতে ভালো। ### ২. আপনার আগ্রহ ও লক্ষ্য নির্ধারণ করুন:`;

describe("chat markdown", () => {
  it("breaks compact local-model markdown into headings and lists", () => {
    const blocks = parseChatMarkdown(sample);
    expect(blocks.some((block) => block.type === "heading" && block.text.startsWith("১."))).toBe(
      true,
    );
    expect(blocks.some((block) => block.type === "list")).toBe(true);
    const list = blocks.find((block) => block.type === "list");
    expect(list?.type === "list" ? list.items[0] : "").toContain("Coursera");
  });

  it("inserts breaks before jammed ATX headings", () => {
    expect(normalizeChatMarkdown("hello: ### Next")).toContain("\n\n### Next");
  });

  it("splits bold and inline code", () => {
    expect(splitInline("use **Python** and `PyTorch`")).toEqual([
      { kind: "text", value: "use " },
      { kind: "strong", value: "Python" },
      { kind: "text", value: " and " },
      { kind: "code", value: "PyTorch" },
    ]);
  });
});
