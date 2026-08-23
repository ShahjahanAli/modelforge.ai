"use client";

import { Star } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { setPlatformDefaultModelAction } from "@/app/(admin)/admin/models/actions";
import { useToast } from "@/components/ui/Toast";

export function SetDefaultModelButton({
  modelId,
  displayName,
}: {
  modelId: string;
  displayName: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function setDefault() {
    setBusy(true);
    const formData = new FormData();
    formData.set("modelId", modelId);
    const result = await setPlatformDefaultModelAction(formData);
    setBusy(false);
    toast.push({
      tone: result.ok ? "ok" : "danger",
      title: result.ok ? "Platform default updated" : "Could not set default",
      description: result.message,
    });
    if (result.ok) router.refresh();
  }

  return (
    <button
      className="btn-secondary text-xs"
      type="button"
      disabled={busy}
      onClick={() => void setDefault()}
    >
      <Star className="size-3.5" aria-hidden />
      {busy ? "Setting…" : "Set default"}
    </button>
  );
}
