"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@modelforge/db";
import { chunkText, simpleEmbed } from "@modelforge/platform";
import { createHash } from "node:crypto";
import { requireSession, assertOwnership } from "@/lib/session";
import { writeAuditEvent } from "@/lib/audit";

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
}

export async function ingestKnowledgeDocumentAction(formData: FormData) {
  const user = await requireSession();
  const knowledgeBaseId = String(formData.get("knowledgeBaseId"));
  const title = String(formData.get("title") || "Untitled");
  const content = String(formData.get("content") || "");
  const base = await prisma.knowledgeBase.findUnique({ where: { id: knowledgeBaseId } });
  if (!base) throw new Error("Knowledge base not found");
  assertOwnership(base.customerId, user);
  if (!content.trim()) throw new Error("Content required");

  const checksum = createHash("sha256").update(content).digest("hex");
  const document = await prisma.knowledgeDocument.create({
    data: {
      knowledgeBaseId,
      title,
      status: "RUNNING",
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
  const chunks = chunkText(content, 800);
  for (const [ordinal, chunk] of chunks.entries()) {
    await prisma.knowledgeChunk.create({
      data: {
        versionId: version.id,
        ordinal,
        content: chunk,
        tokenCount: Math.ceil(chunk.length / 4),
        embedding: simpleEmbed(chunk),
      },
    });
  }
  await prisma.knowledgeDocument.update({
    where: { id: document.id },
    data: { status: "SUCCEEDED" },
  });
  await writeAuditEvent({
    actorType: "user",
    actorId: user.id,
    customerId: user.id,
    action: "knowledge.ingest",
    resourceType: "KnowledgeDocument",
    resourceId: document.id,
  });
  revalidatePath("/knowledge");
}
