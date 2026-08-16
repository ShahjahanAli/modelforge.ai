"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Eraser, Maximize2, MessageSquare, Settings2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { ChatConsole } from "./ChatConsole";
import { ChatSettings } from "./ChatSettings";
import { useChatStream, type ChatModelOption } from "./useChatStream";

/**
 * Persistent chat entry point. Lives in the customer shell so the conversation
 * survives navigation between dashboard pages, and stays out of the way until
 * the bubble is clicked.
 */
export function ChatWidget({ models }: { models: ChatModelOption[] }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const chat = useChatStream({ defaultMaxTokens: 1024 });

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  // The dedicated chat page already provides the full experience.
  if (pathname === "/chat") return null;

  return (
    <div className="pointer-events-none fixed inset-0 z-50">
      {open && (
        <div className="pointer-events-auto absolute inset-x-3 bottom-3 top-3 flex flex-col overflow-hidden rounded-2xl border border-line-strong bg-surface-1 shadow-[0_24px_60px_rgba(16,24,40,0.22)] sm:inset-auto sm:bottom-24 sm:right-5 sm:top-auto sm:h-[34rem] sm:w-[26rem]">
          <div className="flex items-center gap-2 border-b border-line bg-surface-1 px-3 py-2.5">
            <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-brand-100 bg-brand-50 text-brand-600">
              <MessageSquare className="size-4" aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold tracking-tight text-content-primary">
                Model chat
              </span>
              <span className="block font-mono text-[10px] uppercase tracking-wider text-content-muted">
                {chat.streaming ? "generating…" : models.length > 0 ? "ready" : "no models"}
              </span>
            </span>
            <button
              type="button"
              className="icon-btn"
              onClick={() => setShowSettings((value) => !value)}
              aria-pressed={showSettings}
              title="Generation settings"
            >
              <Settings2 className="size-4" aria-hidden />
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={chat.reset}
              disabled={chat.messages.length === 0 || chat.streaming}
              title="New chat"
            >
              <Eraser className="size-4" aria-hidden />
            </button>
            <Link href="/chat" className="icon-btn" title="Open full chat">
              <Maximize2 className="size-4" aria-hidden />
            </Link>
            <button
              type="button"
              className="icon-btn"
              onClick={() => setOpen(false)}
              title="Close chat"
            >
              <X className="size-4" aria-hidden />
            </button>
          </div>

          {showSettings && <ChatSettings models={models} chat={chat} layout="inline" />}

          <ChatConsole models={models} chat={chat} variant="widget" />
        </div>
      )}

      <button
        type="button"
        className="pointer-events-auto absolute bottom-4 right-4 grid size-14 place-items-center rounded-full bg-brand-600 text-white shadow-[0_12px_28px_rgba(79,70,229,0.35)] transition-transform hover:scale-105 hover:bg-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40 focus-visible:ring-offset-2 sm:bottom-5 sm:right-5"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={open ? "Close model chat" : "Open model chat"}
      >
        {open ? (
          <X className="size-5" aria-hidden />
        ) : (
          <MessageSquare className="size-5" aria-hidden />
        )}
        {!open && chat.streaming && (
          <span className="absolute -right-0.5 -top-0.5 size-3 animate-pulse rounded-full border-2 border-white bg-signal-500" />
        )}
      </button>
    </div>
  );
}
