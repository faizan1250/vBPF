import type { EventEnvelope, GenerateResponse } from "./api.js";

export interface HistoryEntry {
  id: string;
  title: string;
  createdAt: number;
  prompt: string;
  script: string;
  chartType: GenerateResponse["chart_type"];
  explanation: string;
  durationS: number;
  warnings: string[];
  runId: string | null;
  exitReason: string | null;
  eventsSample: EventEnvelope[];
}

const STORAGE_KEY = "vbpf:history:v1";
const MAX_ENTRIES = 50;
const MAX_SAMPLED_EVENTS = 200;

export function sampleEvents(events: EventEnvelope[]): EventEnvelope[] {
  if (events.length <= MAX_SAMPLED_EVENTS) return events;
  const step = events.length / MAX_SAMPLED_EVENTS;
  const out: EventEnvelope[] = [];
  for (let i = 0; i < MAX_SAMPLED_EVENTS; i++) {
    out.push(events[Math.floor(i * step)]!);
  }
  return out;
}

function readAll(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as HistoryEntry[]) : [];
  } catch {
    return [];
  }
}

function writeAll(entries: HistoryEntry[]): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(entries.slice(0, MAX_ENTRIES)),
    );
  } catch {
    /* storage full or unavailable: history is best-effort */
  }
}

export function listHistory(): HistoryEntry[] {
  return readAll();
}

export function saveHistory(entry: HistoryEntry): HistoryEntry[] {
  const entries = [entry, ...readAll()].slice(0, MAX_ENTRIES);
  writeAll(entries);
  return entries;
}

export function deleteHistory(id: string): HistoryEntry[] {
  const entries = readAll().filter((e) => e.id !== id);
  writeAll(entries);
  return entries;
}

export function exportEntry(entry: HistoryEntry): string {
  return JSON.stringify(
    {
      exported_at: new Date().toISOString(),
      prompt: entry.prompt,
      script: entry.script,
      chart_type: entry.chartType,
      explanation: entry.explanation,
      duration_s: entry.durationS,
      warnings: entry.warnings,
      run_id: entry.runId,
      exit_reason: entry.exitReason,
      events_sample: entry.eventsSample,
    },
    null,
    2,
  );
}

export function downloadJson(filename: string, text: string): void {
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
