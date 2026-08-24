"use client";

import type { ReactNode } from "react";
import { ToastProvider } from "@/components/ui/Toast";

/** Client boundary that guarantees toast context for shell pages. */
export function ShellProviders({ children }: { children: ReactNode }) {
  return <ToastProvider>{children}</ToastProvider>;
}
