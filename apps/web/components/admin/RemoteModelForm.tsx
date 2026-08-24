"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useToast } from "@/components/ui/Toast";

type ProviderPresetId = "openrouter" | "gemini" | "openai" | "custom";

interface ProviderPreset {
  id: ProviderPresetId;
  label: string;
  baseUrl: string;
  credentialLabel: string;
  modelIdPlaceholder: string;
  displayNamePlaceholder: string;
  remoteModelPlaceholder: string;
  apiKeyPlaceholder: string;
  contextLength: number;
  pricePerMTokIn: number;
  pricePerMTokOut: number;
}

const PRESETS: ProviderPreset[] = [
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    credentialLabel: "OpenRouter",
    modelIdPlaceholder: "openrouter-qwen3-8b",
    displayNamePlaceholder: "Qwen3 8B (OpenRouter)",
    remoteModelPlaceholder: "qwen/qwen3-8b",
    apiKeyPlaceholder: "sk-or-… (stored encrypted)",
    contextLength: 128000,
    pricePerMTokIn: 20,
    pricePerMTokOut: 60,
  },
  {
    id: "gemini",
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    credentialLabel: "Gemini",
    modelIdPlaceholder: "gemini-3.6-flash",
    displayNamePlaceholder: "Gemini 3.6 Flash",
    remoteModelPlaceholder: "gemini-3.6-flash",
    apiKeyPlaceholder: "AIza… (stored encrypted)",
    contextLength: 1048576,
    pricePerMTokIn: 15,
    pricePerMTokOut: 60,
  },
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    credentialLabel: "OpenAI",
    modelIdPlaceholder: "openai-gpt-4o-mini",
    displayNamePlaceholder: "GPT-4o mini",
    remoteModelPlaceholder: "gpt-4o-mini",
    apiKeyPlaceholder: "sk-… (stored encrypted)",
    contextLength: 128000,
    pricePerMTokIn: 15,
    pricePerMTokOut: 60,
  },
  {
    id: "custom",
    label: "Custom",
    baseUrl: "",
    credentialLabel: "Remote",
    modelIdPlaceholder: "my-remote-model",
    displayNamePlaceholder: "My remote model",
    remoteModelPlaceholder: "upstream-model-id",
    apiKeyPlaceholder: "API key (stored encrypted)",
    contextLength: 128000,
    pricePerMTokIn: 20,
    pricePerMTokOut: 60,
  },
];

function presetById(id: ProviderPresetId): ProviderPreset {
  return PRESETS.find((p) => p.id === id) ?? PRESETS[0]!;
}

export function RemoteModelForm({
  action,
}: {
  action: (formData: FormData) => Promise<{ ok: boolean; message: string }>;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [presetId, setPresetId] = useState<ProviderPresetId>("gemini");
  const preset = presetById(presetId);
  const [baseUrl, setBaseUrl] = useState(preset.baseUrl);
  const [credentialLabel, setCredentialLabel] = useState(preset.credentialLabel);
  const [contextLength, setContextLength] = useState(preset.contextLength);
  const [priceIn, setPriceIn] = useState(preset.pricePerMTokIn);
  const [priceOut, setPriceOut] = useState(preset.pricePerMTokOut);

  function applyPreset(nextId: ProviderPresetId) {
    const next = presetById(nextId);
    setPresetId(nextId);
    setBaseUrl(next.baseUrl);
    setCredentialLabel(next.credentialLabel);
    setContextLength(next.contextLength);
    setPriceIn(next.pricePerMTokIn);
    setPriceOut(next.pricePerMTokOut);
  }

  function resetForm(form: HTMLFormElement) {
    form.reset();
    applyPreset("gemini");
  }

  return (
    <form
      className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3"
      onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const formData = new FormData(form);
        startTransition(async () => {
          const result = await action(formData);
          toast.push({
            tone: result.ok ? "ok" : "danger",
            title: result.ok ? "Remote model saved" : "Could not save remote model",
            description: result.message,
          });
          if (result.ok) {
            resetForm(form);
            router.refresh();
          }
        });
      }}
    >
      <div className="sm:col-span-2 xl:col-span-3">
        <span className="field-label">Provider</span>
        <div className="mt-1.5 flex flex-wrap gap-2" role="tablist" aria-label="LLM provider">
          {PRESETS.map((row) => {
            const selected = row.id === presetId;
            return (
              <button
                key={row.id}
                type="button"
                role="tab"
                aria-selected={selected}
                disabled={pending}
                onClick={() => applyPreset(row.id)}
                className={
                  selected
                    ? "btn text-xs"
                    : "btn-secondary text-xs"
                }
              >
                {row.label}
              </button>
            );
          })}
        </div>
      </div>
      <div>
        <label className="field-label" htmlFor="remote-modelId">
          Public slug
        </label>
        <input
          id="remote-modelId"
          className="input"
          name="modelId"
          placeholder={preset.modelIdPlaceholder}
          required
          disabled={pending}
        />
      </div>
      <div>
        <label className="field-label" htmlFor="remote-displayName">
          Display name
        </label>
        <input
          id="remote-displayName"
          className="input"
          name="displayName"
          placeholder={preset.displayNamePlaceholder}
          required
          disabled={pending}
        />
      </div>
      <div>
        <label className="field-label" htmlFor="remote-baseUrl">
          Base URL
        </label>
        <input
          id="remote-baseUrl"
          className="input"
          name="remoteBaseUrl"
          value={baseUrl}
          onChange={(event) => {
            setBaseUrl(event.target.value);
            setPresetId("custom");
          }}
          placeholder={preset.baseUrl || "https://…/v1"}
          required
          disabled={pending}
        />
      </div>
      <div>
        <label className="field-label" htmlFor="remote-remoteModelId">
          Upstream model id
        </label>
        <input
          id="remote-remoteModelId"
          className="input"
          name="remoteModelId"
          placeholder={preset.remoteModelPlaceholder}
          required
          disabled={pending}
        />
      </div>
      <div>
        <label className="field-label" htmlFor="remote-apiKey">
          API key
        </label>
        <input
          id="remote-apiKey"
          className="input"
          name="apiKey"
          type="password"
          autoComplete="off"
          placeholder={preset.apiKeyPlaceholder}
          disabled={pending}
        />
      </div>
      <div>
        <label className="field-label" htmlFor="remote-credentialLabel">
          Credential label
        </label>
        <input
          id="remote-credentialLabel"
          className="input"
          name="credentialLabel"
          value={credentialLabel}
          onChange={(event) => setCredentialLabel(event.target.value)}
          disabled={pending}
        />
      </div>
      <div>
        <label className="field-label" htmlFor="remote-contextLength">
          Context length
        </label>
        <input
          id="remote-contextLength"
          className="input"
          name="contextLength"
          type="number"
          value={contextLength}
          onChange={(event) => setContextLength(Number(event.target.value) || 0)}
          disabled={pending}
        />
      </div>
      <div>
        <label className="field-label" htmlFor="remote-priceIn">
          Price ¢ / M input
        </label>
        <input
          id="remote-priceIn"
          className="input"
          name="pricePerMTokIn"
          type="number"
          value={priceIn}
          onChange={(event) => setPriceIn(Number(event.target.value) || 0)}
          disabled={pending}
        />
      </div>
      <div>
        <label className="field-label" htmlFor="remote-priceOut">
          Price ¢ / M output
        </label>
        <input
          id="remote-priceOut"
          className="input"
          name="pricePerMTokOut"
          type="number"
          value={priceOut}
          onChange={(event) => setPriceOut(Number(event.target.value) || 0)}
          disabled={pending}
        />
      </div>
      <div className="flex items-end gap-3 sm:col-span-2 xl:col-span-3">
        <label className="inline-flex items-center gap-2 text-sm text-content-secondary">
          <input type="checkbox" name="makeDefault" disabled={pending} />
          Set as platform default (local GGUFs will be unloaded)
        </label>
        <button className="btn ml-auto" type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save remote model"}
        </button>
      </div>
      <p className="sm:col-span-2 xl:col-span-3 text-xs text-content-muted">
        Keys are encrypted at rest (AES-GCM). Leave API key blank on update to keep the existing
        credential. Gateway can also fall back to{" "}
        <span className="font-mono">GEMINI_API_KEY</span> /{" "}
        <span className="font-mono">OPENROUTER_API_KEY</span> in env. Gemini uses Google&apos;s
        OpenAI-compatible endpoint (
        <span className="font-mono">…/v1beta/openai</span>).
      </p>
    </form>
  );
}
