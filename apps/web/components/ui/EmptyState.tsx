import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export function EmptyState({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon?: LucideIcon;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-5 py-10 text-center sm:py-12">
      {Icon && (
        <span className="grid size-11 place-items-center rounded-xl border border-line bg-surface-2 text-content-muted">
          <Icon className="size-5" aria-hidden />
        </span>
      )}
      <div>
        <p className="text-sm font-medium text-content-primary">{title}</p>
        {description && (
          <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-content-muted">
            {description}
          </p>
        )}
      </div>
      {children}
    </div>
  );
}
