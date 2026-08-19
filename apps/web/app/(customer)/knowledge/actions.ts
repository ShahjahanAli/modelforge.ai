"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@modelforge/db";
import { prepareKnowledgeChunks } from "@modelforge/platform";
import { createHash } from "node:crypto";
import { requireSession, assertOwnership } from "@/lib/session";
import { writeAuditEvent } from "@/lib/audit";

const MAX_DOCUMENT_BYTES = 512_000;

async function ingestPlainText(input: {
  customerId: string;
  knowledgeBaseId: string;
  title: string;
  content: string;
  contentType?: string;
}) {
  const content = input.content.trim();
  if (!content) throw new Error("Content required");
  if (Buffer.byteLength(content) > MAX_DOCUMENT_BYTES) {
    throw new Error("Document is larger than 512 KB");
  }

  const checksum = createHash("sha256").update(content).digest("hex");
  const document = await prisma.knowledgeDocument.create({
    data: {
      knowledgeBaseId: input.knowledgeBaseId,
      title: input.title.trim() || "Untitled",
      status: "RUNNING",
      contentType: input.contentType ?? "text/plain",
    },
  });
  const version = await prisma.documentVersion.create({
    data: {
      documentId: document.id,
      version: 1,
      checksum,
      storageKey: `local://${document.id}/v1.txt`,
      byteSize: Buffer.byteLength(content),
    },
  });
  const chunks = prepareKnowledgeChunks(content, 800);
  if (chunks.length > 0) {
    await prisma.knowledgeChunk.createMany({
      data: chunks.map((chunk) => ({
        versionId: version.id,
        ordinal: chunk.ordinal,
        content: chunk.content,
        tokenCount: chunk.tokenCount,
        embedding: chunk.embedding,
      })),
    });
  }
  await prisma.knowledgeDocument.update({
    where: { id: document.id },
    data: { status: "SUCCEEDED" },
  });
  await writeAuditEvent({
    actorType: "user",
    actorId: input.customerId,
    customerId: input.customerId,
    action: "knowledge.ingest",
    resourceType: "KnowledgeDocument",
    resourceId: document.id,
  });
  return { documentId: document.id, chunks: chunks.length };
}

export async function createKnowledgeBaseAction(formData: FormData) {
  const user = await requireSession();
  const name = String(formData.get("name") || "").trim();
  if (!name) throw new Error("Name required");
  const base = await prisma.knowledgeBase.create({
    data: {
      customerId: user.id,
      name,
      description: String(formData.get("description") || "") || null,
    },
  });
  await writeAuditEvent({
    actorType: "user",
    actorId: user.id,
    customerId: user.id,
    action: "knowledge.create",
    resourceType: "KnowledgeBase",
    resourceId: base.id,
  });
  revalidatePath("/knowledge");
  revalidatePath("/chat");
}

export async function ingestKnowledgeDocumentAction(formData: FormData) {
  const user = await requireSession();
  const knowledgeBaseId = String(formData.get("knowledgeBaseId"));
  const base = await prisma.knowledgeBase.findUnique({ where: { id: knowledgeBaseId } });
  if (!base) throw new Error("Knowledge base not found");
  assertOwnership(base.customerId, user);

  let title = String(formData.get("title") || "").trim();
  let content = String(formData.get("content") || "");
  let contentType = "text/plain";
  const file = formData.get("file");
  if (file instanceof File && file.size > 0) {
    const name = file.name.toLowerCase();
    if (!/\.(txt|md|csv)$/i.test(name)) {
      throw new Error("Upload a .txt, .md, or .csv file");
    }
    if (file.size > MAX_DOCUMENT_BYTES) throw new Error("File is larger than 512 KB");
    content = await file.text();
    title ||= file.name.replace(/\.(txt|md|csv)$/i, "");
    contentType = name.endsWith(".md") ? "text/markdown" : name.endsWith(".csv") ? "text/csv" : "text/plain";
  }

  await ingestPlainText({
    customerId: user.id,
    knowledgeBaseId,
    title: title || "Untitled",
    content,
    contentType,
  });
  revalidatePath("/knowledge");
  revalidatePath("/chat");
}

export async function deleteKnowledgeDocumentAction(formData: FormData) {
  const user = await requireSession();
  const documentId = String(formData.get("documentId") || "");
  const document = await prisma.knowledgeDocument.findUnique({
    where: { id: documentId },
    include: { knowledgeBase: true },
  });
  if (!document) throw new Error("Document not found");
  assertOwnership(document.knowledgeBase.customerId, user);
  await prisma.knowledgeDocument.delete({ where: { id: documentId } });
  await writeAuditEvent({
    actorType: "user",
    actorId: user.id,
    customerId: user.id,
    action: "knowledge.document.delete",
    resourceType: "KnowledgeDocument",
    resourceId: documentId,
  });
  revalidatePath("/knowledge");
  revalidatePath("/chat");
}

export async function deleteKnowledgeBaseAction(formData: FormData) {
  const user = await requireSession();
  const knowledgeBaseId = String(formData.get("knowledgeBaseId") || "");
  const base = await prisma.knowledgeBase.findUnique({ where: { id: knowledgeBaseId } });
  if (!base) throw new Error("Knowledge base not found");
  assertOwnership(base.customerId, user);
  await prisma.knowledgeBase.delete({ where: { id: knowledgeBaseId } });
  await writeAuditEvent({
    actorType: "user",
    actorId: user.id,
    customerId: user.id,
    action: "knowledge.delete",
    resourceType: "KnowledgeBase",
    resourceId: knowledgeBaseId,
  });
  revalidatePath("/knowledge");
  revalidatePath("/chat");
}
