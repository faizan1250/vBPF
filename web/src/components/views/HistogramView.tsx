import { useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { EventEnvelope } from "../../lib/api.js";
import { bucketLabel, histBuckets } from "../../lib/events.js";

export function HistogramView({ events }: { events: EventEnvelope[] }) {
  const [logScale, setLogScale] = useState(false);
  const latest = events
    .filter((e) => e.kind === "hist" || e.kind === "lhist")
    .at(-1);

  const rows = useMemo(() => {
    if (!latest) return [];
    return histBuckets(latest.data).map((b) => ({
      bucket: bucketLabel(b),
      count: b.count,
    }));
  }, [latest]);

  if (!latest) {
    return (
      <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
        No histogram snapshots yet. Start a run to see bucketed latency.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          checked={logScale}
          onChange={(e) => setLogScale(e.target.checked)}
          className="size-4 accent-sky-500"
        />
        Log scale
      </label>
      <div
        className="h-80 w-full"
        role="img"
        aria-label="Histogram of bucketed values"
      >
        <ResponsiveContainer>
          <BarChart data={rows} margin={{ left: 8, right: 16 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis
              dataKey="bucket"
              tick={{ fontSize: 11 }}
              stroke="hsl(var(--muted-foreground))"
              interval="preserveStartEnd"
            />
            <YAxis
              scale={logScale ? "log" : "linear"}
              domain={logScale ? ["auto", "auto"] : [0, "auto"]}
              allowDataOverflow={logScale}
              tick={{ fontSize: 11 }}
              stroke="hsl(var(--muted-foreground))"
            />
            <Tooltip
              contentStyle={{
                background: "hsl(var(--card))",
                border: "1px solid hsl(var(--border))",
              }}
              labelStyle={{ color: "hsl(var(--foreground))" }}
            />
            <Bar dataKey="count" fill="hsl(var(--primary))" />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
