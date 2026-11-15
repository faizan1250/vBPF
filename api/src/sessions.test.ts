import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { createServer, type Server } from "node:http";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

import { buildApp } from "./server.js";
import { installTestApiAuth } from "./test-auth.js";

const TOKEN = "c2".repeat(32);
const HEALTH = {
  kernel: "6.8-test",
  bpftrace_version: "bpftrace v0.21",
  btf: true,
  root: false,
  tracefs: true,
  uptime_s: 42,
  ready: true,
  catalog: { state: "ready" as const, probes: 5, warnings: [] },
};

interface FakeAgent {
  url: string;
  close: () => Promise<void>;
}

function startFakeAgent(): Promise<FakeAgent> {
  let counter = 0;
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
      req.resume();
      req.on("end", () => {
        send(200, {
          ok: true,
          errors: [],
          probes: ["BEGIN"],
          warnings: [],
          probe_count: 1,
        });
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/runs") {
      counter += 1;
      send(201, { run_id: `run_session_${counter}`, state: "running" });
      return;
    }
    const del = /^\/v1\/runs\/([^/]+)$/.exec(url.pathname);
    if (req.method === "DELETE" && del !== null) {
      send(200, { run_id: del[1], state: "stopping" });
      return;
    }
    send(404, { error: "not found", code: "NOT_FOUND" });
  });

  // Replay a terminal summary so the server-owned monitor finalizes runs
  // headless without the tests polling.
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://x");
    const m = /^\/v1\/runs\/([^/]+)\/stream$/.exec(url.pathname);
    if (m === null || req.headers.authorization !== `Bearer ${TOKEN}`) {
      socket.destroy();
      return;
    }
    const runId = m[1] ?? "";
    wss.handleUpgrade(req, socket, head, (ws) => {
      const send = (kind: string, data: unknown, n: number): void => {
        ws.send(
          JSON.stringify({
            run_id: runId,
            seq: n,
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
      ws.on("message", () => ws.close());
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
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
let apiTokenFile = "";
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
  dir = mkdtempSync(join(tmpdir(), "vbpf-sessions-"));
  tokenFile = join(dir, "agent.token");
  writeFileSync(tokenFile, TOKEN + "\n");
  apiTokenFile = join(dir, "api.token");
  writeFileSync(apiTokenFile, TOKEN + "\n");
  installTestApiAuth(TOKEN);
  fake = await startFakeAgent();
  app = await buildApp({
    agentUrl: fake.url,
    tokenFile,
    apiTokenFile,
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

async function generate(prompt: string): Promise<{
  generation_id: string;
  session_id: string;
  script: string;
}> {
  const res = await fetch(`${base}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    generation_id: string;
    session_id: string;
    script: string;
  };
}

describe("server-side sessions", () => {
  it("creates a session per generation and lists it with counts", async () => {
    const gen = await generate("Which processes are using the most CPU?");
    expect(gen.session_id).toMatch(/^ses_/);

    const list = await fetch(`${base}/api/sessions`);
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      sessions: Array<{
        id: string;
        title: string;
        created_at: number;
        generations: number;
        runs: number;
      }>;
    };
    const found = body.sessions.find((s) => s.id === gen.session_id);
    expect(found).toMatchObject({
      id: gen.session_id,
      generations: 1,
      runs: 0,
    });
    expect(found!.title).toContain("CPU");
  });

  it("serves session detail and a secret-free export", async () => {
    const gen = await generate("Which processes open the most files?");
    const detail = await fetch(`${base}/api/sessions/${gen.session_id}`);
    expect(detail.status).toBe(200);
    const parsed = (await detail.json()) as {
      id: string;
      title: string;
      generations: Array<{ generation_id: string; prompt: string }>;
      runs: unknown[];
    };
    expect(parsed.id).toBe(gen.session_id);
    expect(parsed.generations.map((g) => g.generation_id)).toContain(
      gen.generation_id,
    );
    expect(parsed.generations[0]!.prompt).toBe(
      "Which processes open the most files?",
    );
    expect(parsed.runs).toEqual([]);

    const exp = await fetch(`${base}/api/sessions/${gen.session_id}/export`);
    expect(exp.status).toBe(200);
    expect(exp.headers.get("content-disposition")).toContain("attachment");
    const payload = (await exp.json()) as {
      exported_at: string;
      session: { id: string };
      generations: unknown[];
      runs: unknown[];
    };
    expect(payload.session.id).toBe(gen.session_id);
    expect(payload.generations).toHaveLength(1);
    const text = JSON.stringify(payload);
    // Secret/path hygiene: no token material, db paths, or auth headers.
    for (const secret of [TOKEN, ".sqlite3", "Bearer", "agentToken"]) {
      expect(text).not.toContain(secret);
    }
    expect(payload.exported_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("persists the generation session onto a bound run", async () => {
    const gen = await generate("zzzqqq session bind probe");
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        script: gen.script,
        generation_id: gen.generation_id,
      }),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as {
      run_id: string;
      session_id: string;
    };
    expect(created.session_id).toBe(gen.session_id);

    const got = await fetch(`${base}/api/runs/${created.run_id}`);
    expect(await got.json()).toMatchObject({ session_id: gen.session_id });

    const detail = (await (
      await fetch(`${base}/api/sessions/${gen.session_id}`)
    ).json()) as { runs: Array<{ run_id: string }> };
    expect(detail.runs.map((r) => r.run_id)).toContain(created.run_id);
    await fetch(`${base}/api/runs/${created.run_id}/stop`, {
      method: "POST",
    });
  });

  it("honours a client session for generation-less runs and mints one otherwise", async () => {
    const custom = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        script: "BEGIN { @x = count(); }",
        session_id: "ses_client_supplied",
      }),
    });
    expect(custom.status).toBe(201);
    expect(await custom.json()).toMatchObject({
      session_id: "ses_client_supplied",
    });

    const detail = await fetch(`${base}/api/sessions/ses_client_supplied`);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      id: "ses_client_supplied",
      title: "BEGIN { @x = count(); }",
    });

    const minted = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ script: "interval:s:1 { @y = count(); }" }),
    });
    expect(minted.status).toBe(201);
    const body = (await minted.json()) as { session_id: string };
    expect(body.session_id).toMatch(/^ses_/);
    expect(body.session_id).not.toBe("ses_client_supplied");
  });

  it("404s unknown and overlong session ids on detail and export", async () => {
    for (const path of [
      "/api/sessions/ses_nope",
      "/api/sessions/ses_nope/export",
      `/api/sessions/${"s".repeat(129)}`,
      `/api/sessions/${"s".repeat(129)}/export`,
    ]) {
      const res = await fetch(`${base}${path}`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({
        error: "unknown session",
        code: "NOT_FOUND",
      });
    }
  });

  it("validates the list limit and caps page size", async () => {
    for (const limit of ["0", "201", "abc"]) {
      const res = await fetch(`${base}/api/sessions?limit=${limit}`);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "invalid request",
        code: "VALIDATION_FAILED",
      });
    }
    const one = await fetch(`${base}/api/sessions?limit=1`);
    expect(one.status).toBe(200);
    expect(
      ((await one.json()) as { sessions: unknown[] }).sessions,
    ).toHaveLength(1);
  });
});
