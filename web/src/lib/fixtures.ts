import type { ChartType, EventEnvelope } from "./api.js";

// Synthetic replay for VITE_FIXTURE_MODE=1: lets the full
// prompt -> run -> chart flow work without root or an agent.
export function fixtureScript(chart: ChartType): string {
  switch (chart) {
    case "histogram":
      return "tracepoint:block:block_rq_issue { @start[args->dev] = nsecs; }\ntracepoint:block:block_rq_complete /@start[args->dev]/ { @lat_us = hist((nsecs - @start[args->dev]) / 1000); delete(@start[args->dev]); }\ninterval:s:1 { print(@lat_us); clear(@lat_us); }";
    case "timeseries":
      return "tracepoint:tcp:tcp_retransmit_skb { @retx[comm] = count(); }\ninterval:s:1 { print(@retx); clear(@retx); }";
    case "events":
      return "tracepoint:sched:sched_process_exec { printf(\"%s pid=%d\\n\", comm, pid); }";
    default:
      return "tracepoint:raw_syscalls:sys_enter { @syscalls[comm] = count(); }\ninterval:s:1 { print(@syscalls); clear(@syscalls); }";
  }
}

const MAP_KEYS = ["systemd", "bash", "dockerd", "postgres", "containerd", "init", "chronyd", "dbus-daemon"];

export function fixtureEvents(chart: ChartType, runId: string, tick: number): EventEnvelope[] {
  const base = { run_id: runId, ts: Date.now() };
  if (chart === "events") {
    return [
      { ...base, seq: tick, kind: "printf", data: `bash pid=${1000 + tick} exec ls\n` },
      { ...base, seq: tick, kind: "printf", data: `curl pid=${2000 + tick} exec curl\n` },
    ];
  }
  if (chart === "histogram") {
    return [
      {
        ...base,
        seq: tick,
        kind: "hist",
        data: {
          "@lat_us": [
            { min: 64, max: 127, count: 20 + tick },
            { min: 128, max: 255, count: 200 + tick * 3 },
            { min: 256, max: 511, count: 400 + tick * 2 },
            { min: 512, max: 1023, count: 120 },
            { min: 1024, max: 2047, count: 5 },
          ],
        },
      },
    ];
  }
  const table: Record<string, number> = {};
  for (let i = 0; i < MAP_KEYS.length; i++) {
    table[MAP_KEYS[i]!] = (i + 1) * (10 + tick * 2);
  }
  return [{ ...base, seq: tick, kind: "map", data: { "@counts": table } }];
}
