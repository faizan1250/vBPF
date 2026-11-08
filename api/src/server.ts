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
  CreateRunRequestSchema,
  CreateRunResponseSchema,
  EventEnvelopeSchema,
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
} from "./agent-client.js";
import { indexRecipes, migrate, openDb, searchRecipes } from "./db.js";
import { loadRecipes } from "./recipes.js";

export interface AppOptions {
  agentUrl: string;
  tokenFile: string;
  dbPath: string;
  recipesDir: string;
  webOrigin: string;
}

const BODY_LIMIT = 64 * 1024;
const DEFAULT_DURATION_S = 10;

function agentWsUrl(agentUrl: string, path: string): string {
  const base = agentUrl.replace(/\/$/, "").replace(/^http/, "ws");
  return base + path;
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
    return reply.code(res.status).send(json) as never;
  } catch {
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

  app.addHook("onClose", async () => {
    database.close();
  });

  await app.register(cors, { origin: opts.webOrigin, credentials: false });
  await app.register(websocket);

  app.addHook("onRequest", async (req, reply) => {
    const origin = req.headers.origin;
    if (typeof origin === "string" && origin !== opts.webOrigin) {
      return reply
        .code(403)
        .send({ error: "forbidden origin", code: "FORBIDDEN" });
    }
  });

  app.get("/api/health", async (_req, reply) => {
    try {
      const health = await fetchAgentHealth(opts.agentUrl, opts.tokenFile);
      return reply.send(
        HealthResponseSchema.parse({
          ok: true,
          agent: { reachable: true, health },
        }),
      );
    } catch (err) {
      if (err instanceof AgentOfflineError || err instanceof AgentProxyError) {
        return reply.send(
          HealthResponseSchema.parse({
            ok: true,
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
    "/api/validate",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const parsed = ValidateRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "invalid request", code: "VALIDATION_FAILED" });
      }
      if (parsed.data.script.includes("--unsafe")) {
        return reply
          .code(400)
          .send({ ok: false, errors: ["--unsafe is forbidden"], probes: [] });
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
        return reply.code(res.status).send(text);
      }
      if (!res.ok) return reply.code(res.status).send(json);
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
      database
        .prepare(
          "INSERT INTO runs (id, script_sha256, script_text, duration_s, state, started_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          created.run_id,
          createHash("sha256").update(script).digest("hex"),
          script,
          duration,
          created.state,
          Date.now(),
        );
    } catch (err) {
      app.log.error({ err }, "run insert failed");
    }
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
          `/v1/runs/${id}`,
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
      try {
        database
          .prepare("UPDATE runs SET state = ? WHERE id = ?")
          .run(stopped.state, stopped.run_id);
      } catch (err) {
        app.log.error({ err }, "run stop update failed");
      }
      return reply.send(stopped);
    },
  );

  app.get(
    "/ws/runs/:id",
    { websocket: true },
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
        agentWsUrl(opts.agentUrl, `/v1/runs/${id}/stream`),
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
          EventEnvelopeSchema.parse(JSON.parse(text));
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
    throw err;
  });

  return app;
}
