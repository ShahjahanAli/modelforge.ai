"use client";

import { useEffect } from "react";
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
  const {
    model,
    setModel,
    knowledgeBases,
    knowledgeBaseId,
    setKnowledgeBaseId,
    maxTokens,
    setMaxTokens,
    temperature,
    setTemperature,
    streaming,
  } = chat;
  const inline = layout === "inline";
  const ragOn = knowledgeBaseId !== "off" && knowledgeBases.length > 0;

  useEffect(() => {
    if (model !== "auto" && !models.some((option) => option.id === model)) {
      setModel("auto");
    }
  }, [model, models, setModel]);

  const modelSelect = (
    <label className="block">
      <span className="field-label">Model</span>
      <select
        className="input"
        value={model}
        onChange={(event) => setModel(event.target.value)}
        disabled={streaming}
      >
        <option value="auto">Auto route</option>
        {models.map((option) => (
          <option key={option.id} value={option.id}>
            {option.name}
          </option>
        ))}
      </select>
      {models.length === 0 ? (
        <span className="mt-1.5 block text-[11px] leading-4 text-content-muted">
          Only loaded models are listed. Load one on Infrastructure, or keep Auto route.
        </span>
      ) : null}
    </label>
  );

  const knowledgeSelect = (
    <label className="block">
      <span className="field-label">Knowledge base</span>
      <select
        className="input"
        value={knowledgeBases.length === 0 ? "off" : knowledgeBaseId}
        onChange={(event) => setKnowledgeBaseId(event.target.value)}
        disabled={streaming || knowledgeBases.length === 0}
      >
        {knowledgeBases.length === 0 ? (
          <option value="off">None ingested yet</option>
        ) : (
          <>
            <option value="all">All knowledge bases</option>
            {knowledgeBases.map((base) => (
              <option key={base.id} value={base.id}>
                {base.name} ({base.documentCount})
              </option>
            ))}
            <option value="off">Off — ungrounded chat</option>
          </>
        )}
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
      <div className="grid gap-3 border-b border-line bg-surface-2/60 p-3 @min-[22rem]:grid-cols-2">
        {modelSelect}
        {knowledgeSelect}
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
        {knowledgeSelect}
        {tokenSelect}
        {temperatureControl}
      </div>

      <div className="mt-6 rounded-xl border border-line bg-surface-1 p-3 text-xs leading-5 text-content-muted">
        <p className="font-medium text-content-secondary">
          {ragOn ? "Answering from your knowledge base" : "Private by design"}
        </p>
        <p className="mt-1">
          {ragOn
            ? "Chat retrieves matching passages first and the model may only use those passages. Add documents on Knowledge."
            : "Turn on a knowledge base to ground answers in your documents. Chat still uses the same quota, policy, and receipt pipeline as your API calls."}
        </p>
      </div>
    </aside>
  );
}
