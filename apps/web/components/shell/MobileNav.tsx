"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Hexagon, LogOut, Menu, ShieldCheck, X } from "lucide-react";
import { SidebarNav, type NavGroup } from "./SidebarNav";

export function MobileNav({
  groups,
  email,
  role,
  variant = "workspace",
}: {
  groups: NavGroup[];
  email: string;
  role?: string;
  variant?: "workspace" | "admin";
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open navigation"
        aria-expanded={open}
        className="btn-ghost -ml-1.5 lg:hidden"
      >
        <Menu className="size-5" aria-hidden />
      </button>

      {open && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            aria-label="Close navigation"
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-content-primary/25 backdrop-blur-[2px]"
          />
          <div className="absolute inset-y-0 left-0 flex w-[min(18rem,85vw)] flex-col border-r border-line bg-surface-1 shadow-2xl">
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
              <span className="flex items-center gap-2.5">
                <span
                  className={`grid size-8 place-items-center rounded-lg border ${
                    variant === "admin"
                      ? "border-warn-200 bg-warn-100"
                      : "border-brand-100 bg-brand-50"
                  }`}
                >
                  {variant === "admin" ? (
                    <ShieldCheck className="size-4 text-warn-700" strokeWidth={2.2} aria-hidden />
                  ) : (
                    <Hexagon className="size-4 text-brand-600" strokeWidth={2.4} aria-hidden />
                  )}
                </span>
                <span className="text-sm font-semibold tracking-tight">
                  {variant === "admin" ? "ModelForge Admin" : "ModelForge"}
                </span>
              </span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close navigation"
                className="btn-ghost"
              >
                <X className="size-5" aria-hidden />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-3 py-4">
              <SidebarNav groups={groups} onNavigate={() => setOpen(false)} />
            </div>

            <div className="border-t border-line px-3 py-3">
              <div className="flex items-center gap-2.5 px-1 pb-2">
                <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-line bg-surface-2 font-mono text-xs font-semibold text-brand-700">
                  {email.slice(0, 2).toUpperCase()}
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
                className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-content-secondary transition-colors hover:bg-danger-50 hover:text-danger-700"
              >
                <LogOut className="size-4" aria-hidden />
                Sign out
              </Link>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
