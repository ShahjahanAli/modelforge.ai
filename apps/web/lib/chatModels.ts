import { getServerSession } from "next-auth";
import { prisma } from "@modelforge/db";
import { authOptions } from "@/lib/auth";
import type { ChatModelOption } from "@/components/chat/useChatStream";

/**
 * Models the signed-in subscriber may chat with: hosted in the registry and
 * granted by their plan entitlements. Admins have no chat credential of their
 * own, so they get an empty list.
 */
export async function chatModelsForSession(): Promise<ChatModelOption[]> {
  const session = await getServerSession(authOptions);
  const user = session?.user as { id?: string; role?: string } | undefined;
  if (!user?.id || user.role === "ADMIN") return [];

  const [sub, hostedModels] = await Promise.all([
    prisma.subscription.findUnique({
      where: { customerId: user.id },
      include: { plan: true },
    }),
    prisma.hostedModel.findMany({ orderBy: { displayName: "asc" } }),
  ]);

  const entitled = new Set(sub?.plan.allowedModelIds ?? []);
  return hostedModels
    .filter((model) => entitled.has(model.modelId))
    .map((model) => ({ id: model.modelId, name: model.displayName }));
}
