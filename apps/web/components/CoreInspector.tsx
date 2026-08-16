"use client";

import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  BrainCircuit,
  CheckCircle2,
  Circle,
  Cpu,
  Database,
  Eye,
  Gauge,
  Network,
  Play,
  Radio,
  ShieldCheck,
  Square,
  Timer,
  Workflow,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Panel, PanelBody, PanelHeader } from "@/components/ui/Panel";
import { useToast } from "@/components/ui/Toast";
import {
  armCoreInspectorAction,
  cancelCoreInspectorAction,
} from "@/app/(customer)/core-inspector/actions";

type JsonRecord = Record<string, unknown>;

export interface CoreTraceView {
  id: string;
  status: string;
  expiresAt: string;
  startedAt: string | null;
  completedAt: string | null;
  summary: JsonRecord | null;
  request: {
    id: string;
    status: string;
    resolvedModelSlug: string | null;
    promptTokens: number;
    completionTokens: number;
    latencyMs: number;
  } | null;
  events: Array<{
    sequence: number;
    phase: string;
    kind: string;
    atMs: number;
    payload: JsonRecord | null;
  }>;
}

const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED", "EXPIRED"]);

const PIPELINE = [
  { phase: "ingress", label: "Ingress", icon: Radio },
  { phase: "admission", label: "Admission", icon: ShieldCheck },
  { phase: "routing", label: "Policy + route", icon: Workflow },
  { phase: "runtime", label: "Runtime", icon: Cpu },
  { phase: "generation", label: "Generation", icon: BrainCircuit },
  { phase: "complete", label: "Meter + receipt", icon: Database },
];

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function CoreInspector({ initialTrace }: { initialTrace: CoreTraceView | null }) {
  const toast = useToast();
  const [trace, setTrace] = useState(initialTrace);
  const [arming, setArming] = useState(false);
  const active = trace?.status === "ARMED" || trace?.status === "CAPTURING";

  const refresh = useCallback(async (id: string) => {
    const response = await fetch(`/api/core-inspector/${id}`, { cache: "no-store" });
    if (!response.ok) return;
    setTrace((await response.json()) as CoreTraceView);
  }, []);

  useEffect(() => {
    if (!trace || TERMINAL.has(trace.status)) return;
    const handle = window.setInterval(() => void refresh(trace.id), 700);
    return () => window.clearInterval(handle);
  }, [trace, refresh]);

  async function arm() {
    setArming(true);
    const result = await armCoreInspectorAction();
    setArming(false);
    if (!result.ok) {
      toast.push({ tone: "danger", title: "Could not arm inspector", description: result.message });
      return;
    }
    const next: CoreTraceView = {
      id: result.traceId,
      status: "ARMED",
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      startedAt: null,
      completedAt: null,
      summary: null,
      request: null,
      events: [],
    };
    setTrace(next);
    toast.push({
      tone: "info",
      title: "Core Inspector armed",
      description: "The next inference request will be captured. It disarms automatically after one call.",
      duration: 6000,
    });
  }

  async function cancel() {
    if (!trace || trace.status !== "ARMED") return;
    const result = await cancelCoreInspectorAction(trace.id);
    if (result.ok) {
      setTrace({ ...trace, status: "CANCELLED" });
      toast.push({ tone: "info", title: "Core Inspector deactivated" });
    }
  }

  const ingress = asRecord(trace?.events.find((event) => event.phase === "ingress")?.payload);
  const routing = asRecord(trace?.events.find((event) => event.kind === "model.resolved")?.payload);
  const model = asRecord(routing.model);
  const generationEvents = trace?.events.filter((event) => event.phase === "generation") ?? [];
  const summary = asRecord(trace?.summary);
  const maxAtMs = Math.max(1, ...(trace?.events.map((event) => event.atMs) ?? [1]));

  const statusTone =
    trace?.status === "COMPLETED"
      ? "ok"
      : trace?.status === "FAILED"
        ? "danger"
        : active
          ? "info"
          : "neutral";

  return (
    <div className="space-y-4 sm:space-y-6">
      <Panel className={active ? "border-brand-200 shadow-[0_0_0_3px_rgba(99,102,241,0.06)]" : ""}>
        <PanelBody className="flex flex-col gap-5 sm:flex-row sm:items-center">
          <div
            className={`grid size-12 shrink-0 place-items-center rounded-2xl border ${
              active
                ? "border-brand-200 bg-brand-50 text-brand-600"
                : "border-line-strong bg-surface-2 text-content-muted"
            }`}
          >
            {trace?.status === "CAPTURING" ? (
              <Activity className="size-5 animate-pulse" aria-hidden />
            ) : (
              <BrainCircuit className="size-5" aria-hidden />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold tracking-tight text-content-primary">
                Diagnostic capture
              </h2>
              <Badge tone={statusTone} dot pulse={active}>
                {trace?.status ?? "OFF"}
              </Badge>
            </div>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-content-muted">
              Disabled during normal operation. When armed, exactly one request records privacy-safe
              pipeline events, then tracing turns itself off. Prompt and response text are never stored.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {trace?.status === "ARMED" ? (
              <button type="button" className="btn-secondary" onClick={() => void cancel()}>
                <Square className="size-3.5" aria-hidden />
                Deactivate
              </button>
            ) : (
              <button type="button" className="btn" onClick={() => void arm()} disabled={arming || trace?.status === "CAPTURING"}>
                <Play className="size-3.5" aria-hidden />
                {arming ? "Arming…" : trace?.status === "CAPTURING" ? "Capturing…" : "Capture next call"}
              </button>
            )}
          </div>
        </PanelBody>
        {active && (
          <div className="h-1 overflow-hidden bg-brand-50">
            <div className="h-full w-1/3 animate-[progress-stripes_0.8s_linear_infinite] bg-brand-500 progress-stripes" />
          </div>
        )}
      </Panel>

      {!trace || trace.events.length === 0 ? (
        <InspectorEmpty armed={trace?.status === "ARMED"} />
      ) : (
        <>
          <Panel>
            <PanelHeader
              title="Live inference pipeline"
              description="Observed control-plane and runtime boundaries for this request"
              actions={
                trace.request ? (
                  <Link href={`/requests/${trace.request.id}`} className="btn-ghost text-xs">
                    Request debugger
                  </Link>
                ) : null
              }
            />
            <PanelBody>
              <div className="grid gap-2 sm:grid-cols-3 xl:grid-cols-6">
                {PIPELINE.map((step, index) => {
                  const event = trace.events.find((candidate) => candidate.phase === step.phase);
                  const reached = Boolean(event);
                  const Icon = step.icon;
                  return (
                    <div key={step.phase} className="relative">
                      {index > 0 && (
                        <span className="absolute -left-2 top-6 hidden h-px w-2 bg-line-strong xl:block" />
                      )}
                      <div
                        className={`rounded-xl border p-3 transition-colors ${
                          reached ? "border-brand-200 bg-brand-50/70" : "border-line bg-surface-2/60"
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span
                            className={`grid size-7 place-items-center rounded-lg ${
                              reached ? "bg-brand-100 text-brand-700" : "bg-surface-3 text-content-muted"
                            }`}
                          >
                            <Icon className="size-3.5" aria-hidden />
                          </span>
                          {reached ? (
                            <CheckCircle2 className="size-3.5 text-ok-600" aria-hidden />
                          ) : (
                            <Circle className="size-3.5 text-content-muted" aria-hidden />
                          )}
                        </div>
                        <p className="mt-3 text-xs font-medium text-content-primary">{step.label}</p>
                        <p className="mt-0.5 font-mono text-[10px] text-content-muted">
                          {event ? `+${event.atMs.toLocaleString()} ms` : "waiting"}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </PanelBody>
          </Panel>

          <div className="grid gap-4 xl:grid-cols-3">
            <Panel className="xl:col-span-2">
              <PanelHeader
                title="Model execution path"
                description="The computation stages that participate in each generated token"
              />
              <PanelBody>
                <ArchitectureFlow model={model} resolvedModel={stringValue(routing.resolvedModel)} />
              </PanelBody>
            </Panel>

            <Panel>
              <PanelHeader title="Request interpretation" />
              <PanelBody className="space-y-3">
                <Metric label="Messages" value={numberValue(ingress.messageCount)} />
                <Metric label="Prompt characters" value={numberValue(ingress.promptCharacters).toLocaleString()} />
                <Metric
                  label="Estimated prompt tokens"
                  value={numberValue(ingress.estimatedPromptTokens).toLocaleString()}
                />
                <Metric label="Max output" value={numberValue(ingress.maxOutputTokens).toLocaleString()} />
                <div className="border-t border-line pt-3">
                  <p className="text-[11px] font-medium uppercase tracking-wide text-content-muted">
                    Message roles
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {(Array.isArray(ingress.roles) ? ingress.roles : []).map((role, index) => (
                      <span key={`${String(role)}-${index}`} className="mono-chip">
                        {String(role)}
                      </span>
                    ))}
                  </div>
                </div>
                <p className="rounded-lg border border-ok-100 bg-ok-50 px-3 py-2 text-xs leading-5 text-ok-700">
                  Content capture is off. Only counts, roles, settings, and timing are retained.
                </p>
              </PanelBody>
            </Panel>
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <Panel>
              <PanelHeader title="Token generation activity" description="Batched stream activity; no generated text stored" />
              <PanelBody>
                {generationEvents.length === 0 ? (
                  <p className="text-sm text-content-muted">Waiting for the first generated token…</p>
                ) : (
                  <div className="space-y-2">
                    {generationEvents.slice(-20).map((event) => {
                      const payload = asRecord(event.payload);
                      return (
                        <div key={event.sequence} className="grid grid-cols-[5rem_1fr_4rem] items-center gap-2">
                          <span className="font-mono text-[10px] text-content-muted">
                            +{event.atMs} ms
                          </span>
                          <div className="h-2 overflow-hidden rounded-full bg-surface-3">
                            <div
                              className="h-full rounded-full bg-gradient-to-r from-brand-500 to-signal-500"
                              style={{
                                width: `${Math.max(4, Math.min(100, (event.atMs / maxAtMs) * 100))}%`,
                              }}
                            />
                          </div>
                          <span className="text-right font-mono text-[10px] text-content-secondary">
                            ~{numberValue(payload.approximateTokens) || (event.kind === "token.first" ? 1 : 0)} tok
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </PanelBody>
            </Panel>

            <Panel>
              <PanelHeader title="Observed performance" />
              <PanelBody className="grid gap-3 sm:grid-cols-2">
                <PerformanceTile icon={Timer} label="First token" value={`${numberValue(summary.ttftMs) || "—"} ms`} />
                <PerformanceTile icon={Gauge} label="End-to-end" value={`${numberValue(summary.latencyMs) || "—"} ms`} />
                <PerformanceTile icon={Network} label="Prompt tokens" value={numberValue(summary.promptTokens).toLocaleString()} />
                <PerformanceTile icon={Activity} label="Output tokens" value={numberValue(summary.completionTokens).toLocaleString()} />
              </PanelBody>
            </Panel>
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <CapabilityCard
              icon={Workflow}
              title="Mixture-of-Experts routing"
              available={Boolean(asRecord(summary.expertRouting).available)}
              explanation={
                stringValue(asRecord(summary.expertRouting).reason) ||
                "Available only when a runtime adapter exposes router decisions."
              }
            />
            <CapabilityCard
              icon={Eye}
              title="Attention and layer activations"
              available={Boolean(asRecord(summary.attentionMaps).available)}
              explanation={
                stringValue(asRecord(summary.attentionMaps).reason) ||
                "Requires a separately instrumented debug runtime."
              }
            />
          </div>
        </>
      )}
    </div>
  );
}

function InspectorEmpty({ armed }: { armed: boolean }) {
  return (
    <Panel>
      <PanelBody className="flex min-h-72 flex-col items-center justify-center text-center">
        <span className={`grid size-14 place-items-center rounded-2xl border ${armed ? "border-brand-200 bg-brand-50 text-brand-600" : "border-line-strong bg-surface-2 text-content-muted"}`}>
          {armed ? <Radio className="size-6 animate-pulse" aria-hidden /> : <BrainCircuit className="size-6" aria-hidden />}
        </span>
        <h3 className="mt-4 text-base font-semibold text-content-primary">
          {armed ? "Waiting for the next LLM call" : "Inspector is inactive"}
        </h3>
        <p className="mt-2 max-w-lg text-sm leading-6 text-content-muted">
          {armed
            ? "Send a request from Chat or through the OpenAI-compatible API. This session will claim that request and deactivate automatically."
            : "Normal inference runs without diagnostic event writes. Activate a one-shot capture when you need to see the execution path."}
        </p>
      </PanelBody>
    </Panel>
  );
}

function ArchitectureFlow({ model, resolvedModel }: { model: JsonRecord; resolvedModel: string }) {
  const stages = useMemo(
    () => [
      { title: "Token embedding", subtitle: "IDs → vectors" },
      { title: "Attention blocks", subtitle: "Context + KV cache" },
      { title: "Feed-forward blocks", subtitle: "Dense weight transforms" },
      { title: "Normalization", subtitle: "Residual stream" },
      { title: "LM head", subtitle: "Logits → sampler" },
    ],
    [],
  );

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge tone="info">{resolvedModel || "resolving model"}</Badge>
        {Boolean(model.quantization) && <Badge tone="neutral">{String(model.quantization)}</Badge>}
        {Boolean(model.contextLength) && <Badge tone="neutral">{Number(model.contextLength).toLocaleString()} context</Badge>}
        {Boolean(model.threads) && <Badge tone="neutral">{String(model.threads)} CPU threads</Badge>}
      </div>
      <div className="mt-5 grid gap-2 sm:grid-cols-5">
        {stages.map((stage, index) => (
          <div key={stage.title} className="relative">
            {index > 0 && (
              <span className="absolute -left-2 top-1/2 hidden h-px w-2 bg-brand-300 sm:block" />
            )}
            <div className="h-full rounded-xl border border-brand-100 bg-gradient-to-b from-brand-50 to-surface-1 p-3">
              <p className="text-xs font-medium text-content-primary">{stage.title}</p>
              <p className="mt-1 text-[10px] leading-4 text-content-muted">{stage.subtitle}</p>
              <div className="mt-3 flex gap-1">
                {[0, 1, 2, 3].map((bar) => (
                  <span
                    key={bar}
                    className="h-1 flex-1 animate-pulse rounded-full bg-brand-300"
                    style={{ animationDelay: `${bar * 100}ms` }}
                  />
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>
      <p className="mt-4 text-xs leading-5 text-content-muted">
        This is the verified execution structure, not a claim that individual weights contain human-readable
        concepts. Dense models engage their transformer blocks for every token; exact tensors are not exported.
      </p>
    </>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="text-content-muted">{label}</span>
      <span className="font-mono tabular-nums text-content-primary">{value}</span>
    </div>
  );
}

function PerformanceTile({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Timer;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-xl border border-line bg-surface-2/60 p-3">
      <Icon className="size-4 text-brand-600" aria-hidden />
      <p className="mt-3 text-[11px] uppercase tracking-wide text-content-muted">{label}</p>
      <p className="mt-1 font-mono text-lg font-semibold tabular-nums text-content-primary">{value}</p>
    </div>
  );
}

function CapabilityCard({
  icon: Icon,
  title,
  available,
  explanation,
}: {
  icon: typeof Workflow;
  title: string;
  available: boolean;
  explanation: string;
}) {
  return (
    <Panel>
      <PanelBody className="flex gap-3">
        <span className={`grid size-10 shrink-0 place-items-center rounded-xl border ${available ? "border-ok-200 bg-ok-50 text-ok-600" : "border-warn-200 bg-warn-50 text-warn-600"}`}>
          {available ? <Icon className="size-5" aria-hidden /> : <AlertTriangle className="size-5" aria-hidden />}
        </span>
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-content-primary">{title}</h3>
            <Badge tone={available ? "ok" : "warn"}>{available ? "available" : "adapter unavailable"}</Badge>
          </div>
          <p className="mt-1 text-xs leading-5 text-content-muted">{explanation}</p>
        </div>
      </PanelBody>
    </Panel>
  );
}
