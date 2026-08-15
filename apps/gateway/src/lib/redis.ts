import { Redis } from "ioredis";

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

/** Local/dev can set REDIS_ENABLED=false and skip Redis/BullMQ entirely. */
export function isRedisEnabled(): boolean {
  return parseBool(process.env.REDIS_ENABLED, true);
}

let redis: Redis | null = null;

export function getRedis(url = process.env.REDIS_URL ?? "redis://localhost:6379"): Redis {
  if (!isRedisEnabled()) {
    throw new Error("Redis is disabled (REDIS_ENABLED=false)");
  }
  if (!redis) {
    redis = new Redis(url, { maxRetriesPerRequest: null, enableReadyCheck: true });
  }
  return redis;
}

export function redisConnection(url = process.env.REDIS_URL ?? "redis://localhost:6379") {
  return { url };
}
