import { getServerSession } from "next-auth";
import { prisma } from "@modelforge/db";
import { authOptions } from "@/lib/auth";
import type { ChatModelOption, KnowledgeBaseOption } from "@/components/chat/useChatStream";

/**
 * Models the signed-in subscriber may pick in chat: granted by their plan and
 * currently available (LOADED local GGUF, or configured remote OpenAI-compatible).
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
      where: {
        OR: [{ status: "LOADED" }, { providerKind: "OPENAI_COMPAT", status: { not: "ERROR" } }],
      },
      orderBy: { displayName: "asc" },
    }),
  ]);

  const entitled = new Set(sub?.plan.allowedModelIds ?? []);
  return hostedModels
    .filter((model) => entitled.has(model.modelId))
    .map((model) => ({ id: model.modelId, name: model.displayName }));
}

/** Display name for the platform default used by model:auto routing. */
export async function platformDefaultModelLabel(): Promise<string | null> {
  const model = await prisma.hostedModel.findFirst({
    where: { isPlatformDefault: true },
    select: { displayName: true },
  });
  return model?.displayName ?? null;
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
