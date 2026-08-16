import type { Request, Response, NextFunction } from "express";
import { prisma } from "@modelforge/db";
import { hashApiKey } from "../lib/keys.js";

export interface AuthContext {
  customerId: string;
  apiKeyId: string;
  email: string;
  planId: string;
  planName: string;
  monthlyTokenQuota: bigint;
  requestsPerMinute: number;
  maxConcurrent: number;
  allowedModelIds: string[];
  billingMode: string;
  periodStart: Date;
  periodEnd: Date;
}

export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  try {
    const header = req.header("authorization") ?? "";
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match?.[1]) {
      return res.status(401).json({
        error: { type: "authentication_error", message: "Missing Bearer API key" },
      });
    }
    const raw = match[1].trim();
    const keyHash = hashApiKey(raw);
    const apiKey = await prisma.apiKey.findUnique({
      where: { keyHash },
      include: {
        customer: {
          include: {
            subscription: { include: { plan: true } },
          },
        },
      },
    });

    if (!apiKey || apiKey.revokedAt) {
      return res.status(401).json({
        error: { type: "authentication_error", message: "Invalid API key" },
      });
    }

    const sub = apiKey.customer.subscription;
    if (!sub || sub.status !== "ACTIVE") {
      return res.status(403).json({
        error: { type: "permission_error", message: "No active subscription" },
      });
    }

    req.auth = {
      customerId: apiKey.customerId,
      apiKeyId: apiKey.id,
      email: apiKey.customer.email,
      planId: sub.plan.id,
      planName: sub.plan.name,
      monthlyTokenQuota: sub.plan.monthlyTokenQuota,
      requestsPerMinute: sub.plan.requestsPerMinute,
      maxConcurrent: sub.plan.maxConcurrent,
      allowedModelIds: sub.plan.allowedModelIds,
      billingMode: sub.plan.billingMode,
      periodStart: sub.currentPeriodStart,
      periodEnd: sub.currentPeriodEnd,
    };
    next();
  } catch (err) {
    console.error(err);
    return res.status(503).json({
      error: { type: "server_error", message: "Auth backend unavailable" },
    });
  }
}

export function internalAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.header("x-internal-token");
  if (!token || token !== process.env.INTERNAL_SERVICE_TOKEN) {
    return res.status(401).json({ error: { type: "authentication_error", message: "Unauthorized" } });
  }
  next();
}
