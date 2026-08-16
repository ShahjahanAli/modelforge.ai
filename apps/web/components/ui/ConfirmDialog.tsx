"use client";

import { AlertTriangle } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode } from "react";

/**
 * Blocking confirmation for destructive infrastructure actions. Rendered inline
 * (not portalled) so it inherits the shell's font and token scope.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "danger",
  busy = false,
  details,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "danger" | "warn";
  busy?: boolean;
  details?: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    confirmRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !busy) onCancel();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, busy, onCancel]);

  if (!open) return null;

  const accent =
    tone === "danger"
      ? { mark: "border-danger-200 bg-danger-50 text-danger-600", button: "btn-danger" }
      : { mark: "border-warn-200 bg-warn-50 text-warn-600", button: "btn-secondary" };

  return (
    <div className="fixed inset-0 z-70 flex items-end justify-center p-3 sm:items-center">
      <div
        className="animate-overlay-in absolute inset-0 bg-content-primary/40 backdrop-blur-[2px]"
        onClick={() => !busy && onCancel()}
        aria-hidden
      />
      <div
        className="animate-dialog-in relative w-full max-w-md rounded-2xl border border-line-strong bg-surface-1 p-5 shadow-[0_24px_60px_rgba(16,24,40,0.28)]"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="flex items-start gap-3">
          <span className={`grid size-10 shrink-0 place-items-center rounded-xl border ${accent.mark}`}>
            <AlertTriangle className="size-5" aria-hidden />
          </span>
          <div className="min-w-0">
            <h2 id={titleId} className="text-base font-semibold tracking-tight text-content-primary">
              {title}
            </h2>
            <p className="mt-1 text-sm leading-6 text-content-secondary">{description}</p>
          </div>
        </div>

        {details && (
          <div className="mt-4 rounded-xl border border-line bg-surface-2/60 p-3 text-xs leading-5 text-content-secondary">
            {details}
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={`${accent.button} !px-3 !py-2 !text-sm`}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
