export const SIMPLE_EMBEDDING_DIMENSIONS = 64;

export function chunkText(text: string, maxChars: number, overlapChars = 0): string[] {
  if (!Number.isSafeInteger(maxChars) || maxChars <= 0) {
    throw new RangeError("maxChars must be a positive integer");
  }

  const overlap = Math.max(0, Math.min(overlapChars, maxChars - 1));
  const source = text.trim();
  if (!source) return [];

  const chunks: string[] = [];
  let start = 0;
  while (start < source.length) {
    let end = Math.min(start + maxChars, source.length);
    if (end < source.length) {
      const window = source.slice(start, end + 1);
      const boundary = window.search(/\s+\S*$/);
      if (boundary > 0) end = start + boundary;
    }
    const chunk = source.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= source.length) break;
    const next = end - overlap;
    start = next <= start ? end : next;
  }
  return chunks;
}

export function tokenize(text: string): string[] {
  return normalizeSearchText(text).match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
}

/** Fold Bangla y-kar variants so আয়কর and আয়কর match. */
export function normalizeSearchText(text: string): string {
  return text.normalize("NFC").replace(/\u09DF/g, "য").replace(/য়/g, "য").toLocaleLowerCase();
}

export function lexicalOverlap(query: string, document: string): number {
  const queryTokens = new Set(tokenize(query));
  if (queryTokens.size === 0) return 0;
  const documentTokens = new Set(tokenize(document));
  let hits = 0;
  for (const token of queryTokens) {
    if (documentTokens.has(token)) hits += 1;
  }
  return hits / queryTokens.size;
}

export function parseEmbedding(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const numbers = value.map((entry) => Number(entry));
  return numbers.every(Number.isFinite) ? numbers : null;
}

export type RankableChunk = {
  content: string;
  embedding?: unknown;
};

export type DiversifiableChunk = RankableChunk & {
  documentId?: string;
  ordinal?: number;
};

export function rankChunks<T extends RankableChunk>(
  query: string,
  chunks: readonly T[],
  options: { topK?: number; minScore?: number } = {},
): Array<T & { score: number }> {
  const topK = Math.max(1, Math.min(options.topK ?? 5, 12));
  const minScore = options.minScore ?? 0.12;
  const queryEmbedding = simpleEmbed(query);
  const needle = query.trim().toLocaleLowerCase();

  const scored = chunks
    .map((chunk) => {
      const stored = parseEmbedding(chunk.embedding) ?? simpleEmbed(chunk.content);
      const cosine =
        stored.length === queryEmbedding.length ? cosineSimilarity(queryEmbedding, stored) : 0;
      const lexical = lexicalOverlap(query, chunk.content);
      const heading = (chunk.content.match(/^#{1,3}\s+(.+)$/m)?.[1] ?? chunk.content.slice(0, 160)).replaceAll("\r", "").trim();
      const headingMatch = lexicalOverlap(query, heading);
      const contained = needle.length >= 4 && normalizeSearchText(chunk.content).includes(normalizeSearchText(needle)) ? 0.2 : 0;
      return {
        ...chunk,
        score:
          0.2 * cosine +
          0.35 * lexical +
          0.3 * headingMatch +
          contained +
          processHeadingBoost(query, heading),
      };
    })
    .filter((chunk) => chunk.score >= minScore)
    .sort((left, right) => right.score - left.score);

  return diversifyChunks(scored, topK);
}

/**
 * Sliding-window ingest produces near-duplicate neighbors. Keep the highest
 * scoring unique passages so RAG does not flood the context window.
 */
export function diversifyChunks<T extends DiversifiableChunk>(
  ranked: readonly T[],
  topK: number,
): T[] {
  const picked: T[] = [];
  for (const chunk of ranked) {
    const duplicate = picked.some((existing) => {
      const existingHeading = faqHeading(existing.content);
      const chunkHeading = faqHeading(chunk.content);
      if (existingHeading && chunkHeading) {
        return lexicalOverlap(existingHeading, chunkHeading) >= 0.86;
      }
      return lexicalOverlap(existing.content.slice(0, 280), chunk.content.slice(0, 280)) >= 0.72;
    });
    if (duplicate) continue;
    picked.push(chunk);
    if (picked.length >= topK) break;
  }
  return picked;
}

export function prepareKnowledgeChunks(content: string, maxChars = 800) {
  const parts = looksLikeFaqMarkdown(content)
    ? chunkFaqMarkdown(content, Math.max(maxChars, 4_000))
    : chunkText(content, maxChars, Math.min(120, Math.floor(maxChars / 6)));
  return parts.map((chunk, ordinal) => ({
    ordinal,
    content: chunk,
    tokenCount: Math.ceil(chunk.length / 4),
    embedding: simpleEmbed(chunk),
  }));
}

function looksLikeFaqMarkdown(text: string): boolean {
  return (text.match(/^### /gm) ?? []).length >= 3;
}

/** Keep each FAQ Q&A intact so retrieval does not cut a process mid-sentence. */
export function chunkFaqMarkdown(text: string, maxChars = 4_000): string[] {
  const blocks = text.split(/(?=^### )/m).map((block) => block.trim()).filter(Boolean);
  const chunks: string[] = [];
  for (const block of blocks) {
    if (block.startsWith("# ") || (block.startsWith("## ") && !block.startsWith("### "))) {
      continue;
    }
    if (block.length <= maxChars) {
      chunks.push(block);
      continue;
    }
    chunks.push(...chunkText(block, maxChars, 80));
  }
  return chunks;
}

export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length) {
    throw new RangeError("Vectors must have equal dimensions");
  }

  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) {
    return 0;
  }
  return dot / Math.sqrt(leftMagnitude * rightMagnitude);
}

function faqHeading(content: string): string | null {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("#")) return null;
  const heading = trimmed.match(/^#{1,3}\s+(.+?)\r?$/m)?.[1]?.trim();
  return heading || null;
}

function includesNormalized(haystack: string, needle: string): boolean {
  return haystack.includes(normalizeSearchText(needle));
}

function processHeadingBoost(query: string, heading: string): number {
  const q = normalizeSearchText(query);
  const h = normalizeSearchText(heading);
  const wantsProcess =
    includesNormalized(q, "কিভাবে") ||
    includesNormalized(q, "কীভাবে") ||
    includesNormalized(q, "how to") ||
    includesNormalized(q, "প্রক্রিয়া") ||
    includesNormalized(q, "পদ্ধতি") ||
    includesNormalized(q, "জমা দি") ||
    includesNormalized(q, "দাখিল কর");
  if (!wantsProcess) return 0;

  const filingReturn =
    (includesNormalized(q, "আয়কর") || includesNormalized(q, "রিটার্ন") || includesNormalized(q, "income tax")) &&
    (includesNormalized(q, "জমা") || includesNormalized(q, "দাখিল") || includesNormalized(q, "submit") || includesNormalized(q, "file"));
  let boost = 0;
  if (
    filingReturn &&
    includesNormalized(h, "রিটার্ন") &&
    (includesNormalized(h, "প্রক্রিয়া") ||
      includesNormalized(h, "পদ্ধতি") ||
      includesNormalized(h, "শুরু কর") ||
      includesNormalized(h, "কোথায় দাখিল"))
  ) {
    boost += 0.55;
  } else if (includesNormalized(h, "প্রক্রিয়া") || includesNormalized(h, "পদ্ধতি")) {
    boost += 0.45;
  } else if (includesNormalized(h, "কিভাবে") || includesNormalized(h, "কীভাবে") || includesNormalized(h, "শুরু কর")) {
    boost += 0.12;
  }
  if (
    (includesNormalized(q, "জমা দি") || includesNormalized(q, "দাখিল কর")) &&
    (includesNormalized(h, "জমা দেবার") || includesNormalized(h, "জমা দেও") || includesNormalized(h, "প্রক্রিয়া"))
  ) {
    boost += 0.2;
  }
  if (
    filingReturn &&
    (includesNormalized(h, "সাপোর্টিং") || includesNormalized(h, "attach") || includesNormalized(h, "বাতিল") || includesNormalized(h, "অধীক্ষেত্র") || includesNormalized(h, "ক্রেডিট")) &&
    !(includesNormalized(q, "সাপোর্টিং") || includesNormalized(q, "attach") || includesNormalized(q, "বাতিল") || includesNormalized(q, "ক্রেডিট"))
  ) {
    boost -= 0.4;
  }
  if (
    (/\sকি\s*\?|\sকী\s*\?|what is/.test(h) || includesNormalized(h, " কি?")) &&
    !(includesNormalized(h, "জমা") || includesNormalized(h, "দাখিল") || includesNormalized(h, "প্রক্রিয়া") || includesNormalized(h, "পদ্ধতি"))
  ) {
    boost -= 0.22;
  }
  return boost;
}

function hashToken(token: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function simpleEmbed(text: string): number[] {
  const vector = Array<number>(SIMPLE_EMBEDDING_DIMENSIONS).fill(0);
  const tokens = tokenize(text);
  for (const token of tokens) {
    const dimension = hashToken(token) % SIMPLE_EMBEDDING_DIMENSIONS;
    vector[dimension] = (vector[dimension] ?? 0) + 1;
  }
  return vector;
}
