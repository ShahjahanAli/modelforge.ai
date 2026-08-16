"use client";

import { useState } from "react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel, PanelBody, PanelHeader } from "@/components/ui/Panel";
import { Badge } from "@/components/ui/Badge";

export default function VerifyReceiptPage() {
  const [payload, setPayload] = useState("");
  const [signature, setSignature] = useState("");
  const [keyId, setKeyId] = useState("");
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function onVerify(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/usage/receipts/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ payload, signature, keyId }),
      });
      const body = (await res.json()) as { ok?: boolean; message?: string; error?: string };
      setResult({
        ok: Boolean(body.ok),
        message: body.message ?? body.error ?? (body.ok ? "Valid signature" : "Invalid"),
      });
    } catch (error) {
      setResult({
        ok: false,
        message: error instanceof Error ? error.message : "Verification failed",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="Trust"
        title="Verify usage receipt"
        description="Validate a detached ModelForge Ed25519 receipt against the published signing key."
      />
      <Panel>
        <PanelHeader
          title="Receipt materials"
          actions={
            result ? <Badge tone={result.ok ? "ok" : "danger"}>{result.ok ? "valid" : "invalid"}</Badge> : null
          }
        />
        <PanelBody>
          <form className="space-y-4" onSubmit={onVerify}>
            <label className="block">
              <span className="field-label">Key ID</span>
              <input className="input" value={keyId} onChange={(e) => setKeyId(e.target.value)} required />
            </label>
            <label className="block">
              <span className="field-label">Canonical payload</span>
              <textarea
                className="input min-h-40 font-mono text-xs"
                value={payload}
                onChange={(e) => setPayload(e.target.value)}
                required
              />
            </label>
            <label className="block">
              <span className="field-label">Signature (base64)</span>
              <textarea
                className="input min-h-24 font-mono text-xs"
                value={signature}
                onChange={(e) => setSignature(e.target.value)}
                required
              />
            </label>
            <button className="btn" type="submit" disabled={busy}>
              {busy ? "Verifying…" : "Verify"}
            </button>
            {result && <p className="text-sm text-content-secondary">{result.message}</p>}
          </form>
        </PanelBody>
      </Panel>
    </>
  );
}
