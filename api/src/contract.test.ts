import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type IncomingMessage, type Server } from "node:http";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";

import { buildApp } from "./server.js";

const TOKEN = "test-token-123";
const HEALTH = {
  kernel: "6.8-test",
  bpftrace_version: "bpftrace v0.21",
  btf: true,
  root: false,
  tracefs: true,
  uptime_s: 42,
};

interface FakeAgent {
  url: string;
  validateHits: () => number;
  close: () => Promise<void>;
}

function startFakeAgent(): Promise<FakeAgent> {
  let validateHits = 0;
  let activeRun: string | null = null;

  const server: Server = createServer((req, res) => {
    const send = (code: number, body: unknown): void => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      send(401, { error: "unauthorized", code: "UNAUTHORIZED" });
      return;
    }
    const url = new URL(req.url ?? "/", "http://x");
    if (req.method === "GET" && url.pathname === "/health") {
      send(200, HEALTH);
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/validate") {
      validateHits += 1;
      let raw = "";
      req.on("data", (c) => {
        raw += c;
      });
      req.on("end", () => {
        const body = JSON.parse(raw as string) as { script?: string };
        if ((body.script ?? "").includes("bad-probe")) {
          send(200, {
            ok: false,
            errors: ["probe not found: bad-probe"],
            probes: [],
          });
        } else {
          send(200, { ok: true, errors: [], probes: ["BEGIN"] });
        }
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/runs") {
      let raw = "";
      req.on("data", (c) => {
        raw += c;
      });
      req.on("end", () => {
        const body = JSON.parse(raw as string) as { script?: string };
        if ((body.script ?? "").includes("bad-probe")) {
          send(400, { error: "probe not found", code: "VALIDATION_FAILED" });
        } else if (activeRun !== null) {
          send(409, { error: "another run is active", code: "LIMIT_EXCEEDED" });
        } else {
          activeRun = `run_${Date.now()}`;
          send(201, { run_id: activeRun, state: "running" });
        }
      });
      return;
    }
    const del = /^\/v1\/runs\/([^/]+)$/.exec(url.pathname);
    if (req.method === "DELETE" && del !== null) {
      if (activeRun !== null && del[1] === activeRun) {
        const id = activeRun;
        activeRun = null;
        send(200, { run_id: id, state: "stopping" });
      } else {
        send(404, { error: "unknown run", code: "NOT_FOUND" });
      }
      return;
    }
    send(404, { error: "not found", code: "NOT_FOUND" });
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? "/", "http://x");
    const m = /^\/v1\/runs\/([^/]+)\/stream$/.exec(url.pathname);
    if (m === null || req.headers.authorization !== `Bearer ${TOKEN}`) {
      socket.destroy();
      return;
    }
    const runId = m[1] ?? "";
    wss.handleUpgrade(req, socket, head, (ws) => {
      const seq = (n: number): number => n;
      const send = (kind: string, data: unknown, n: number): void => {
        ws.send(
          JSON.stringify({
            run_id: runId,
            seq: seq(n),
            ts: 1_700_000_000_000 + n,
            kind,
            data,
          }),
        );
      };
      send("status", { state: "running" }, 0);
      send("printf", "hello", 1);
      send(
        "summary",
        {
          events: 1,
          bytes: 5,
          dropped: 0,
          duration_ms: 10,
          exit_reason: "completed",
        },
        2,
      );
      ws.on("message", () => {
        ws.close();
      });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        validateHits: () => validateHits,
        close: () =>
          new Promise<void>((done) => {
            wss.close();
            server.close(() => done());
          }),
      });
    });
  });
}

let dir = "";
let tokenFile = "";
let fake: FakeAgent;
let app: FastifyInstance;
let base = "";

const recipesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "recipes",
);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "vbpf-api-"));
  tokenFile = join(dir, "agent.token");
  writeFileSync(tokenFile, TOKEN + "\n");
  fake = await startFakeAgent();
  app = await buildApp({
    agentUrl: fake.url,
    tokenFile,
    dbPath: join(dir, "api.sqlite3"),
    recipesDir,
    webOrigin: "http://localhost:5173",
  });
  const addr = await app.listen({ host: "127.0.0.1", port: 0 });
  base = addr.replace("[::1]", "127.0.0.1");
}, 30000);

afterAll(async () => {
  await app?.close();
  await fake?.close();
  if (dir !== "") rmSync(dir, { recursive: true, force: true });
});

describe("validate proxy", () => {
  it("forwards agent envelope verbatim", async () => {
    const res = await fetch(`${base}/api/validate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ script: "BEGIN { @x = count(); }" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      errors: [],
      probes: ["BEGIN"],
    });
  });

  it("forwards agent rejection verbatim", async () => {
    const res = await fetch(`${base}/api/validate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ script: "bad-probe { @x = count(); }" }),
    });
    expect(await res.json()).toEqual({
      ok: false,
      errors: ["probe not found: bad-probe"],
      probes: [],
    });
  });

  it("rejects --unsafe locally without contacting agent", async () => {
    const before = fake.validateHits();
    const res = await fetch(`${base}/api/validate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ script: "BEGIN { @x = count(); } --unsafe" }),
    });
    expect(res.status).toBe(400);
    expect(fake.validateHits()).toBe(before);
  });
});

describe("runs proxy", () => {
  it("rejects out-of-range duration", async () => {
    for (const duration_s of [0, 61]) {
      const res = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ script: "BEGIN { @x = count(); }", duration_s }),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "VALIDATION_FAILED" });
    }
  });

  it("creates, enforces 409, stops, recreates", async () => {
    const first = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        script: "BEGIN { @x = count(); }",
        duration_s: 10,
      }),
    });
    expect(first.status).toBe(201);
    const created = (await first.json()) as { run_id: string };
    expect(created.run_id).toMatch(/^run_/);

    const clash = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        script: "BEGIN { @x = count(); }",
        duration_s: 10,
      }),
    });
    expect(clash.status).toBe(409);
    expect(await clash.json()).toMatchObject({ code: "LIMIT_EXCEEDED" });

    const stop = await fetch(`${base}/api/runs/${created.run_id}/stop`, {
      method: "POST",
    });
    expect(stop.status).toBe(200);
    expect(await stop.json()).toMatchObject({ run_id: created.run_id });

    const again = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ script: "BEGIN { @x = count(); }" }),
    });
    expect(again.status).toBe(201);
    const second = (await again.json()) as { run_id: string };
    await fetch(`${base}/api/runs/${second.run_id}/stop`, { method: "POST" });
  });

  it("proxies unknown stop id as 404", async () => {
    const res = await fetch(`${base}/api/runs/nope/stop`, { method: "POST" });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("websocket relay", () => {
  it("preserves agent envelope", async () => {
    const created = (await (
      await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ script: "BEGIN { @x = count(); }" }),
      })
    ).json()) as { run_id: string };
    const wsUrl = `${base.replace(/^http/, "ws")}/ws/runs/${created.run_id}`;
    const kinds: string[] = [];
    let runId = "";
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.on("message", (data) => {
        const ev = JSON.parse(data.toString()) as {
          run_id: string;
          seq: number;
          ts: number;
          kind: string;
          data: unknown;
        };
        runId = ev.run_id;
        kinds.push(ev.kind);
        expect(ev.run_id).toBe(created.run_id);
        expect(ev.seq).toBeGreaterThanOrEqual(0);
        if (kinds.length === 3) {
          ws.close();
          resolve();
        }
      });
      ws.on("error", reject);
      setTimeout(() => reject(new Error("ws timeout")), 10000);
    });
    expect(runId).toBe(created.run_id);
    expect(kinds).toEqual(["status", "printf", "summary"]);
    await fetch(`${base}/api/runs/${created.run_id}/stop`, { method: "POST" });
  });
});

describe("health and recipes", () => {
  it("aggregates agent health", async () => {
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      agent: { reachable: true, health: HEALTH },
    });
  });

  it("searches FTS5 recipes", async () => {
    const res = await fetch(`${base}/api/recipes?q=cpu`);
    const body = (await res.json()) as { recipes: Array<{ id: string }> };
    expect(body.recipes.map((r) => r.id)).toContain("cpu-by-process");
    const all = (await (await fetch(`${base}/api/recipes`)).json()) as {
      recipes: unknown[];
    };
    expect(all.recipes.length).toBeGreaterThanOrEqual(10);
  });

  it("rejects foreign origin", async () => {
    const res = await fetch(`${base}/api/health`, {
      headers: { origin: "http://evil.example" },
    });
    expect(res.status).toBe(403);
  });
});

describe("agent offline", () => {
  it("reports AGENT_OFFLINE", async () => {
    const offline = await buildApp({
      agentUrl: "http://127.0.0.1:1",
      tokenFile,
      dbPath: ":memory:",
      recipesDir,
      webOrigin: "http://localhost:5173",
    });
    const addr = await offline.listen({ host: "127.0.0.1", port: 0 });
    const url = addr.replace("[::1]", "127.0.0.1");
    try {
      const health = await fetch(`${url}/api/health`);
      expect(await health.json()).toMatchObject({
        ok: true,
        agent: { reachable: false, code: "AGENT_OFFLINE" },
      });
      const validate = await fetch(`${url}/api/validate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ script: "BEGIN { @x = count(); }" }),
      });
      expect(validate.status).toBe(503);
      expect(await validate.json()).toMatchObject({ code: "AGENT_OFFLINE" });
      const run = await fetch(`${url}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ script: "BEGIN { @x = count(); }" }),
      });
      expect(run.status).toBe(503);
    } finally {
      await offline.close();
    }
  });
});
