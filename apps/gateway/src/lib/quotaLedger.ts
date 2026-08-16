import { Prisma, prisma } from "@modelforge/db";

export class QuotaExceededError extends Error {
  constructor() {
    super("Monthly token quota exceeded");
    this.name = "QuotaExceededError";
  }
}

export function wouldExceedQuota(
  used: bigint,
  reserved: bigint,
  estimate: bigint,
  limit: bigint,
): boolean {
  return limit > 0n && used + reserved + estimate > limit;
}

function isPrismaError(error: unknown, code: string): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}

async function serializable<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt < 2 && isPrismaError(error, "P2034")) continue;
      throw error;
    }
  }
}

function defaultPeriod() {
  const periodStart = new Date();
  return { periodStart, periodEnd: new Date(periodStart.getTime() + 30 * 86_400_000) };
}

export interface ReserveQuotaInput {
  customerId: string;
  requestId: string;
  estimatedTokens: number | bigint;
  idempotencyKey: string;
  limit: number | bigint;
  periodStart?: Date;
  periodEnd?: Date;
}

export async function reserveQuota(input: ReserveQuotaInput) {
  const estimate = BigInt(input.estimatedTokens);
  const limit = BigInt(input.limit);
  const period = defaultPeriod();
  try {
    return await serializable(() =>
      prisma.$transaction(
        async (tx) => {
          const existing = await tx.quotaLedgerEntry.findUnique({
            where: { idempotencyKey: input.idempotencyKey },
          });
          if (existing) return existing;

          const ledger = await tx.quotaLedger.upsert({
            where: { customerId: input.customerId },
            update: {},
            create: {
              customerId: input.customerId,
              periodStart: input.periodStart ?? period.periodStart,
              periodEnd: input.periodEnd ?? period.periodEnd,
            },
          });
          if (wouldExceedQuota(ledger.tokensUsed, ledger.tokensReserved, estimate, limit)) {
            throw new QuotaExceededError();
          }

          const entry = await tx.quotaLedgerEntry.create({
            data: {
              ledgerId: ledger.id,
              idempotencyKey: input.idempotencyKey,
              deltaTokens: 0n,
              reservedDelta: estimate,
              reason: "RESERVE",
              requestId: input.requestId,
            },
          });
          await tx.quotaLedger.update({
            where: { id: ledger.id },
            data: { tokensReserved: { increment: estimate } },
          });
          return entry;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );
  } catch (error) {
    if (isPrismaError(error, "P2002")) {
      return prisma.quotaLedgerEntry.findUniqueOrThrow({
        where: { idempotencyKey: input.idempotencyKey },
      });
    }
    throw error;
  }
}

export interface CommitQuotaInput {
  customerId: string;
  requestId: string;
  actualTokens: number | bigint;
  idempotencyKey: string;
}

export async function commitQuota(input: CommitQuotaInput) {
  const actual = BigInt(input.actualTokens);
  try {
    return await serializable(() =>
      prisma.$transaction(
        async (tx) => {
          const existing = await tx.quotaLedgerEntry.findUnique({
            where: { idempotencyKey: input.idempotencyKey },
          });
          if (existing) return existing;

          const ledger = await tx.quotaLedger.findUniqueOrThrow({
            where: { customerId: input.customerId },
          });
          const reservation = await tx.quotaLedgerEntry.aggregate({
            where: { ledgerId: ledger.id, requestId: input.requestId },
            _sum: { reservedDelta: true },
          });
          const reserved = reservation._sum.reservedDelta ?? 0n;
          const release = reserved > 0n ? reserved : 0n;
          const entry = await tx.quotaLedgerEntry.create({
            data: {
              ledgerId: ledger.id,
              idempotencyKey: input.idempotencyKey,
              deltaTokens: actual,
              reservedDelta: -release,
              reason: "COMMIT",
              requestId: input.requestId,
            },
          });
          await tx.quotaLedger.update({
            where: { id: ledger.id },
            data: {
              tokensUsed: { increment: actual },
              tokensReserved: { decrement: release },
            },
          });
          return entry;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );
  } catch (error) {
    if (isPrismaError(error, "P2002")) {
      return prisma.quotaLedgerEntry.findUniqueOrThrow({
        where: { idempotencyKey: input.idempotencyKey },
      });
    }
    throw error;
  }
}

export interface ReleaseQuotaInput {
  customerId: string;
  requestId: string;
  reservedTokens: number | bigint;
  idempotencyKey: string;
}

export async function releaseQuota(input: ReleaseQuotaInput) {
  const reserved = BigInt(input.reservedTokens);
  try {
    return await serializable(() =>
      prisma.$transaction(
        async (tx) => {
          const existing = await tx.quotaLedgerEntry.findUnique({
            where: { idempotencyKey: input.idempotencyKey },
          });
          if (existing) return existing;
          const ledger = await tx.quotaLedger.findUniqueOrThrow({
            where: { customerId: input.customerId },
          });
          const amount = reserved > ledger.tokensReserved ? ledger.tokensReserved : reserved;
          const entry = await tx.quotaLedgerEntry.create({
            data: {
              ledgerId: ledger.id,
              idempotencyKey: input.idempotencyKey,
              deltaTokens: 0n,
              reservedDelta: -amount,
              reason: "RELEASE",
              requestId: input.requestId,
            },
          });
          await tx.quotaLedger.update({
            where: { id: ledger.id },
            data: { tokensReserved: { decrement: amount } },
          });
          return entry;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );
  } catch (error) {
    if (isPrismaError(error, "P2002")) {
      return prisma.quotaLedgerEntry.findUniqueOrThrow({
        where: { idempotencyKey: input.idempotencyKey },
      });
    }
    throw error;
  }
}
