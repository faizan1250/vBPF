import { useAppStore } from "../store/useAppStore.js";
import { Card, CardBody, CardHeader, CardTitle } from "./ui/card.js";

export function SummaryCard() {
  const summary = useAppStore((s) => s.summary);
  const events = useAppStore((s) => s.events);
  const dropped = useAppStore((s) => s.dropped);
  const runPhase = useAppStore((s) => s.runPhase);

  if (!summary && events.length === 0) return null;

  const rows: Array<[string, string]> = [
    ["Events", String(summary?.events ?? events.length)],
    ["Dropped", String(summary?.dropped ?? dropped)],
    ["Duration", `${summary?.durationS ?? "—"}s`],
    ["Exit", summary?.exitReason ?? runPhase],
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Run summary</CardTitle>
      </CardHeader>
      <CardBody>
        <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
          {rows.map(([label, value]) => (
            <div key={label} className="rounded-md bg-accent/50 px-2 py-1.5">
              <dt className="text-[11px] text-muted-foreground">{label}</dt>
              <dd className="font-mono">{value}</dd>
            </div>
          ))}
        </dl>
      </CardBody>
    </Card>
  );
}
