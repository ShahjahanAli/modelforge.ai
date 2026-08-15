import type { ReactNode } from "react";

type Tone = "neutral" | "ok" | "warn" | "danger" | "info";

const toneStyles: Record<Tone, string> = {
  neutral: "border-line-strong bg-surface-2 text-content-secondary",
  ok: "border-ok-100 bg-ok-50 text-ok-700",
  warn: "border-warn-100 bg-warn-50 text-warn-700",
  danger: "border-danger-100 bg-danger-50 text-danger-700",
  info: "border-brand-100 bg-brand-50 text-brand-700",
};

const dotStyles: Record<Tone, string> = {
  neutral: "bg-content-muted",
  ok: "bg-ok-500",
  warn: "bg-warn-500",
  danger: "bg-danger-500",
  info: "bg-brand-500",
};

export function Badge({
  children,
  tone = "neutral",
  dot = false,
  pulse = false,
}: {
  children: ReactNode;
  tone?: Tone;
  dot?: boolean;
  pulse?: boolean;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide ${toneStyles[tone]}`}
    >
      {dot && (
        <span className="relative flex size-1.5">
          {pulse && (
            <span
              className={`absolute inline-flex size-full animate-ping rounded-full opacity-70 ${dotStyles[tone]}`}
            />
          )}
          <span className={`relative inline-flex size-1.5 rounded-full ${dotStyles[tone]}`} />
        </span>
      )}
      {children}
    </span>
  );
}

/** Maps domain status strings to a consistent visual tone. */
export function StatusBadge({ status }: { status: string }) {
  const value = status.toUpperCase();
  const tone: Tone =
    value === "LOADED" || value === "ACTIVE" || value === "PAID"
      ? "ok"
      : value === "ERROR" || value === "REVOKED" || value === "OVERDUE" || value === "CANCELED"
        ? "danger"
        : value === "PAST_DUE" || value === "SENT" || value === "DRAFT"
          ? "warn"
          : "neutral";

  return (
    <Badge tone={tone} dot pulse={value === "LOADED"}>
      {value.replace(/_/g, " ")}
    </Badge>
  );
}
