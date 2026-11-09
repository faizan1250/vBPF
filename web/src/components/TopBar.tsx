import { useQuery } from "@tanstack/react-query";
import { Activity, TriangleAlert } from "lucide-react";

import { fetchHealth, fixtureMode } from "../lib/api.js";
import { Badge } from "./ui/badge.js";
import { cn } from "./ui/cn.js";

const FIX_HINTS: Record<string, string> = {
  AGENT_OFFLINE:
    "Start the agent as root: ./scripts/dev-agent.sh start, then retry.",
  NO_PRIVILEGE: "Agent needs root: restart it with sudo or -u root.",
  KERNEL_UNSUPPORTED:
    "Kernel lacks BTF or required probes; see docs/environment.md.",
  PROBE_NOT_FOUND: "Probe missing on this kernel; pick a recipe alternative.",
  VALIDATION_FAILED: "Fix the highlighted script errors and retry.",
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
  const warnings = agent && agent.reachable ? (agent.warnings ?? []) : [];
  const degraded = online && warnings.length > 0 ? warnings[0]! : null;
  const offlineCode =
    agent && !agent.reachable
      ? agent.code
      : health.isError
        ? "AGENT_OFFLINE"
        : null;

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
          ) : online ? (
            <Badge tone="ok">
              <Activity aria-hidden /> agent online
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
      {degraded && !offlineCode && (
        <p
          role="status"
          className={cn(
            "border-t border-border px-4 py-1.5 text-xs text-amber-400",
          )}
        >
          {FIX_HINTS[degraded] ?? "Agent degraded; see docs/environment.md."}
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
