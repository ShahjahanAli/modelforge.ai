import type { Request, Response, NextFunction } from "express";
import { getRedis, isRedisEnabled } from "../lib/redis.js";

type CounterBucket = { count: number; resetAt: number };
type ConcBucket = { count: number };

const memoryRpm = new Map<string, CounterBucket>();
const memoryConc = new Map<string, ConcBucket>();

function memoryIncrRpm(apiKeyId: string, windowMs: number): number {
  const now = Date.now();
  const key = `rl:${apiKeyId}`;
  const current = memoryRpm.get(key);
  if (!current || current.resetAt <= now) {
    memoryRpm.set(key, { count: 1, resetAt: now + windowMs });
    return 1;
  }
  current.count += 1;
  return current.count;
}

function memoryAcquireConc(apiKeyId: string, maxConcurrent: number): boolean {
  const key = `conc:${apiKeyId}`;
  const current = memoryConc.get(key) ?? { count: 0 };
  if (current.count >= maxConcurrent) return false;
  current.count += 1;
  memoryConc.set(key, current);
  return true;
}

function memoryReleaseConc(apiKeyId: string) {
  const key = `conc:${apiKeyId}`;
  const current = memoryConc.get(key);
  if (!current) return;
  current.count = Math.max(0, current.count - 1);
  if (current.count === 0) memoryConc.delete(key);
  else memoryConc.set(key, current);
}

/** Redis token-bucket when enabled; in-memory fallback for REDIS_ENABLED=false. */
export async function rateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
  try {
    const auth = req.auth;
    if (!auth) {
      return res.status(401).json({ error: { type: "authentication_error", message: "Unauthenticated" } });
    }

    const rpm = Math.max(1, auth.requestsPerMinute);
    const windowMs = 60_000;

    if (!isRedisEnabled()) {
      const count = memoryIncrRpm(auth.apiKeyId, windowMs);
      if (count > rpm) {
        res.setHeader("Retry-After", "60");
        return res.status(429).json({
          error: { type: "rate_limit_exceeded", message: `Limit ${rpm} requests/minute` },
        });
      }
      if (!memoryAcquireConc(auth.apiKeyId, auth.maxConcurrent)) {
        return res.status(429).json({
          error: { type: "rate_limit_exceeded", message: `Max concurrent ${auth.maxConcurrent}` },
        });
      }
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        memoryReleaseConc(auth.apiKeyId);
      };
      res.once("finish", release);
      res.once("close", release);
      return next();
    }

    const redis = getRedis();
    const key = `rl:${auth.apiKeyId}`;
    const now = Date.now();
    const bucketKey = `${key}:${Math.floor(now / windowMs)}`;

    const count = await redis.incr(bucketKey);
    if (count === 1) await redis.pexpire(bucketKey, windowMs);
    if (count > rpm) {
      res.setHeader("Retry-After", "60");
      return res.status(429).json({
        error: { type: "rate_limit_exceeded", message: `Limit ${rpm} requests/minute` },
      });
    }

    const ckey = `conc:${auth.apiKeyId}`;
    const current = await redis.incr(ckey);
    if (current === 1) await redis.expire(ckey, 120);
    if (current > auth.maxConcurrent) {
      await redis.decr(ckey);
      return res.status(429).json({
        error: { type: "rate_limit_exceeded", message: `Max concurrent ${auth.maxConcurrent}` },
      });
    }
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      void redis.decr(ckey).catch(() => undefined);
    };
    res.once("finish", release);
    res.once("close", release);
    next();
  } catch (err) {
    console.error("rate limit error", err);
    return res.status(503).json({
      error: { type: "server_error", message: "Rate limiter unavailable" },
    });
  }
}
