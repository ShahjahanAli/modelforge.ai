"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { adjustCustomerQuotaAction } from "@/app/(admin)/admin/customers/actions";
import { useToast } from "@/components/ui/Toast";

const PRESETS = [100_000, 500_000, 1_000_000, 5_000_000] as const;

export function AdjustCustomerQuota({
  customerId,
  email,
  planQuota,
  bonusTokens,
  tokensUsed,
}: {
  customerId: string;
  email: string;
  planQuota: number;
  bonusTokens: number;
  tokensUsed: number;
}) {
  const router = useRouter();
  const toast = useToast();
  const [addTokens, setAddTokens] = useState(String(PRESETS[0]));
  const [resetUsage, setResetUsage] = useState(false);
  const [busy, setBusy] = useState(false);

  const effective =
    planQuota <= 0 ? 0 : planQuota + Math.max(0, bonusTokens);
  const exhausted = planQuota > 0 && tokensUsed >= effective;

  async function submit() {
    const parsed = Math.floor(Number(addTokens.replace(/,/g, "")) || 0);
    if (parsed <= 0 && !resetUsage) {
      toast.push({
        tone: "danger",
        title: "Nothing to apply",
        description: "Enter tokens to add, or check reset usage.",
      });
      return;
    }
    setBusy(true);
    const result = await adjustCustomerQuotaAction({
      customerId,
      addTokens: parsed,
      resetUsage,
    });
    setBusy(false);
    toast.push({
      tone: result.ok ? "ok" : "danger",
      title: result.ok ? "Quota updated" : "Could not update quota",
      description: result.message,
    });
    if (result.ok) {
      setResetUsage(false);
      router.refresh();
    }
  }

  return (
    <div className="flex min-w-[14rem] flex-col gap-1.5">
      <div className="font-mono text-[11px] tabular-nums text-content-muted">
        {tokensUsed.toLocaleString()}
        {" / "}
        {planQuota <= 0 ? "∞" : effective.toLocaleString()}
        {bonusTokens > 0 ? (
          <span className="text-content-secondary"> (+{bonusTokens.toLocaleString()} bonus)</span>
        ) : null}
        {exhausted ? <span className="ml-1 text-danger-700">exhausted</span> : null}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <input
          className="input h-8 w-28 font-mono text-xs"
          inputMode="numeric"
          aria-label={`Add quota tokens for ${email}`}
          value={addTokens}
          onChange={(e) => setAddTokens(e.target.value)}
          disabled={busy}
        />
        <div className="flex flex-wrap gap-1">
          {PRESETS.map((n) => (
            <button
              key={n}
              type="button"
              className="btn-ghost h-7 px-1.5 text-[10px]"
              disabled={busy}
              onClick={() => setAddTokens(String(n))}
            >
              +{(n / 1_000_000).toString().replace(/\.0$/, "")}M
            </button>
          ))}
        </div>
      </div>
      <label className="flex items-center gap-1.5 text-[11px] text-content-secondary">
        <input
          type="checkbox"
          checked={resetUsage}
          disabled={busy}
          onChange={(e) => setResetUsage(e.target.checked)}
        />
        Reset usage to 0
      </label>
      <button
        type="button"
        className="btn-primary h-8 text-xs"
        disabled={busy}
        onClick={() => void submit()}
      >
        {busy ? "Updating…" : "Increase quota"}
      </button>
    </div>
  );
}
