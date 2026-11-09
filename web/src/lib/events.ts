import type { ChartType, EventEnvelope } from "./api.js";

export type ViewKind = "events" | "bar" | "histogram" | "timeseries" | "table";

export interface HistBucket {
  min: number;
  max: number;
  count: number;
}

export interface SummaryInfo {
  events: number;
  bytes: number;
  dropped: number;
  durationS: number;
  exitReason: string;
}

export function autoView(
  events: EventEnvelope[],
  hint: ChartType | null,
): ViewKind {
  if (hint === "table") return "table";
  if (hint === "events") return "events";
  if (hint === "histogram") return "histogram";
  if (hint === "bar") return "bar";
  if (hint === "timeseries") return "timeseries";
  const kinds = new Set(events.map((e) => e.kind));
  // Prefer the richest structural view present.
  if (kinds.has("hist") || kinds.has("lhist")) return "histogram";
  if (kinds.has("map")) {
    const mapCount = events.filter((e) => e.kind === "map").length;
    if (mapCount >= 3) return "timeseries";
    return "bar";
  }
  if (kinds.has("printf")) return "events";
  return "events";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// Map snapshots look like { "@name": { key: count } } or { key: count }.
export function mapEntries(data: unknown): Array<[string, number]> {
  if (!isRecord(data)) return [];
  const inner = Object.values(data).find((v) => isRecord(v));
  const table = (isRecord(inner) ? inner : data) as Record<string, unknown>;
  const rows: Array<[string, number]> = [];
  for (const [k, v] of Object.entries(table)) {
    if (typeof v === "number" && Number.isFinite(v)) rows.push([k, v]);
  }
  return rows.sort((a, b) => b[1] - a[1]);
}

export function histBuckets(data: unknown): HistBucket[] {
  if (!isRecord(data)) return [];
  const arrays = Object.values(data).filter(Array.isArray);
  const first = arrays[0] as unknown;
  if (!Array.isArray(first)) return [];
  return (first as unknown[]).flatMap((b) => {
    if (!isRecord(b)) return [];
    const { min, max, count } = b as {
      min?: unknown;
      max?: unknown;
      count?: unknown;
    };
    if (
      typeof min !== "number" ||
      typeof max !== "number" ||
      typeof count !== "number"
    )
      return [];
    return [{ min, max, count }];
  });
}

export function bucketLabel(b: HistBucket): string {
  const fmt = (n: number): string =>
    n >= 1_000_000
      ? `${(n / 1_000_000).toFixed(1)}s`
      : n >= 1000
        ? `${(n / 1000).toFixed(1)}k`
        : `${n}`;
  return `${fmt(b.min)}–${fmt(b.max)}`;
}

export function summaryFrom(data: unknown): SummaryInfo | null {
  if (!isRecord(data)) return null;
  const num = (k: string): number =>
    typeof data[k] === "number" ? (data[k] as number) : 0;
  const str = (k: string): string =>
    typeof data[k] === "string" ? (data[k] as string) : "";
  if (
    !("events" in data) &&
    !("exit_reason" in data) &&
    !("exitReason" in data)
  )
    return null;
  return {
    events: num("events"),
    bytes: num("bytes"),
    dropped: num("dropped"),
    durationS: num("duration_s") || num("durationS"),
    exitReason: str("exit_reason") || str("exitReason") || "completed",
  };
}

export interface SeriesPoint {
  t: number;
  [key: string]: number;
}

// Accumulates repeated map snapshots into per-key series. Keeps the top-5
// keys by latest value plus an "other" aggregate; bounded to 1200 points.
export function accumulateSeries(
  snapshots: Array<{ ts: number; rows: Array<[string, number]> }>,
  topN = 5,
): { points: SeriesPoint[]; keys: string[] } {
  const latest = new Map<string, number>();
  for (const snap of snapshots) {
    for (const [k, v] of snap.rows) latest.set(k, v);
  }
  const top = [...latest.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([k]) => k);
  const topSet = new Set(top);
  const capped = snapshots.slice(-1200);
  const t0 = capped.length > 0 ? capped[0]!.ts : 0;
  const points = capped.map((snap) => {
    const point: SeriesPoint = {
      t: Math.max(0, Math.round((snap.ts - t0) / 1000)),
    };
    let other = 0;
    for (const [k, v] of snap.rows) {
      if (topSet.has(k)) point[k] = v;
      else other += v;
    }
    if (capped.length > 0 && other > 0) point["other"] = other;
    return point;
  });
  return { points, keys: [...top, "other"] };
}

export function stderrText(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (isRecord(data) && typeof data["text"] === "string")
    return data["text"] as string;
  if (isRecord(data) && typeof data["message"] === "string")
    return data["message"] as string;
  return null;
}

export function printfText(data: unknown): string {
  if (typeof data === "string") return data;
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}
