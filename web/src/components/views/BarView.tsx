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
import { mapEntries } from "../../lib/events.js";
import { Select } from "../ui/field.js";

const TOP_OPTIONS = [5, 10, 25] as const;

export function BarView({ events }: { events: EventEnvelope[] }) {
  const [topN, setTopN] = useState<number>(10);
  const latest = events.filter((e) => e.kind === "map").at(-1);

  const rows = useMemo(() => {
    if (!latest) return [];
    return mapEntries(latest.data)
      .slice(0, topN)
      .map(([name, value]) => ({
        name: name.length > 18 ? `${name.slice(0, 17)}…` : name,
        full: name,
        value,
      }));
  }, [latest, topN]);

  if (!latest) {
    return (
      <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
        No map snapshots yet. Start a run to see aggregated counts.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <label htmlFor="bar-topn" className="text-xs text-muted-foreground">
          Top
        </label>
        <Select
          id="bar-topn"
          value={topN}
          onChange={(e) => setTopN(Number(e.target.value))}
          className="w-24"
        >
          {TOP_OPTIONS.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </Select>
      </div>
      <div
        className="h-80 w-full"
        role="img"
        aria-label="Bar chart of latest map snapshot"
      >
        <ResponsiveContainer>
          <BarChart
            data={rows}
            layout="vertical"
            margin={{ left: 8, right: 16 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis
              type="number"
              tick={{ fontSize: 11 }}
              stroke="hsl(var(--muted-foreground))"
            />
            <YAxis
              type="category"
              dataKey="name"
              width={140}
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
            <Bar dataKey="value" fill="hsl(var(--primary))" />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-muted-foreground">
            <th className="py-1 pr-2 font-medium">Key</th>
            <th className="py-1 text-right font-medium">Count</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.full} className="border-t border-border/50 font-mono">
              <td className="py-1 pr-2">{r.full}</td>
              <td className="py-1 text-right">{r.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
