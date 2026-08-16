"use client";

import type { ChatModelOption, ChatStream } from "./useChatStream";

const TOKEN_CHOICES = [512, 1024, 2048, 4096];

export function ChatSettings({
  models,
  chat,
  layout = "sidebar",
}: {
  models: ChatModelOption[];
  chat: ChatStream;
  layout?: "sidebar" | "inline";
}) {
  const { model, setModel, maxTokens, setMaxTokens, temperature, setTemperature, streaming } = chat;
  const inline = layout === "inline";

  const modelSelect = (
    <label className="block">
      <span className="field-label">Model</span>
      <select
        className="input"
        value={model}
        onChange={(event) => setModel(event.target.value)}
        disabled={streaming || models.length === 0}
      >
        <option value="auto">Auto route</option>
        {models.map((option) => (
          <option key={option.id} value={option.id}>
            {option.name}
          </option>
        ))}
      </select>
    </label>
  );

  const tokenSelect = (
    <label className="block">
      <span className="field-label">Maximum output</span>
      <select
        className="input"
        value={maxTokens}
        onChange={(event) => setMaxTokens(Number(event.target.value))}
        disabled={streaming}
      >
        {TOKEN_CHOICES.map((value) => (
          <option key={value} value={value}>
            {value.toLocaleString()} tokens
          </option>
        ))}
      </select>
    </label>
  );

  const temperatureControl = (
    <label className="block">
      <span className="field-label">
        Temperature <span className="float-right font-mono">{temperature.toFixed(1)}</span>
      </span>
      <input
        className="w-full accent-brand-600"
        type="range"
        min="0"
        max="2"
        step="0.1"
        value={temperature}
        onChange={(event) => setTemperature(Number(event.target.value))}
        disabled={streaming}
      />
      <span className="mt-1 flex justify-between text-[10px] text-content-muted">
        <span>Precise</span>
        <span>Creative</span>
      </span>
    </label>
  );

  if (inline) {
    return (
      <div className="grid gap-3 border-b border-line bg-surface-2/60 p-3 sm:grid-cols-2">
        {modelSelect}
        {tokenSelect}
        <div className="sm:col-span-2">{temperatureControl}</div>
      </div>
    );
  }

  return (
    <aside className="border-t border-line bg-surface-2/50 p-4 lg:border-l lg:border-t-0">
      <p className="label-caps">Generation settings</p>
      <div className="mt-4 space-y-4">
        {modelSelect}
        {tokenSelect}
        {temperatureControl}
      </div>

      <div className="mt-6 rounded-xl border border-line bg-surface-1 p-3 text-xs leading-5 text-content-muted">
        <p className="font-medium text-content-secondary">Private by design</p>
        <p className="mt-1">
          Chat uses a session-scoped dashboard credential through the same quota, policy, metering,
          and receipt pipeline as your API calls.
        </p>
      </div>
    </aside>
  );
}
