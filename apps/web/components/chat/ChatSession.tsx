"use client";

import { createContext, useContext, type ReactNode } from "react";
import { useChatStream, type ChatStream, type KnowledgeBaseOption } from "./useChatStream";

const ChatSessionContext = createContext<ChatStream | null>(null);

/**
 * One conversation for the customer shell. The floating widget and the full
 * /chat page both read this, so expanding the bubble keeps the live stream.
 */
export function ChatSession({
  children,
  knowledgeBases = [],
}: {
  children: ReactNode;
  knowledgeBases?: KnowledgeBaseOption[];
}) {
  const chat = useChatStream({ defaultMaxTokens: 2048, knowledgeBases });
  return <ChatSessionContext.Provider value={chat}>{children}</ChatSessionContext.Provider>;
}

export function useChatSession(): ChatStream {
  const chat = useContext(ChatSessionContext);
  if (!chat) {
    throw new Error("useChatSession must be used inside <ChatSession>");
  }
  return chat;
}
