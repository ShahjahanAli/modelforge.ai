import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

type Accent = "brand" | "signal" | "ok" | "warn" | "danger";

const accentRing: Record<Accent, string> = {
  brand: "text-brand-600 bg-brand-50 border-brand-100",
  signal: "text-signal-600 bg-signal-50 border-signal-100",
  ok: "text-ok-600 bg-ok-50 border-ok-100",
  warn: "text-warn-600 bg-warn-50 border-warn-100",
  danger: "text-danger-600 bg-danger-50 border-danger-100",
};

export function StatCard({
  label,
  value,
  unit,
  hint,
  icon: Icon,
  accent = "brand",
  children,
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  hint?: ReactNode;
  icon?: LucideIcon;
  accent?: Accent;
  children?: ReactNode;
}) {
  return (
    <article className="panel panel-hover p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <p className="label-caps">{label}</p>
        {Icon && (
          <span
            className={`grid size-8 shrink-0 place-items-center rounded-lg border ${accentRing[accent]}`}
          >
            <Icon className="size-4" strokeWidth={2} aria-hidden />
          </span>
        )}
      </div>
      <p className="mt-3 flex flex-wrap items-baseline gap-x-1.5">
        <span className="metric">{value}</span>
        {unit && <span className="text-xs text-content-muted">{unit}</span>}
      </p>
      {hint && <div className="mt-1.5 text-xs text-content-muted">{hint}</div>}
      {children && <div className="mt-3">{children}</div>}
    </article>
  );
}

export function Meter({
  value,
  max,
  tone = "brand",
}: {
  value: number;
  max: number;
  tone?: "brand" | "ok" | "warn" | "danger";
}) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  const bar: Record<string, string> = {
    brand: "bg-brand-500",
    ok: "bg-ok-500",
    warn: "bg-warn-500",
    danger: "bg-danger-500",
  };
  const risky = pct >= 90 ? "danger" : pct >= 70 ? "warn" : tone;

  return (
    <div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3">
        <div
          className={`h-full rounded-full transition-all duration-500 ${bar[risky]}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="mt-1.5 font-mono text-[11px] tabular-nums text-content-muted">{pct}% used</p>
    </div>
  );
}
