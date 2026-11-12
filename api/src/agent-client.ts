import { readFileSync, statSync } from "node:fs";

import { WebSocket } from "ws";

import {
  AgentHealthSchema,
  EventEnvelopeSchema,
  ValidateResponseSchema,
  type AgentHealth,
  type ValidateResponse,
} from "@vbpf/schemas";

export type { AgentHealth, ValidateResponse };

export const AGENT_TIMEOUT_MS = 10_000;

export class AgentOfflineError extends Error {
  readonly code = "AGENT_OFFLINE";
  constructor(message = "agent unreachable") {
    super(message);
  }
}

export class AgentProxyError extends Error {
  readonly status: number;
  readonly body: string;
  readonly code: string | undefined;
  readonly errorMessage: string | undefined;
  readonly errors: string[] | undefined;
  readonly retryAfter: string | undefined;
  constructor(status: number, body: string, retryAfter?: string | null) {
    super(`agent responded ${status}`);
    this.status = status;
    this.body = body;
    this.retryAfter = retryAfter ?? undefined;
    try {
      const parsed = JSON.parse(body) as {
        code?: unknown;
        error?: unknown;
        errors?: unknown;
      };
      if (typeof parsed.code === "string") this.code = parsed.code;
      if (typeof parsed.error === "string") this.errorMessage = parsed.error;
      if (Array.isArray(parsed.errors)) {
        this.errors = parsed.errors.filter(
          (e): e is string => typeof e === "string",
        );
      }
    } catch {
      // Non-JSON upstream response body; parsed metadata remains undefined.
    }
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
  if (!res.ok) {
    throw new AgentProxyError(
      res.status,
      await res.text(),
      res.headers.get("retry-after"),
    );
  }
  return AgentHealthSchema.parse(await res.json());
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
  if (!res.ok) {
    throw new AgentProxyError(
      res.status,
      await res.text(),
      res.headers.get("retry-after"),
    );
  }
  const body = (await res.json()) as { probes?: unknown };
  if (!Array.isArray(body.probes)) return [];
  return body.probes
    .filter((p): p is string => typeof p === "string")
    .slice(0, 40);
}

export async function validateScript(
  base: string,
  tokenFile: string,
  script: string,
  timeoutMs = AGENT_TIMEOUT_MS,
): Promise<ValidateResponse> {
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
  if (!res.ok) {
    throw new AgentProxyError(
      res.status,
      await res.text(),
      res.headers.get("retry-after"),
    );
  }
  return ValidateResponseSchema.parse(await res.json());
}

export const PROBE_ARGS_TIMEOUT_MS = 3000;

const DATA_EVENT_KINDS = new Set(["printf", "map", "hist", "lhist"]);

// R2-01 stage A produced output: start a fixed-duration run and count data
// events streamed over the run websocket. Resolves on the summary envelope
// or rejects on timeout/transport failure. Sequential use only (concurrency
// 1); the eval paces cases with --delay-ms between LLM calls, not here.
// Eval v2 (I-10) also captures data-event text (capped) for oracle checks.
export const RUN_OUTPUT_MAX_BYTES = 64 * 1024;

export async function runScriptAndCountEvents(
  base: string,
  tokenFile: string,
  script: string,
  durationS = 5,
): Promise<{ events: number; output: string }> {
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
    if (!res.ok) {
      throw new AgentProxyError(
        res.status,
        await res.text(),
        res.headers.get("retry-after"),
      );
    }
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
  return new Promise<{ events: number; output: string }>((resolve, reject) => {
    let events = 0;
    let done = false;
    const chunks: string[] = [];
    let bytes = 0;
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
        if (
          DATA_EVENT_KINDS.has(envelope.kind) &&
          bytes < RUN_OUTPUT_MAX_BYTES
        ) {
          const text = data.toString();
          chunks.push(text);
          bytes += text.length;
        }
        if (envelope.kind === "summary") {
          finish(() => resolve({ events, output: chunks.join("\n") }));
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
      finish(() => resolve({ events, output: chunks.join("\n") }));
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
  if (!res.ok) {
    throw new AgentProxyError(
      res.status,
      await res.text(),
      res.headers.get("retry-after"),
    );
  }
  const body = (await res.json()) as { output?: unknown };
  if (typeof body.output !== "string") return "";
  return body.output.slice(0, 8 * 1024);
}
