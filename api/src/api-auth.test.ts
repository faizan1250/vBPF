import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import {
  bearerToken,
  loadOrCreateApiToken,
  readApiToken,
  redactTokenUrl,
  tokensEqual,
  wsQueryToken,
} from "./api-auth.js";
import { buildApp } from "./server.js";

const AGENT_TOKEN = "b2".repeat(32);
const API_TOKEN = "a1".repeat(32);
const PRESENTED = "c3".repeat(32);

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

let dir = "";
let apiTokenFile = "";
let fake: Server | null = null;
let fakeUrl = "";
let app: FastifyInstance | null = null;
let base = "";
let captured = "";
let originalWrite: typeof process.stdout.write;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "vbpf-api-auth-"));
  writeFileSync(join(dir, "agent.token"), `${AGENT_TOKEN}\n`);
  apiTokenFile = join(dir, "api.token");
  writeFileSync(apiTokenFile, `${API_TOKEN}\n`);

  fake = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(HEALTH));
    void req;
  });
  await new Promise<void>((resolve) => fake?.listen(0, "127.0.0.1", resolve));
  const addr = fake.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  fakeUrl = `http://127.0.0.1:${port}`;

  originalWrite = process.stdout.write.bind(process.stdout);
  captured = "";
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    captured += String(chunk);
    return (originalWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;

  app = await buildApp({
    agentUrl: fakeUrl,
    tokenFile: join(dir, "agent.token"),
    apiTokenFile,
    dbPath: join(dir, "api.sqlite3"),
    recipesDir: join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "recipes",
    ),
    webOrigin: "http://localhost:5173",
  });
  const listenAddr = await app.listen({ host: "127.0.0.1", port: 0 });
  base = listenAddr.replace("[::1]", "127.0.0.1");
}, 30000);

afterAll(async () => {
  process.stdout.write = originalWrite;
  await app?.close();
  await new Promise<void>((resolve) => fake?.close(() => resolve()));
  if (dir !== "") rmSync(dir, { recursive: true, force: true });
});

const authed = { Authorization: `Bearer ${API_TOKEN}` };

describe("api token helpers", () => {
  it("compares fixed 64-char hex tokens in constant time", () => {
    expect(tokensEqual(API_TOKEN, API_TOKEN)).toBe(true);
    expect(tokensEqual(API_TOKEN, PRESENTED)).toBe(false);
    expect(tokensEqual(API_TOKEN, "different")).toBe(false);
    expect(tokensEqual("", API_TOKEN)).toBe(false);
    expect(tokensEqual(API_TOKEN, "")).toBe(false);
    expect(tokensEqual("short", "a-much-longer-value")).toBe(false);
    // No-hash path: length and hex-charset gates reject before timingSafeEqual.
    expect(tokensEqual("x".repeat(64), API_TOKEN)).toBe(false);
    expect(tokensEqual(API_TOKEN.slice(0, 63), API_TOKEN)).toBe(false);
    expect(tokensEqual(API_TOKEN, API_TOKEN.slice(0, 63))).toBe(false);
  });

  it("parses bearer headers strictly", () => {
    expect(bearerToken(`Bearer ${API_TOKEN}`)).toBe(API_TOKEN);
    expect(bearerToken(`bearer   ${API_TOKEN}  `)).toBe(API_TOKEN);
    expect(bearerToken("Basic abc")).toBe("");
    expect(bearerToken("Bearer")).toBe("");
    expect(bearerToken(undefined)).toBe("");
    expect(bearerToken([`Bearer ${API_TOKEN}`])).toBe(API_TOKEN);
  });

  it("reads and redacts ws query tokens", () => {
    expect(wsQueryToken("/ws/runs/x?token=abc")).toBe("abc");
    expect(wsQueryToken("/ws/runs/x")).toBe("");
    expect(wsQueryToken(undefined)).toBe("");
    expect(redactTokenUrl("/ws/runs/x?token=abc")).toBe(
      "/ws/runs/x?token=[REDACTED]",
    );
    expect(redactTokenUrl("/api/health")).toBe("/api/health");
    expect(redactTokenUrl(undefined)).toBeUndefined();
  });

  it("generates a 0600 token file when missing", () => {
    const fresh = join(dir, "fresh-api.token");
    const created = loadOrCreateApiToken(fresh);
    expect(created.length).toBeGreaterThanOrEqual(32);
    expect(readApiToken(fresh)).toBe(created);
    // Second call reads the same file, never mints a new one.
    expect(loadOrCreateApiToken(fresh)).toBe(created);
    if (process.platform !== "win32") {
      expect(statSync(fresh).mode & 0o777).toBe(0o600);
    }
  });
});

describe("api bearer gate", () => {
  it("requires the token on health too (D-107)", async () => {
    const missing = await fetch(`${base}/api/health`);
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({
      error: "unauthorized",
      code: "UNAUTHORIZED",
    });

    const wrong = await fetch(`${base}/api/health`, {
      headers: { Authorization: `Bearer wrong` },
    });
    expect(wrong.status).toBe(401);

    const ok = await fetch(`${base}/api/health`, { headers: authed });
    expect(ok.status).toBe(200);
  });

  it("requires the token on every api route shape", async () => {
    for (const init of [
      { url: `${base}/api/recipes`, method: "GET" },
      { url: `${base}/api/sessions`, method: "GET" },
      { url: `${base}/api/runs/nope`, method: "GET" },
      {
        url: `${base}/api/validate`,
        method: "POST",
        body: JSON.stringify({ script: "BEGIN { @x = count(); }" }),
      },
      {
        url: `${base}/api/runs`,
        method: "POST",
        body: JSON.stringify({ script: "BEGIN { @x = count(); }" }),
      },
      { url: `${base}/api/runs/nope/stop`, method: "POST", body: "{}" },
    ] as Array<{ url: string; method: string; body?: string }>) {
      const res = await fetch(init.url, {
        method: init.method,
        headers: { "content-type": "application/json" },
        body: init.body,
      });
      expect(res.status, init.url).toBe(401);
      expect(await res.json()).toMatchObject({ code: "UNAUTHORIZED" });
    }
  });

  it("lets authorized calls through", async () => {
    const recipes = await fetch(`${base}/api/recipes`, { headers: authed });
    expect(recipes.status).toBe(200);
    const runs = await fetch(`${base}/api/runs/nope`, { headers: authed });
    expect(runs.status).toBe(404);
    const sessions = await fetch(`${base}/api/sessions`, {
      headers: authed,
    });
    expect(sessions.status).toBe(200);
  });

  it("rejects websocket upgrades without a token", async () => {
    const rejected = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`${base.replace(/^http/, "ws")}/ws/runs/run_x`);
      ws.on("unexpected-response", (_req, res) => {
        res.resume();
        res.on("end", () => {
          ws.terminate();
          resolve(res.statusCode ?? 0);
        });
      });
      ws.on("open", () => {
        ws.terminate();
        resolve(200);
      });
      ws.on("error", () => resolve(-1));
    });
    expect(rejected).toBe(401);
  });

  it("accepts websocket upgrades via header or query token (D-108)", async () => {
    const viaHeader = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`${base.replace(/^http/, "ws")}/ws/runs/run_x`, {
        headers: authed,
      });
      // The fake agent has no WS endpoint, so the upstream close (not a 401)
      // proves the gate passed: open or non-401 close both mean admitted.
      ws.on("unexpected-response", (_req, res) => {
        res.resume();
        res.on("end", () => {
          ws.terminate();
          resolve(res.statusCode ?? 0);
        });
      });
      ws.on("open", () => {
        ws.terminate();
        resolve(101);
      });
      ws.on("error", () => resolve(-1));
    });
    expect(viaHeader).not.toBe(401);

    const viaQuery = await new Promise<number>((resolve) => {
      const ws = new WebSocket(
        `${base.replace(/^http/, "ws")}/ws/runs/run_x?token=${encodeURIComponent(API_TOKEN)}`,
      );
      ws.on("unexpected-response", (_req, res) => {
        res.resume();
        res.on("end", () => {
          ws.terminate();
          resolve(res.statusCode ?? 0);
        });
      });
      ws.on("open", () => {
        ws.terminate();
        resolve(101);
      });
      ws.on("error", () => resolve(-1));
    });
    expect(viaQuery).not.toBe(401);
  });

  it("leaks no token material in bodies or logs", async () => {
    const res = await fetch(`${base}/api/health`, {
      headers: { Authorization: `Bearer ${PRESENTED}` },
    });
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).not.toContain(PRESENTED);
    expect(text).not.toContain(API_TOKEN);
    expect(text).not.toContain("api.token");

    // A query-token probe must be redacted from the request line in logs.
    const probe = `probe-${"q".repeat(24)}`;
    await new Promise<void>((resolve) => {
      const ws = new WebSocket(
        `${base.replace(/^http/, "ws")}/ws/runs/run_x?token=${probe}`,
      );
      ws.on("unexpected-response", (_req, r) => {
        r.resume();
        r.on("end", () => {
          ws.terminate();
          resolve();
        });
      });
      ws.on("open", () => {
        ws.terminate();
        resolve();
      });
      ws.on("error", () => resolve());
    });
    await new Promise((r) => setTimeout(r, 250));
    expect(captured).not.toContain(PRESENTED);
    expect(captured).not.toContain(probe);
    expect(captured).toContain("token=[REDACTED]");
    expect(captured).not.toContain(API_TOKEN);
  });
});
