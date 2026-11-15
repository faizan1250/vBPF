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
import {
  fetchSession,
  fetchSessionExport,
  fetchSessions,
  fixtureMode,
  type SessionSummary,
} from "../lib/api.js";
import { useAppStore } from "../store/useAppStore.js";
import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import { Card, CardBody, CardHeader, CardTitle } from "./ui/card.js";

// Server-first history. The panel lists server-side sessions when the
// backend is reachable and falls back to browser-local entries otherwise
// (fixture mode is always local: the network is bypassed there). Local
// entries stay as the offline record; the server persists the same trail
// via /api/generate and /api/runs.
export function HistoryPanel() {
  const historyVersion = useAppStore((s) => s.historyVersion);
  const [localEntries, setLocalEntries] = useState<HistoryEntry[]>([]);
  const [serverSessions, setServerSessions] = useState<SessionSummary[] | null>(
    null,
  );
  const [serverFailed, setServerFailed] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const setScript = useAppStore((s) => s.setScript);
  const setPrompt = useAppStore((s) => s.setPrompt);
  const setDuration = useAppStore((s) => s.setDuration);

  useEffect(() => {
    setLocalEntries(listHistory());
    if (fixtureMode()) return;
    let cancelled = false;
    setServerFailed(false);
    fetchSessions()
      .then((res) => {
        if (!cancelled) setServerSessions(res.sessions);
      })
      .catch(() => {
        if (!cancelled) {
          setServerSessions(null);
          setServerFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [historyVersion]);

  async function loadSession(id: string): Promise<void> {
    setActionError(null);
    try {
      const detail = await fetchSession(id);
      const latest = detail.generations[detail.generations.length - 1];
      if (latest === undefined) {
        setActionError("Session has no generations to load.");
        return;
      }
      setPrompt(latest.prompt);
      setScript(latest.script);
      setDuration(latest.duration_s ?? 10);
      window.scrollTo({ top: 0 });
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : "Failed to load session.",
      );
    }
  }

  async function exportSession(id: string): Promise<void> {
    setActionError(null);
    try {
      const payload = await fetchSessionExport(id);
      downloadJson(`vbpf-session-${id}.json`, JSON.stringify(payload, null, 2));
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : "Failed to export session.",
      );
    }
  }

  if (fixtureMode() || (serverFailed && serverSessions === null)) {
    return (
      <LocalHistoryCard
        entries={localEntries}
        onDelete={(id) => setLocalEntries(deleteHistory(id))}
        footnote={
          fixtureMode()
            ? "Past generations and runs land here (stored in this browser only)."
            : "Server history unavailable; showing browser-local entries."
        }
      />
    );
  }

  if (serverSessions === null) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>History</CardTitle>
        </CardHeader>
        <CardBody>
          <p className="text-sm text-muted-foreground">Loading history…</p>
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
        {actionError && (
          <p role="alert" className="text-xs text-red-400">
            {actionError}
          </p>
        )}
        {serverSessions.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No sessions yet — generate a probe to start one.
          </p>
        ) : (
          serverSessions.map((session) => (
            <div
              key={session.id}
              className="rounded-md border border-border p-2"
            >
              <div className="flex items-center gap-2">
                <History
                  aria-hidden
                  className="size-3.5 shrink-0 text-muted-foreground"
                />
                <p
                  className="truncate text-xs font-medium"
                  title={session.title || session.id}
                >
                  {session.title === "" ? "untitled session" : session.title}
                </p>
                <Badge tone="neutral">
                  {session.generations} gen · {session.runs} runs
                </Badge>
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {new Date(session.created_at).toLocaleString()}
              </p>
              <div className="mt-1.5 flex gap-1.5">
                <Button
                  size="sm"
                  intent="ghost"
                  aria-label={`Load ${session.title || session.id}`}
                  onClick={() => void loadSession(session.id)}
                >
                  <RotateCcw aria-hidden /> Load
                </Button>
                <Button
                  size="sm"
                  intent="ghost"
                  aria-label={`Export session ${session.title || session.id}`}
                  onClick={() => void exportSession(session.id)}
                >
                  <Download aria-hidden /> Export
                </Button>
              </div>
            </div>
          ))
        )}
        {localEntries.length > 0 && (
          <>
            <p className="mt-1 text-[11px] font-medium text-muted-foreground">
              Browser-local (this device only)
            </p>
            {localEntries.map((entry) => (
              <LocalEntryRow
                key={entry.id}
                entry={entry}
                onDelete={() => setLocalEntries(deleteHistory(entry.id))}
              />
            ))}
          </>
        )}
        <p className="text-[11px] text-muted-foreground">
          Server-side history; exports carry prompts, scripts, and summaries
          only — no secrets or server paths.
        </p>
      </CardBody>
    </Card>
  );
}

function LocalHistoryCard({
  entries,
  onDelete,
  footnote,
}: {
  entries: HistoryEntry[];
  onDelete: (id: string) => void;
  footnote: string;
}) {
  if (entries.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>History</CardTitle>
        </CardHeader>
        <CardBody>
          <p className="text-sm text-muted-foreground">{footnote}</p>
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
          <LocalEntryRow
            key={entry.id}
            entry={entry}
            onDelete={() => onDelete(entry.id)}
          />
        ))}
        <p className="text-[11px] text-muted-foreground">{footnote}</p>
      </CardBody>
    </Card>
  );
}

function LocalEntryRow({
  entry,
  onDelete,
}: {
  entry: HistoryEntry;
  onDelete: () => void;
}) {
  const setScript = useAppStore((s) => s.setScript);
  const setPrompt = useAppStore((s) => s.setPrompt);
  const setDuration = useAppStore((s) => s.setDuration);
  return (
    <div className="rounded-md border border-border p-2">
      <div className="flex items-center gap-2">
        <History
          aria-hidden
          className="size-3.5 shrink-0 text-muted-foreground"
        />
        <p className="truncate text-xs font-medium" title={entry.prompt}>
          {entry.title}
        </p>
        {entry.runId ? (
          <Badge tone="ok">ran</Badge>
        ) : (
          <Badge tone="neutral">draft</Badge>
        )}
        <Badge
          tone={
            entry.origin === "generated"
              ? "ok"
              : entry.origin === "recipe"
                ? "info"
                : "warn"
          }
        >
          {entry.origin}
        </Badge>
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
          onClick={() =>
            downloadJson(`vbpf-${entry.id}.json`, exportEntry(entry))
          }
        >
          <Download aria-hidden /> Export
        </Button>
        <Button
          size="sm"
          intent="ghost"
          aria-label={`Delete ${entry.title}`}
          onClick={onDelete}
        >
          <Trash2 aria-hidden />
        </Button>
      </div>
    </div>
  );
}

// Keyed per runId: StrictMode double-invokes the done-effect, and without
// the guard each completion would persist two history entries.
const recordedRunIds = new Set<string>();

export function recordRunToHistory(runId: string | null): void {
  const s = useAppStore.getState();
  if (!s.generation && s.script.trim() === "") return;
  if (runId) {
    if (recordedRunIds.has(runId)) return;
    recordedRunIds.add(runId);
  }
  saveHistory({
    id: `${Date.now()}`,
    title:
      s.prompt.trim().slice(0, 80) ||
      s.script.split("\n")[0]!.slice(0, 80) ||
      "untitled run",
    createdAt: Date.now(),
    prompt: s.prompt,
    script: s.script,
    chartType: s.generation?.chart_type ?? "bar",
    explanation: s.generation?.explanation ?? "",
    durationS: s.durationS,
    warnings: s.generation?.warnings ?? [],
    runId: s.runId,
    // Authoritative origin from the create-run response (fixture: local).
    origin: s.runOrigin ?? "edited",
    exitReason: s.summary?.exitReason ?? null,
    eventsSample: sampleEvents(s.events),
  });
  s.bumpHistory();
}
