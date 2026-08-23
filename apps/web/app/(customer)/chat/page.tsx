import { PageHeader } from "@/components/ui/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { ChatWorkspace } from "@/components/chat/ChatWorkspace";
import { chatModelsForSession, platformDefaultModelLabel } from "@/lib/chatModels";

export const dynamic = "force-dynamic";

export default async function ChatPage() {
  const [models, defaultLabel] = await Promise.all([
    chatModelsForSession(),
    platformDefaultModelLabel(),
  ]);
  const autoRouteLabel = defaultLabel ? `Auto → ${defaultLabel}` : "Auto route";

  return (
    <>
      <PageHeader
        eyebrow="Playground"
        title="Chat"
        description="Talk to the models on your plan. When a knowledge base is selected, answers come from your documents, not from the model's memory."
        actions={
          <Badge tone={models.length > 0 ? "ok" : "warn"} dot>
            {models.length > 0 ? `${models.length} model${models.length > 1 ? "s" : ""}` : "no models"}
          </Badge>
        }
      />

      <ChatWorkspace models={models} autoRouteLabel={autoRouteLabel} />
    </>
  );
}
