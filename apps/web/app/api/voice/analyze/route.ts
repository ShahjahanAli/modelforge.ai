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
      data: { keyHash, keyPrefix: raw.slice(0, 12), scopes: ["chat"], revokedAt: null },
    });
  } else {
    await prisma.apiKey.create({
      data: { customerId, keyHash, keyPrefix: raw.slice(0, 12), label: "dashboard-chat", scopes: ["chat"] },
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
  const form = await request.formData();
  const audio = form.get("audio");
  if (!(audio instanceof File)) {
    return NextResponse.json(
      { error: { type: "invalid_request", message: "Missing audio file" } },
      { status: 400 },
    );
  }
  try {
    const rawKey = await dashboardApiKey(customerId);
    const base = process.env.GATEWAY_INTERNAL_URL ?? "http://localhost:9000";
    const prompt = form.get("prompt");
    const model = form.get("model");
    const maxTokens = form.get("max_tokens");
    const query = new URLSearchParams();
    if (typeof prompt === "string" && prompt.trim()) query.set("prompt", prompt);
    if (typeof model === "string" && model.trim()) query.set("model", model);
    if (typeof maxTokens === "string" && maxTokens.trim()) query.set("max_tokens", maxTokens);
    const audioBuffer = Buffer.from(await audio.arrayBuffer());

    const upstream = await fetch(`${base}/v1/voice/analyze?${query.toString()}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${rawKey}`,
        "content-type": audio.type || "audio/webm",
        "x-audio-mime": audio.type || "audio/webm",
        "x-audio-filename": audio.name || "recording.webm",
      },
      body: audioBuffer,
      cache: "no-store",
      signal: request.signal,
    });
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: {
          type: "server_error",
          message: error instanceof Error ? error.message : "Voice gateway unavailable",
        },
      },
      { status: 503 },
    );
  }
}
