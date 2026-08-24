"use client";

import { RotateCcw } from "lucide-react";
import { useMemo, useState, useSyncExternalStore } from "react";

export interface RecentRequestRow {
  id: string;
  createdAt: string;
  customer?: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  /** USD cost for prompt/input tokens (0 if unpriced). */
  inputCostUsd?: number;
  /** USD cost for completion/output tokens (0 if unpriced). */
  outputCostUsd?: number;
}

interface RecentRequestsTableProps {
  rows: RecentRequestRow[];
  /** Platform-wide views show the customer; subscriber dashboards omit it. */
  showCustomer?: boolean;
}

const ROW_OPTIONS = [10, 25, 50, 100] as const;
const subscribe = () => () => undefined;

function useHydrated(): boolean {
  return useSyncExternalStore(subscribe, () => true, () => false);
}

function localDateKey(iso: string): string {
  const date = new Date(iso);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value === 0) return "$0.000000";
  if (value < 0.000001) return "<$0.000001";
  return `$${value.toFixed(6)}`;
}

function LocalTime({ iso }: { iso: string }) {
  const hydrated = useHydrated();
  if (!hydrated) return <span className="text-content-muted">—</span>;

  const date = new Date(iso);
  return (
    <time dateTime={iso} title={date.toISOString()}>
      {new Intl.DateTimeFormat(undefined, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
        timeZoneName: "shortOffset",
      }).format(date)}
    </time>
  );
}

export function RecentRequestsTable({
  rows,
  showCustomer = false,
}: RecentRequestsTableProps) {
  const hydrated = useHydrated();
  const [rowLimit, setRowLimit] = useState(10);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [minTokens, setMinTokens] = useState("");
  const [maxTokens, setMaxTokens] = useState("");

  const filteredRows = useMemo(() => {
    const minimum = minTokens === "" ? null : Number(minTokens);
    const maximum = maxTokens === "" ? null : Number(maxTokens);

    return rows.filter((row) => {
      const dateKey = localDateKey(row.createdAt);
      const tokens = row.promptTokens + row.completionTokens;
      if (dateFrom && dateKey < dateFrom) return false;
      if (dateTo && dateKey > dateTo) return false;
      if (minimum !== null && Number.isFinite(minimum) && tokens < minimum) return false;
      if (maximum !== null && Number.isFinite(maximum) && tokens > maximum) return false;
      return true;
    });
  }, [dateFrom, dateTo, maxTokens, minTokens, rows]);

  const visibleRows = filteredRows.slice(0, rowLimit);
  const hasFilters = Boolean(dateFrom || dateTo || minTokens || maxTokens || rowLimit !== 10);
  const timeZone = hydrated
    ? Intl.DateTimeFormat().resolvedOptions().timeZone || "Browser local"
    : "Browser local";

  const modelCostSummary = useMemo(() => {
    const byModel = new Map<
      string,
      {
        model: string;
        requests: number;
        promptTokens: number;
        completionTokens: number;
        inputCostUsd: number;
        outputCostUsd: number;
      }
    >();
    for (const row of filteredRows) {
      const entry = byModel.get(row.model) ?? {
        model: row.model,
        requests: 0,
        promptTokens: 0,
        completionTokens: 0,
        inputCostUsd: 0,
        outputCostUsd: 0,
      };
      entry.requests += 1;
      entry.promptTokens += row.promptTokens;
      entry.completionTokens += row.completionTokens;
      entry.inputCostUsd += row.inputCostUsd ?? 0;
      entry.outputCostUsd += row.outputCostUsd ?? 0;
      byModel.set(row.model, entry);
    }
    return [...byModel.values()].sort(
      (a, b) => b.inputCostUsd + b.outputCostUsd - (a.inputCostUsd + a.outputCostUsd),
    );
  }, [filteredRows]);

  const filteredTotalCostUsd = modelCostSummary.reduce(
    (sum, row) => sum + row.inputCostUsd + row.outputCostUsd,
    0,
  );

  function resetFilters() {
    setRowLimit(10);
    setDateFrom("");
    setDateTo("");
    setMinTokens("");
    setMaxTokens("");
  }

  return (
    <>
      <div className="grid gap-3 border-b border-line bg-surface-2/50 px-4 py-3 sm:grid-cols-2 sm:px-5 lg:grid-cols-6">
        <label>
          <span className="field-label">Rows</span>
          <select
            className="input"
            value={rowLimit}
            onChange={(event) => setRowLimit(Number(event.target.value))}
          >
            {ROW_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span className="field-label">Date from</span>
          <input
            className="input"
            type="date"
            value={dateFrom}
            max={dateTo || undefined}
            onChange={(event) => setDateFrom(event.target.value)}
          />
        </label>

        <label>
          <span className="field-label">Date to</span>
          <input
            className="input"
            type="date"
            value={dateTo}
            min={dateFrom || undefined}
            onChange={(event) => setDateTo(event.target.value)}
          />
        </label>

        <label>
          <span className="field-label">Minimum tokens</span>
          <input
            className="input"
            type="number"
            min="0"
            step="1"
            inputMode="numeric"
            placeholder="Any"
            value={minTokens}
            onChange={(event) => setMinTokens(event.target.value)}
          />
        </label>

        <label>
          <span className="field-label">Maximum tokens</span>
          <input
            className="input"
            type="number"
            min="0"
            step="1"
            inputMode="numeric"
            placeholder="Any"
            value={maxTokens}
            onChange={(event) => setMaxTokens(event.target.value)}
          />
        </label>

        <div className="flex items-end">
          <button
            type="button"
            className="btn-secondary w-full"
            disabled={!hasFilters}
            onClick={resetFilters}
          >
            <RotateCcw className="size-3.5" aria-hidden />
            Reset
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2 text-[11px] text-content-muted sm:px-5">
        <span>
          Showing {visibleRows.length.toLocaleString()} of {filteredRows.length.toLocaleString()} matching
          requests · filtered spend {formatUsd(filteredTotalCostUsd)}
        </span>
        <span className="font-mono">Time zone: {timeZone}</span>
      </div>

      {modelCostSummary.length > 0 ? (
        <div className="border-b border-line px-4 py-3 sm:px-5">
          <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
            <div>
              <p className="text-xs font-semibold tracking-wide text-content-primary uppercase">
                Cost by model
              </p>
              <p className="mt-0.5 text-[11px] text-content-muted">
                Totals for the current filter set (not limited to visible rows)
              </p>
            </div>
            <p className="font-mono text-xs tabular-nums text-content-primary">
              All models {formatUsd(filteredTotalCostUsd)}
            </p>
          </div>
          <div className="table-scroll rounded-lg border border-line">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Model</th>
                  <th className="text-right">Calls</th>
                  <th className="text-right">Input $</th>
                  <th className="text-right">Output $</th>
                  <th className="text-right">Total $</th>
                  <th className="text-right">Share</th>
                </tr>
              </thead>
              <tbody>
                {modelCostSummary.map((row) => {
                  const total = row.inputCostUsd + row.outputCostUsd;
                  const share =
                    filteredTotalCostUsd > 0 ? (total / filteredTotalCostUsd) * 100 : 0;
                  return (
                    <tr key={row.model}>
                      <td>
                        <span className="mono-chip">{row.model}</span>
                      </td>
                      <td className="text-right font-mono tabular-nums">
                        {row.requests.toLocaleString()}
                      </td>
                      <td className="text-right font-mono tabular-nums">
                        {formatUsd(row.inputCostUsd)}
                      </td>
                      <td className="text-right font-mono tabular-nums">
                        {formatUsd(row.outputCostUsd)}
                      </td>
                      <td className="text-right font-mono tabular-nums text-content-primary">
                        {formatUsd(total)}
                      </td>
                      <td className="text-right font-mono text-xs tabular-nums text-content-muted">
                        {share.toFixed(1)}%
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {visibleRows.length === 0 ? (
        <p className="px-5 py-10 text-center text-sm text-content-muted">
          No requests match these filters.
        </p>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Browser time</th>
                {showCustomer && <th>Customer</th>}
                <th>Model</th>
                <th className="text-right">Input</th>
                <th className="text-right">Output</th>
                <th className="text-right">Total tokens</th>
                <th className="text-right">Input $</th>
                <th className="text-right">Output $</th>
                <th className="text-right">Cost $</th>
                <th className="text-right">Latency</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => {
                const inputUsd = row.inputCostUsd ?? 0;
                const outputUsd = row.outputCostUsd ?? 0;
                return (
                  <tr key={row.id}>
                    <td className="whitespace-nowrap font-mono text-xs">
                      <LocalTime iso={row.createdAt} />
                    </td>
                    {showCustomer && (
                      <td className="max-w-52 truncate">{row.customer ?? "—"}</td>
                    )}
                    <td>
                      <span className="mono-chip">{row.model}</span>
                    </td>
                    <td className="text-right font-mono tabular-nums">
                      {row.promptTokens.toLocaleString()}
                    </td>
                    <td className="text-right font-mono tabular-nums">
                      {row.completionTokens.toLocaleString()}
                    </td>
                    <td className="text-right font-mono tabular-nums text-content-primary">
                      {(row.promptTokens + row.completionTokens).toLocaleString()}
                    </td>
                    <td className="whitespace-nowrap text-right font-mono tabular-nums">
                      {formatUsd(inputUsd)}
                    </td>
                    <td className="whitespace-nowrap text-right font-mono tabular-nums">
                      {formatUsd(outputUsd)}
                    </td>
                    <td className="whitespace-nowrap text-right font-mono tabular-nums text-content-primary">
                      {formatUsd(inputUsd + outputUsd)}
                    </td>
                    <td className="whitespace-nowrap text-right font-mono tabular-nums">
                      {row.latencyMs.toLocaleString()} ms
                    </td>
                    <td className="text-right">
                      <a className="btn-ghost text-xs" href={`/requests`}>
                        Debugger
                      </a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
