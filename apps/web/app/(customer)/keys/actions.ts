"use server";

import { getServerSession } from "next-auth";
import { revalidatePath } from "next/cache";
import { authOptions } from "@/lib/auth";
import { gatewayFetch } from "@/lib/gateway";
import { prisma } from "@modelforge/db";

export async function revokeKeyAction(formData: FormData) {
  const session = await getServerSession(authOptions);
  if (!session?.user) throw new Error("Unauthorized");
  const id = String(formData.get("id"));
  const key = await prisma.apiKey.findFirst({
    where: { id, customerId: session.user.id },
    select: { id: true },
  });
  if (!key) throw new Error("API key not found");
  await gatewayFetch(`/internal/keys/${id}`, { method: "DELETE" });
  revalidatePath("/keys");
}
