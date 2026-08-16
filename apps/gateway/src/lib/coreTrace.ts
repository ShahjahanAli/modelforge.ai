import { prisma, type Prisma } from "@modelforge/db";

const armedByCustomer = new Map<string, string>();

export interface TraceEventInput {
  phase: string;
  kind: string;
  payload?: Prisma.InputJsonValue;
}

/**
 * Keeps the disabled path in memory: normal inference does not query or write
 * trace tables. The map is hydrated once at gateway startup and changed only
 * by authenticated internal control-plane calls.
 */
export async function hydrateArmedCoreTraces(): Promise<number> {
  const now = new Date();
  await prisma.coreTraceSession.updateMany({
    where: { status: "ARMED", expiresAt: { lte: now } },
    data: { status: "EXPIRED" },
  });
  const sessions = await prisma.coreTraceSession.findMany({
    where: { status: "ARMED", expiresAt: { gt: now } },
    orderBy: { createdAt: "asc" },
    select: { id: true, customerId: true },
  });
  armedByCustomer.clear();
  for (const session of sessions) {
    // Only the oldest armed capture per customer claims the next request.
    if (!armedByCustomer.has(session.customerId)) {
      armedByCustomer.set(session.customerId, session.id);
    }
  }
  return armedByCustomer.size;
}

export function armCoreTrace(customerId: string, traceId: string): void {
  armedByCustomer.set(customerId, traceId);
}

export function disarmCoreTrace(customerId: string, traceId?: string): void {
  if (!traceId || armedByCustomer.get(customerId) === traceId) {
    armedByCustomer.delete(customerId);
  }
}

export class CoreTraceRecorder {
  readonly traceId: string;
  private readonly originMs: number;
  private sequence = 0;
  private closed = false;

  constructor(traceId: string, originMs: number) {
    this.traceId = traceId;
    this.originMs = originMs;
  }

  async event(input: TraceEventInput): Promise<void> {
    if (this.closed) return;
    this.sequence += 1;
    try {
      await prisma.coreTraceEvent.create({
        data: {
          traceId: this.traceId,
          sequence: this.sequence,
          phase: input.phase,
          kind: input.kind,
          atMs: Math.max(0, Date.now() - this.originMs),
          payload: input.payload,
        },
      });
    } catch (error) {
      // Diagnostics must never fail or delay production inference correctness.
      console.warn("Core trace event write skipped:", error);
    }
  }

  async complete(summary: Prisma.InputJsonValue): Promise<void> {
    if (this.closed) return;
    await this.event({ phase: "complete", kind: "request.completed", payload: summary });
    this.closed = true;
    await prisma.coreTraceSession
      .update({
        where: { id: this.traceId },
        data: { status: "COMPLETED", completedAt: new Date(), summary },
      })
      .catch((error) => console.warn("Core trace completion write skipped:", error));
  }

  async fail(message: string): Promise<void> {
    if (this.closed) return;
    await this.event({
      phase: "failed",
      kind: "request.failed",
      payload: { message },
    });
    this.closed = true;
    await prisma.coreTraceSession
      .update({
        where: { id: this.traceId },
        data: {
          status: "FAILED",
          completedAt: new Date(),
          summary: { error: message },
        },
      })
      .catch((error) => console.warn("Core trace failure write skipped:", error));
  }
}

export async function claimCoreTrace(input: {
  customerId: string;
  requestId: string;
  startedAtMs: number;
  explicitTraceId?: string;
  requestSnapshot: Prisma.InputJsonValue;
}): Promise<CoreTraceRecorder | null> {
  const traceId = input.explicitTraceId ?? armedByCustomer.get(input.customerId);
  if (!traceId) return null;

  const now = new Date();
  const claimed = await prisma.coreTraceSession
    .updateMany({
      where: {
        id: traceId,
        customerId: input.customerId,
        status: "ARMED",
        expiresAt: { gt: now },
      },
      data: {
        status: "CAPTURING",
        requestId: input.requestId,
        startedAt: now,
      },
    })
    .catch((error) => {
      console.warn("Core trace claim skipped:", error);
      return { count: 0 };
    });
  disarmCoreTrace(input.customerId, traceId);
  if (claimed.count !== 1) return null;

  const recorder = new CoreTraceRecorder(traceId, input.startedAtMs);
  await recorder.event({
    phase: "ingress",
    kind: "request.received",
    payload: input.requestSnapshot,
  });
  return recorder;
}
