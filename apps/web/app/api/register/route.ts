import { NextResponse } from "next/server";
import * as argon2 from "argon2";
import { prisma } from "@modelforge/db";

export async function POST(req: Request) {
  const body = (await req.json()) as { email?: string; password?: string; name?: string };
  if (!body.email || !body.password || body.password.length < 8) {
    return NextResponse.json({ error: "Valid email and password (8+) required" }, { status: 400 });
  }
  const email = body.email.toLowerCase();
  const existing = await prisma.customer.findUnique({ where: { email } });
  if (existing) {
    return NextResponse.json({ error: "Email already registered" }, { status: 409 });
  }

  const free = await prisma.plan.findUnique({ where: { name: "free" } });
  if (!free) {
    return NextResponse.json({ error: "Plans not seeded" }, { status: 500 });
  }

  const passwordHash = await argon2.hash(body.password);
  const now = new Date();
  const periodEnd = new Date(now);
  periodEnd.setMonth(periodEnd.getMonth() + 1);

  const customer = await prisma.customer.create({
    data: {
      email,
      name: body.name ?? null,
      passwordHash,
      role: "CUSTOMER",
      subscription: {
        create: {
          planId: free.id,
          status: "ACTIVE",
          currentPeriodStart: now,
          currentPeriodEnd: periodEnd,
        },
      },
      quotaLedger: {
        create: {
          periodStart: now,
          periodEnd,
          tokensUsed: 0n,
        },
      },
    },
  });

  return NextResponse.json({ id: customer.id, email: customer.email });
}
