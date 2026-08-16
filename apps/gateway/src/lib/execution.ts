import { prisma, type InferenceStatus, type Prisma } from "@modelforge/db";

export interface CreateInferenceRequestInput {
  customerId: string;
  apiKeyId: string;
  requestedModelSlug: string;
  requestedModelId?: string;
  stream: boolean;
}

export function createInferenceRequest(input: CreateInferenceRequestInput) {
  return prisma.inferenceRequest.create({
    data: {
      customerId: input.customerId,
      apiKeyId: input.apiKeyId,
      requestedModelSlug: input.requestedModelSlug,
      requestedModelId: input.requestedModelId,
      stream: input.stream,
    },
  });
}

export function startAttempt(
  requestId: string,
  input: { backend: string; modelSlug: string; nodeId?: string; attemptNo: number },
) {
  const now = new Date();
  return prisma.$transaction([
    prisma.inferenceRequest.update({
      where: { id: requestId },
      data: { status: "RUNNING", startedAt: now },
    }),
    prisma.inferenceAttempt.create({
      data: {
        requestId,
        backend: input.backend,
        modelSlug: input.modelSlug,
        nodeId: input.nodeId,
        attemptNo: input.attemptNo,
        status: "RUNNING",
        startedAt: now,
      },
    }),
  ]);
}

export interface FinalizeInferenceRequestFields {
  status: InferenceStatus;
  promptTokens?: number;
  completionTokens?: number;
  queueMs?: number;
  coldStartMs?: number;
  ttftMs?: number | null;
  generationMs?: number;
  latencyMs?: number;
  finishReason?: string | null;
  error?: { code?: string; message?: string } | null;
  pricingVersionId?: string | null;
  costMicros?: bigint | number;
  resolvedModelId?: string | null;
  resolvedModelSlug?: string | null;
  policyVersionId?: string | null;
  policyDecisionHash?: string | null;
  nodeId?: string | null;
  attemptNo?: number;
}

export async function finalizeInferenceRequest(
  requestId: string,
  fields: FinalizeInferenceRequestFields,
) {
  const completedAt = new Date();
  const request = await prisma.inferenceRequest.update({
    where: { id: requestId },
    data: {
      status: fields.status,
      promptTokens: fields.promptTokens,
      completionTokens: fields.completionTokens,
      queueMs: fields.queueMs,
      coldStartMs: fields.coldStartMs,
      ttftMs: fields.ttftMs,
      generationMs: fields.generationMs,
      latencyMs: fields.latencyMs,
      finishReason: fields.finishReason,
      errorCode: fields.error?.code ?? null,
      errorMessage: fields.error?.message ?? null,
      pricingVersionId: fields.pricingVersionId,
      costMicros: fields.costMicros === undefined ? undefined : BigInt(fields.costMicros),
      resolvedModelId: fields.resolvedModelId,
      resolvedModelSlug: fields.resolvedModelSlug,
      policyVersionId: fields.policyVersionId,
      policyDecisionHash: fields.policyDecisionHash,
      nodeId: fields.nodeId,
      completedAt,
    },
  });

  if (fields.attemptNo !== undefined) {
    await prisma.inferenceAttempt.update({
      where: { requestId_attemptNo: { requestId, attemptNo: fields.attemptNo } },
      data: {
        status: fields.status,
        promptTokens: fields.promptTokens,
        completionTokens: fields.completionTokens,
        queueMs: fields.queueMs,
        coldStartMs: fields.coldStartMs,
        ttftMs: fields.ttftMs,
        generationMs: fields.generationMs,
        costMicros: fields.costMicros === undefined ? undefined : BigInt(fields.costMicros),
        errorCode: fields.error?.code ?? null,
        errorMessage: fields.error?.message ?? null,
        completedAt,
      },
    });
  }
  return request;
}

export interface AuditEventInput {
  actorType: string;
  actorId?: string;
  customerId?: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  requestId?: string;
  beforeHash?: string;
  afterHash?: string;
  metadata?: Prisma.InputJsonValue;
  ip?: string;
  userAgent?: string;
}

export function writeAuditEvent(input: AuditEventInput) {
  return prisma.auditEvent.create({ data: input });
}
