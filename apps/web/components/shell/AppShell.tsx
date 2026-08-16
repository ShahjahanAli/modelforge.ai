import Link from "next/link";
import type { ReactNode } from "react";
import { LogOut, Hexagon, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { SidebarNav, type NavGroup } from "./SidebarNav";
import { MobileNav } from "./MobileNav";

export type ShellVariant = "workspace" | "admin";

/**
 * Admin routes get a warmer chrome so it is obvious at a glance that an action
 * affects the whole platform rather than the signed-in customer's own account.
 */
const chrome = {
  workspace: {
    accentBar: "bg-gradient-to-r from-brand-500 via-brand-400 to-signal-500",
    sidebar: "bg-surface-1",
    header: "bg-surface-1/85",
    mark: "border-brand-100 bg-brand-50",
    markIcon: "text-brand-600",
    subtitle: "LLM Runtime",
  },
  admin: {
    accentBar: "bg-gradient-to-r from-warn-500 via-warn-600 to-danger-500",
    sidebar: "bg-surface-2",
    header: "bg-warn-50/80",
    mark: "border-warn-200 bg-warn-100",
    markIcon: "text-warn-700",
    subtitle: "Control Plane",
  },
} satisfies Record<ShellVariant, Record<string, string>>;

export function AppShell({
  groups,
  email,
  role,
  variant = "workspace",
  overlay,
  children,
}: {
  groups: NavGroup[];
  email: string;
  role?: string;
  variant?: ShellVariant;
  /** Floating chrome (chat bubble, toasts) rendered outside the page content flow. */
  overlay?: ReactNode;
  children: ReactNode;
}) {
  const skin = chrome[variant];
  const isAdminShell = variant === "admin";
  const homeHref = isAdminShell ? "/admin/dashboard" : "/dashboard";
  const initials = email.slice(0, 2).toUpperCase();

  return (
    <div className="flex min-h-screen w-full">
      <div className="app-backdrop" aria-hidden />
      <div className={`fixed inset-x-0 top-0 z-40 h-0.5 ${skin.accentBar}`} aria-hidden />

      <aside
        className={`sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r border-line px-3 py-4 lg:flex xl:w-68 xl:px-4 ${skin.sidebar}`}
      >
        <Link href={homeHref} className="mb-6 flex items-center gap-2.5 px-2">
          <span className={`grid size-8 place-items-center rounded-lg border ${skin.mark}`}>
            {isAdminShell ? (
              <ShieldCheck className={`size-4 ${skin.markIcon}`} strokeWidth={2.2} aria-hidden />
            ) : (
              <Hexagon className={`size-4 ${skin.markIcon}`} strokeWidth={2.4} aria-hidden />
            )}
          </span>
          <span>
            <span className="block text-sm font-semibold tracking-tight text-content-primary">
              ModelForge
            </span>
            <span className="block font-mono text-[10px] uppercase tracking-[0.16em] text-content-muted">
              {skin.subtitle}
            </span>
          </span>
        </Link>

        <div className="flex-1 overflow-y-auto">
          <SidebarNav groups={groups} />
        </div>

        <div className="mt-5 border-t border-line pt-3">
          <div className="flex items-center gap-2.5 px-1">
            <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-line bg-surface-1 font-mono text-xs font-semibold text-brand-700">
              {initials}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium text-content-primary">
                {email}
              </span>
              <span className="block text-[10px] uppercase tracking-wider text-content-muted">
                {role ?? "customer"}
              </span>
            </span>
          </div>
          <Link
            href="/api/auth/signout"
            className="mt-2 flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-content-secondary transition-colors hover:bg-danger-50 hover:text-danger-700"
          >
            <LogOut className="size-4" aria-hidden />
            Sign out
          </Link>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header
          className={`sticky top-0 z-30 border-b border-line backdrop-blur-md ${skin.header}`}
        >
          <div className="flex items-center gap-2 px-3 py-2.5 sm:px-5 sm:py-3 lg:px-7">
            <MobileNav groups={groups} email={email} role={role} variant={variant} />

            <Link href={homeHref} className="flex items-center gap-2 lg:hidden">
              {isAdminShell ? (
                <ShieldCheck className={`size-4 ${skin.markIcon}`} strokeWidth={2.2} aria-hidden />
              ) : (
                <Hexagon className={`size-4 ${skin.markIcon}`} strokeWidth={2.4} aria-hidden />
              )}
              <span className="text-sm font-semibold tracking-tight text-content-primary">
                ModelForge
              </span>
            </Link>

            <div className="hidden items-center gap-2 lg:flex">
              {isAdminShell ? (
                <>
                  <Badge tone="warn" dot>
                    Admin · platform-wide
                  </Badge>
                  <span className="font-mono text-[11px] text-content-muted">
                    changes affect all tenants
                  </span>
                </>
              ) : (
                <>
                  <Badge tone="info">CPU runtime</Badge>
                  <span className="font-mono text-[11px] text-content-muted">
                    llama.cpp · OpenAI-compatible v1
                  </span>
                </>
              )}
            </div>

            <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-2">
              {isAdminShell ? (
                <>
                  <Link href="/models" className="btn-secondary text-xs">
                    Customer view
                  </Link>
                  <Link href="/admin/models" className="btn hidden text-xs sm:inline-flex">
                    Add model
                  </Link>
                </>
              ) : (
                <>
                  <Link href="/models" className="btn-ghost hidden text-xs sm:inline-flex">
                    Model catalog
                  </Link>
                  <Link href="/keys" className="btn text-xs">
                    New API key
                  </Link>
                </>
              )}
            </div>
          </div>
        </header>

        <main className="w-full flex-1 px-3 py-4 sm:px-5 sm:py-6 lg:px-7 lg:py-7">
          <div className="w-full space-y-4 sm:space-y-6">{children}</div>
        </main>
      </div>

      {overlay}
    </div>
  );
}
