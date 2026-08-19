import { getServerSession } from "next-auth";
import { prisma } from "@modelforge/db";
import { authOptions } from "@/lib/auth";
import type { ChatModelOption, KnowledgeBaseOption } from "@/components/chat/useChatStream";

/**
 * Models the signed-in subscriber may pick in chat: granted by their plan and
 * currently resident (LOADED). Inactive registry rows stay entitled for Auto
 * route / first-token load, but they are not listed as selectable models.
 * Admins have no chat credential of their own, so they get an empty list.
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
    prisma.hostedModel.findMany({
      where: { status: "LOADED" },
      orderBy: { displayName: "asc" },
    }),
  ]);

  const entitled = new Set(sub?.plan.allowedModelIds ?? []);
  return hostedModels
    .filter((model) => entitled.has(model.modelId))
    .map((model) => ({ id: model.modelId, name: model.displayName }));
}

export async function chatKnowledgeBasesForSession(): Promise<KnowledgeBaseOption[]> {
  const session = await getServerSession(authOptions);
  const user = session?.user as { id?: string; role?: string } | undefined;
  if (!user?.id || user.role === "ADMIN") return [];

  const bases = await prisma.knowledgeBase.findMany({
    where: { customerId: user.id },
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      _count: { select: { documents: true } },
    },
  });
  return bases.map((base) => ({
    id: base.id,
    name: base.name,
    documentCount: base._count.documents,
  }));
}
