import { useMemo } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { EventEnvelope } from "../../lib/api.js";
import { accumulateSeries, mapEntries } from "../../lib/events.js";

const SERIES_COLORS = [
  "hsl(var(--primary))",
  "#22c55e",
  "#f59e0b",
  "#a78bfa",
  "#ec4899",
  "#64748b",
];

export function TimeseriesView({ events }: { events: EventEnvelope[] }) {
  const { points, keys } = useMemo(() => {
    const snapshots = events
      .filter((e) => e.kind === "map")
      .map((e) => ({ ts: e.ts, rows: mapEntries(e.data) }));
    return accumulateSeries(snapshots, 5);
  }, [events]);

  if (points.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
        No time series yet. Map snapshots accumulate here as a run progresses.
      </p>
    );
  }

  return (
    <div className="h-80 w-full" role="img" aria-label="Time series of top keys">
      <ResponsiveContainer>
        <LineChart data={points} margin={{ left: 8, right: 16 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
          <XAxis dataKey="t" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" label={{ value: "s", position: "insideRight", fontSize: 11 }} />
          <YAxis tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
          <Tooltip
            contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }}
            labelStyle={{ color: "hsl(var(--foreground))" }}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          {keys.map((key, i) => (
            <Line
              key={key}
              type="monotone"
              dataKey={key}
              stroke={SERIES_COLORS[i % SERIES_COLORS.length]}
              dot={false}
              strokeWidth={2}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
