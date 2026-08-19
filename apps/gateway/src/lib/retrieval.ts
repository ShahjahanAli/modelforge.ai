import { createHash } from "node:crypto";
import { prisma } from "@modelforge/db";
import { rankChunks } from "@modelforge/platform";

export class RetrievalError extends Error {
  readonly status = 400;
  readonly type = "invalid_request";

  constructor(message: string) {
    super(message);
    this.name = "RetrievalError";
  }
}

export type ChatTurn = { role: string; content: string };

export type RetrievalHit = {
  chunkId: string;
  knowledgeBaseId: string;
  knowledgeBaseName: string;
  documentId: string;
  documentTitle: string;
  ordinal: number;
  content: string;
  score: number;
};

export type RetrievalResult = {
  knowledgeBaseIds: string[];
  topK: number;
  query: string;
  hits: RetrievalHit[];
  mode: "passages" | "catalog";
};

export const GROUNDED_SYSTEM_PROMPT =
  "Answer using ONLY the knowledge passages below. " +
  "If a passage lists steps or a procedure, include every step in order — do not shorten it to one sentence. " +
  "If several passages apply, combine them. " +
  "If the passages do not contain the answer, say that you do not have that information — in the same language as the user. " +
  "When the user writes Bangla, do not reply with the English words \"I do not know\". " +
  "Do not invent facts. " +
  "Always answer in the user's language. Passages may mix Bangla and English; translate the facts, keep official menu names. " +
  "When giving instructions, address the user as you (Bangla: আপনি), not I (আমি).";

export const CATALOG_SYSTEM_PROMPT =
  "The user asked what is in their knowledge base. Answer from the catalog below. " +
  "List each knowledge base and its documents, and briefly say what they cover. " +
  "Do not say you do not know. Do not invent extra documents. " +
  "Always answer in the user's language. When the user writes Bangla, answer in Bangla.";

/** Conservative mixed-script estimate so Bangla does not overflow llama.cpp context. */
export function estimatePromptTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 2));
}

export function clampMaxTokens(
  contextLength: number,
  messages: readonly ChatTurn[],
  requested: number,
): number {
  const prompt =
    messages.reduce((sum, message) => sum + estimatePromptTokens(message.content), 0) + 96;
  const room = contextLength - prompt;
  return Math.max(48, Math.min(requested, Math.max(48, room)));
}

function passageCharBudget(contextLength: number): number {
  return Math.max(800, Math.floor(contextLength * 0.9));
}

export function fitHitsToBudget(hits: readonly RetrievalHit[], contextLength: number): RetrievalHit[] {
  const budget = passageCharBudget(contextLength);
  const fitted: RetrievalHit[] = [];
  let used = 0;
  for (const hit of hits) {
    if (fitted.length > 0 && used + hit.content.length > budget) break;
    fitted.push(hit);
    used += hit.content.length;
  }
  return fitted.length > 0 ? fitted : hits.slice(0, 1);
}

export function lastUserQuery(messages: readonly ChatTurn[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user" && message.content.trim()) return message.content;
  }
  return "";
}

export function isKnowledgeCatalogQuery(query: string): boolean {
  const q = query.normalize("NFC").trim().toLocaleLowerCase();
  if (!q) return false;
  const aboutLibrary =
    /knowledge\s*base|knowledgebase|নলেজ\s*বেস|নলেজবেস|\bkb\b|ingested documents|আমার নথি/.test(q);
  const listing =
    /ক[ীি]\s*আছে|কি\s*কি|what(?:'s| is) in|what do (?:i|you) have|list (?:the )?(?:docs|documents)|contents|catalog|index|কোন নথি|কী নথি/.test(
      q,
    );
  return aboutLibrary && listing;
}

export function prefersBanglaReply(query: string): boolean {
  const bangla = (query.match(/\p{Script=Bengali}/gu) ?? []).length;
  const latin = (query.match(/[A-Za-z]/g) ?? []).length;
  return bangla >= 4 && bangla >= latin;
}

export function replyLanguageDirective(query: string): string {
  if (prefersBanglaReply(query)) {
    return (
      "Language lock: The user wrote Bangla. Write the entire answer in Bangla script. " +
      "Do not write paragraphs in English. Keep only official labels in Latin " +
      "(e-Return, TIN, Return submission, Assessment) if they appear in the passages. " +
      "Address the user as আপনি, never as আমি. Do not copy the user's first-person phrasing. " +
      "Use second-person instructions (করুন, যান, দিন).\n" +
      "ভাষা: ব্যবহারকারী বাংলায় প্রশ্ন করেছেন। পুরো উত্তর বাংলায় লিখুন। ইংরেজিতে অনুচ্ছেদ লিখবেন না। " +
      "ব্যবহারকারীকে আপনি বলে সম্বোধন করুন, আমি নয়। প্রশ্নের আমি কপি করবেন না।"
    );
  }
  return "Language lock: Reply in the same language as the user. Address the user as you, not I.";
}

export function applyRetrievalContext(
  messages: ChatTurn[],
  hits: readonly RetrievalHit[],
  mode: "passages" | "catalog" = "passages",
): ChatTurn[] {
  const passages =
    hits.length === 0
      ? "No relevant passages were found. Tell the user you do not have that information, in the same language they used."
      : hits
          .map(
            (hit, index) =>
              `[${index + 1}] ${hit.documentTitle}\n${hit.content}`,
          )
          .join("\n\n");

  const instructions = mode === "catalog" ? CATALOG_SYSTEM_PROMPT : GROUNDED_SYSTEM_PROMPT;
  const query = lastUserQuery(messages);
  const grounded: ChatTurn = {
    role: "system",
    content:
      `${instructions}\n\nKnowledge ${mode === "catalog" ? "catalog" : "passages"}:\n${passages}` +
      `\n\n${replyLanguageDirective(query)}`,
  };

  const rest = messages.filter((message) => message.role !== "system");
  return [grounded, ...rest];
}

export function publicRetrievalHits(hits: readonly RetrievalHit[]) {
  const unique = new Map<
    string,
    { title: string; knowledge_base: string; score: number; excerpt: string }
  >();
  for (const hit of hits) {
    const key = hit.documentId || hit.documentTitle;
    if (unique.has(key)) continue;
    unique.set(key, {
      title: hit.documentTitle,
      knowledge_base: hit.knowledgeBaseName,
      score: Number(hit.score.toFixed(3)),
      excerpt: hit.content.replace(/\s+/g, " ").slice(0, 120).trim(),
    });
  }
  return [...unique.values()];
}

export async function retrieveCustomerKnowledge(input: {
  customerId: string;
  query: string;
  knowledgeBaseIds: string[];
  topK?: number;
  contextLength?: number;
}): Promise<RetrievalResult> {
  const requested = [...new Set(input.knowledgeBaseIds.map((id) => id.trim()).filter(Boolean))];
  if (requested.length === 0) {
    return { knowledgeBaseIds: [], topK: input.topK ?? 4, query: input.query, hits: [], mode: "passages" };
  }

  if (isKnowledgeCatalogQuery(input.query)) {
    return catalogCustomerKnowledge({
      customerId: input.customerId,
      knowledgeBaseIds: requested,
      query: input.query,
    });
  }

  const bases = await prisma.knowledgeBase.findMany({
    where: { customerId: input.customerId, id: { in: requested } },
    select: { id: true, name: true },
  });
  if (bases.length !== requested.length) {
    throw new RetrievalError("One or more knowledge bases were not found on this account");
  }

  const topK = Math.max(1, Math.min(input.topK ?? 4, 8));
  const rows = await prisma.knowledgeChunk.findMany({
    where: {
      version: {
        document: {
          status: "SUCCEEDED",
          knowledgeBaseId: { in: requested },
        },
      },
    },
    select: {
      id: true,
      content: true,
      embedding: true,
      ordinal: true,
      version: {
        select: {
          document: {
            select: {
              id: true,
              title: true,
              knowledgeBase: { select: { id: true, name: true } },
            },
          },
        },
      },
    },
    take: 4_000,
  });

  const ranked = rankChunks(
    input.query,
    rows.map((row) => ({
      chunkId: row.id,
      knowledgeBaseId: row.version.document.knowledgeBase.id,
      knowledgeBaseName: row.version.document.knowledgeBase.name,
      documentId: row.version.document.id,
      documentTitle: row.version.document.title,
      ordinal: row.ordinal,
      content: row.content,
      embedding: row.embedding,
    })),
    { topK, minScore: 0.12 },
  );

  const hits: RetrievalHit[] = ranked.map((chunk) => ({
    chunkId: chunk.chunkId,
    knowledgeBaseId: chunk.knowledgeBaseId,
    knowledgeBaseName: chunk.knowledgeBaseName,
    documentId: chunk.documentId,
    documentTitle: chunk.documentTitle,
    ordinal: chunk.ordinal,
    content: chunk.content,
    score: chunk.score,
  }));

  return {
    knowledgeBaseIds: requested,
    topK,
    query: input.query,
    hits: input.contextLength ? fitHitsToBudget(hits, input.contextLength) : hits,
    mode: "passages",
  };
}

async function catalogCustomerKnowledge(input: {
  customerId: string;
  knowledgeBaseIds: string[];
  query: string;
}): Promise<RetrievalResult> {
  const bases = await prisma.knowledgeBase.findMany({
    where: { customerId: input.customerId, id: { in: input.knowledgeBaseIds } },
    select: {
      id: true,
      name: true,
      documents: {
        where: { status: "SUCCEEDED" },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          title: true,
          versions: {
            orderBy: { version: "desc" },
            take: 1,
            select: {
              chunks: {
                orderBy: { ordinal: "asc" },
                take: 1,
                select: { id: true, content: true },
              },
            },
          },
        },
      },
    },
  });
  if (bases.length !== input.knowledgeBaseIds.length) {
    throw new RetrievalError("One or more knowledge bases were not found on this account");
  }

  const hits: RetrievalHit[] = [];
  for (const base of bases) {
    if (base.documents.length === 0) {
      hits.push({
        chunkId: `catalog:${base.id}`,
        knowledgeBaseId: base.id,
        knowledgeBaseName: base.name,
        documentId: base.id,
        documentTitle: base.name,
        ordinal: 0,
        score: 1,
        content: `Knowledge base "${base.name}" has no ingested documents yet.`,
      });
      continue;
    }
    for (const [index, document] of base.documents.entries()) {
      const opening = document.versions[0]?.chunks[0]?.content.replace(/\s+/g, " ").slice(0, 280).trim();
      hits.push({
        chunkId: document.versions[0]?.chunks[0]?.id ?? `catalog:${document.id}`,
        knowledgeBaseId: base.id,
        knowledgeBaseName: base.name,
        documentId: document.id,
        documentTitle: document.title,
        ordinal: index,
        score: 1,
        content:
          `This document is in knowledge base "${base.name}".\n` +
          `Title: ${document.title}\n` +
          (opening ? `Opening excerpt: ${opening}` : "No preview is available."),
      });
    }
  }

  return {
    knowledgeBaseIds: input.knowledgeBaseIds,
    topK: Math.max(hits.length, 1),
    query: input.query,
    hits,
    mode: "catalog",
  };
}

export async function persistRetrievalRun(input: {
  requestId: string;
  result: RetrievalResult;
}) {
  const queryHash = createHash("sha256").update(input.result.query).digest("hex");
  await prisma.retrievalRun.create({
    data: {
      requestId: input.requestId,
      queryHash,
      topK: input.result.topK,
      hits: publicRetrievalHits(input.result.hits),
    },
  });
}
