"use client";

import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";

const STORAGE_PREFIX = "modelforge:apiKey:";

export function rememberRawApiKey(id: string, rawKey: string) {
  try {
    sessionStorage.setItem(`${STORAGE_PREFIX}${id}`, rawKey);
  } catch {
    // Private mode / quota — create UI still shows the key once.
  }
}

export function readRememberedRawApiKey(id: string): string | null {
  try {
    return sessionStorage.getItem(`${STORAGE_PREFIX}${id}`);
  } catch {
    return null;
  }
}

export function CopyTextButton({
  text,
  label = "Copy",
  className = "btn-ghost !px-2 !py-1 text-xs",
}: {
  text: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function onCopy() {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }

  return (
    <button type="button" className={className} onClick={() => void onCopy()} title={label}>
      {copied ? (
        <>
          <Check className="size-3.5 text-ok-600" aria-hidden />
          Copied
        </>
      ) : (
        <>
          <Copy className="size-3.5" aria-hidden />
          {label}
        </>
      )}
    </button>
  );
}

export function ExistingKeyCopy({
  keyId,
  keyPrefix,
}: {
  keyId: string;
  keyPrefix: string;
}) {
  const [raw, setRaw] = useState<string | null>(null);

  useEffect(() => {
    setRaw(readRememberedRawApiKey(keyId));
  }, [keyId]);

  if (raw) {
    return <CopyTextButton text={raw} label="Copy key" className="btn-secondary !px-2.5 !py-1 text-xs" />;
  }

  return (
    <CopyTextButton
      text={keyPrefix}
      label="Copy prefix"
      className="btn-ghost !px-2.5 !py-1 text-xs"
    />
  );
}
