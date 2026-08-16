"use client";

import { useCallback, useRef, useState } from "react";

export interface ChatModelOption {
  id: string;
  name: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  finishReason?: string;
  error?: boolean;
}

interface StreamChunk {
  choices?: Array<{
    delta?: { content?: string };
    finish_reason?: string | null;
  }>;
  error?: { message?: string };
}

export function useChatStream(options: { defaultMaxTokens?: number } = {}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [model, setModel] = useState("auto");
  const [maxTokens, setMaxTokens] = useState(options.defaultMaxTokens ?? 2048);
  const [temperature, setTemperature] = useState(0.7);
  const [streaming, setStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const reset = useCallback(() => {
    setMessages([]);
    setInput("");
  }, []);

  const send = useCallback(
    async (text?: string) => {
      const prompt = (text ?? input).trim();
      if (!prompt || streaming) return;

      const userMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content: prompt,
      };
      const assistantId = crypto.randomUUID();
      const history = [...messages, userMessage];

      setMessages([...history, { id: assistantId, role: "assistant", content: "" }]);
      setInput("");
      setStreaming(true);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model,
            messages: history.map(({ role, content }) => ({ role, content })),
            max_tokens: maxTokens,
            temperature,
            stream: true,
          }),
          signal: controller.signal,
        });

        if (!response.ok || !response.body) {
          const body = (await response.json().catch(() => null)) as {
            error?: { message?: string };
          } | null;
          throw new Error(body?.error?.message ?? `Chat request failed (${response.status})`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let complete = false;

        while (!complete) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const data = trimmed.slice(5).trim();
            if (data === "[DONE]") {
              complete = true;
              break;
            }

            let chunk: StreamChunk;
            try {
              chunk = JSON.parse(data) as StreamChunk;
            } catch {
              continue;
            }
            if (chunk.error?.message) throw new Error(chunk.error.message);

            const delta = chunk.choices?.[0]?.delta?.content ?? "";
            const finishReason = chunk.choices?.[0]?.finish_reason ?? undefined;
            if (delta || finishReason) {
              setMessages((current) =>
                current.map((message) =>
                  message.id === assistantId
                    ? {
                        ...message,
                        content: message.content + delta,
                        finishReason: finishReason ?? message.finishReason,
                      }
                    : message,
                ),
              );
            }
          }
        }
      } catch (error) {
        const aborted = error instanceof DOMException && error.name === "AbortError";
        setMessages((current) =>
          current.map((message) =>
            message.id === assistantId
              ? {
                  ...message,
                  content:
                    message.content ||
                    (aborted
                      ? "Generation stopped."
                      : error instanceof Error
                        ? error.message
                        : "Unable to complete this request."),
                  finishReason: aborted ? "stopped" : "error",
                  error: !aborted,
                }
              : message,
          ),
        );
      } finally {
        abortRef.current = null;
        setStreaming(false);
      }
    },
    [input, maxTokens, messages, model, streaming, temperature],
  );

  return {
    messages,
    input,
    setInput,
    model,
    setModel,
    maxTokens,
    setMaxTokens,
    temperature,
    setTemperature,
    streaming,
    send,
    stop,
    reset,
  };
}

export type ChatStream = ReturnType<typeof useChatStream>;

export function finishLabel(message: ChatMessage): string {
  if (message.finishReason === "length") return "Token limit reached";
  if (message.finishReason === "stopped") return "Stopped";
  if (message.finishReason === "error") return "Error";
  return "ModelForge";
}
