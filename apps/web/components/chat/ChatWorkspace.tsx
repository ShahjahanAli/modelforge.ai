"use client";

import { Eraser } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { ChatConsole } from "./ChatConsole";
import { ChatSettings } from "./ChatSettings";
import { useChatSession } from "./ChatSession";
import type { ChatModelOption } from "./useChatStream";

export function ChatWorkspace({ models }: { models: ChatModelOption[] }) {
  const chat = useChatSession();

  return (
    <Panel className="overflow-hidden">
      <PanelHeader
        title="Chat with your models"
        description="Streaming OpenAI-compatible chat through your private ModelForge runtime"
        actions={
          <div className="flex items-center gap-2">
            <Badge
              tone={chat.streaming ? "info" : models.length > 0 ? "ok" : "warn"}
              dot
              pulse={chat.streaming}
            >
              {chat.streaming ? "generating" : models.length > 0 ? "ready" : "no models"}
            </Badge>
            <button
              type="button"
              className="btn-ghost"
              onClick={chat.reset}
              disabled={chat.messages.length === 0 || chat.streaming}
              title="Clear conversation"
            >
              <Eraser className="size-4" aria-hidden />
              <span className="hidden sm:inline">New chat</span>
            </button>
          </div>
        }
      />

      <div className="grid lg:grid-cols-[minmax(0,1fr)_15rem]">
        <div className="flex h-[clamp(28rem,calc(100vh-19rem),52rem)] min-h-0 flex-col">
          <ChatConsole models={models} chat={chat} />
        </div>
        <ChatSettings models={models} chat={chat} />
      </div>
    </Panel>
  );
}
