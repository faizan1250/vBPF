import { createHash } from "node:crypto";

import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Database from "better-sqlite3";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { WebSocket } from "ws";
import {
  AgentRunSummarySchema,
  CreateRunRequestSchema,
  CreateRunResponseSchema,
  EventEnvelopeSchema,
  ExplainRequestSchema,
  ExplainResponseSchema,
  GenerateRequestSchema,
  GetRunResponseSchema,
  HealthResponseSchema,
  RecipeListResponseSchema,
  StopRunResponseSchema,
  ValidateRequestSchema,
} from "@vbpf/schemas";

import {
  AGENT_TIMEOUT_MS,
  AgentOfflineError,
  AgentProxyError,
  fetchAgentHealth,
  readAgentToken,
  type AgentHealth,
} from "./agent-client.js";
import {
  closeDb,
  generationExists,
  getGeneration,
  indexRecipes,
  insertRun,
  markRunFailedIfActive,
  migrate,
  openDb,
  persistRunSummary,
  searchRecipes,
} from "./db.js";
import { ExplainValidationError, explainScriptText } from "./explain.js";
import {
  RefusalError,
  ValidationFailedError,
  makeMockLlm,
  runGenerate,
} from "./generate.js";
import {
  LIVE_UNAVAILABLE_RETRY_AFTER_S,
  LiveLlmChain,
  LlmRequestError,
  LlmUnavailableError,
} from "./live-llm.js";
import { PromptBudgetError } from "./llm.js";
import { loadRecipes } from "./recipes.js";

export interface AppOptions {
  agentUrl: string;
  tokenFile: string;
  dbPath: string;
  recipesDir: string;
  webOrigin: string;
  llmModel?: string;
  llmMode?: "mock" | "live";
  llmChain?: string;
  llmEnv?: NodeJS.ProcessEnv;
  llmFetch?: typeof fetch;
  generateRateLimit?: { max: number; windowMs: number };
}

const BODY_LIMIT = 64 * 1024;
const DEFAULT_DURATION_S = 10;
// POST /api/generate budget: 10 requests per IP per minute. LLM-backed
// generation is the most expensive handler; per-route limiter only.
const GENERATE_RATE_MAX = 10;
const GENERATE_RATE_WINDOW_MS = 60_000;
const AGENT_NOT_READY_HINT =
  "Agent probe catalog is not ready yet. Mount debugfs/tracefs, verify BTF support, or restart the agent.";

function isCatalogUnavailableResponse(
  status: number,
  json: unknown,
): { unavailable: boolean; error?: string } {
  const rec =
    typeof json === "object" && json !== null
      ? (json as { code?: unknown; error?: unknown })
      : null;
  const unavailable = status === 503 || rec?.code === "CATALOG_UNAVAILABLE";
  return {
    unavailable,
    ...(typeof rec?.error === "string" ? { error: rec.error } : {}),
  };
}

function sendAgentNotReady(
  reply: FastifyReply,
  retryAfter: string | null | undefined,
  message = "agent probe catalog not ready",
): FastifyReply {
  return reply
    .code(503)
    .header(
      "retry-after",
      retryAfter !== null && retryAfter !== undefined && retryAfter !== ""
        ? retryAfter
        : "2",
    )
    .send({
      error: message,
      code: "AGENT_NOT_READY",
      fix_hint: AGENT_NOT_READY_HINT,
    });
}

function agentWsUrl(agentUrl: string, path: string): string {
  const base = agentUrl.replace(/\/$/, "").replace(/^http/, "ws");
  return base + path;
}

// Loopback-only Host gate (DNS-rebinding protection). The API binds
// loopback, so a non-loopback Host means a rebinding or proxy attack.
// WEB_ORIGIN's host is loopback too, so legit browser traffic passes.
export function isSafeId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    id.length > 0 &&
    id.length <= 128 &&
    /^[a-zA-Z0-9_-]+$/.test(id)
  );
}

function hostIsLoopback(host: string | undefined): boolean {
  if (typeof host !== "string" || host === "") return false;
  let name = host.toLowerCase();
  if (name.startsWith("[")) {
    const end = name.indexOf("]");
    if (end < 0) return false;
    const rest = name.slice(end + 1);
    if (rest !== "" && !/^:\d+$/.test(rest)) return false;
    name = name.slice(0, end + 1);
  } else if (
    name.includes(":") &&
    name.indexOf(":") === name.lastIndexOf(":")
  ) {
    const colon = name.indexOf(":");
    if (!/^\d+$/.test(name.slice(colon + 1))) return false;
    name = name.slice(0, colon);
  }
  return (
    name === "127.0.0.1" ||
    name === "localhost" ||
    name === "[::1]" ||
    name === "::1"
  );
}

// Fixed-window per-IP limiter scoped to one route. Returns false when the
// caller is over budget; state lives on the app instance (no shared global).
function createRouteLimiter(
  max: number,
  windowMs: number,
): (ip: string, now: number) => boolean {
  const hits = new Map<string, number[]>();
  return (ip: string, now: number): boolean => {
    let arr = hits.get(ip);
    if (arr === undefined) {
      arr = [];
      hits.set(ip, arr);
    }
    while (arr.length > 0 && (arr[0] ?? 0) <= now - windowMs) arr.shift();
    if (arr.length >= max) return false;
    arr.push(now);
    if (hits.size > 1000) {
      for (const [key, times] of hits) {
        if (
          times.length === 0 ||
          (times[times.length - 1] ?? 0) <= now - windowMs
        ) {
          hits.delete(key);
        }
      }
    }
    return true;
  };
}

async function proxyVerbatim(
  reply: FastifyReply,
  work: () => Promise<Response>,
): Promise<never> {
  let res: Response;
  try {
    res = await work();
  } catch (err) {
    if (err instanceof AgentOfflineError) {
      return reply
        .code(503)
        .send({ error: "agent offline", code: "AGENT_OFFLINE" }) as never;
    }
    throw err;
  }
  const text = await res.text();
  try {
    const json: unknown = text === "" ? {} : JSON.parse(text);
    const check = isCatalogUnavailableResponse(res.status, json);
    if (check.unavailable) {
      return sendAgentNotReady(
        reply,
        res.headers.get("retry-after"),
        check.error,
      ) as never;
    }
    return reply.code(res.status).send(json) as never;
  } catch {
    if (res.status === 503) {
      return sendAgentNotReady(reply, res.headers.get("retry-after")) as never;
    }
    return reply.code(res.status).send(text) as never;
  }
}

function agentPost(
  base: string,
  tokenFile: string,
  path: string,
  body: unknown,
): Promise<Response> {
  const token = readAgentToken(tokenFile);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), AGENT_TIMEOUT_MS);
  return fetch(base.replace(/\/$/, "") + path, {
    method: "POST",
    signal: ctrl.signal,
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  })
    .catch((err: unknown) => {
      throw new AgentOfflineError(
        err instanceof Error ? err.message : "agent unreachable",
      );
    })
    .finally(() => clearTimeout(timer));
}

function agentDelete(
  base: string,
  tokenFile: string,
  path: string,
): Promise<Response> {
  let token: string;
  try {
    token = readAgentToken(tokenFile);
  } catch (err) {
    return Promise.reject(err);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), AGENT_TIMEOUT_MS);
  return fetch(base.replace(/\/$/, "") + path, {
    method: "DELETE",
    signal: ctrl.signal,
    headers: { Authorization: `Bearer ${token}` },
  })
    .catch((err: unknown) => {
      throw new AgentOfflineError(
        err instanceof Error ? err.message : "agent unreachable",
      );
    })
    .finally(() => clearTimeout(timer));
}

// All LLM_UNAVAILABLE 503s carry a fixed retry hint (D-24): 90 s matches
// the default total LLM budget, so clients back off one budget window.
function sendLlmUnavailable(reply: FastifyReply): FastifyReply {
  return reply
    .code(503)
    .header("retry-after", String(LIVE_UNAVAILABLE_RETRY_AFTER_S))
    .send({
      error: "LLM unavailable in this environment",
      code: "LLM_UNAVAILABLE",
      retry_after_s: LIVE_UNAVAILABLE_RETRY_AFTER_S,
    });
}

// Aborts the in-flight provider request when the HTTP client goes away.
// Listens on the response: req.raw "close" fires once the (small,
// buffered) request body is consumed, which is not a disconnect. The
// response "close" before the body is fully sent means the client left.
function trackClientDisconnect(reply: FastifyReply): {
  signal: AbortSignal;
  done: () => void;
} {
  const ctrl = new AbortController();
  const onClose = (): void => {
    if (!reply.raw.writableEnded) ctrl.abort();
  };
  reply.raw.on("close", onClose);
  return {
    signal: ctrl.signal,
    done: () => reply.raw.removeListener("close", onClose),
  };
}

// Derives taxonomy warning codes from agent health signals. Exported for
// tests; the full mapping (including gaps) lives in docs/security.md.
export function healthWarnings(health: AgentHealth): string[] {
  const warnings: string[] = [];
  if (!health.root) warnings.push("NO_PRIVILEGE");
  if (!health.btf || !health.tracefs) warnings.push("KERNEL_UNSUPPORTED");
  if (!health.ready) warnings.push("AGENT_NOT_READY");
  return warnings;
}

export async function buildApp(
  opts: AppOptions,
  db?: Database.Database,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env["LOG_LEVEL"] ?? "info",
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.Authorization",
          "*.token",
          "*.agentToken",
        ],
        censor: "[REDACTED]",
      },
    },
    bodyLimit: BODY_LIMIT,
  });

  const database = db ?? openDb(opts.dbPath);
  migrate(database);
  indexRecipes(database, loadRecipes(opts.recipesDir));

  const activeObservers = new Set<WebSocket>();

  // Persists the terminal summary from the agent's summary event. One update
  // per termination; stream end covers natural completion and timeout.
  const recordRunSummary = (runId: string, data: unknown): void => {
    const parsed = AgentRunSummarySchema.safeParse(data);
    if (!parsed.success) return;
    try {
      persistRunSummary(database, runId, parsed.data);
    } catch (err) {
      app.log.error({ err }, "run summary update failed");
    }
  };

  // Marks a run stopping when termination is requested (stop endpoint or a
  // stop message over the run's websocket). The later summary event, if a
  // stream is attached, fills in the counts.
  const markRunStopping = (runId: string): void => {
    try {
      database
        .prepare("UPDATE runs SET state = ?, ended_at = ? WHERE id = ?")
        .run("stopping", Date.now(), runId);
    } catch (err) {
      app.log.error({ err }, "run stop update failed");
    }
  };

  const startRunObserver = (runId: string): void => {
    let token: string;
    try {
      token = readAgentToken(opts.tokenFile);
    } catch (err) {
      app.log.warn({ err, runId }, "run observer failed to read agent token");
      return;
    }

    const target = agentWsUrl(
      opts.agentUrl,
      `/v1/runs/${encodeURIComponent(runId)}/stream`,
    );
    let ws: WebSocket;
    try {
      ws = new WebSocket(target, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (err) {
      app.log.warn({ err, runId }, "failed to initialize run observer socket");
      return;
    }

    activeObservers.add(ws);
    let receivedSummary = false;

    const cleanup = (): void => {
      activeObservers.delete(ws);
    };

    ws.on("message", (data) => {
      try {
        const envelope = EventEnvelopeSchema.parse(JSON.parse(data.toString()));
        if (envelope.kind === "summary") {
          const parsed = AgentRunSummarySchema.safeParse(envelope.data);
          if (parsed.success) {
            receivedSummary = true;
            try {
              persistRunSummary(database, runId, parsed.data);
            } catch (err) {
              app.log.error({ err, runId }, "run summary update failed");
            }
            cleanup();
            try {
              ws.close();
            } catch {
              /* already closed */
            }
          }
        }
      } catch {
        // Non-envelope or unparseable event: ignore
      }
    });

    ws.on("close", () => {
      cleanup();
      if (!receivedSummary) {
        try {
          markRunFailedIfActive(database, runId);
        } catch (err) {
          app.log.error(
            { err, runId },
            "failed to transition disconnected run to failed",
          );
        }
      }
    });

    ws.on("error", (err) => {
      cleanup();
      app.log.debug({ err, runId }, "run observer websocket error");
    });
  };

  app.addHook("onClose", async () => {
    for (const ws of activeObservers) {
      try {
        ws.terminate();
      } catch {
        /* already closed */
      }
    }
    activeObservers.clear();
    closeDb(database);
  });

  await app.register(websocket);

  // Register before cors so rejected requests never get ACAO or 204 preflight
  // answers, and after websocket so rejected upgrades still mark req.ws for teardown.
  app.addHook("onRequest", async (req, reply) => {
    if (!hostIsLoopback(req.headers.host)) {
      return reply
        .code(403)
        .send({ error: "forbidden host", code: "FORBIDDEN" });
    }
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== opts.webOrigin) {
      return reply
        .code(403)
        .send({ error: "forbidden origin", code: "FORBIDDEN" });
    }
    const fetchSite = req.headers["sec-fetch-site"];
    if (
      Array.isArray(fetchSite) ||
      (typeof fetchSite === "string" &&
        fetchSite
          .toLowerCase()
          .split(",")
          .some((v) => v.trim() === "cross-site"))
    ) {
      return reply
        .code(403)
        .send({ error: "forbidden fetch site", code: "FORBIDDEN" });
    }
  });

  await app.register(cors, { origin: opts.webOrigin, credentials: false });

  const checkGenerateRate = createRouteLimiter(
    opts.generateRateLimit?.max ?? GENERATE_RATE_MAX,
    opts.generateRateLimit?.windowMs ?? GENERATE_RATE_WINDOW_MS,
  );
  const generateWindowS = Math.ceil(
    (opts.generateRateLimit?.windowMs ?? GENERATE_RATE_WINDOW_MS) / 1000,
  );

  // Live chain is built once and shared: key-disable and cooldown state
  // persist across requests for the process lifetime. Logs go through a
  // request-independent child so per-call lines carry the component field.
  const llmMode = opts.llmMode ?? "mock";
  const liveLogger = app.log.child({ component: "live-llm" });
  const liveChain =
    llmMode === "live"
      ? new LiveLlmChain({
          env: opts.llmEnv ?? process.env,
          fetchFn: opts.llmFetch,
          chain: opts.llmChain,
          logger: {
            warn: (msg) => liveLogger.warn(msg),
            info: (obj, msg) => liveLogger.info(obj, msg ?? "live llm call"),
          },
        })
      : null;
  const liveLlm = liveChain !== null && liveChain.configured ? liveChain : null;

  const llmHealth = (): {
    mode: "mock" | "live";
    providers: Array<{
      name: string;
      state: "ready" | "cooldown" | "unconfigured" | "exhausted";
      keys: number;
      reason?: string;
    }>;
  } => liveChain?.health() ?? { mode: llmMode, providers: [] };

  app.get("/api/health", async (_req, reply) => {
    try {
      const health = await fetchAgentHealth(opts.agentUrl, opts.tokenFile);
      return reply.send(
        HealthResponseSchema.parse({
          ok: true,
          llm: llmHealth(),
          agent: {
            reachable: true,
            health,
            warnings: healthWarnings(health),
          },
        }),
      );
    } catch (err) {
      if (err instanceof AgentOfflineError || err instanceof AgentProxyError) {
        return reply.send(
          HealthResponseSchema.parse({
            ok: true,
            llm: llmHealth(),
            agent: {
              reachable: false,
              code: "AGENT_OFFLINE",
              error: "agent offline",
            },
          }),
        );
      }
      throw err;
    }
  });

  app.get("/api/recipes", async (req, reply) => {
    const q = (req.query as { q?: unknown })?.q;
    const query = typeof q === "string" ? q.slice(0, 256) : "";
    const recipes = searchRecipes(database, query);
    return reply.send(RecipeListResponseSchema.parse({ recipes }));
  });

  app.post(
    "/api/generate",
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!checkGenerateRate(req.ip, Date.now())) {
        return reply
          .code(429)
          .header("retry-after", String(generateWindowS))
          .send({ error: "rate limit exceeded", code: "RATE_LIMITED" });
      }
      const parsed = GenerateRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "invalid request", code: "VALIDATION_FAILED" });
      }
      const mode = opts.llmMode ?? "mock";
      const llm =
        mode === "mock"
          ? makeMockLlm(database, opts.recipesDir, opts.llmModel ?? "mock")
          : liveLlm;
      if (llm === null) {
        return sendLlmUnavailable(reply);
      }
      const client = trackClientDisconnect(reply);
      try {
        const result = await runGenerate(parsed.data.prompt, {
          sessionId: parsed.data.session_id,
          deps: {
            db: database,
            recipesDir: opts.recipesDir,
            agentUrl: opts.agentUrl,
            tokenFile: opts.tokenFile,
            llm,
          },
          signal: client.signal,
        });
        return reply.send(result);
      } catch (err) {
        if (err instanceof RefusalError) {
          return reply.code(422).send({
            error: err.refusal,
            code: "REFUSAL",
            generation_id: err.generationId,
          });
        }
        if (err instanceof ValidationFailedError) {
          return reply.code(422).send({
            error: "validation failed",
            code: "VALIDATION_FAILED",
            generation_id: err.generationId,
            attempts: err.attempts,
            errors: err.errors,
          });
        }
        if (err instanceof AgentOfflineError) {
          return reply
            .code(503)
            .send({ error: "agent offline", code: "AGENT_OFFLINE" });
        }
        if (
          err instanceof AgentProxyError &&
          (err.status === 503 || err.code === "CATALOG_UNAVAILABLE")
        ) {
          return sendAgentNotReady(
            reply,
            err.retryAfter,
            err.errorMessage ?? "agent probe catalog not ready",
          );
        }
        if (err instanceof LlmUnavailableError) {
          return sendLlmUnavailable(reply);
        }
        if (
          err instanceof LlmRequestError ||
          err instanceof PromptBudgetError
        ) {
          return reply
            .code(502)
            .send({ error: "LLM request failed", code: "LLM_ERROR" });
        }
        throw err;
      } finally {
        client.done();
      }
    },
  );

  app.post("/api/explain", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!checkGenerateRate(req.ip, Date.now())) {
      return reply
        .code(429)
        .header("retry-after", String(generateWindowS))
        .send({ error: "rate limit exceeded", code: "RATE_LIMITED" });
    }
    const parsed = ExplainRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid request", code: "VALIDATION_FAILED" });
    }
    const mode = opts.llmMode ?? "mock";
    const llm = mode === "mock" ? null : liveLlm;
    if (mode !== "mock" && llm === null) {
      return sendLlmUnavailable(reply);
    }
    const client = trackClientDisconnect(reply);
    try {
      const result = await explainScriptText(
        parsed.data.script,
        {
          db: database,
          recipesDir: opts.recipesDir,
          llm,
        },
        { signal: client.signal },
      );
      return reply.send(ExplainResponseSchema.parse(result));
    } catch (err) {
      if (err instanceof ExplainValidationError) {
        return reply.code(422).send({
          error: "validation failed",
          code: "VALIDATION_FAILED",
          errors: err.errors,
        });
      }
      if (err instanceof LlmUnavailableError) {
        return sendLlmUnavailable(reply);
      }
      if (err instanceof LlmRequestError) {
        return reply
          .code(502)
          .send({ error: "LLM request failed", code: "LLM_ERROR" });
      }
      throw err;
    } finally {
      client.done();
    }
  });

  app.post(
    "/api/validate",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const parsed = ValidateRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "invalid request", code: "VALIDATION_FAILED" });
      }
      if (parsed.data.script.includes("--unsafe")) {
        return reply.code(400).send({
          ok: false,
          errors: ["--unsafe is forbidden"],
          probes: [],
          warnings: [],
          probe_count: 0,
        });
      }
      return proxyVerbatim(reply, () =>
        agentPost(opts.agentUrl, opts.tokenFile, "/v1/validate", parsed.data),
      );
    },
  );

  app.post("/api/runs", async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = CreateRunRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid request", code: "VALIDATION_FAILED" });
    }
    const { script, duration_s: durationS } = parsed.data;
    if (script.includes("--unsafe")) {
      return reply
        .code(400)
        .send({ error: "--unsafe is forbidden", code: "VALIDATION_FAILED" });
    }
    // Generation binding resolves before the agent call: an unknown id must
    // not occupy the agent's single-run slot. The agent still re-validates
    // the script itself on run creation.
    const generationId = parsed.data.generation_id ?? null;
    let edited = false;
    if (generationId !== null) {
      if (!generationExists(database, generationId)) {
        return reply
          .code(400)
          .send({ error: "Invalid generation ID", code: "VALIDATION_FAILED" });
      }
      const gen = getGeneration(database, generationId);
      edited = gen !== undefined && script !== gen.script;
    }
    const duration = durationS ?? DEFAULT_DURATION_S;
    let created: { run_id: string; state: string };
    try {
      const res = await agentPost(opts.agentUrl, opts.tokenFile, "/v1/runs", {
        script,
        duration_s: duration,
      });
      const text = await res.text();
      let json: unknown = {};
      try {
        json = text === "" ? {} : JSON.parse(text);
      } catch {
        if (res.status === 503) {
          return sendAgentNotReady(reply, res.headers.get("retry-after"));
        }
        return reply.code(res.status).send(text);
      }
      if (!res.ok) {
        const check = isCatalogUnavailableResponse(res.status, json);
        if (check.unavailable) {
          return sendAgentNotReady(
            reply,
            res.headers.get("retry-after"),
            check.error,
          );
        }
        return reply.code(res.status).send(json);
      }
      created = CreateRunResponseSchema.parse(json);
    } catch (err) {
      if (err instanceof AgentOfflineError) {
        return reply
          .code(503)
          .send({ error: "agent offline", code: "AGENT_OFFLINE" });
      }
      throw err;
    }
    try {
      insertRun(database, {
        id: created.run_id,
        generation_id: generationId,
        script_sha256: createHash("sha256").update(script).digest("hex"),
        script_text: script,
        edited,
        duration_s: duration,
        state: created.state,
        started_at: Date.now(),
      });
    } catch (err) {
      app.log.error({ err, runId: created.run_id }, "run insert failed");
      agentDelete(
        opts.agentUrl,
        opts.tokenFile,
        `/v1/runs/${encodeURIComponent(created.run_id)}`,
      ).catch((delErr: unknown) => {
        app.log.warn(
          { err: delErr, runId: created.run_id },
          "best-effort run abort failed",
        );
      });
      return reply
        .code(500)
        .send({ error: "failed to persist run", code: "INTERNAL_ERROR" });
    }
    startRunObserver(created.run_id);
    return reply.code(201).send(created);
  });

  app.post(
    "/api/runs/:id/stop",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = req.params as { id: string };
      if (typeof id !== "string" || id === "" || id.length > 256) {
        return reply
          .code(404)
          .send({ error: "unknown run", code: "NOT_FOUND" });
      }
      let stopped: { run_id: string; state: string };
      try {
        const res = await agentDelete(
          opts.agentUrl,
          opts.tokenFile,
          `/v1/runs/${encodeURIComponent(id)}`,
        );
        const text = await res.text();
        let json: unknown = {};
        try {
          json = text === "" ? {} : JSON.parse(text);
        } catch {
          return reply.code(res.status).send(text);
        }
        if (!res.ok) return reply.code(res.status).send(json);
        stopped = StopRunResponseSchema.parse(json);
      } catch (err) {
        if (err instanceof AgentOfflineError) {
          return reply
            .code(503)
            .send({ error: "agent offline", code: "AGENT_OFFLINE" });
        }
        throw err;
      }
      markRunStopping(stopped.run_id);
      return reply.send(stopped);
    },
  );

  app.get("/api/runs/:id", async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    if (typeof id !== "string" || id === "" || id.length > 256) {
      return reply.code(404).send({ error: "unknown run", code: "NOT_FOUND" });
    }
    const row = database
      .prepare(
        "SELECT id, generation_id, edited, duration_s, state, started_at, ended_at, events_count, bytes, dropped, exit_reason FROM runs WHERE id = ?",
      )
      .get(id) as
      | {
          id: string;
          generation_id: string | null;
          edited: number;
          duration_s: number;
          state: string;
          started_at: number;
          ended_at: number | null;
          events_count: number;
          bytes: number;
          dropped: number;
          exit_reason: string | null;
        }
      | undefined;
    if (row === undefined) {
      return reply.code(404).send({ error: "unknown run", code: "NOT_FOUND" });
    }
    // script_text stays out of this response: metadata and the summary only.
    return reply.send(
      GetRunResponseSchema.parse({
        run_id: row.id,
        state: row.state,
        duration_s: row.duration_s,
        started_at: row.started_at,
        ended_at: row.ended_at,
        generation_id: row.generation_id,
        edited: row.edited === 1,
        summary:
          row.exit_reason === null
            ? null
            : {
                events_count: row.events_count,
                bytes: row.bytes,
                dropped: row.dropped,
                exit_reason: row.exit_reason,
              },
      }),
    );
  });

  app.get(
    "/ws/runs/:id",
    {
      websocket: true,
      preHandler: async (req, reply) => {
        const { id } = req.params as { id: string };
        if (!isSafeId(id)) {
          return reply.code(400).send({
            error: "Invalid run ID format",
            code: "VALIDATION_FAILED",
          });
        }
      },
    },
    (socket: WebSocket, req: FastifyRequest) => {
      const { id } = req.params as { id: string };
      let token: string;
      try {
        token = readAgentToken(opts.tokenFile);
      } catch {
        socket.send(
          JSON.stringify({ error: "agent offline", code: "AGENT_OFFLINE" }),
        );
        socket.close();
        return;
      }
      const upstream = new WebSocket(
        agentWsUrl(opts.agentUrl, `/v1/runs/${encodeURIComponent(id)}/stream`),
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      const closeUpstream = (): void => {
        try {
          upstream.close();
        } catch {
          /* already closed */
        }
      };
      upstream.on("message", (data) => {
        if (socket.readyState !== WebSocket.OPEN) return;
        const text = data.toString();
        try {
          const envelope = EventEnvelopeSchema.parse(JSON.parse(text));
          if (envelope.kind === "summary") {
            recordRunSummary(id, envelope.data);
          }
        } catch {
          return;
        }
        socket.send(text);
      });
      upstream.on("error", () => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(
            JSON.stringify({ error: "agent offline", code: "AGENT_OFFLINE" }),
          );
        }
        socket.close();
      });
      socket.on("message", (data) => {
        if (upstream.readyState !== WebSocket.OPEN) return;
        const text = data.toString();
        try {
          const msg = JSON.parse(text) as { type?: unknown };
          if (msg.type !== "stop") return;
        } catch {
          return;
        }
        markRunStopping(id);
        upstream.send(text);
      });
      const closeBoth = (): void => {
        closeUpstream();
        try {
          socket.close();
        } catch {
          /* already closed */
        }
      };
      socket.on("close", closeBoth);
      socket.on("error", closeBoth);
      upstream.on("close", () => {
        try {
          socket.close();
        } catch {
          /* already closed */
        }
      });
    },
  );

  app.setErrorHandler((err, _req, reply) => {
    if (typeof err === "object" && err !== null && "validation" in err) {
      return reply
        .code(400)
        .send({ error: "invalid request", code: "VALIDATION_FAILED" });
    }
    app.log.error({ err }, "unhandled error");
    if (reply.sent) return;
    return reply.code(500).send({ error: "internal error", code: "INTERNAL" });
  });

  return app;
}
