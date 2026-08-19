/**
 * Ingest NBR FAQ markdown into the subscriber knowledge base.
 *
 *   pnpm exec dotenv -e ../../.env -- pnpm exec tsx src/scripts/ingest-nbr-faq.ts
 */
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "@modelforge/db";
import { ingestTextDocument } from "../lib/modernJobs.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../../..");

const EMAIL = process.env.KNOWLEDGE_CUSTOMER_EMAIL ?? "shahjahan.mist@gmail.com";
const BASE_NAME = "Primary knowledge";
const FAQ_PATH = join(repoRoot, "data", "knowledge", "nbr-faq-eng.md");
const DOCUMENT_TITLE = "NBR FAQ (nbr.gov.bd/all-faq/eng)";

const customer = await prisma.customer.findUnique({
  where: { email: EMAIL.toLowerCase() },
  include: {
    knowledgeBases: {
      where: { name: BASE_NAME },
      include: { documents: { where: { title: DOCUMENT_TITLE } } },
    },
  },
});

if (!customer) {
  console.error(`No customer found for ${EMAIL}`);
  process.exit(1);
}

const base = customer.knowledgeBases[0];
if (!base) {
  console.error(`Knowledge base "${BASE_NAME}" not found for ${EMAIL}. Run knowledge:provision first.`);
  process.exit(1);
}

if (base.documents.length > 0) {
  for (const document of base.documents) {
    await prisma.knowledgeDocument.delete({ where: { id: document.id } });
  }
  console.log(
    JSON.stringify(
      {
        replaced: true,
        knowledgeBaseId: base.id,
        removedDocumentIds: base.documents.map((document) => document.id),
      },
      null,
      2,
    ),
  );
}

const content = readFileSync(FAQ_PATH, "utf8");
const result = await ingestTextDocument({
  knowledgeBaseId: base.id,
  title: DOCUMENT_TITLE,
  content,
});

console.log(
  JSON.stringify(
    {
      customer: { id: customer.id, email: customer.email },
      knowledgeBase: { id: base.id, name: base.name },
      document: result,
      source: FAQ_PATH,
      bytes: Buffer.byteLength(content),
    },
    null,
    2,
  ),
);

await prisma.$disconnect();
