import { useVirtualizer } from "@tanstack/react-virtual";
import { useMemo, useRef, useState } from "react";

import type { EventEnvelope } from "../lib/api.js";
import { printfText } from "../lib/events.js";
import { useAppStore } from "../store/useAppStore.js";
import { Button } from "./ui/button.js";
import { Input } from "./ui/field.js";

export function EventsView({ events }: { events: EventEnvelope[] }) {
  const eventsPaused = useAppStore((s) => s.eventsPaused);
  const setEventsPaused = useAppStore((s) => s.setEventsPaused);
  const [filter, setFilter] = useState("");
  const parentRef = useRef<HTMLDivElement>(null);

  const rows = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const mapped = events.map((e) => ({ seq: e.seq, ts: e.ts, text: printfText(e.data) }));
    if (needle === "") return mapped;
    return mapped.filter((r) => r.text.toLowerCase().includes(needle));
  }, [events, filter]);

  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 24,
    overscan: 20,
  });

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter events…"
          aria-label="Filter events"
          className="max-w-64"
        />
        <Button
          size="sm"
          intent={eventsPaused ? "primary" : "secondary"}
          onClick={() => setEventsPaused(!eventsPaused)}
          aria-pressed={eventsPaused}
        >
          {eventsPaused ? "Resume" : "Pause"}
        </Button>
        <span className="ml-auto text-xs text-muted-foreground" aria-live="polite">
          {rows.length} events{eventsPaused ? " (paused)" : ""}
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          No events yet. Start a run to stream output here.
        </p>
      ) : (
        <div ref={parentRef} className="h-96 overflow-auto rounded-md border border-border" role="log" aria-label="Live events">
          <div style={{ height: virtual.getTotalSize(), position: "relative" }}>
            {virtual.getVirtualItems().map((item) => {
              const row = rows[item.index]!;
              return (
                <div
                  key={`${row.seq}-${item.index}`}
                  style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${item.start}px)` }}
                  className="flex gap-2 border-b border-border/50 px-2 font-mono text-xs leading-6"
                >
                  <span className="shrink-0 text-muted-foreground">#{row.seq}</span>
                  <span className="whitespace-pre-wrap break-all">{row.text}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
