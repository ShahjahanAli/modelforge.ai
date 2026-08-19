"use client";

import {
  Bot,
  Brain,
  Check,
  ChevronDown,
  Copy,
  Send,
  Sparkles,
  Square,
  User,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  finishLabel,
  splitReasoning,
  type ChatMessage,
  type ChatModelOption,
  type ChatStream,
} from "./useChatStream";
import { ChatMarkdown } from "./ChatMarkdown";

interface ChatConsoleProps {
  models: ChatModelOption[];
  chat: ChatStream;
  variant?: "page" | "widget";
}

const SUGGESTIONS = [
  "Explain this platform architecture",
  "Write a TypeScript API example",
  "Summarize a technical concept",
  "Create a deployment checklist",
];

const GROUNDED_SUGGESTIONS = [
  "What is in my knowledge base?",
  "আমার নলেজ বেসে কী আছে?",
  "What is the retrieval check code?",
];

/**
 * Reasoning models stream a scratchpad before answering. It stays out of the
 * way by default and expands on demand, but auto-opens while it is the only
 * thing the model has produced so far.
 */
function ReasoningBlock({
  reasoning,
  thinking,
  hasAnswer,
}: {
  reasoning: string;
  thinking: boolean;
  hasAnswer: boolean;
}) {
  const [override, setOverride] = useState<boolean | null>(null);
  const open = override ?? (thinking && !hasAnswer);

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface-2/60">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-content-secondary transition-colors hover:bg-surface-3/60"
        onClick={() => setOverride(!open)}
        aria-expanded={open}
      >
        <Brain
          className={`size-3.5 shrink-0 ${thinking ? "animate-pulse text-brand-600" : "text-content-muted"}`}
          aria-hidden
        />
        <span className="flex-1 text-xs font-medium">
          {thinking ? "Thinking…" : "Thought process"}
        </span>
        <span className="font-mono text-[10px] text-content-muted">
          {open ? "hide" : "show"}
        </span>
        <ChevronDown
          className={`size-3.5 shrink-0 text-content-muted transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden
        />
      </button>
      {open && (
        <div className="max-h-64 overflow-y-auto border-t border-line px-2.5 py-2">
          <p className="whitespace-pre-wrap break-words text-xs leading-5 text-content-muted">
            {reasoning}
          </p>
        </div>
      )}
    </div>
  );
}

const PIN_TO_BOTTOM_PX = 96;

export function ChatConsole({ models, chat, variant = "page" }: ChatConsoleProps) {
  const compact = variant === "widget";
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const pinnedToBottomRef = useRef(true);
  const messageCountRef = useRef(0);
  const { messages, input, setInput, streaming, send, stop, knowledgeBases, knowledgeBaseId } = chat;
  const disabled = models.length === 0;
  const ragOn = knowledgeBaseId !== "off" && knowledgeBases.length > 0;
  const suggestions = ragOn ? GROUNDED_SUGGESTIONS : SUGGESTIONS;

  function isNearBottom(el: HTMLDivElement): boolean {
    return el.scrollHeight - el.scrollTop - el.clientHeight <= PIN_TO_BOTTOM_PX;
  }

  function scrollToLatest(behavior: ScrollBehavior) {
    const el = transcriptRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  }

  function handleTranscriptScroll() {
    const el = transcriptRef.current;
    if (!el) return;
    const pinned = isNearBottom(el);
    pinnedToBottomRef.current = pinned;
    setShowJumpToLatest(!pinned && messages.length > 0);
  }

  useEffect(() => {
    if (messages.length > messageCountRef.current) {
      pinnedToBottomRef.current = true;
      setShowJumpToLatest(false);
    }
    messageCountRef.current = messages.length;
    if (!pinnedToBottomRef.current) return;
    // Instant while tokens arrive so smooth animations cannot yank the viewport back.
    scrollToLatest(streaming ? "auto" : "smooth");
  }, [messages, streaming]);

  async function copyMessage(message: ChatMessage) {
    // Copy the answer only; the reasoning scratchpad is rarely what you want.
    const { answer } = splitReasoning(message.content);
    await navigator.clipboard.writeText(answer || message.content);
    setCopiedId(message.id);
    window.setTimeout(() => setCopiedId(null), 1500);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative min-h-0 flex-1">
        <div
          ref={transcriptRef}
          onScroll={handleTranscriptScroll}
          className={`absolute inset-0 overflow-y-auto overscroll-contain bg-surface-0/40 ${
            compact ? "px-3 py-4" : "px-4 py-5 sm:px-6"
          }`}
          aria-live="polite"
        >
        {messages.length === 0 ? (
          <div className="mx-auto flex h-full max-w-xl flex-col items-center justify-center text-center">
            <span className="grid size-11 place-items-center rounded-2xl border border-brand-200 bg-brand-50 text-brand-600 shadow-sm">
              <Sparkles className="size-5" aria-hidden />
            </span>
            <h3
              className={`mt-4 font-semibold tracking-tight text-content-primary ${
                compact ? "text-base" : "text-lg"
              }`}
            >
              How can your model help?
            </h3>
            <p className="mt-2 max-w-md text-xs leading-6 text-content-muted sm:text-sm">
              {disabled
                ? "No models are enabled on your plan yet. Ask an administrator to grant model access."
                : ragOn
                  ? "Ask in Bangla or English. Answers come from your knowledge base, not from the model's memory."
                  : "Ask questions, draft content, analyze code, or test a newly connected GGUF model. Responses stream directly from your private runtime."}
            </p>
            {!disabled && (
              <div className={`mt-5 grid w-full gap-2 ${compact ? "" : "sm:grid-cols-2"}`}>
                {(compact ? suggestions.slice(0, 3) : suggestions).map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    className="rounded-xl border border-line bg-surface-1 px-3 py-2.5 text-left text-xs text-content-secondary transition-colors hover:border-brand-200 hover:bg-brand-50 hover:text-brand-700"
                    onClick={() => setInput(prompt)}
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className={`mx-auto space-y-5 ${compact ? "" : "max-w-3xl"}`}>
            {messages.map((message) => {
              const { reasoning, answer, thinking } =
                message.role === "assistant" && !message.error
                  ? splitReasoning(message.content)
                  : { reasoning: "", answer: message.content, thinking: false };
              const hasBody = Boolean(reasoning || answer);

              return (
              <article
                key={message.id}
                className={`group flex gap-2.5 ${
                  message.role === "user" ? "justify-end" : "justify-start"
                }`}
              >
                {message.role === "assistant" && !compact && (
                  <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg border border-brand-100 bg-brand-50 text-brand-600">
                    <Bot className="size-4" aria-hidden />
                  </span>
                )}
                <div
                  className={`relative max-w-[min(42rem,92%)] rounded-2xl px-3.5 py-3 text-sm leading-6 shadow-sm ${
                    message.role === "user"
                      ? "rounded-br-md bg-brand-600 text-white"
                      : message.error
                        ? "rounded-bl-md border border-danger-200 bg-danger-50 text-danger-700"
                        : "rounded-bl-md border border-line bg-surface-1 text-content-primary"
                  }`}
                >
                  {hasBody ? (
                    <div className="space-y-2">
                      {reasoning && (
                        <ReasoningBlock
                          reasoning={reasoning}
                          thinking={thinking && streaming}
                          hasAnswer={Boolean(answer)}
                        />
                      )}
                      {answer &&
                        (message.role === "assistant" && !message.error ? (
                          <ChatMarkdown text={answer} />
                        ) : (
                          <div className="whitespace-pre-wrap break-words">{answer}</div>
                        ))}
                    </div>
                  ) : (
                    <span className="flex items-center gap-1 py-1 text-content-muted">
                      <span className="size-1.5 animate-pulse rounded-full bg-brand-400" />
                      <span className="size-1.5 animate-pulse rounded-full bg-brand-400 [animation-delay:150ms]" />
                      <span className="size-1.5 animate-pulse rounded-full bg-brand-400 [animation-delay:300ms]" />
                    </span>
                  )}
                  {message.role === "assistant" && message.content && (
                    <div className="mt-2 flex items-center justify-between gap-3 border-t border-line pt-2">
                      <span className="font-mono text-[10px] uppercase tracking-wide text-content-muted">
                        {finishLabel(message)}
                      </span>
                      <button
                        type="button"
                        className="text-content-muted transition-colors hover:text-content-primary"
                        onClick={() => void copyMessage(message)}
                        title="Copy response"
                      >
                        {copiedId === message.id ? (
                          <Check className="size-3.5 text-ok-600" aria-hidden />
                        ) : (
                          <Copy className="size-3.5" aria-hidden />
                        )}
                      </button>
                    </div>
                  )}
                  {message.role === "assistant" && message.sources && message.sources.length > 0 && (
                    <div className="mt-2 space-y-1 text-[11px] leading-5 text-content-muted">
                      <p>
                        Source
                        {message.sources.length === 1 ? "" : "s"}:{" "}
                        {message.sources.map((source) => source.title).join(" · ")}
                      </p>
                      {message.sources[0]?.excerpt && (
                        <p className="line-clamp-2 text-[10px] text-content-muted/80">
                          {message.sources[0].excerpt}
                        </p>
                      )}
                    </div>
                  )}
                </div>
                {message.role === "user" && !compact && (
                  <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg border border-line-strong bg-surface-2 text-content-secondary">
                    <User className="size-4" aria-hidden />
                  </span>
                )}
              </article>
              );
            })}
          </div>
        )}
      </div>
        {showJumpToLatest && (
          <button
            type="button"
            className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-full border border-line-strong bg-surface-1 px-3 py-1.5 text-xs font-medium text-content-secondary shadow-sm hover:bg-surface-2"
            onClick={() => {
              pinnedToBottomRef.current = true;
              setShowJumpToLatest(false);
              scrollToLatest("smooth");
            }}
          >
            <ChevronDown className="size-3.5" aria-hidden />
            Latest
          </button>
        )}
      </div>

      <div className={`border-t border-line bg-surface-1 ${compact ? "p-2.5" : "p-3 sm:p-4"}`}>
        <div
          className={`mx-auto rounded-2xl border border-line-strong bg-surface-1 p-2 shadow-[0_4px_16px_rgba(16,24,40,0.08)] focus-within:border-brand-400 focus-within:ring-2 focus-within:ring-brand-500/15 ${
            compact ? "" : "max-w-3xl"
          }`}
        >
          <textarea
            className={`w-full resize-none bg-transparent px-2 py-1.5 text-sm text-content-primary outline-none placeholder:text-content-muted ${
              compact ? "max-h-28 min-h-11" : "max-h-40 min-h-16"
            }`}
            placeholder={disabled ? "No models available on your plan" : "Message your model…"}
            value={input}
            disabled={disabled}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
          />
          <div className="flex items-center justify-between gap-3 px-1">
            <span className="text-[10px] text-content-muted">
              {compact ? "Enter to send" : "Enter to send · Shift+Enter for newline"}
            </span>
            {streaming ? (
              <button type="button" className="btn-secondary !rounded-xl" onClick={stop}>
                <Square className="size-3.5 fill-current" aria-hidden />
                Stop
              </button>
            ) : (
              <button
                type="button"
                className="btn !rounded-xl"
                onClick={() => void send()}
                disabled={!input.trim() || disabled}
              >
                <Send className="size-3.5" aria-hidden />
                Send
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
