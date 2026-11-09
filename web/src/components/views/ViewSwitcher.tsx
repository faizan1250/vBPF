import { useAppStore } from "../../store/useAppStore.js";
import type { ViewKind } from "../../lib/events.js";
import { Badge } from "../ui/badge.js";
import { Card, CardBody, CardHeader, CardTitle } from "../ui/card.js";
import { BarView } from "./BarView.js";
import { EventsView } from "./EventsView.js";
import { HistogramView } from "./HistogramView.js";
import { TimeseriesView } from "./TimeseriesView.js";

const VIEWS: Array<{ id: ViewKind; label: string }> = [
  { id: "events", label: "Events" },
  { id: "bar", label: "Bar" },
  { id: "histogram", label: "Histogram" },
  { id: "timeseries", label: "Time series" },
  { id: "table", label: "Table" },
];

export function ViewSwitcher({
  autoView,
  hint,
}: {
  autoView: ViewKind;
  hint: string | null;
}) {
  const events = useAppStore((s) => s.events);
  const dropped = useAppStore((s) => s.dropped);
  const viewOverride = useAppStore((s) => s.viewOverride);
  const setViewOverride = useAppStore((s) => s.setViewOverride);

  const active = viewOverride ?? autoView;

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center gap-2">
        <CardTitle>Live view</CardTitle>
        {hint && (
          <Badge tone="info" title="Suggested by the generator">
            {hint}
          </Badge>
        )}
        {dropped > 0 && (
          <Badge tone="warn" role="status">
            {dropped} events dropped
          </Badge>
        )}
        <div
          className="ml-auto flex gap-1"
          role="tablist"
          aria-label="View selector"
        >
          {VIEWS.map((v) => (
            <button
              key={v.id}
              role="tab"
              aria-selected={active === v.id}
              onClick={() => setViewOverride(v.id === autoView ? null : v.id)}
              className={
                active === v.id
                  ? "rounded-md bg-accent px-2 py-1 text-xs font-medium text-accent-foreground"
                  : "rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              }
            >
              {v.label}
            </button>
          ))}
        </div>
      </CardHeader>
      <CardBody>
        {active === "events" && <EventsView events={events} />}
        {active === "bar" && <BarView events={events} />}
        {active === "histogram" && <HistogramView events={events} />}
        {active === "timeseries" && <TimeseriesView events={events} />}
        {active === "table" && <BarView events={events} />}
      </CardBody>
    </Card>
  );
}
