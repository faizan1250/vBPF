import type { ChartType, EventEnvelope } from "./api.js";

// Synthetic replay for VITE_FIXTURE_MODE=1: lets the full
// prompt -> run -> chart flow work without root or an agent.
//
// Five recorded scenarios (I-17). All keys are generic process/service
// names; no usernames, real paths, or hostnames appear anywhere.
export interface FixtureScenario {
  id: string;
  title: string;
  prompt: string;
  chart: ChartType;
  script: string;
  explanation: string;
}

export const FIXTURE_SCENARIOS: FixtureScenario[] = [
  {
    id: "slow-disk",
    title: "Slow disk I/O by process",
    prompt: "Which processes are doing the slowest disk I/O?",
    chart: "bar",
    script:
      "tracepoint:block:block_rq_issue { @disk[comm] = count(); }\ninterval:s:1 { print(@disk); clear(@disk); }",
    explanation:
      "Fixture replay: block I/O counts by process (synthetic, nothing is executed).",
  },
  {
    id: "new-processes",
    title: "New processes",
    prompt: "Show new processes as they start",
    chart: "events",
    script:
      'tracepoint:sched:sched_process_exec { printf("%s pid=%d\\n", comm, pid); }',
    explanation:
      "Fixture replay: process exec events (synthetic, nothing is executed).",
  },
  {
    id: "tcp-retransmits",
    title: "TCP retransmits",
    prompt: "Show TCP retransmits over time",
    chart: "timeseries",
    script:
      "tracepoint:tcp:tcp_retransmit_skb { @retx[comm] = count(); }\ninterval:s:1 { print(@retx); clear(@retx); }",
    explanation:
      "Fixture replay: TCP retransmit counts over time (synthetic, nothing is executed).",
  },
  {
    id: "syscall-counts",
    title: "Syscall counts by process",
    prompt: "Count system calls by process",
    chart: "bar",
    script:
      "tracepoint:raw_syscalls:sys_enter { @syscalls[comm] = count(); }\ninterval:s:1 { print(@syscalls); clear(@syscalls); }",
    explanation:
      "Fixture replay: syscall counts by process (synthetic, nothing is executed).",
  },
  {
    id: "dns-lookups",
    title: "DNS lookups by process",
    prompt: "Which processes are doing DNS lookups?",
    chart: "table",
    script:
      "uprobe:libc:getaddrinfo { @dns[comm] = count(); }\ninterval:s:1 { print(@dns); clear(@dns); }",
    explanation:
      "Fixture replay: DNS lookup counts by process (synthetic, nothing is executed).",
  },
];

export const FIXTURE_SCENARIO_IDS = FIXTURE_SCENARIOS.map((s) => s.id);

export function fixtureScenarioForPrompt(prompt: string): FixtureScenario {
  const lower = prompt.toLowerCase();
  const byId = (id: string): FixtureScenario =>
    FIXTURE_SCENARIOS.find((s) => s.id === id) ?? FIXTURE_SCENARIOS[0]!;
  if (lower.includes("histogram")) {
    return {
      id: "block-latency-histogram",
      title: "Block I/O latency histogram",
      prompt,
      chart: "histogram",
      script: fixtureScript("histogram"),
      explanation:
        "Fixture replay: block I/O latency histogram (synthetic, nothing is executed).",
    };
  }
  if (/\b(start|exec|spawn)\b/.test(lower)) return byId("new-processes");
  if (
    lower.includes("retransmit") ||
    /\btcp\b/.test(lower) ||
    lower.includes("packet loss")
  )
    return byId("tcp-retransmits");
  if (
    lower.includes("dns") ||
    lower.includes("lookup") ||
    lower.includes("getaddrinfo") ||
    lower.includes("resolv")
  )
    return byId("dns-lookups");
  if (lower.includes("syscall")) return byId("syscall-counts");
  if (
    lower.includes("disk") ||
    lower.includes("block") ||
    lower.includes("slow")
  )
    return byId("slow-disk");
  return byId("syscall-counts");
}

// Offline recipe picker entries for fixture mode (no /api/recipes fetch).
export interface FixtureRecipe {
  id: string;
  title: string;
  description: string;
  tags: string[];
  view: ChartType;
}

export const FIXTURE_RECIPES: FixtureRecipe[] = [
  {
    id: "slow-disk-by-process",
    title: "Slow disk I/O by process",
    description: "Which processes are doing the slowest disk I/O?",
    tags: ["disk"],
    view: "bar",
  },
  {
    id: "new-processes",
    title: "New processes",
    description: "Show new processes as they start",
    tags: ["process"],
    view: "events",
  },
  {
    id: "tcp-retransmits",
    title: "TCP retransmits",
    description: "Show TCP retransmits over time",
    tags: ["tcp"],
    view: "timeseries",
  },
  {
    id: "syscall-counts-by-process",
    title: "Syscall counts by process",
    description: "Count system calls by process",
    tags: ["syscalls"],
    view: "bar",
  },
  {
    id: "dns-lookups",
    title: "DNS lookups by process",
    description: "Which processes are doing DNS lookups?",
    tags: ["dns"],
    view: "table",
  },
];

export function fixtureScript(chart: ChartType): string {
  switch (chart) {
    case "histogram":
      return "tracepoint:block:block_rq_issue { @start[args->dev] = nsecs; }\ntracepoint:block:block_rq_complete /@start[args->dev]/ { @lat_us = hist((nsecs - @start[args->dev]) / 1000); delete(@start[args->dev]); }\ninterval:s:1 { print(@lat_us); clear(@lat_us); }";
    case "timeseries":
      return "tracepoint:tcp:tcp_retransmit_skb { @retx[comm] = count(); }\ninterval:s:1 { print(@retx); clear(@retx); }";
    case "events":
      return 'tracepoint:sched:sched_process_exec { printf("%s pid=%d\\n", comm, pid); }';
    default:
      return "tracepoint:raw_syscalls:sys_enter { @syscalls[comm] = count(); }\ninterval:s:1 { print(@syscalls); clear(@syscalls); }";
  }
}

const MAP_KEYS_BY_SCENARIO: Record<string, string[]> = {
  "slow-disk": [
    "postgres",
    "dockerd",
    "containerd",
    "systemd",
    "bash",
    "chronyd",
  ],
  "syscall-counts": [
    "systemd",
    "bash",
    "dockerd",
    "postgres",
    "containerd",
    "init",
  ],
  "tcp-retransmits": [
    "curl",
    "postgres",
    "dockerd",
    "systemd",
    "bash",
    "dbus-daemon",
  ],
  "dns-lookups": [
    "systemd-resolved",
    "curl",
    "bash",
    "postgres",
    "chronyd",
    "dockerd",
  ],
  default: [
    "systemd",
    "bash",
    "dockerd",
    "postgres",
    "containerd",
    "init",
    "chronyd",
    "dbus-daemon",
  ],
};

const MAP_NAME_BY_SCENARIO: Record<string, string> = {
  "slow-disk": "@disk",
  "syscall-counts": "@syscalls",
  "tcp-retransmits": "@retx",
  "dns-lookups": "@dns",
  default: "@counts",
};

export function fixtureScenarioId(runId: string): string {
  const rest = runId.startsWith("run_fixture_")
    ? runId.slice("run_fixture_".length)
    : "";
  const parts = rest.split("_");
  const id = parts.slice(0, -1).join("_");
  return id !== "" && id in MAP_KEYS_BY_SCENARIO ? id : "default";
}

export function fixtureEvents(
  chart: ChartType,
  runId: string,
  tick: number,
  scenarioId = "default",
): EventEnvelope[] {
  const base = { run_id: runId, ts: Date.now() };
  if (chart === "events") {
    return [
      {
        ...base,
        seq: tick,
        kind: "printf",
        data: `bash pid=${1000 + tick} exec ls\n`,
      },
      {
        ...base,
        seq: tick,
        kind: "printf",
        data: `curl pid=${2000 + tick} exec curl\n`,
      },
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
  const keys =
    MAP_KEYS_BY_SCENARIO[scenarioId] ?? MAP_KEYS_BY_SCENARIO["default"]!;
  const mapName =
    MAP_NAME_BY_SCENARIO[scenarioId] ?? MAP_NAME_BY_SCENARIO["default"]!;
  const table: Record<string, number> = {};
  for (let i = 0; i < keys.length; i++) {
    table[keys[i]!] = (i + 1) * (10 + tick * 2);
  }
  return [{ ...base, seq: tick, kind: "map", data: { [mapName]: table } }];
}
