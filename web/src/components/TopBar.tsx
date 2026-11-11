import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, TriangleAlert } from "lucide-react";

import { fetchHealth, fixtureMode } from "../lib/api.js";
import { useAppStore } from "../store/useAppStore.js";
import { Badge } from "./ui/badge.js";
import { cn } from "./ui/cn.js";

const FIX_HINTS: Record<string, string> = {
  AGENT_OFFLINE:
    "Start the agent as root: ./scripts/dev-agent.sh start, then retry.",
  AGENT_NOT_READY:
    "Agent probe catalog is not ready yet. Mount debugfs/tracefs, verify BTF support, or restart the agent.",
  NO_PRIVILEGE: "Agent needs root: restart it with sudo or -u root.",
  KERNEL_UNSUPPORTED:
    "Kernel lacks BTF or required probes; see docs/environment.md.",
  PROBE_NOT_FOUND: "Probe missing on this kernel; pick a recipe alternative.",
  VALIDATION_FAILED: "Fix the highlighted script errors and retry.",
  BLOCKED_CALL: "Remove the blocked call and retry.",
  UNKNOWN_CALL: "Use only allowlisted functions and retry.",
  LIMIT_EXCEEDED: "Shorten duration or narrow the probe; see run summary.",
  RATE_LIMITED: "Generation is rate-limited: wait a minute, then retry.",
  LLM_UNAVAILABLE: "Set ANTHROPIC_API_KEY locally, or browse recipes below.",
};

export function TopBar() {
  const health = useQuery({
    queryKey: ["health"],
    queryFn: fetchHealth,
    refetchInterval: 15_000,
    retry: 1,
    staleTime: 10_000,
  });

  const agent = health.data?.agent;
  const online = agent?.reachable === true;
  const catalog = agent && agent.reachable ? agent.health.catalog : null;
  const ready = online && agent.health.ready === true;
  const notReady = online && !ready;
  const topWarnings = agent && agent.reachable ? (agent.warnings ?? []) : [];
  const catalogWarnings = catalog?.warnings ?? [];
  const warnings = Array.from(
    new Set([
      ...topWarnings.filter((w) => w !== "AGENT_NOT_READY"),
      ...catalogWarnings,
    ]),
  );
  const degraded = ready && warnings.length > 0 ? warnings[0]! : null;
  const offlineCode =
    agent && !agent.reachable
      ? agent.code
      : health.isError
        ? "AGENT_OFFLINE"
        : null;

  useEffect(() => {
    const store = useAppStore.getState();
    if (fixtureMode()) {
      store.setAgentStatus(true, "ready", null);
      return;
    }
    if (agent?.reachable) {
      const hint = !agent.health.ready
        ? catalog?.last_error ||
          catalogWarnings[0] ||
          FIX_HINTS["AGENT_NOT_READY"]!
        : (catalog?.last_error ?? null);
      store.setAgentStatus(agent.health.ready, catalog?.state ?? null, hint);
    } else if (offlineCode !== null) {
      store.setAgentStatus(
        false,
        null,
        FIX_HINTS[offlineCode] ?? "Agent offline.",
      );
    }
  }, [
    agent,
    catalog?.last_error,
    catalog?.state,
    catalogWarnings,
    offlineCode,
  ]);

  return (
    <header className="border-b border-border bg-card">
      <div className="flex items-center gap-3 px-4 py-2.5">
        <h1 className="text-base font-bold tracking-tight">vBPF</h1>
        <span className="hidden text-xs text-muted-foreground sm:inline">
          natural language to safe eBPF probes
        </span>
        <div className="ml-auto flex items-center gap-2">
          {fixtureMode() && <Badge tone="info">fixture replay</Badge>}
          {health.isPending ? (
            <Badge tone="neutral">checking agent…</Badge>
          ) : ready ? (
            <Badge tone="ok">
              <Activity aria-hidden /> agent online
            </Badge>
          ) : notReady ? (
            <Badge tone="warn" role="alert">
              <TriangleAlert aria-hidden /> AGENT_NOT_READY
              {catalog ? ` (${catalog.state})` : ""}
            </Badge>
          ) : (
            <Badge tone="bad" role="alert">
              <TriangleAlert aria-hidden /> {offlineCode ?? "AGENT_OFFLINE"}
            </Badge>
          )}
          {degraded && (
            <Badge tone="warn" role="status">
              <TriangleAlert aria-hidden /> {degraded}
            </Badge>
          )}
        </div>
      </div>
      {notReady && (
        <p
          role="alert"
          className={cn(
            "border-t border-border px-4 py-1.5 text-xs text-amber-400",
          )}
        >
          {FIX_HINTS["AGENT_NOT_READY"]}
          {catalog?.last_error ? ` (${catalog.last_error})` : ""}
        </p>
      )}
      {!notReady && degraded && !offlineCode && (
        <p
          role="status"
          className={cn(
            "border-t border-border px-4 py-1.5 text-xs text-amber-400",
          )}
        >
          {FIX_HINTS[degraded] ?? degraded}
          {catalog?.stale_since && catalog.last_error
            ? ` (stale since ${catalog.stale_since}: ${catalog.last_error})`
            : ""}
        </p>
      )}
      {offlineCode && (
        <p
          role="alert"
          className={cn(
            "border-t border-border px-4 py-1.5 text-xs text-amber-400",
          )}
        >
          {FIX_HINTS[offlineCode] ??
            "Agent unreachable; check the API and agent logs."}
        </p>
      )}
    </header>
  );
}
