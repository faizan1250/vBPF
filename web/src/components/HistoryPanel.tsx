import { useEffect, useState } from "react";
import { Download, History, RotateCcw, Trash2 } from "lucide-react";

import type { HistoryEntry } from "../lib/history.js";
import {
  deleteHistory,
  downloadJson,
  exportEntry,
  listHistory,
  sampleEvents,
  saveHistory,
} from "../lib/history.js";
import { useAppStore } from "../store/useAppStore.js";
import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import { Card, CardBody, CardHeader, CardTitle } from "./ui/card.js";

// UI-local session history. The backend exposes no sessions/export routes,
// so entries persist in localStorage and export as a JSON download.
export function HistoryPanel() {
  const historyVersion = useAppStore((s) => s.historyVersion);
  const [entries, setEntries] = useState<HistoryEntry[]>([]);

  useEffect(() => {
    setEntries(listHistory());
  }, [historyVersion]);

  const setScript = useAppStore((s) => s.setScript);
  const setPrompt = useAppStore((s) => s.setPrompt);
  const setDuration = useAppStore((s) => s.setDuration);

  if (entries.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>History</CardTitle>
        </CardHeader>
        <CardBody>
          <p className="text-sm text-muted-foreground">
            Past generations and runs land here (stored in this browser only).
          </p>
        </CardBody>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>History</CardTitle>
      </CardHeader>
      <CardBody className="flex flex-col gap-2">
        {entries.map((entry) => (
          <div key={entry.id} className="rounded-md border border-border p-2">
            <div className="flex items-center gap-2">
              <History aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
              <p className="truncate text-xs font-medium" title={entry.prompt}>
                {entry.title}
              </p>
              {entry.runId ? (
                <Badge tone="ok">ran</Badge>
              ) : (
                <Badge tone="neutral">draft</Badge>
              )}
            </div>
            <div className="mt-1.5 flex gap-1.5">
              <Button
                size="sm"
                intent="ghost"
                aria-label={`Re-run ${entry.title}`}
                onClick={() => {
                  setPrompt(entry.prompt);
                  setScript(entry.script);
                  setDuration(entry.durationS);
                  window.scrollTo({ top: 0 });
                }}
              >
                <RotateCcw aria-hidden /> Re-run
              </Button>
              <Button
                size="sm"
                intent="ghost"
                aria-label={`Export ${entry.title}`}
                onClick={() => downloadJson(`vbpf-${entry.id}.json`, exportEntry(entry))}
              >
                <Download aria-hidden /> Export
              </Button>
              <Button
                size="sm"
                intent="ghost"
                aria-label={`Delete ${entry.title}`}
                onClick={() => setEntries(deleteHistory(entry.id))}
              >
                <Trash2 aria-hidden />
              </Button>
            </div>
          </div>
        ))}
        <p className="text-[11px] text-muted-foreground">
          Browser-local only; the API has no session store. Export to keep a run.
        </p>
      </CardBody>
    </Card>
  );
}

export function recordRunToHistory(): void {
  const s = useAppStore.getState();
  if (!s.generation && s.script.trim() === "") return;
  saveHistory({
    id: `${Date.now()}`,
    title: s.prompt.trim().slice(0, 80) || s.script.split("\n")[0]!.slice(0, 80) || "untitled run",
    createdAt: Date.now(),
    prompt: s.prompt,
    script: s.script,
    chartType: s.generation?.chart_type ?? "bar",
    explanation: s.generation?.explanation ?? "",
    durationS: s.durationS,
    warnings: s.generation?.warnings ?? [],
    runId: s.runId,
    exitReason: s.summary?.exitReason ?? null,
    eventsSample: sampleEvents(s.events),
  });
  s.bumpHistory();
}
