import { useMemo } from "react";

import type { EventEnvelope } from "../../lib/api.js";
import { mapEntries } from "../../lib/events.js";

export function TableView({ events }: { events: EventEnvelope[] }) {
  const latest = events.filter((e) => e.kind === "map").at(-1);

  const rows = useMemo(() => {
    if (!latest) return [];
    return mapEntries(latest.data);
  }, [latest]);

  if (!latest) {
    return (
      <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
        No table rows yet. Start a run to collect map snapshots.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <span
        className="text-xs text-muted-foreground"
        aria-live="polite"
      >{`${rows.length} keys (latest snapshot)`}</span>
      <div className="max-h-96 overflow-auto rounded-md border border-border">
        <table className="w-full text-xs" aria-label="Latest map snapshot">
          <thead className="sticky top-0 bg-card">
            <tr className="text-left text-muted-foreground">
              <th className="px-2 py-1 font-medium">Key</th>
              <th className="px-2 py-1 text-right font-medium">Count</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([key, value]) => (
              <tr key={key} className="border-t border-border/50 font-mono">
                <td className="break-all px-2 py-1">{key}</td>
                <td className="px-2 py-1 text-right">{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
