import { readFileSync, statSync } from "node:fs";

import { WebSocket } from "ws";

import { EventEnvelopeSchema } from "@vbpf/schemas";

export const AGENT_TIMEOUT_MS = 10_000;

export interface AgentHealth {
  kernel: string;
  bpftrace_version: string;
  btf: boolean;
  root: boolean;
  tracefs: boolean;
  uptime_s: number;
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

const tokenCache = new Map<string, { mtimeMs: number; token: string }>();

export function readAgentToken(tokenFile: string): string {
  let mtimeMs = -1;
  try {
    mtimeMs = statSync(tokenFile).mtimeMs;
    const cached = tokenCache.get(tokenFile);
    if (cached !== undefined && cached.mtimeMs === mtimeMs) {
      return cached.token;
    }
  } catch {
    tokenCache.delete(tokenFile);
    throw new AgentOfflineError("agent token unreadable");
  }
  let raw: string;
  try {
    raw = readFileSync(tokenFile, "utf8").trim();
  } catch {
    tokenCache.delete(tokenFile);
    throw new AgentOfflineError("agent token unreadable");
  }
  if (raw === "") {
    tokenCache.delete(tokenFile);
    throw new AgentOfflineError("agent token empty");
  }
  tokenCache.set(tokenFile, { mtimeMs, token: raw });
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

export async function searchProbes(
  base: string,
  tokenFile: string,
  q: string,
  timeoutMs = 5000,
): Promise<string[]> {
  const query = q.slice(0, 256);
  const res = await agentFetch(
    base,
    tokenFile,
    `/v1/probes?q=${encodeURIComponent(query)}`,
    {},
    timeoutMs,
  );
  if (!res.ok) throw new AgentProxyError(res.status, await res.text());
  const body = (await res.json()) as { probes?: unknown };
  if (!Array.isArray(body.probes)) return [];
  return body.probes
    .filter((p): p is string => typeof p === "string")
    .slice(0, 40);
}

export interface AgentValidation {
  ok: boolean;
  errors: string[];
  probes: string[];
}
export async function validateScript(
  base: string,
  tokenFile: string,
  script: string,
  timeoutMs = AGENT_TIMEOUT_MS,
): Promise<AgentValidation> {
  const res = await agentFetch(
    base,
    tokenFile,
    "/v1/validate",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ script }),
    },
    timeoutMs,
  );
  if (!res.ok) throw new AgentProxyError(res.status, await res.text());
  const body = (await res.json()) as {
    ok?: unknown;
    errors?: unknown;
    probes?: unknown;
  };
  return {
    ok: body.ok === true,
    errors: Array.isArray(body.errors)
      ? body.errors.filter((e): e is string => typeof e === "string")
      : [],
    probes: Array.isArray(body.probes)
      ? body.probes.filter((p): p is string => typeof p === "string")
      : [],
  };
}

export const PROBE_ARGS_TIMEOUT_MS = 3000;

const DATA_EVENT_KINDS = new Set(["printf", "map", "hist", "lhist"]);

// R2-01 stage A produced output: start a fixed-duration run and count data
// events streamed over the run websocket. Resolves on the summary envelope
// or rejects on timeout/transport failure. Sequential use only (concurrency
// 1); the eval paces cases with --delay-ms between LLM calls, not here.
export async function runScriptAndCountEvents(
  base: string,
  tokenFile: string,
  script: string,
  durationS = 5,
): Promise<{ events: number }> {
  const token = readAgentToken(tokenFile);
  const ctrl = new AbortController();
  const createTimer = setTimeout(() => ctrl.abort(), AGENT_TIMEOUT_MS);
  let runId: string;
  try {
    const res = await fetch(agentUrl(base, "/v1/runs"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ script, duration_s: durationS }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new AgentProxyError(res.status, await res.text());
    const body = (await res.json()) as { run_id?: unknown };
    if (typeof body.run_id !== "string" || body.run_id === "") {
      throw new AgentProxyError(res.status, "run creation returned no id");
    }
    runId = body.run_id;
  } catch (err) {
    if (err instanceof AgentProxyError) throw err;
    throw new AgentOfflineError(
      err instanceof Error ? err.message : "agent unreachable",
    );
  } finally {
    clearTimeout(createTimer);
  }
  const wsUrl =
    base.replace(/\/$/, "").replace(/^http/, "ws") +
    `/v1/runs/${encodeURIComponent(runId)}/stream`;
  return new Promise<{ events: number }>((resolve, reject) => {
    let events = 0;
    let done = false;
    const finish = (fn: () => void): void => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      fn();
    };
    // duration plus headroom for scheduling and stream teardown.
    const deadline = setTimeout(
      () => {
        finish(() => reject(new AgentOfflineError("run stream timed out")));
      },
      (durationS + 20) * 1000,
    );
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (err) {
      finish(() => reject(err instanceof Error ? err : new Error("ws failed")));
      return;
    }
    ws.on("message", (data) => {
      try {
        const envelope = EventEnvelopeSchema.parse(JSON.parse(data.toString()));
        if (DATA_EVENT_KINDS.has(envelope.kind)) events += 1;
        if (envelope.kind === "summary") {
          finish(() => resolve({ events }));
        }
      } catch {
        return;
      }
    });
    ws.on("error", (err) => {
      finish(() =>
        reject(
          new AgentOfflineError(
            err instanceof Error ? err.message : "run stream failed",
          ),
        ),
      );
    });
    ws.on("close", () => {
      finish(() => resolve({ events }));
    });
  });
}

export async function fetchProbeArgs(
  base: string,
  tokenFile: string,
  probe: string,
  timeoutMs = PROBE_ARGS_TIMEOUT_MS,
): Promise<string> {
  const res = await agentFetch(
    base,
    tokenFile,
    `/v1/probe-args?probe=${encodeURIComponent(probe)}`,
    {},
    timeoutMs,
  );
  if (!res.ok) throw new AgentProxyError(res.status, await res.text());
  const body = (await res.json()) as { output?: unknown };
  if (typeof body.output !== "string") return "";
  return body.output.slice(0, 8 * 1024);
}
