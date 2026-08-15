import type { Request, Response, NextFunction } from "express";
import { prisma } from "@modelforge/db";
import { getRedis, isRedisEnabled } from "../lib/redis.js";

export async function quotaMiddleware(req: Request, res: Response, next: NextFunction) {
  try {
    const auth = req.auth;
    if (!auth) {
      return res.status(401).json({ error: { type: "authentication_error", message: "Unauthenticated" } });
    }
    // Usage-based enterprise plans have unlimited quota (0)
    if (auth.billingMode === "USAGE" || auth.monthlyTokenQuota === 0n) {
      return next();
    }

    let used: bigint;
    if (!isRedisEnabled()) {
      const ledger = await prisma.quotaLedger.findUnique({ where: { customerId: auth.customerId } });
      used = ledger?.tokensUsed ?? 0n;
    } else {
      const redis = getRedis();
      const cacheKey = `quota:${auth.customerId}`;
      let usedStr = await redis.get(cacheKey);
      if (usedStr === null) {
        const ledger = await prisma.quotaLedger.findUnique({ where: { customerId: auth.customerId } });
        usedStr = (ledger?.tokensUsed ?? 0n).toString();
        await redis.set(cacheKey, usedStr, "EX", 60);
      }
      used = BigInt(usedStr);
    }

    if (used >= auth.monthlyTokenQuota) {
      return res.status(429).json({
        error: { type: "quota_exceeded", message: "Monthly token quota exhausted" },
      });
    }
    next();
  } catch (err) {
    console.error("quota error", err);
    return res.status(503).json({
      error: { type: "server_error", message: "Quota service unavailable" },
    });
  }
}

export async function bumpQuotaCache(customerId: string, tokens: number) {
  if (!isRedisEnabled()) return;
  const redis = getRedis();
  const cacheKey = `quota:${customerId}`;
  const exists = await redis.exists(cacheKey);
  if (exists) await redis.incrby(cacheKey, tokens);
}
