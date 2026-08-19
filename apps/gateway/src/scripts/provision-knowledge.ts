/**
 * Provision a grounded knowledge base for a subscriber.
 *
 *   pnpm --filter @modelforge/gateway knowledge:provision
 */
import { prisma } from "@modelforge/db";
import { ingestTextDocument } from "../lib/modernJobs.js";

const EMAIL = process.env.KNOWLEDGE_CUSTOMER_EMAIL ?? "shahjahan.mist@gmail.com";
const BASE_NAME = "Primary knowledge";

const DOCUMENTS: Array<{ title: string; content: string }> = [
  {
    title: "How grounded chat works",
    content: `This knowledge base grounds ModelForge chat for this account.

English:
- Chat retrieves matching passages from ingested documents before answering.
- If a fact is not in those passages, the assistant must say it does not know.
- Do not invent tax rates, laws, circular numbers, or citations.
- Reply in Bangla when the user writes Bangla, otherwise match the user's language.
- Add official documents on the Knowledge page as .txt, .md, or .csv files.

বাংলা:
- চ্যাট উত্তর দেওয়ার আগে নলেজ বেসের নথি থেকে মিল থাকা অংশ খুঁজে নেয়।
- কোনো তথ্য নথিতে না থাকলে সহকারী বলবে সে জানে না।
- করহার, আইন, সার্কুলার নম্বর বা উদ্ধৃতি তৈরি করা যাবে না।
- ব্যবহারকারী বাংলায় লিখলে উত্তর বাংলায় দিতে হবে।
- আসল নথি Knowledge পাতায় যোগ করুন।`,
  },
  {
    title: "Retrieval check",
    content: `This document exists so you can verify retrieval is working.

The ModelForge retrieval check code is MF-RAG-7719.

If a user asks for the retrieval check code, the retrieval test phrase, or "রিট্রিভাল চেক কোড", answer only: MF-RAG-7719.

Do not use this document to answer unrelated questions.`,
  },
  {
    title: "Account profile",
    content: `Subscriber profile for this ModelForge workspace.

- Account email: shahjahan.mist@gmail.com
- Workspace purpose: bilingual Bangla and English Q&A grounded in uploaded documents
- Preferred answer language: Bangla when the question is in Bangla
- Knowledge policy: answers must come from ingested documents, not model memory

If asked who this workspace belongs to, say it is the ModelForge subscriber account shahjahan.mist@gmail.com.`,
  },
];

const customer = await prisma.customer.findUnique({
  where: { email: EMAIL.toLowerCase() },
  include: { knowledgeBases: { include: { documents: true } } },
});

if (!customer) {
  console.error(`No customer found for ${EMAIL}. Register the account first.`);
  process.exit(1);
}

if (customer.role === "ADMIN") {
  console.error(`${EMAIL} is an admin account. Knowledge bases are tenant-scoped to subscribers.`);
  process.exit(1);
}

const existing = customer.knowledgeBases.find((base) => base.name === BASE_NAME);
const base =
  existing ??
  (await prisma.knowledgeBase.create({
    data: {
      customerId: customer.id,
      name: BASE_NAME,
      description: "Grounded bilingual Q&A. Chat answers only from ingested documents.",
      sensitivity: "INTERNAL",
      retentionDays: 365,
    },
  }));

const already = new Set((existing?.documents ?? []).map((document) => document.title));

const created: string[] = [];
for (const document of DOCUMENTS) {
  if (already.has(document.title)) continue;
  await ingestTextDocument({
    knowledgeBaseId: base.id,
    title: document.title,
    content: document.content,
  });
  created.push(document.title);
}

const summary = await prisma.knowledgeBase.findUniqueOrThrow({
  where: { id: base.id },
  include: {
    documents: {
      include: { versions: { include: { _count: { select: { chunks: true } } } } },
    },
  },
});

console.log(
  JSON.stringify(
    {
      customer: { id: customer.id, email: customer.email },
      knowledgeBase: {
        id: summary.id,
        name: summary.name,
        created: !existing,
        documents: summary.documents.map((document) => ({
          title: document.title,
          status: document.status,
          chunks: document.versions.reduce((sum, version) => sum + version._count.chunks, 0),
        })),
        ingestedNow: created,
      },
    },
    null,
    2,
  ),
);

await prisma.$disconnect();
