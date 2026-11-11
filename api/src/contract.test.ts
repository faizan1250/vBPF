import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createServer,
  IncomingMessage,
  request,
  ServerResponse,
  type IncomingHttpHeaders,
  type OutgoingHttpHeaders,
  type Server,
} from "node:http";
import { createConnection, Socket } from "node:net";
import { PassThrough } from "node:stream";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";

import { buildApp, healthWarnings, isSafeId } from "./server.js";

const TOKEN = "test-token-123";
const HEALTH = {
  kernel: "6.8-test",
  bpftrace_version: "bpftrace v0.21",
  btf: true,
  root: false,
  tracefs: true,
  uptime_s: 42,
  ready: true,
  catalog: {
    state: "ready" as const,
    probes: 5,
    warnings: [],
  },
};

interface FakeAgent {
  url: string;
  validateHits: () => number;
  close: () => Promise<void>;
}

function startFakeAgent(): Promise<FakeAgent> {
  let validateHits = 0;
  let activeRun: string | null = null;
  let activeRunScript = "";

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
    if (req.method === "GET" && url.pathname === "/v1/probe-args") {
      const probe = url.searchParams.get("probe") ?? "";
      if (probe === "tracepoint:block:block_rq_issue") {
        send(200, {
          probe,
          output: `${probe}\n  unsigned long sector;\n`,
        });
      } else {
        send(404, { error: "unknown probe", code: "NOT_FOUND" });
      }
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
            warnings: [],
            probe_count: 0,
          });
        } else {
          send(200, {
            ok: true,
            errors: [],
            probes: ["BEGIN"],
            warnings: [],
            probe_count: 1,
          });
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
          activeRunScript = body.script ?? "";
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
      if (activeRunScript.includes("stay-running")) {
        send("status", { state: "running" }, 0);
        ws.on("message", () => {
          ws.close();
        });
        return;
      }
      if (activeRunScript.includes("stream-drop")) {
        send("status", { state: "running" }, 0);
        ws.close();
        return;
      }
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

// node:http honors an explicit Host header (undici fetch does not), so Host
// and raw header gate tests use this instead of fetch.
function requestRaw(
  url: string,
  opts: {
    method?: string;
    headers?: OutgoingHttpHeaders;
    body?: string;
  } = {},
): Promise<{ status: number; headers: IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      { method: opts.method ?? "GET", headers: opts.headers },
      (res) => {
        res.resume();
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers }),
        );
      },
    );
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

function getWithHost(url: string, host: string): Promise<number> {
  return requestRaw(url, { headers: { host } }).then((r) => r.status);
}

function sendRawHttp(
  url: string,
  payload: string,
): Promise<{ status: number; rawHeaders: string }> {
  const { hostname, port } = new URL(url);
  return new Promise((resolve, reject) => {
    const sock = createConnection(Number(port), hostname, () => {
      sock.write(payload);
    });
    let data = "";
    sock.on("data", (chunk) => {
      data += chunk.toString();
    });
    sock.on("end", () => {
      const m = /^HTTP\/\d\.\d\s+(\d+)/.exec(data);
      const rawHeaders = data.split("\r\n\r\n")[0] ?? "";
      resolve({ status: m ? Number(m[1]) : 0, rawHeaders });
    });
    sock.on("error", reject);
  });
}

function wsUpgradeRejected(
  wsUrl: string,
  headers: OutgoingHttpHeaders,
): Promise<{ status: number; headers: IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(wsUrl, { headers });
    ws.on("unexpected-response", (_req, res) => {
      res.resume();
      res.on("end", () => {
        settled = true;
        ws.terminate();
        resolve({ status: res.statusCode ?? 0, headers: res.headers });
      });
    });
    ws.on("open", () => {
      settled = true;
      ws.close();
      reject(new Error("expected websocket upgrade rejection"));
    });
    ws.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
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

describe("probe-args contract", () => {
  it("fetches -vl output for a known probe", async () => {
    const { fetchProbeArgs } = await import("./agent-client.js");
    const output = await fetchProbeArgs(
      fake.url,
      tokenFile,
      "tracepoint:block:block_rq_issue",
    );
    expect(output).toContain("sector");
  });

  it("rejects unknown probe names", async () => {
    const { fetchProbeArgs } = await import("./agent-client.js");
    await expect(
      fetchProbeArgs(fake.url, tokenFile, "tracepoint:foo:bar; rm -rf /"),
    ).rejects.toThrow();
  });
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
      warnings: [],
      probe_count: 1,
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
      warnings: [],
      probe_count: 0,
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

  it("propagates insertRun failure as 500 and releases agent slot", async () => {
    const { default: Database } = await import("better-sqlite3");
    const testDb = new Database(join(dir, "api.sqlite3"));
    try {
      testDb.exec(
        "CREATE TRIGGER fail_runs BEFORE INSERT ON runs BEGIN SELECT RAISE(FAIL, 'simulated disk failure'); END;",
      );
      const res = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ script: "BEGIN { @x = count(); }" }),
      });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({
        error: "failed to persist run",
        code: "INTERNAL_ERROR",
      });
      testDb.exec("DROP TRIGGER fail_runs;");

      const next = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ script: "BEGIN { @x = count(); }" }),
      });
      expect(next.status).toBe(201);
      const created = (await next.json()) as { run_id: string };
      await fetch(`${base}/api/runs/${created.run_id}/stop`, {
        method: "POST",
      });
    } finally {
      try {
        testDb.exec("DROP TRIGGER IF EXISTS fail_runs;");
      } catch {
        /* ignore */
      }
      testDb.close();
    }
  });

  it("proxies unknown stop id as 404", async () => {
    const res = await fetch(`${base}/api/runs/nope/stop`, { method: "POST" });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("run summaries", () => {
  it("persists the summary on stream end and serves it via GET", async () => {
    const created = (await (
      await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          script: "BEGIN { @x = count(); }",
          duration_s: 10,
        }),
      })
    ).json()) as { run_id: string };
    try {
      const wsUrl = `${base.replace(/^http/, "ws")}/ws/runs/${created.run_id}`;
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        ws.on("message", (data) => {
          const ev = JSON.parse(data.toString()) as { kind: string };
          if (ev.kind === "summary") {
            ws.close();
            resolve();
          }
        });
        ws.on("error", reject);
        setTimeout(() => reject(new Error("ws timeout")), 10000);
      });
      const res = await fetch(`${base}/api/runs/${created.run_id}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({
        run_id: created.run_id,
        state: "completed",
        duration_s: 10,
        started_at: expect.any(Number),
        ended_at: expect.any(Number),
        generation_id: null,
        edited: false,
        summary: {
          events_count: 1,
          bytes: 5,
          dropped: 0,
          exit_reason: "completed",
        },
      });
      expect(body).not.toHaveProperty("script_text");
    } finally {
      await fetch(`${base}/api/runs/${created.run_id}/stop`, {
        method: "POST",
      });
    }
  });

  it("marks stopping with ended_at on stop", async () => {
    const created = (await (
      await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          script: "BEGIN { @x = count(); } stay-running",
        }),
      })
    ).json()) as { run_id: string };
    const stop = await fetch(`${base}/api/runs/${created.run_id}/stop`, {
      method: "POST",
    });
    expect(stop.status).toBe(200);
    const res = await fetch(`${base}/api/runs/${created.run_id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      run_id: created.run_id,
      state: "stopping",
      summary: null,
    });
    expect(body.ended_at).toEqual(expect.any(Number));
    expect(body).not.toHaveProperty("script_text");
  });

  it("persists summary for headless runs without websocket client", async () => {
    const created = (await (
      await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ script: "BEGIN { @x = count(); }" }),
      })
    ).json()) as { run_id: string };
    try {
      let state = "";
      let body: { state?: string; summary?: unknown } = {};
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const res = await fetch(`${base}/api/runs/${created.run_id}`);
        body = (await res.json()) as typeof body;
        state = body.state ?? "";
        if (state === "completed") break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(state).toBe("completed");
      expect(body.summary).toEqual({
        events_count: 1,
        bytes: 5,
        dropped: 0,
        exit_reason: "completed",
      });
    } finally {
      await fetch(`${base}/api/runs/${created.run_id}/stop`, {
        method: "POST",
      });
    }
  });

  it("transitions run to failed when stream terminates without summary", async () => {
    const created = (await (
      await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ script: "BEGIN { @x = count(); } stream-drop" }),
      })
    ).json()) as { run_id: string };
    try {
      let state = "";
      let body: { state?: string; summary?: unknown } = {};
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const res = await fetch(`${base}/api/runs/${created.run_id}`);
        body = (await res.json()) as typeof body;
        state = body.state ?? "";
        if (state === "failed") break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(state).toBe("failed");
      expect(body.summary).toBeNull();
    } finally {
      await fetch(`${base}/api/runs/${created.run_id}/stop`, {
        method: "POST",
      });
    }
  });

  it("handles agent without websocket support cleanly and transitions run to failed", async () => {
    let httpOnlyServer: Server | null = null;
    const httpOnlyUrl = await new Promise<string>((resolve) => {
      httpOnlyServer = createServer((req, res) => {
        const send = (code: number, payload: unknown): void => {
          res.writeHead(code, { "content-type": "application/json" });
          res.end(JSON.stringify(payload));
        };
        const url = new URL(req.url ?? "/", "http://x");
        if (req.method === "GET" && url.pathname === "/health") {
          send(200, HEALTH);
          return;
        }
        if (req.method === "POST" && url.pathname === "/v1/runs") {
          send(201, { run_id: `run_http_${Date.now()}`, state: "running" });
          return;
        }
        send(404, { error: "not found" });
      });
      httpOnlyServer.listen(0, "127.0.0.1", () => {
        const addr = httpOnlyServer?.address();
        const port = typeof addr === "object" && addr !== null ? addr.port : 0;
        resolve(`http://127.0.0.1:${port}`);
      });
    });

    const httpOnlyApp = await buildApp({
      agentUrl: httpOnlyUrl,
      tokenFile,
      dbPath: ":memory:",
      recipesDir,
      webOrigin: "http://localhost:5173",
    });
    const addr = await httpOnlyApp.listen({ host: "127.0.0.1", port: 0 });
    const localBase = addr.replace("[::1]", "127.0.0.1");

    try {
      const res = await fetch(`${localBase}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ script: "BEGIN { @x = count(); }" }),
      });
      expect(res.status).toBe(201);
      const created = (await res.json()) as { run_id: string };

      let state = "";
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const check = await fetch(`${localBase}/api/runs/${created.run_id}`);
        const body = (await check.json()) as { state: string };
        state = body.state;
        if (state === "failed") break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(state).toBe("failed");
    } finally {
      await httpOnlyApp.close();
      await new Promise<void>((resolve) =>
        httpOnlyServer?.close(() => resolve()),
      );
    }
  });

  it("teardown terminates active observer sockets on Fastify close without hanging", async () => {
    let teardownServer: Server | null = null;
    let teardownWs: WebSocket | null = null;
    const teardownUrl = await new Promise<string>((resolve) => {
      teardownServer = createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://x");
        if (req.method === "POST" && url.pathname === "/v1/runs") {
          res.writeHead(201, { "content-type": "application/json" });
          res.end(JSON.stringify({ run_id: "run_teardown", state: "running" }));
          return;
        }
        res.writeHead(404);
        res.end();
      });
      const wss = new WebSocketServer({ noServer: true });
      teardownServer.on("upgrade", (req, socket, head) => {
        wss.handleUpgrade(req, socket, head, (ws) => {
          teardownWs = ws;
          ws.send(
            JSON.stringify({ kind: "status", data: { state: "running" } }),
          );
        });
      });
      teardownServer.listen(0, "127.0.0.1", () => {
        const addr = teardownServer?.address();
        const port = typeof addr === "object" && addr !== null ? addr.port : 0;
        resolve(`http://127.0.0.1:${port}`);
      });
    });

    const testApp = await buildApp({
      agentUrl: teardownUrl,
      tokenFile,
      dbPath: ":memory:",
      recipesDir,
      webOrigin: "http://localhost:5173",
    });
    const addr = await testApp.listen({ host: "127.0.0.1", port: 0 });
    const localBase = addr.replace("[::1]", "127.0.0.1");

    const res = await fetch(`${localBase}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ script: "BEGIN { @x = count(); }" }),
    });
    expect(res.status).toBe(201);

    const deadline = Date.now() + 2000;
    while (!teardownWs && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }

    await expect(testApp.close()).resolves.toBeUndefined();
    await new Promise<void>((resolve) =>
      teardownServer?.close(() => resolve()),
    );
  });

  it("404s unknown run id", async () => {
    const res = await fetch(`${base}/api/runs/nope`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("run generation links", () => {
  async function freshGeneration(): Promise<{
    generation_id: string;
    script: string;
  }> {
    const res = await fetch(`${base}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "Which processes are using the most CPU?",
      }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { generation_id: string; script: string };
  }

  it("links an unedited script to its generation", async () => {
    const gen = await freshGeneration();
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        script: gen.script,
        generation_id: gen.generation_id,
      }),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { run_id: string };
    try {
      const got = await fetch(`${base}/api/runs/${created.run_id}`);
      expect(await got.json()).toMatchObject({
        run_id: created.run_id,
        generation_id: gen.generation_id,
        edited: false,
      });
    } finally {
      await fetch(`${base}/api/runs/${created.run_id}/stop`, {
        method: "POST",
      });
    }
  });

  it("marks an edited script", async () => {
    const gen = await freshGeneration();
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        script: `${gen.script}\n`,
        generation_id: gen.generation_id,
      }),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { run_id: string };
    try {
      const got = await fetch(`${base}/api/runs/${created.run_id}`);
      expect(await got.json()).toMatchObject({
        run_id: created.run_id,
        generation_id: gen.generation_id,
        edited: true,
      });
    } finally {
      await fetch(`${base}/api/runs/${created.run_id}/stop`, {
        method: "POST",
      });
    }
  });

  it("rejects an unknown generation id without consuming the run slot", async () => {
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        script: "BEGIN { @x = count(); }",
        generation_id: "gen_nope",
      }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Invalid generation ID",
      code: "VALIDATION_FAILED",
    });
    const retry = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ script: "BEGIN { @x = count(); }" }),
    });
    expect(retry.status).toBe(201);
    const created = (await retry.json()) as { run_id: string };
    await fetch(`${base}/api/runs/${created.run_id}/stop`, {
      method: "POST",
    });
  });

  it("keeps agent re-validation for bound scripts", async () => {
    const gen = await freshGeneration();
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        script: "bad-probe { @x = count(); }",
        generation_id: gen.generation_id,
      }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "VALIDATION_FAILED" });
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

  it("validates run IDs with isSafeId", () => {
    expect(isSafeId("run_123")).toBe(true);
    expect(isSafeId("run_1700000000_abc")).toBe(true);
    expect(isSafeId("valid-id_42")).toBe(true);
    expect(isSafeId("")).toBe(false);
    expect(isSafeId(null)).toBe(false);
    expect(isSafeId(undefined)).toBe(false);
    expect(isSafeId(123)).toBe(false);
    expect(isSafeId("../escape")).toBe(false);
    expect(isSafeId("run with spaces")).toBe(false);
    expect(isSafeId("run$evil")).toBe(false);
    expect(isSafeId("run\0")).toBe(false);
    expect(isSafeId("a".repeat(129))).toBe(false);
  });

  it("rejects unsafe run ID before websocket upgrade with 400", async () => {
    const wsBase = base.replace(/^http/, "ws");
    const httpRes = await fetch(`${base}/ws/runs/invalid..id`, {
      headers: { origin: "http://localhost:5173" },
    });
    expect(httpRes.status).toBe(400);
    expect(await httpRes.json()).toEqual({
      error: "Invalid run ID format",
      code: "VALIDATION_FAILED",
    });

    const rejected = await wsUpgradeRejected(`${wsBase}/ws/runs/invalid..id`, {
      origin: "http://localhost:5173",
    });
    expect(rejected.status).toBe(400);
  });

  it("ensures host and origin checks precede run ID validation on ws routes", async () => {
    const wsBase = base.replace(/^http/, "ws");
    const badHost = await wsUpgradeRejected(`${wsBase}/ws/runs/invalid..id`, {
      host: "evil.example",
      origin: "http://localhost:5173",
    });
    expect(badHost.status).toBe(403);

    const badOrigin = await wsUpgradeRejected(`${wsBase}/ws/runs/invalid..id`, {
      origin: "http://evil.example",
    });
    expect(badOrigin.status).toBe(403);
  });
});

describe("health and recipes", () => {
  it("aggregates agent health", async () => {
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      llm: { mode: "mock", providers: [] },
      agent: { reachable: true, health: HEALTH, warnings: ["NO_PRIVILEGE"] },
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
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("rejects non-loopback host", async () => {
    const res = await requestRaw(`${base}/api/health`, {
      headers: { host: "evil.example", origin: "http://localhost:5173" },
    });
    expect(res.status).toBe(403);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("allows loopback hosts with any port", async () => {
    for (const host of ["127.0.0.1:1", "localhost:5173", "[::1]:8080"]) {
      expect(await getWithHost(`${base}/api/health`, host), host).toBe(200);
    }
  });

  it("rejects malformed host ports", async () => {
    for (const host of [
      "localhost:evil",
      "localhost:",
      "127.0.0.1:abc",
      "[::1]:evil",
      "[::1]:",
    ]) {
      expect(await getWithHost(`${base}/api/health`, host), host).toBe(403);
    }
    const emptyHost = await sendRawHttp(
      base,
      "GET /api/health HTTP/1.1\r\nHost:\r\nConnection: close\r\n\r\n",
    );
    expect(emptyHost.status).toBe(403);
  });

  it("rejects non-string array origin header", async () => {
    const wire = await sendRawHttp(
      base,
      "GET /api/health HTTP/1.1\r\nHost: localhost:5173\r\nOrigin: http://localhost:5173\r\nOrigin: http://localhost:5173\r\nConnection: close\r\n\r\n",
    );
    expect(wire.status).toBe(403);
    expect(wire.rawHeaders.toLowerCase()).not.toContain(
      "access-control-allow-origin",
    );

    const sock = new Socket();
    const req = new IncomingMessage(sock);
    req.method = "GET";
    req.url = "/api/health";
    req.headers = {
      host: "localhost:5173",
      origin: ["http://localhost:5173"] as unknown as string,
    };
    const out = Object.assign(new PassThrough(), {
      cork: () => {},
      uncork: () => {},
    });
    out.resume();
    const res = new ServerResponse(req);
    res.assignSocket(out as unknown as Socket);
    await new Promise<void>((resolve) => {
      res.on("finish", resolve);
      app.server.emit("request", req, res);
    });
    sock.destroy();
    out.destroy();
    expect(res.statusCode).toBe(403);
    expect(res.getHeader("access-control-allow-origin")).toBeUndefined();
  });

  it("blocks Sec-Fetch-Site cross-site and allows same-origin or absent", async () => {
    const blocked = await requestRaw(`${base}/api/health`, {
      headers: {
        origin: "http://localhost:5173",
        "sec-fetch-site": "cross-site",
      },
    });
    expect(blocked.status).toBe(403);
    expect(blocked.headers["access-control-allow-origin"]).toBeUndefined();

    const mixedCase = await requestRaw(`${base}/api/health`, {
      headers: { "sec-fetch-site": "Cross-Site" },
    });
    expect(mixedCase.status).toBe(403);

    const sameOrigin = await requestRaw(`${base}/api/health`, {
      headers: { "sec-fetch-site": "same-origin" },
    });
    expect(sameOrigin.status).toBe(200);

    const absent = await requestRaw(`${base}/api/health`);
    expect(absent.status).toBe(200);
  });

  it("enforces host and origin gates on OPTIONS preflight without ACAO", async () => {
    const badHost = await requestRaw(`${base}/api/runs`, {
      method: "OPTIONS",
      headers: {
        host: "evil.example",
        origin: "http://localhost:5173",
        "access-control-request-method": "POST",
      },
    });
    expect(badHost.status).toBe(403);
    expect(badHost.headers["access-control-allow-origin"]).toBeUndefined();

    const badOrigin = await requestRaw(`${base}/api/runs`, {
      method: "OPTIONS",
      headers: {
        origin: "http://evil.example",
        "access-control-request-method": "POST",
      },
    });
    expect(badOrigin.status).toBe(403);
    expect(badOrigin.headers["access-control-allow-origin"]).toBeUndefined();

    const allowed = await requestRaw(`${base}/api/runs`, {
      method: "OPTIONS",
      headers: {
        host: "localhost:5173",
        origin: "http://localhost:5173",
        "access-control-request-method": "POST",
      },
    });
    expect(allowed.status).toBe(204);
    expect(allowed.headers["access-control-allow-origin"]).toBe(
      "http://localhost:5173",
    );
  });

  it("rejects POST /api/runs with non-loopback host or foreign origin", async () => {
    const body = JSON.stringify({ script: "BEGIN { @x = count(); }" });
    const badHost = await requestRaw(`${base}/api/runs`, {
      method: "POST",
      headers: {
        host: "evil.example",
        origin: "http://localhost:5173",
        "content-type": "application/json",
      },
      body,
    });
    expect(badHost.status).toBe(403);
    expect(badHost.headers["access-control-allow-origin"]).toBeUndefined();

    const badOrigin = await requestRaw(`${base}/api/runs`, {
      method: "POST",
      headers: {
        origin: "http://evil.example",
        "content-type": "application/json",
      },
      body,
    });
    expect(badOrigin.status).toBe(403);
    expect(badOrigin.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("enforces host and origin gates on /ws/runs/:id upgrades", async () => {
    const wsBase = base.replace(/^http/, "ws");
    const badHost = await wsUpgradeRejected(`${wsBase}/ws/runs/run_test`, {
      host: "evil.example",
      origin: "http://localhost:5173",
    });
    expect(badHost.status).toBe(403);
    expect(badHost.headers["access-control-allow-origin"]).toBeUndefined();

    const badOrigin = await wsUpgradeRejected(`${wsBase}/ws/runs/run_test`, {
      origin: "http://evil.example",
    });
    expect(badOrigin.status).toBe(403);
    expect(badOrigin.headers["access-control-allow-origin"]).toBeUndefined();

    const crossSite = await wsUpgradeRejected(`${wsBase}/ws/runs/run_test`, {
      origin: "http://localhost:5173",
      "sec-fetch-site": "cross-site",
    });
    expect(crossSite.status).toBe(403);
    expect(crossSite.headers["access-control-allow-origin"]).toBeUndefined();

    const created = (await (
      await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ script: "BEGIN { @x = count(); }" }),
      })
    ).json()) as { run_id: string };
    try {
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`${wsBase}/ws/runs/${created.run_id}`, {
          headers: { origin: "http://localhost:5173" },
        });
        ws.on("message", (data) => {
          const ev = JSON.parse(data.toString()) as { kind: string };
          if (ev.kind === "summary") {
            ws.close();
            resolve();
          }
        });
        ws.on("error", reject);
        setTimeout(() => reject(new Error("ws timeout")), 10000);
      });
    } finally {
      await fetch(`${base}/api/runs/${created.run_id}/stop`, {
        method: "POST",
      });
    }
  });
});

describe("health warnings", () => {
  it("maps missing privileges and BTF to taxonomy codes", () => {
    expect(
      healthWarnings({
        ...HEALTH,
        root: true,
        btf: true,
        tracefs: true,
      }),
    ).toEqual([]);
    expect(healthWarnings({ ...HEALTH, root: false })).toEqual([
      "NO_PRIVILEGE",
    ]);
    expect(healthWarnings({ ...HEALTH, root: true, btf: false })).toEqual([
      "KERNEL_UNSUPPORTED",
    ]);
    expect(healthWarnings({ ...HEALTH, root: true, tracefs: false })).toEqual([
      "KERNEL_UNSUPPORTED",
    ]);
    expect(healthWarnings({ ...HEALTH, root: false, btf: false })).toEqual([
      "NO_PRIVILEGE",
      "KERNEL_UNSUPPORTED",
    ]);
    expect(healthWarnings({ ...HEALTH, root: true, ready: false })).toEqual([
      "AGENT_NOT_READY",
    ]);
  });
});

describe("agent catalog not ready (AGENT_NOT_READY)", () => {
  it("translates 503 CATALOG_UNAVAILABLE to 503 AGENT_NOT_READY across validate, runs, generate, and health", async () => {
    let notReadyServer: Server | null = null;
    const notReadyUrl = await new Promise<string>((resolve) => {
      notReadyServer = createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://x");
        if (req.method === "GET" && url.pathname === "/health") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              ...HEALTH,
              root: true,
              ready: false,
              catalog: {
                state: "loading",
                probes: 0,
                last_error: "debugfs not mounted",
                warnings: [],
              },
            }),
          );
          return;
        }
        if (req.method === "GET" && url.pathname === "/v1/probes") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ probes: [], count: 0 }));
          return;
        }
        res.writeHead(503, {
          "content-type": "application/json",
          "retry-after": "3",
        });
        res.end(
          JSON.stringify({
            error: "probe catalog not ready",
            code: "CATALOG_UNAVAILABLE",
          }),
        );
      });
      notReadyServer.listen(0, "127.0.0.1", () => {
        const addr = notReadyServer?.address();
        const port = typeof addr === "object" && addr !== null ? addr.port : 0;
        resolve(`http://127.0.0.1:${port}`);
      });
    });
    const unreadyApp = await buildApp({
      agentUrl: notReadyUrl,
      tokenFile,
      dbPath: ":memory:",
      recipesDir,
      webOrigin: "http://localhost:5173",
      llmMode: "mock",
    });
    const addr = await unreadyApp.listen({ host: "127.0.0.1", port: 0 });
    const url = addr.replace("[::1]", "127.0.0.1");
    try {
      const hRes = await fetch(`${url}/api/health`);
      expect(hRes.status).toBe(200);
      expect(await hRes.json()).toMatchObject({
        ok: true,
        agent: {
          reachable: true,
          warnings: ["AGENT_NOT_READY"],
          health: { ready: false, catalog: { state: "loading" } },
        },
      });

      const vRes = await fetch(`${url}/api/validate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ script: "BEGIN { @x = count(); }" }),
      });
      expect(vRes.status).toBe(503);
      expect(vRes.headers.get("retry-after")).toBe("3");
      expect(await vRes.json()).toMatchObject({
        code: "AGENT_NOT_READY",
        fix_hint: expect.stringContaining("tracefs"),
      });

      const rRes = await fetch(`${url}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ script: "BEGIN { @x = count(); }" }),
      });
      expect(rRes.status).toBe(503);
      expect(rRes.headers.get("retry-after")).toBe("3");
      expect(await rRes.json()).toMatchObject({
        code: "AGENT_NOT_READY",
        fix_hint: expect.stringContaining("tracefs"),
      });

      const gRes = await fetch(`${url}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "Which processes use CPU?" }),
      });
      expect(gRes.status).toBe(503);
      expect(gRes.headers.get("retry-after")).toBe("3");
      expect(await gRes.json()).toMatchObject({
        code: "AGENT_NOT_READY",
        fix_hint: expect.stringContaining("tracefs"),
      });
    } finally {
      await unreadyApp.close();
      await new Promise<void>((resolve) =>
        notReadyServer?.close(() => resolve()),
      );
    }
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

describe("run id length cap (128) and same-host origin", () => {
  it("rejects overlong run ids with 404 on HTTP and 400 on WS", async () => {
    const long129 = `r${"a".repeat(128)}`;
    expect(long129.length).toBe(129);
    expect(isSafeId(long129)).toBe(false);

    const getLong = await fetch(`${base}/api/runs/${long129}`);
    expect(getLong.status).toBe(404);

    const stopLong = await fetch(`${base}/api/runs/${long129}/stop`, {
      method: "POST",
    });
    expect(stopLong.status).toBe(404);

    const wsBase = base.replace(/^http/, "ws");
    const rejected = await wsUpgradeRejected(`${wsBase}/ws/runs/${long129}`, {
      origin: "http://localhost:5173",
    });
    expect(rejected.status).toBe(400);
  });

  it("allows same-host origin", async () => {
    const res = await fetch(`${base}/api/health`, {
      headers: { origin: "http://localhost:5173" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:5173",
    );
  });
});

describe("catalog-unavailable scope (code-only)", () => {
  it("forwards 503 with other code verbatim instead of AGENT_NOT_READY", async () => {
    let otherServer: Server | null = null;
    const otherUrl = await new Promise<string>((resolve) => {
      otherServer = createServer((req, res) => {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ error: "overloaded", code: "LIMIT_EXCEEDED" }),
        );
        void req;
      });
      otherServer.listen(0, "127.0.0.1", () => {
        const addr = otherServer?.address();
        const port = typeof addr === "object" && addr !== null ? addr.port : 0;
        resolve(`http://127.0.0.1:${port}`);
      });
    });
    const otherApp = await buildApp({
      agentUrl: otherUrl,
      tokenFile,
      dbPath: ":memory:",
      recipesDir,
      webOrigin: "http://localhost:5173",
      llmMode: "mock",
    });
    const addr = await otherApp.listen({ host: "127.0.0.1", port: 0 });
    const url = addr.replace("[::1]", "127.0.0.1");
    try {
      const vRes = await fetch(`${url}/api/validate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ script: "BEGIN { @x = count(); }" }),
      });
      expect(vRes.status).toBe(503);
      expect(await vRes.json()).toMatchObject({ code: "LIMIT_EXCEEDED" });
    } finally {
      await otherApp.close();
      await new Promise<void>((resolve) =>
        otherServer?.close(() => resolve()),
      );
    }
  });
});
