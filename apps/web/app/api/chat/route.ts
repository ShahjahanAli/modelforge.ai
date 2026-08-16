import { createHash, createHmac } from "node:crypto";
import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { prisma } from "@modelforge/db";
import { authOptions } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 900;

async function dashboardApiKey(customerId: string): Promise<string> {
  const secret = process.env.INTERNAL_SERVICE_TOKEN;
  if (!secret) throw new Error("INTERNAL_SERVICE_TOKEN is not configured");

  const raw = `mf_dash_${createHmac("sha256", secret).update(customerId).digest("hex")}`;
  const keyHash = createHash("sha256").update(raw).digest("hex");
  const existing = await prisma.apiKey.findFirst({
    where: { customerId, label: "dashboard-chat" },
  });

  if (existing) {
    await prisma.apiKey.update({
      where: { id: existing.id },
      data: {
        keyHash,
        keyPrefix: raw.slice(0, 12),
        scopes: ["chat"],
        revokedAt: null,
      },
    });
  } else {
    await prisma.apiKey.create({
      data: {
        customerId,
        keyHash,
        keyPrefix: raw.slice(0, 12),
        label: "dashboard-chat",
        scopes: ["chat"],
      },
    });
  }
  return raw;
}

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  const customerId = (session?.user as { id?: string; role?: string } | undefined)?.id;
  const role = (session?.user as { role?: string } | undefined)?.role;
  if (!customerId || role === "ADMIN") {
    return NextResponse.json(
      { error: { type: "authentication_error", message: "Subscriber session required" } },
      { status: 401 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { error: { type: "invalid_request", message: "Invalid JSON body" } },
      { status: 400 },
    );
  }

  try {
    const rawKey = await dashboardApiKey(customerId);
    const base = process.env.GATEWAY_INTERNAL_URL ?? "http://localhost:3000";
    const upstream = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${rawKey}`,
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify({ ...body, stream: true }),
      cache: "no-store",
      signal: request.signal,
    });

    if (!upstream.ok || !upstream.body) {
      return new Response(await upstream.text(), {
        status: upstream.status,
        headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
      });
    }

    const headers = new Headers({
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    for (const name of ["x-request-id", "x-modelforge-request-id", "x-modelforge-resolved-model"]) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }
    return new Response(upstream.body, { status: 200, headers });
  } catch (error) {
    return NextResponse.json(
      {
        error: {
          type: "server_error",
          message: error instanceof Error ? error.message : "Chat gateway unavailable",
        },
      },
      { status: 503 },
    );
  }
}
