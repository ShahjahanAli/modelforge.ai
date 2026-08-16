import path from "node:path";
import { prisma, type InferenceRequest } from "@modelforge/db";
import { canonicalStringify, LocalFileSigningProvider } from "@modelforge/platform";

let signingProvider: LocalFileSigningProvider | undefined;

export async function ensureSigningKey(): Promise<LocalFileSigningProvider> {
  signingProvider ??= new LocalFileSigningProvider(
    path.resolve(process.env.MODELFORGE_SIGNING_DIR ?? "./data/signing"),
  );
  await prisma.signingKey.upsert({
    where: { keyId: signingProvider.keyId },
    update: { active: true, revokedAt: null },
    create: {
      keyId: signingProvider.keyId,
      algorithm: "Ed25519",
      publicKey: signingProvider.publicKey,
      privateRef: process.env.MODELFORGE_SIGNING_DIR ?? "./data/signing",
    },
  });
  return signingProvider;
}

export async function issueUsageReceipt(input: {
  request: InferenceRequest;
  usageEventId?: string;
}) {
  const existing = await prisma.usageReceipt.findUnique({
    where: { requestId: input.request.id },
  });
  if (existing) return existing;

  const previous = await prisma.usageReceipt.findFirst({ orderBy: { issuedAt: "desc" } });
  const issuedAt = new Date();
  const payload = {
    version: 1,
    requestId: input.request.id,
    customerId: input.request.customerId,
    apiKeyId: input.request.apiKeyId,
    requestedModel: input.request.requestedModelSlug,
    resolvedModel: input.request.resolvedModelSlug,
    promptTokens: input.request.promptTokens,
    completionTokens: input.request.completionTokens,
    costMicros: input.request.costMicros.toString(),
    finishReason: input.request.finishReason,
    status: input.request.status,
    usageEventId: input.usageEventId ?? null,
    issuedAt: issuedAt.toISOString(),
  };
  const provider = await ensureSigningKey();
  const signed = provider.signPayload(payload);
  const receipt = await prisma.usageReceipt.create({
    data: {
      requestId: input.request.id,
      usageEventId: input.usageEventId,
      payloadCanonical: canonicalStringify(payload),
      payloadHash: signed.payloadHash,
      signature: signed.signature,
      algorithm: signed.algorithm,
      signingKeyId: signed.keyId,
      previousHash: previous?.payloadHash,
      issuedAt,
    },
  });
  await prisma.inferenceRequest.update({
    where: { id: input.request.id },
    data: { receiptId: receipt.id },
  });
  return receipt;
}
