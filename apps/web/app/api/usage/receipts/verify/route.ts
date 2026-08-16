import { NextResponse } from "next/server";
import { createHash, verify } from "node:crypto";
import { prisma } from "@modelforge/db";

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export async function POST(req: Request) {
  const body = (await req.json()) as {
    payload?: string;
    signature?: string;
    keyId?: string;
  };
  if (!body.payload || !body.signature || !body.keyId) {
    return NextResponse.json(
      { ok: false, error: "payload, signature, and keyId are required" },
      { status: 400 },
    );
  }

  const key = await prisma.signingKey.findUnique({ where: { keyId: body.keyId } });
  if (!key || key.revokedAt) {
    return NextResponse.json({ ok: false, error: "Unknown or revoked signing key" }, { status: 404 });
  }

  try {
    const canonical =
      typeof body.payload === "string" && body.payload.trim().startsWith("{")
        ? stableStringify(JSON.parse(body.payload))
        : body.payload;
    const signature = Buffer.from(
      body.signature.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    );
    const ok = verify(null, Buffer.from(canonical), key.publicKey, signature);
    const payloadHash = createHash("sha256").update(canonical).digest("hex");
    return NextResponse.json({
      ok,
      message: ok ? "Signature valid" : "Signature mismatch",
      payloadHash,
      algorithm: key.algorithm,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Verification failed",
      },
      { status: 400 },
    );
  }
}
