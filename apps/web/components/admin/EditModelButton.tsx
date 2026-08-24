"use client";

import { Pencil, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { useToast } from "@/components/ui/Toast";
import { updateModelPropertiesAction } from "@/app/(admin)/admin/models/actions";

export type EditableModel = {
  modelId: string;
  displayName: string;
  providerKind: "LOCAL_GGUF" | "OPENAI_COMPAT" | string;
  weightsPath: string;
  quantization: string;
  contextLength: number;
  nThreads: number;
  pricePerMTokIn: number;
  pricePerMTokOut: number;
  remoteBaseUrl: string | null;
  remoteModelId: string | null;
  hasCredential: boolean;
};

export function EditModelButton({ model }: { model: EditableModel }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  return (
    <>
      <button className="btn-secondary text-xs" type="button" onClick={() => setOpen(true)}>
        <Pencil className="size-3.5" aria-hidden />
        Edit
      </button>
      {open ? (
        <EditModelDialog
          model={model}
          busy={pending}
          onCancel={() => !pending && setOpen(false)}
          onSubmit={(formData) => {
            startTransition(async () => {
              const result = await updateModelPropertiesAction(formData);
              toast.push({
                tone: result.ok ? "ok" : "danger",
                title: result.ok ? "Model updated" : "Update failed",
                description: result.message,
              });
              if (result.ok) {
                setOpen(false);
                router.refresh();
              }
            });
          }}
        />
      ) : null}
    </>
  );
}

function EditModelDialog({
  model,
  busy,
  onCancel,
  onSubmit,
}: {
  model: EditableModel;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (formData: FormData) => void;
}) {
  const titleId = useId();
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const remote = model.providerKind === "OPENAI_COMPAT";

  useEffect(() => {
    firstFieldRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !busy) onCancel();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onCancel]);

  return (
    <div className="fixed inset-0 z-70 flex items-end justify-center p-3 sm:items-center">
      <div
        className="animate-overlay-in absolute inset-0 bg-content-primary/40 backdrop-blur-[2px]"
        onClick={() => !busy && onCancel()}
        aria-hidden
      />
      <div
        className="animate-dialog-in relative max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-line-strong bg-surface-1 p-5 shadow-[0_24px_60px_rgba(16,24,40,0.28)]"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id={titleId} className="text-base font-semibold tracking-tight text-content-primary">
              Edit model properties
            </h2>
            <p className="mt-1 text-sm text-content-secondary">
              Public slug stays fixed (<span className="font-mono text-xs">{model.modelId}</span>).
              Pricing changes create a new pricing version.
            </p>
          </div>
          <button
            type="button"
            className="btn-ghost shrink-0 p-2"
            onClick={onCancel}
            disabled={busy}
            aria-label="Close"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>

        <form
          className="mt-4 grid gap-3 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit(new FormData(event.currentTarget));
          }}
        >
          <input type="hidden" name="modelId" value={model.modelId} />

          <div className="sm:col-span-2">
            <label className="field-label" htmlFor="edit-displayName">
              Display name
            </label>
            <input
              ref={firstFieldRef}
              id="edit-displayName"
              className="input"
              name="displayName"
              defaultValue={model.displayName}
              required
              disabled={busy}
            />
          </div>

          <div>
            <label className="field-label" htmlFor="edit-contextLength">
              Context length
            </label>
            <input
              id="edit-contextLength"
              className="input"
              name="contextLength"
              type="number"
              min={512}
              defaultValue={model.contextLength}
              required
              disabled={busy}
            />
          </div>

          {!remote ? (
            <div>
              <label className="field-label" htmlFor="edit-nThreads">
                Threads
              </label>
              <input
                id="edit-nThreads"
                className="input"
                name="nThreads"
                type="number"
                min={1}
                defaultValue={model.nThreads}
                required
                disabled={busy}
              />
            </div>
          ) : (
            <div>
              <label className="field-label" htmlFor="edit-quantization">
                Quant / type
              </label>
              <input
                id="edit-quantization"
                className="input"
                name="quantization"
                defaultValue={model.quantization || "remote"}
                disabled={busy}
              />
            </div>
          )}

          <div>
            <label className="field-label" htmlFor="edit-priceIn">
              Price ¢ / M input
            </label>
            <input
              id="edit-priceIn"
              className="input"
              name="pricePerMTokIn"
              type="number"
              min={0}
              step="0.01"
              defaultValue={model.pricePerMTokIn}
              required
              disabled={busy}
            />
          </div>
          <div>
            <label className="field-label" htmlFor="edit-priceOut">
              Price ¢ / M output
            </label>
            <input
              id="edit-priceOut"
              className="input"
              name="pricePerMTokOut"
              type="number"
              min={0}
              step="0.01"
              defaultValue={model.pricePerMTokOut}
              required
              disabled={busy}
            />
          </div>

          {remote ? (
            <>
              <div className="sm:col-span-2">
                <label className="field-label" htmlFor="edit-remoteBaseUrl">
                  Base URL
                </label>
                <input
                  id="edit-remoteBaseUrl"
                  className="input font-mono text-xs"
                  name="remoteBaseUrl"
                  defaultValue={model.remoteBaseUrl ?? ""}
                  required
                  disabled={busy}
                />
              </div>
              <div className="sm:col-span-2">
                <label className="field-label" htmlFor="edit-remoteModelId">
                  Upstream model id
                </label>
                <input
                  id="edit-remoteModelId"
                  className="input font-mono text-xs"
                  name="remoteModelId"
                  defaultValue={model.remoteModelId ?? ""}
                  required
                  disabled={busy}
                />
              </div>
              <div className="sm:col-span-2">
                <label className="field-label" htmlFor="edit-apiKey">
                  API key {model.hasCredential ? "(leave blank to keep current)" : "(optional if env fallback)"}
                </label>
                <input
                  id="edit-apiKey"
                  className="input font-mono text-xs"
                  name="apiKey"
                  type="password"
                  autoComplete="off"
                  placeholder={model.hasCredential ? "••••••••" : "Paste to store encrypted"}
                  disabled={busy}
                />
              </div>
            </>
          ) : (
            <>
              <div className="sm:col-span-2">
                <label className="field-label" htmlFor="edit-weightsPath">
                  GGUF path
                </label>
                <input
                  id="edit-weightsPath"
                  className="input font-mono text-xs"
                  name="weightsPath"
                  defaultValue={model.weightsPath}
                  required
                  disabled={busy}
                />
              </div>
              <div className="sm:col-span-2">
                <label className="field-label" htmlFor="edit-quantization">
                  Quantization
                </label>
                <input
                  id="edit-quantization"
                  className="input"
                  name="quantization"
                  defaultValue={model.quantization}
                  required
                  disabled={busy}
                />
              </div>
            </>
          )}

          <div className="mt-2 flex flex-wrap justify-end gap-2 sm:col-span-2">
            <button className="btn-secondary" type="button" onClick={onCancel} disabled={busy}>
              Cancel
            </button>
            <button className="btn" type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save changes"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
