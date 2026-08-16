import { createHash } from "node:crypto";
import { prisma, type Prisma } from "@modelforge/db";

export async function writeAuditEvent(input: {
  actorType: string;
  actorId?: string;
  customerId?: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  requestId?: string;
  metadata?: Prisma.InputJsonValue;
  before?: unknown;
  after?: unknown;
}) {
  const hash = (value: unknown) =>
    value === undefined
      ? undefined
      : createHash("sha256").update(JSON.stringify(value)).digest("hex");

  return prisma.auditEvent.create({
    data: {
      actorType: input.actorType,
      actorId: input.actorId,
      customerId: input.customerId,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      requestId: input.requestId,
      beforeHash: hash(input.before),
      afterHash: hash(input.after),
      metadata: input.metadata,
    },
  });
}
