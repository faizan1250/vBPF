import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ExplainResponseSchema } from "@vbpf/schemas";

import { EXPLAIN_RESULTS_GENERIC } from "./explain.js";
import { buildApp } from "./server.js";

const RECIPES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "recipes",
);

const RESULTS_CONTENT =
  "The opens table shows bash with 42 events and sshd with 7.";

function chatOk(content: string = RESULTS_CONTENT): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

interface SeenCall {
  url: string;
  system: string | null;
  user: string | null;
  model: string | null;
}

function stubFetch(
  handler: (seen: SeenCall[]) => Response | Promise<Response>,
  seen: SeenCall[],
): typeof fetch {
  return (async (url: unknown, init?: unknown) => {
    const request = (init ?? {}) as RequestInit;
    let system: string | null = null;
    let user: string | null = null;
    let model: string | null = null;
    try {
      const body = JSON.parse(String(request.body)) as {
        model?: string;
        messages?: Array<{ role?: string; content?: string }>;
      };
      model = body.model ?? null;
      system = body.messages?.[0]?.content ?? null;
      user = body.messages?.[1]?.content ?? null;
    } catch {
      system = null;
    }
    seen.push({ url: String(url), system, user, model });
    return handler(seen);
  }) as typeof fetch;
}

let dir = "";
let tokenFile = "";
let mockApp: FastifyInstance;
let mockBase = "";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "vbpf-explain-results-"));
  tokenFile = join(dir, "agent.token");
  writeFileSync(tokenFile, "test-token-explain-results\n");
  mockApp = await buildApp({
    agentUrl: "http://127.0.0.1:1",
    tokenFile,
    dbPath: join(dir, "api.sqlite3"),
    recipesDir: RECIPES_DIR,
    webOrigin: "http://localhost:5173",
    llmMode: "mock",
  });
  const addr = await mockApp.listen({ host: "127.0.0.1", port: 0 });
  mockBase = addr.replace("[::1]", "127.0.0.1");
}, 30000);

afterAll(async () => {
  await mockApp?.close();
  if (dir !== "") rmSync(dir, { recursive: true, force: true });
});

const SCRIPT = "BEGIN { @x = count(); }\n";
const OUTPUT = '[#1 printf] hello\n[#2 map] {"bash": 42}';

function post(body: unknown): Promise<Response> {
  return fetch(`${mockBase}/api/explain-results`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/explain-results validation", () => {
  it("requires explicit literal-true consent", async () => {
    for (const body of [
      { script: SCRIPT, output: OUTPUT },
      { script: SCRIPT, output: OUTPUT, consent: false },
      { script: SCRIPT, output: OUTPUT, consent: "yes" },
    ]) {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "VALIDATION_FAILED" });
    }
  });

  it("rejects missing, empty, and oversize output", async () => {
    for (const body of [
      { script: SCRIPT, consent: true },
      { script: SCRIPT, output: "", consent: true },
      { script: SCRIPT, output: "   ", consent: true },
    ]) {
      const res = await post(body);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    }
    const big = await post({
      script: SCRIPT,
      output: `x\n`.repeat(3000),
      consent: true,
    });
    expect(big.status).toBe(400);
    expect(await big.json()).toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("rejects oversize scripts", async () => {
    const res = await post({
      script: `BEGIN { @x = count(); } ${"x".repeat(9 * 1024)}`,
      output: OUTPUT,
      consent: true,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("runs the static validator before the LLM", async () => {
    const seen: SeenCall[] = [];
    const live = await buildApp({
      agentUrl: "http://127.0.0.1:1",
      tokenFile,
      dbPath: ":memory:",
      recipesDir: RECIPES_DIR,
      webOrigin: "http://localhost:5173",
      llmMode: "live",
      llmChain: "groq",
      llmEnv: {
        LLM_PROVIDER_CHAIN: "groq",
        GROQ_API_KEY: "stub-key",
        LLM_GROQ_MODEL: "stub-model",
      },
      llmFetch: stubFetch(() => chatOk(), seen),
    });
    const addr = await live.listen({ host: "127.0.0.1", port: 0 });
    const url = addr.replace("[::1]", "127.0.0.1");
    try {
      const res = await fetch(`${url}/api/explain-results`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          script: 'BEGIN { system("ls"); }',
          output: OUTPUT,
          consent: true,
        }),
      });
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({ code: "VALIDATION_FAILED" });
      expect(seen).toHaveLength(0);
    } finally {
      await live.close();
    }
  });
});

describe("POST /api/explain-results mock mode", () => {
  it("returns the generic message without caching", async () => {
    const body = { script: SCRIPT, output: OUTPUT, consent: true };
    const first = await post(body);
    expect(first.status).toBe(200);
    const parsed = ExplainResponseSchema.parse(await first.json());
    expect(parsed.explanation).toBe(EXPLAIN_RESULTS_GENERIC);
    expect(parsed.model).toBe("mock");
    expect(parsed.cached).toBe(false);

    const second = await post(body);
    expect(second.status).toBe(200);
    // Result explanations are never cached: output may hold host data.
    expect(ExplainResponseSchema.parse(await second.json())).toMatchObject({
      cached: false,
    });
  });
});

describe("POST /api/explain-results live mode", () => {
  it("sends script plus capped output through the stub provider", async () => {
    const seen: SeenCall[] = [];
    const live = await buildApp({
      agentUrl: "http://127.0.0.1:1",
      tokenFile,
      dbPath: ":memory:",
      recipesDir: RECIPES_DIR,
      webOrigin: "http://localhost:5173",
      llmMode: "live",
      llmChain: "groq",
      llmEnv: {
        LLM_PROVIDER_CHAIN: "groq",
        GROQ_API_KEY: "stub-key",
        LLM_GROQ_MODEL: "stub-model",
      },
      llmFetch: stubFetch(() => chatOk(), seen),
    });
    const addr = await live.listen({ host: "127.0.0.1", port: 0 });
    const url = addr.replace("[::1]", "127.0.0.1");
    try {
      const res = await fetch(`${url}/api/explain-results`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          script: SCRIPT,
          output: OUTPUT,
          consent: true,
        }),
      });
      expect(res.status).toBe(200);
      expect(ExplainResponseSchema.parse(await res.json())).toMatchObject({
        explanation: RESULTS_CONTENT,
        cached: false,
        model: "groq/stub-model",
      });
      expect(seen).toHaveLength(1);
      expect(seen[0]?.system).toMatch(/run output/i);
      expect(seen[0]?.user).toContain(SCRIPT);
      expect(seen[0]?.user).toContain(OUTPUT);
      expect(seen[0]?.model).toBe("stub-model");
    } finally {
      await live.close();
    }
  });

  it("never sends script-only explain output text to the results prompt", async () => {
    const seen: SeenCall[] = [];
    const live = await buildApp({
      agentUrl: "http://127.0.0.1:1",
      tokenFile,
      dbPath: ":memory:",
      recipesDir: RECIPES_DIR,
      webOrigin: "http://localhost:5173",
      llmMode: "live",
      llmChain: "groq",
      llmEnv: {
        LLM_PROVIDER_CHAIN: "groq",
        GROQ_API_KEY: "stub-key",
        LLM_GROQ_MODEL: "stub-model",
      },
      llmFetch: stubFetch(() => chatOk(), seen),
    });
    const addr = await live.listen({ host: "127.0.0.1", port: 0 });
    const url = addr.replace("[::1]", "127.0.0.1");
    try {
      // No consent flag on this route is a different route entirely:
      // /api/explain (script-only) must not include output.
      const res = await fetch(`${url}/api/explain`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ script: SCRIPT }),
      });
      expect(res.status).toBe(200);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.user).toBe(SCRIPT);
      expect(seen[0]?.user).not.toContain(OUTPUT);
    } finally {
      await live.close();
    }
  });

  it("live without keys reports LLM_UNAVAILABLE", async () => {
    const live = await buildApp({
      agentUrl: "http://127.0.0.1:1",
      tokenFile,
      dbPath: ":memory:",
      recipesDir: RECIPES_DIR,
      webOrigin: "http://localhost:5173",
      llmMode: "live",
      llmChain: "groq",
      llmEnv: {},
      llmFetch: stubFetch(() => chatOk(), []),
    });
    const addr = await live.listen({ host: "127.0.0.1", port: 0 });
    const url = addr.replace("[::1]", "127.0.0.1");
    try {
      const res = await fetch(`${url}/api/explain-results`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          script: SCRIPT,
          output: OUTPUT,
          consent: true,
        }),
      });
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ code: "LLM_UNAVAILABLE" });
    } finally {
      await live.close();
    }
  });
});

describe("explain-results rate limit", () => {
  it("shares the generate budget", async () => {
    const limited = await buildApp({
      agentUrl: "http://127.0.0.1:1",
      tokenFile,
      dbPath: ":memory:",
      recipesDir: RECIPES_DIR,
      webOrigin: "http://localhost:5173",
      llmMode: "mock",
      generateRateLimit: { max: 1, windowMs: 60_000 },
    });
    const addr = await limited.listen({ host: "127.0.0.1", port: 0 });
    const url = addr.replace("[::1]", "127.0.0.1");
    try {
      const gen = await fetch(`${url}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "cpu?" }),
      });
      expect(gen.status).not.toBe(429);
      const exp = await fetch(`${url}/api/explain-results`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          script: SCRIPT,
          output: OUTPUT,
          consent: true,
        }),
      });
      expect(exp.status).toBe(429);
      expect(await exp.json()).toMatchObject({ code: "RATE_LIMITED" });
    } finally {
      await limited.close();
    }
  });
});
