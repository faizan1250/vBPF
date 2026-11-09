import { useEffect, useRef } from "react";

import { fixtureMode, type EventEnvelope } from "../lib/api.js";
import { stderrText, summaryFrom } from "../lib/events.js";
import { fixtureEvents as replayEvents } from "../lib/fixtures.js";
import { useAppStore } from "../store/useAppStore.js";

const FLUSH_MS = 100; // render at 10 Hz
const MAX_BACKOFF_MS = 5000;
const MAX_ATTEMPTS = 8;

function wsUrl(runId: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws/runs/${encodeURIComponent(runId)}`;
}

function parseEnvelope(raw: string, runId: string): EventEnvelope | null {
  try {
    const parsed = JSON.parse(raw) as Partial<EventEnvelope>;
    if (typeof parsed.seq !== "number" || typeof parsed.kind !== "string")
      return null;
    return {
      run_id: typeof parsed.run_id === "string" ? parsed.run_id : runId,
      seq: parsed.seq,
      ts: typeof parsed.ts === "number" ? parsed.ts : Date.now(),
      kind: parsed.kind,
      data: parsed.data,
    };
  } catch {
    return null;
  }
}

// Streams run events: batches socket messages at 10 Hz, keeps a bounded ring
// in the store, surfaces lost/stderr/summary side-channels. Reconnects with
// backoff; fixture mode replays synthetic events instead of opening a socket.
export function useRunStream(
  runId: string | null,
  chartHint: string | null,
): void {
  const attemptRef = useRef(0);
  const bufferRef = useRef<EventEnvelope[]>([]);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!runId) return;
    const store = useAppStore.getState();
    store.setRunPhase("running");
    attemptRef.current = 0;
    bufferRef.current = [];
    let closed = false;
    let socket: WebSocket | null = null;
    let backoffTimer: number | null = null;
    let fixtureTimer: number | null = null;

    const flush = (): void => {
      const batch = bufferRef.current;
      bufferRef.current = [];
      if (batch.length === 0) return;
      const current = useAppStore.getState();
      const dataEvents = batch.filter(
        (e) => e.kind !== "lost" && e.kind !== "stderr" && e.kind !== "summary",
      );
      const lost = batch.filter((e) => e.kind === "lost").length;
      for (const e of batch) {
        if (e.kind === "stderr") {
          const text = stderrText(e.data);
          if (text) current.pushStderr(text);
        } else if (e.kind === "summary") {
          const summary = summaryFrom(e.data);
          if (summary) current.setSummary(summary);
        }
      }
      if (dataEvents.length > 0) current.pushEvents(dataEvents);
      if (lost > 0) {
        // Agent-side drops are reported separately from ring overflow.
        useAppStore.setState((s) => ({ dropped: s.dropped + lost }));
      }
      for (const e of batch) {
        if (e.kind === "status" && isRecord(e.data)) {
          const state = (e.data as Record<string, unknown>)["state"];
          if (
            state === "completed" ||
            state === "failed" ||
            state === "killed"
          ) {
            current.setRunPhase(state === "failed" ? "failed" : "done");
          } else if (state === "stopping") {
            current.setRunPhase("stopping");
          }
        }
      }
    };

    timerRef.current = window.setInterval(flush, FLUSH_MS);

    if (fixtureMode()) {
      let tick = 0;
      const chart = (chartHint ?? "bar") as
        "bar" | "histogram" | "timeseries" | "events" | "table";
      fixtureTimer = window.setInterval(() => {
        tick += 1;
        bufferRef.current.push(...replayEvents(chart, runId, tick));
        const s = useAppStore.getState();
        if (s.runPhase === "stopping" || s.events.length >= 60) {
          s.setRunPhase("done");
          s.setSummary({
            events: s.events.length,
            bytes: 0,
            dropped: 0,
            durationS: s.durationS,
            exitReason: "completed",
          });
          if (fixtureTimer !== null) window.clearInterval(fixtureTimer);
        }
      }, 250);
    } else {
      const connect = (): void => {
        if (closed) return;
        socket = new WebSocket(wsUrl(runId));
        socket.onmessage = (msg) => {
          const env = parseEnvelope(String(msg.data), runId);
          if (env) bufferRef.current.push(env);
        };
        socket.onclose = () => {
          if (closed) return;
          attemptRef.current += 1;
          if (attemptRef.current > MAX_ATTEMPTS) {
            useAppStore
              .getState()
              .setRunError("stream disconnected (AGENT_OFFLINE)");
            useAppStore.getState().setRunPhase("failed");
            return;
          }
          const delay = Math.min(MAX_BACKOFF_MS, 250 * 2 ** attemptRef.current);
          backoffTimer = window.setTimeout(connect, delay);
        };
        socket.onerror = () => {
          try {
            socket?.close();
          } catch {
            /* reconnect handled by onclose */
          }
        };
      };
      connect();
    }

    return () => {
      closed = true;
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
      if (backoffTimer !== null) window.clearTimeout(backoffTimer);
      if (fixtureTimer !== null) window.clearInterval(fixtureTimer);
      flush();
      try {
        socket?.close();
      } catch {
        /* already closed */
      }
    };
  }, [runId]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
