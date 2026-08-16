import { NextResponse } from "next/server";
import { prisma } from "@modelforge/db";

export async function GET() {
  const keys = await prisma.signingKey.findMany({
    where: { active: true, revokedAt: null },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({
    keys: keys.map((key) => ({
      keyId: key.keyId,
      algorithm: key.algorithm,
      publicKey: key.publicKey,
      createdAt: key.createdAt.toISOString(),
      rotatedAt: key.rotatedAt?.toISOString() ?? null,
    })),
  });
}
