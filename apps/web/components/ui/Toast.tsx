"use client";

import { AlertTriangle, CheckCircle2, Info, Loader2, X, XCircle } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type ToastTone = "ok" | "warn" | "danger" | "info" | "pending";

export interface ToastInput {
  tone?: ToastTone;
  title: string;
  description?: string;
  /** 0 keeps the toast until it is dismissed or updated — use for in-flight work. */
  duration?: number;
}

interface Toast extends ToastInput {
  id: string;
}

interface ToastApi {
  push: (input: ToastInput) => string;
  update: (id: string, input: Partial<ToastInput>) => void;
  dismiss: (id: string) => void;
}

const DEFAULT_DURATION = 5000;

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error("useToast must be used inside <ToastProvider>");
  return api;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef(new Map<string, number>());

  const clearTimer = useCallback((id: string) => {
    const handle = timers.current.get(id);
    if (handle !== undefined) {
      window.clearTimeout(handle);
      timers.current.delete(id);
    }
  }, []);

  const dismiss = useCallback(
    (id: string) => {
      clearTimer(id);
      setToasts((current) => current.filter((toast) => toast.id !== id));
    },
    [clearTimer],
  );

  const schedule = useCallback(
    (id: string, duration: number) => {
      clearTimer(id);
      if (duration > 0) {
        timers.current.set(id, window.setTimeout(() => dismiss(id), duration));
      }
    },
    [clearTimer, dismiss],
  );

  const push = useCallback(
    (input: ToastInput) => {
      const id = crypto.randomUUID();
      const duration = input.duration ?? DEFAULT_DURATION;
      setToasts((current) => [...current.slice(-3), { ...input, id, duration }]);
      schedule(id, duration);
      return id;
    },
    [schedule],
  );

  const update = useCallback(
    (id: string, input: Partial<ToastInput>) => {
      setToasts((current) =>
        current.map((toast) => (toast.id === id ? { ...toast, ...input } : toast)),
      );
      if (input.duration !== undefined) schedule(id, input.duration);
    },
    [schedule],
  );

  useEffect(() => {
    const handles = timers.current;
    return () => {
      for (const handle of handles.values()) window.clearTimeout(handle);
      handles.clear();
    };
  }, []);

  const api = useMemo<ToastApi>(() => ({ push, update, dismiss }), [push, update, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        // Offset clears the floating chat bubble in the customer shell.
        className="pointer-events-none fixed inset-x-3 bottom-24 z-60 flex flex-col gap-2 sm:inset-x-auto sm:right-5 sm:w-88"
        role="region"
        aria-label="Notifications"
      >
        {toasts.map((toast) => (
          <ToastCard key={toast.id} toast={toast} onDismiss={() => dismiss(toast.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

const toneChrome: Record<ToastTone, { wrap: string; icon: string }> = {
  ok: { wrap: "border-ok-200", icon: "text-ok-600" },
  warn: { wrap: "border-warn-200", icon: "text-warn-600" },
  danger: { wrap: "border-danger-200", icon: "text-danger-600" },
  info: { wrap: "border-brand-200", icon: "text-brand-600" },
  pending: { wrap: "border-line-strong", icon: "text-brand-600" },
};

function ToastIcon({ tone }: { tone: ToastTone }) {
  const className = `size-4 shrink-0 ${toneChrome[tone].icon}`;
  if (tone === "ok") return <CheckCircle2 className={className} aria-hidden />;
  if (tone === "warn") return <AlertTriangle className={className} aria-hidden />;
  if (tone === "danger") return <XCircle className={className} aria-hidden />;
  if (tone === "pending") return <Loader2 className={`${className} animate-spin`} aria-hidden />;
  return <Info className={className} aria-hidden />;
}

function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const tone = toast.tone ?? "info";

  return (
    <div
      className={`animate-toast-in pointer-events-auto flex items-start gap-2.5 rounded-xl border bg-surface-1 px-3.5 py-3 shadow-[0_12px_32px_rgba(16,24,40,0.16)] ${toneChrome[tone].wrap}`}
      role={tone === "danger" ? "alert" : "status"}
      aria-live={tone === "danger" ? "assertive" : "polite"}
    >
      <span className="mt-0.5">
        <ToastIcon tone={tone} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-content-primary">{toast.title}</p>
        {toast.description && (
          <p className="mt-0.5 break-words text-xs leading-5 text-content-muted">
            {toast.description}
          </p>
        )}
      </div>
      <button type="button" className="icon-btn !size-6" onClick={onDismiss} aria-label="Dismiss">
        <X className="size-3.5" aria-hidden />
      </button>
    </div>
  );
}
