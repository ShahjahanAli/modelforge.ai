"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";

/**
 * Refreshes server-component data without a full page navigation. Pauses while
 * the tab is hidden so inactive admin sessions do not generate needless load.
 */
export function LiveRefresh({ intervalMs = 10_000 }: { intervalMs?: number }) {
  const router = useRouter();

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, intervalMs);

    return () => window.clearInterval(timer);
  }, [intervalMs, router]);

  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-content-muted">
      <RefreshCw className="size-3 animate-spin [animation-duration:3s]" aria-hidden />
      refresh {Math.round(intervalMs / 1000)}s
    </span>
  );
}
