import { readFileSync } from "node:fs";

export const AGENT_TIMEOUT_MS = 10_000;

export interface AgentHealth {
  kernel: string;
  bpftrace_version: string;
  btf: boolean;
  root: boolean;
  tracefs: boolean;
  uptime_s: number;
}

export interface AgentValidateOk {
  ok: boolean;
  errors: string[];
  probes: string[];
}

export interface AgentRunCreated {
  run_id: string;
  state: string;
}

export class AgentOfflineError extends Error {
  readonly code = "AGENT_OFFLINE";
  constructor(message = "agent unreachable") {
    super(message);
  }
}

export class AgentProxyError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string) {
    super(`agent responded ${status}`);
    this.status = status;
    this.body = body;
  }
}

export function readAgentToken(tokenFile: string): string {
  const raw = readFileSync(tokenFile, "utf8").trim();
  if (raw === "") throw new AgentOfflineError("agent token empty");
  return raw;
}

function agentUrl(base: string, path: string): string {
  return base.replace(/\/$/, "") + path;
}

async function agentFetch(
  base: string,
  tokenFile: string,
  path: string,
  init: RequestInit,
  timeoutMs = AGENT_TIMEOUT_MS,
): Promise<Response> {
  const token = readAgentToken(tokenFile);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(agentUrl(base, path), {
      ...init,
      signal: ctrl.signal,
      headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
    });
  } catch (err) {
    throw new AgentOfflineError(
      err instanceof Error ? err.message : "agent unreachable",
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchAgentHealth(
  base: string,
  tokenFile: string,
  timeoutMs = 3000,
): Promise<AgentHealth> {
  const res = await agentFetch(base, tokenFile, "/health", {}, timeoutMs);
  if (!res.ok) throw new AgentProxyError(res.status, await res.text());
  return (await res.json()) as AgentHealth;
}

export function startHealthPoll(
  base: string,
  tokenFile: string,
  onChange: (healthy: boolean) => void,
  intervalMs = 5000,
): () => void {
  let stopped = false;
  let failures = 0;
  let timer: NodeJS.Timeout;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      await fetchAgentHealth(base, tokenFile);
      if (failures > 0) onChange(true);
      failures = 0;
    } catch {
      failures += 1;
      onChange(false);
    }
    const backoff = Math.min(intervalMs * 2 ** Math.min(failures, 4), 30000);
    timer = setTimeout(() => void tick(), backoff);
    timer.unref?.();
  };
  void tick();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
