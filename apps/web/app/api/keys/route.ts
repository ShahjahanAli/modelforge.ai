import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { gatewayFetch } from "@/lib/gateway";

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as { label?: string };
  try {
    const created = await gatewayFetch("/internal/keys", {
      method: "POST",
      body: JSON.stringify({
        customerId: session.user.id,
        label: body.label?.trim() || undefined,
      }),
    });
    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not create key" },
      { status: 502 },
    );
  }
}
