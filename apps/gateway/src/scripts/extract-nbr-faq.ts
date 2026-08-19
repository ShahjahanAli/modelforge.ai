/**
 * Parse NBR FAQ markdown (from nbr.gov.bd/all-faq/eng) into RAG-friendly Q&A markdown.
 *
 *   pnpm exec dotenv -e ../../.env -- pnpm exec tsx src/scripts/extract-nbr-faq.ts
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../../..");

const SOURCE_URL = "https://nbr.gov.bd/all-faq/eng";
const INPUT = process.argv[2] ?? join(repoRoot, "data", "knowledge", "raw", "nbr-all-faq-eng.md");
const OUTPUT = process.argv[3] ?? join(repoRoot, "data", "knowledge", "nbr-faq-eng.md");

const SECTION_MARKERS = new Set(["faq"]);

const DOMAIN_SECTIONS = new Map<string, string>([
  ["customs search customs", "Customs"],
  ["vat search vat", "VAT"],
  ["income tax search incometax", "Income Tax"],
]);

function isNoiseLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();
  return DOMAIN_SECTIONS.has(lower) || SECTION_MARKERS.has(lower);
}

function isDomainSection(line: string): string | null {
  const key = line.trim().toLowerCase();
  return DOMAIN_SECTIONS.get(key) ?? null;
}

const SECTION_HEADERS = new Map<string, string>([
  ["আয়কর", "Income Tax (আয়কর)"],
  ["আয়কর সংক্রান্ত সচরাচর জিজ্ঞাসা", "Income Tax — Frequently Asked Questions"],
  ["অনলাইন আয়কর রিটার্ন", "Online Income Tax Return"],
  ["অনলাইন আয়কর রিটার্ন সংক্রান্ত সচরাচর জিজ্ঞাসা", "Online e-Return FAQ"],
  ["chapter 1", "Chapter 1"],
  ["chapter 2", "Chapter 2"],
  ["chapter 3", "Chapter 3"],
  ["chapter 4", "Chapter 4"],
  ["chapter 5", "Chapter 5"],
  ["chapter 6", "Chapter 6"],
  ["chapter 7", "Chapter 7"],
  ["chapter 8", "Chapter 8"],
  ["chapter 9", "Chapter 9"],
  ["chapter 10", "Chapter 10"],
  ["chapter 11", "Chapter 11"],
  ["chapter 12", "Chapter 12"],
  ["chapter 13", "Chapter 13"],
  ["chapter 14", "Chapter 14"],
  ["chapter 15", "Chapter 15"],
  ["chapter 16", "Chapter 16"],
  ["basics of vat", "Basics of VAT"],
  ["registration & enlistment", "VAT Registration & Enlistment"],
  ["general information about customs:", "Customs — General Information"],
  ["informer of smuggling of goods and rewards:", "Customs — Smuggling Informers & Rewards"],
]);

function isQuestionHeading(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length < 3) return false;
  const lower = trimmed.toLowerCase();
  if (isNoiseLine(trimmed)) return false;
  if (SECTION_HEADERS.has(lower)) return false;
  if (/^chapter \d+$/i.test(trimmed)) return false;
  if (/^search /i.test(trimmed)) return false;
  if (trimmed === "আয়কর" || trimmed === "অনলাইন আয়কর রিটার্ন") return false;
  return true;
}

function normalizeSectionTitle(text: string): string {
  const key = text.trim().toLowerCase();
  return SECTION_HEADERS.get(key) ?? text.trim();
}

function parseFaq(raw: string) {
  const lines = raw.split(/\r?\n/);
  const sections: Array<{ title: string; items: Array<{ question: string; answer: string }> }> = [];
  let currentSection = "General";
  let currentQuestion: string | null = null;
  let answerLines: string[] = [];

  const flushQuestion = () => {
    if (!currentQuestion) return;
    const answer = answerLines
      .filter((line) => !isNoiseLine(line))
      .join("\n")
      .trim();
    if (!answer) {
      if (/^[\d.]+\s/.test(currentQuestion) || /[?？]$/.test(currentQuestion.trim())) {
        currentQuestion = null;
        answerLines = [];
        return;
      }
      currentSection = normalizeSectionTitle(currentQuestion);
      currentQuestion = null;
      answerLines = [];
      return;
    }
    let section = sections.find((entry) => entry.title === currentSection);
    if (!section) {
      section = { title: currentSection, items: [] };
      sections.push(section);
    }
    section.items.push({ question: currentQuestion.trim(), answer });
    currentQuestion = null;
    answerLines = [];
  };

  for (const line of lines) {
    const domain = isDomainSection(line);
    if (domain) {
      flushQuestion();
      currentSection = domain;
      continue;
    }
    if (line.startsWith("### ")) {
      flushQuestion();
      currentQuestion = line.slice(4).trim();
      continue;
    }
    if (line.startsWith("#### ")) {
      flushQuestion();
      currentSection = normalizeSectionTitle(line.slice(5).trim());
      continue;
    }
    if (line.startsWith("# ") && !line.startsWith("## ")) {
      continue;
    }
    if (currentQuestion !== null) {
      answerLines.push(line);
    }
  }
  flushQuestion();

  return sections.filter((section) => section.items.length > 0);
}

function toMarkdown(sections: ReturnType<typeof parseFaq>): string {
  const extractedAt = new Date().toISOString().slice(0, 10);
  const parts: string[] = [
    "# National Board of Revenue (NBR) — FAQ",
    "",
    `> Source: [${SOURCE_URL}](${SOURCE_URL})`,
    `> Extracted: ${extractedAt}`,
    "",
    "This document is for grounded Q&A in ModelForge. Answers must follow the passages below.",
    "The `/eng` FAQ page includes Bangla income-tax content and English VAT/customs content.",
    "",
    "**Coverage note:** Income Tax and e-Return entries are in **Bangla**. VAT entries are in **English**.",
    "The Customs block on the source page lists question titles only (answers load in-browser and were not in the static export), so those entries are omitted here.",
    "",
  ];

  let total = 0;
  for (const section of sections) {
    parts.push(`## ${section.title}`, "");
    for (const item of section.items) {
      total += 1;
      parts.push(`### ${item.question}`, "", item.answer, "");
    }
  }

  parts.push("---", "", `Total FAQ entries: ${total}`, "");
  return parts.join("\n");
}

const raw = readFileSync(INPUT, "utf8");
mkdirSync(dirname(OUTPUT), { recursive: true });
const sections = parseFaq(raw);
const markdown = toMarkdown(sections);
writeFileSync(OUTPUT, markdown, "utf8");

const total = sections.reduce((sum, section) => sum + section.items.length, 0);
console.log(
  JSON.stringify(
    {
      input: INPUT,
      output: OUTPUT,
      sections: sections.length,
      entries: total,
      bytes: Buffer.byteLength(markdown),
    },
    null,
    2,
  ),
);
