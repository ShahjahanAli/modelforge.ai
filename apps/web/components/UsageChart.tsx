"use client";

import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  type TooltipProps,
} from "recharts";

export interface UsagePoint {
  day: string;
  prompt: number;
  completion: number;
}

const axisStyle = {
  fill: "#667085",
  fontSize: 11,
  fontFamily: "var(--font-mono-code), monospace",
};

function ChartTooltip({ active, payload, label }: TooltipProps<number, string>) {
  if (!active || !payload?.length) return null;
  const total = payload.reduce((sum, item) => sum + (item.value ?? 0), 0);

  return (
    <div className="rounded-lg border border-line-strong bg-surface-1 px-3 py-2 shadow-lg">
      <p className="mb-1.5 font-mono text-[11px] text-content-muted">{label}</p>
      {payload.map((item) => (
        <p key={item.name} className="flex items-center gap-2 text-xs">
          <span className="size-1.5 rounded-full" style={{ background: item.color }} />
          <span className="capitalize text-content-secondary">{item.name}</span>
          <span className="ml-auto pl-3 font-mono tabular-nums text-content-primary">
            {(item.value ?? 0).toLocaleString()}
          </span>
        </p>
      ))}
      <p className="mt-1.5 flex items-center gap-2 border-t border-line pt-1.5 text-xs">
        <span className="text-content-secondary">Total</span>
        <span className="ml-auto pl-3 font-mono tabular-nums text-content-primary">
          {total.toLocaleString()}
        </span>
      </p>
    </div>
  );
}

export function UsageChart({ data }: { data: UsagePoint[] }) {
  return (
    <div className="h-56 w-full sm:h-64 lg:h-72">
      <ResponsiveContainer>
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
          <defs>
            <linearGradient id="fillPrompt" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#06b6d4" stopOpacity={0.32} />
              <stop offset="100%" stopColor="#06b6d4" stopOpacity={0.02} />
            </linearGradient>
            <linearGradient id="fillCompletion" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#6366f1" stopOpacity={0.34} />
              <stop offset="100%" stopColor="#6366f1" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="#e4e7ec" vertical={false} />
          <XAxis
            dataKey="day"
            tick={axisStyle}
            tickLine={false}
            axisLine={{ stroke: "#e4e7ec" }}
            interval="preserveStartEnd"
            minTickGap={16}
            tickFormatter={(value: string) => value.slice(5)}
          />
          <YAxis
            tick={axisStyle}
            tickLine={false}
            axisLine={false}
            width={52}
            tickFormatter={(value: number) =>
              value >= 1000 ? `${(value / 1000).toFixed(0)}k` : String(value)
            }
          />
          <Tooltip content={<ChartTooltip />} cursor={{ stroke: "#d0d5dd" }} />
          <Area
            type="monotone"
            dataKey="prompt"
            name="prompt"
            stackId="tokens"
            stroke="#0891b2"
            strokeWidth={1.5}
            fill="url(#fillPrompt)"
          />
          <Area
            type="monotone"
            dataKey="completion"
            name="completion"
            stackId="tokens"
            stroke="#4f46e5"
            strokeWidth={1.5}
            fill="url(#fillCompletion)"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
