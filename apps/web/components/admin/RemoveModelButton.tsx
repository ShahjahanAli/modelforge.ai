"use client";

import { Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";
import { removeModelAction } from "@/app/(admin)/admin/models/actions";

export function RemoveModelButton({
  modelId,
  displayName,
  weightsPath,
  status,
}: {
  modelId: string;
  displayName: string;
  weightsPath: string;
  status: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function confirm() {
    setBusy(true);
    const result = await removeModelAction(modelId);
    setBusy(false);
    setOpen(false);
    toast.push({
      tone: result.ok ? "ok" : "danger",
      title: result.ok ? "Model removed" : "Could not remove model",
      description: result.message,
    });
    if (result.ok) router.refresh();
  }

  return (
    <>
      <button className="btn-danger" type="button" onClick={() => setOpen(true)}>
        <Trash2 className="size-3.5" aria-hidden />
        Remove
      </button>
      <ConfirmDialog
        open={open}
        busy={busy}
        title={`Remove ${displayName}?`}
        description="This ejects the runtime if it is loaded, revokes plan access, and deletes the registry entry. Chat will no longer list this model."
        confirmLabel="Remove model"
        onCancel={() => !busy && setOpen(false)}
        onConfirm={() => void confirm()}
        details={
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-content-muted">Slug</dt>
            <dd className="font-mono break-all">{modelId}</dd>
            <dt className="text-content-muted">Status</dt>
            <dd className="font-mono">{status}</dd>
            <dt className="text-content-muted">Weights</dt>
            <dd className="font-mono break-all">{weightsPath}</dd>
            <dt className="text-content-muted">Disk</dt>
            <dd>GGUF files are deleted when no other registered model points at the same path.</dd>
          </dl>
        }
      />
    </>
  );
}
