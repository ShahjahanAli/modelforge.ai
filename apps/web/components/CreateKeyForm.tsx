"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { AlertCircle, Check, Copy, KeyRound, Plus } from "lucide-react";
import { Panel, PanelBody, PanelHeader } from "@/components/ui/Panel";

export function CreateKeyForm() {
  const router = useRouter();
  const [label, setLabel] = useState("");
  const [rawKey, setRawKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  async function createKey(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setRawKey(null);
    setCopied(false);
    const response = await fetch("/api/keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: label || undefined }),
    });
    const body = (await response.json()) as { rawKey?: string; error?: string };
    setLoading(false);
    if (!response.ok || !body.rawKey) {
      setError(body.error ?? "Could not create API key");
      return;
    }
    setRawKey(body.rawKey);
    setLabel("");
    router.refresh();
  }

  async function copyKey() {
    if (!rawKey) return;
    await navigator.clipboard.writeText(rawKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Panel>
      <PanelHeader
        title="Create a new key"
        description="Keys are hashed with SHA-256 — the plaintext is shown exactly once."
      />
      <PanelBody className="space-y-4">
        <form onSubmit={createKey} className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="min-w-0 flex-1">
            <label htmlFor="key-label" className="field-label">
              Label
            </label>
            <input
              id="key-label"
              className="input"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="production-worker"
            />
          </div>
          <button className="btn w-full shrink-0 sm:w-auto" type="submit" disabled={loading}>
            {loading ? (
              "Generating…"
            ) : (
              <>
                <Plus className="size-4" aria-hidden />
                Generate key
              </>
            )}
          </button>
        </form>

        {error && (
          <p className="danger-note">
            <AlertCircle className="size-4 shrink-0" aria-hidden />
            {error}
          </p>
        )}

        {rawKey && (
          <div className="rounded-lg border border-warn-100 bg-warn-50 p-3 sm:p-4">
            <p className="flex items-center gap-2 text-sm font-medium text-warn-700">
              <KeyRound className="size-4 shrink-0" aria-hidden />
              Copy this key now — it will not be shown again.
            </p>
            <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
              <code className="min-w-0 flex-1 break-all rounded-md border border-warn-100 bg-surface-1 px-3 py-2 font-mono text-xs text-content-primary">
                {rawKey}
              </code>
              <button
                type="button"
                onClick={copyKey}
                className="btn-secondary w-full shrink-0 sm:w-auto"
              >
                {copied ? (
                  <>
                    <Check className="size-4 text-ok-600" aria-hidden />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy className="size-4" aria-hidden />
                    Copy
                  </>
                )}
              </button>
            </div>
          </div>
        )}
      </PanelBody>
    </Panel>
  );
}
