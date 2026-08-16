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

const THINK_OPEN = /<(?:think|thinking|reasoning)>/i;
const THINK_CLOSE = /<\/(?:think|thinking|reasoning)>/i;

export interface SplitMessage {
  /** Chain-of-thought the model wrapped in <think> tags. */
  reasoning: string;
  /** The user-facing answer with reasoning removed. */
  answer: string;
  /** True while a reasoning block is still open mid-stream. */
  thinking: boolean;
}

/**
 * Reasoning models emit their scratchpad inline. Split it out so the UI can
 * collapse it instead of showing raw tags in the answer.
 */
export function splitReasoning(content: string): SplitMessage {
  const reasoning: string[] = [];
  let answer = "";
  let rest = content;
  let thinking = false;

  while (rest.length > 0) {
    const open = rest.match(THINK_OPEN);
    if (!open || open.index === undefined) {
      answer += rest;
      break;
    }
    answer += rest.slice(0, open.index);
    rest = rest.slice(open.index + open[0].length);

    const close = rest.match(THINK_CLOSE);
    if (!close || close.index === undefined) {
      reasoning.push(rest);
      thinking = true;
      break;
    }
    reasoning.push(rest.slice(0, close.index));
    rest = rest.slice(close.index + close[0].length);
  }

  return { reasoning: reasoning.join("\n\n").trim(), answer: answer.trim(), thinking };
}

export function finishLabel(message: ChatMessage): string {
  if (message.finishReason === "length") return "Token limit reached";
  if (message.finishReason === "stopped") return "Stopped";
  if (message.finishReason === "error") return "Error";
  return "ModelForge";
}
