"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface ChatModelOption {
  id: string;
  name: string;
}

export interface KnowledgeBaseOption {
  id: string;
  name: string;
  documentCount: number;
}

export interface RetrievalHit {
  title: string;
  knowledge_base: string;
  score: number;
  excerpt?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  finishReason?: string;
  error?: boolean;
  sources?: RetrievalHit[];
}

export interface VoiceState {
  status: "idle" | "uploading" | "transcribing" | "analyzing" | "done" | "error";
  step: "uploading" | "transcribing" | "analyzing" | "done" | "error";
  transcript: string;
  analysis: string;
  error?: string;
}

function friendlyVoiceError(message: string): string {
  if (/max concurrent/i.test(message)) {
    return "Another chat or voice request is still running. Wait for it to finish, then try again.";
  }
  if (/requests\/minute/i.test(message) || /rate_limit/i.test(message)) {
    return "Too many requests right now. Please wait a minute and retry.";
  }
  return message;
}

const OPEN_SYSTEM_PROMPT =
  "You are a helpful assistant on ModelForge. Reply in the same language as the user. " +
  "Give accurate, specific answers. If you are unsure, say so instead of inventing facts. " +
  "When explaining a topic, use short paragraphs and markdown headings or bullet lists.";

const GROUNDED_SYSTEM_PROMPT =
  "You are a knowledge-base assistant on ModelForge. Answer only from retrieved knowledge passages. " +
  "If a passage lists steps or a procedure, include every step in order. " +
  "If the user asks what is in the knowledge base, list the documents from the retrieved catalog. " +
  "If the passages do not contain the answer, say that in the same language as the user. " +
  "Never reply with only the English words \"I do not know\" when the user wrote Bangla. " +
  "Never invent laws, rates, or citations. " +
  "Reply in the same language as the user. If the user writes Bangla, answer in Bangla. " +
  "Address the user as আপনি, not আমি.";

interface StreamChunk {
  choices?: Array<{
    delta?: { content?: string };
    finish_reason?: string | null;
  }>;
  error?: { message?: string };
  modelforge?: { retrieval?: { hits?: RetrievalHit[] } };
}

export function useChatStream(
  options: { defaultMaxTokens?: number; knowledgeBases?: KnowledgeBaseOption[] } = {},
) {
  const knowledgeBases = options.knowledgeBases ?? [];
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [model, setModel] = useState("auto");
  const [knowledgeBaseId, setKnowledgeBaseId] = useState(knowledgeBases.length > 0 ? "all" : "off");
  const [maxTokens, setMaxTokens] = useState(options.defaultMaxTokens ?? 2048);
  const [temperature, setTemperature] = useState(0.7);
  const [streaming, setStreaming] = useState(false);
  const [voice, setVoice] = useState<VoiceState>({
    status: "idle",
    step: "uploading",
    transcript: "",
    analysis: "",
  });
  const abortRef = useRef<AbortController | null>(null);
  const previousBaseCount = useRef(knowledgeBases.length);

  useEffect(() => {
    if (previousBaseCount.current === 0 && knowledgeBases.length > 0 && knowledgeBaseId === "off") {
      setKnowledgeBaseId("all");
    }
    previousBaseCount.current = knowledgeBases.length;
  }, [knowledgeBaseId, knowledgeBases.length]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const reset = useCallback(() => {
    setMessages([]);
    setInput("");
    setVoice({ status: "idle", step: "uploading", transcript: "", analysis: "" });
  }, []);

  const analyzeVoice = useCallback(
    async (file: File, prompt?: string) => {
      if (streaming) return;
      const hasAnalysisPrompt = Boolean(prompt?.trim());
      let step: VoiceState["step"] = "uploading";
      setVoice({ status: "uploading", step, transcript: "", analysis: "" });
      const form = new FormData();
      form.set("audio", file, file.name || "recording.webm");
      if (hasAnalysisPrompt) form.set("prompt", prompt!.trim());
      // LLM analysis model is chosen server-side (platform default). Only forward an explicit pick.
      if (model !== "auto") form.set("model", model);
      form.set("max_tokens", String(maxTokens));
      try {
        step = "transcribing";
        setVoice({ status: "transcribing", step, transcript: "", analysis: "" });
        const response = await fetch("/api/voice/analyze", { method: "POST", body: form });
        const json = (await response.json().catch(() => null)) as
          | { transcript?: { text?: string }; analysis?: string; error?: { message?: string } }
          | null;
        if (!response.ok) {
          throw new Error(json?.error?.message ?? `Voice request failed (${response.status})`);
        }
        const transcript = json?.transcript?.text?.trim() ?? "";
        const analysis = json?.analysis?.trim() ?? "";
        if (hasAnalysisPrompt) {
          setVoice({ status: "analyzing", step: "analyzing", transcript, analysis: "" });
        }
        setMessages((current) => {
          const transcriptMessage = transcript
            ? `[Voice transcript]\n${transcript}`
            : "[Empty transcript]";
          const nextMessages: ChatMessage[] = [
            ...current,
            { id: crypto.randomUUID(), role: "user", content: transcriptMessage },
          ];
          if (analysis) {
            nextMessages.push({ id: crypto.randomUUID(), role: "assistant", content: analysis });
          }
          return nextMessages;
        });
        setVoice({ status: "done", step: "done", transcript, analysis });
      } catch (error) {
        const raw = error instanceof Error ? error.message : "Voice analysis failed";
        setVoice((current) => ({
          status: "error",
          step,
          transcript: current.transcript,
          analysis: "",
          error: friendlyVoiceError(raw),
        }));
      }
    },
    [maxTokens, model, setMessages, streaming],
  );

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
      const selectedIds =
        knowledgeBaseId === "off"
          ? []
          : knowledgeBaseId === "all"
            ? knowledgeBases.map((base) => base.id)
            : [knowledgeBaseId];
      const ragEnabled = selectedIds.length > 0;

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
            messages: [
              { role: "system", content: ragEnabled ? GROUNDED_SYSTEM_PROMPT : OPEN_SYSTEM_PROMPT },
              ...history.map(({ role, content }) => ({ role, content })),
            ],
            max_tokens: maxTokens,
            temperature: ragEnabled ? Math.min(temperature, 0.3) : temperature,
            stream: true,
            metadata: {
              modelforge: {
                knowledge_base_ids: selectedIds,
                rag_top_k: 4,
              },
            },
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

            const hits = chunk.modelforge?.retrieval?.hits;
            if (hits) {
              setMessages((current) =>
                current.map((message) =>
                  message.id === assistantId ? { ...message, sources: hits } : message,
                ),
              );
            }

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
    [input, knowledgeBaseId, knowledgeBases, maxTokens, messages, model, streaming, temperature],
  );

  const rerunTranscript = useCallback(
    async (transcriptText: string, prompt?: string) => {
      const normalized = transcriptText.trim();
      const analysisPrompt = prompt?.trim();
      if (!normalized || !analysisPrompt || streaming) return;
      await send(`${analysisPrompt}\n\nTranscript:\n${normalized}`);
    },
    [send, streaming],
  );

  return {
    messages,
    input,
    setInput,
    model,
    setModel,
    knowledgeBases,
    knowledgeBaseId,
    setKnowledgeBaseId,
    maxTokens,
    setMaxTokens,
    temperature,
    setTemperature,
    streaming,
    voice,
    analyzeVoice,
    rerunTranscript,
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
  if (message.finishReason === "length") return "Answer cut off";
  if (message.finishReason === "stopped") return "Stopped";
  if (message.finishReason === "error") return "Error";
  return "ModelForge";
}
