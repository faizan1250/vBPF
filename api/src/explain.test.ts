import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ExplainResponseSchema } from "@vbpf/schemas";

import { EXPLAIN_GENERIC } from "./explain.js";
import { loadRecipes } from "./recipes.js";
import { buildApp } from "./server.js";

const RECIPES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "recipes",
);

const EXPLAIN_CONTENT =
  "This probe samples on-CPU stacks.\n- profile fires 99 times a second\n- counts are aggregated in-kernel";

function chatOk(content: string = EXPLAIN_CONTENT): Response {
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
  dir = mkdtempSync(join(tmpdir(), "vbpf-explain-"));
  tokenFile = join(dir, "agent.token");
  writeFileSync(tokenFile, "test-token-explain\n");
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

function firstRecipe(): { id: string; description: string; body: string } {
  const recipe = loadRecipes(RECIPES_DIR)[0]!;
  const body = readFileSync(join(RECIPES_DIR, `${recipe.id}.bt`), "utf8");
  return { id: recipe.id, description: recipe.description, body };
}

describe("POST /api/explain validation", () => {
  it("rejects missing and empty scripts", async () => {
    for (const body of ["{}", JSON.stringify({ script: "" })]) {
      const res = await fetch(`${mockBase}/api/explain`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "VALIDATION_FAILED" });
    }
  });

  it("rejects oversize scripts", async () => {
    const res = await fetch(`${mockBase}/api/explain`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        script: `BEGIN { @x = count(); } ${"x".repeat(9 * 1024)}`,
      }),
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
      for (const script of [
        'BEGIN { system("ls"); }',
        "BEGIN { @x = count(); } --unsafe",
      ]) {
        const res = await fetch(`${url}/api/explain`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ script }),
        });
        expect(res.status).toBe(422);
        expect(await res.json()).toMatchObject({ code: "VALIDATION_FAILED" });
      }
      expect(seen).toHaveLength(0);
    } finally {
      await live.close();
    }
  });
});

describe("POST /api/explain mock mode", () => {
  it("returns the matching recipe description, then the cached row", async () => {
    const { description, body } = firstRecipe();
    // firstRecipe is uncached (each test file run starts from a fresh DB).
    const post = (): Promise<Response> =>
      fetch(`${mockBase}/api/explain`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ script: body }),
      });
    const first = await post();
    expect(first.status).toBe(200);
    const parsed = ExplainResponseSchema.parse(await first.json());
    expect(parsed.explanation).toBe(description);
    expect(parsed.model).toBe("mock");
    expect(parsed.cached).toBe(false);

    const second = await post();
    expect(second.status).toBe(200);
    expect(ExplainResponseSchema.parse(await second.json())).toMatchObject({
      explanation: description,
      cached: true,
      model: "mock",
    });
  });

  it("returns a generic message for non-recipe scripts", async () => {
    const res = await fetch(`${mockBase}/api/explain`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ script: "BEGIN { @x = count(); }\n" }),
    });
    expect(res.status).toBe(200);
    const parsed = ExplainResponseSchema.parse(await res.json());
    expect(parsed.explanation).toBe(EXPLAIN_GENERIC);
    expect(parsed.model).toBe("mock");
  });
});

describe("POST /api/explain live mode", () => {
  it("explains through the stub provider and caches by SHA-256", async () => {
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
      const { body } = firstRecipe();
      const post = (): Promise<Response> =>
        fetch(`${url}/api/explain`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ script: body }),
        });
      const first = await post();
      expect(first.status).toBe(200);
      expect(ExplainResponseSchema.parse(await first.json())).toMatchObject({
        explanation: EXPLAIN_CONTENT,
        cached: false,
        model: "groq/stub-model",
      });
      expect(seen).toHaveLength(1);
      expect(seen[0]?.system).toMatch(/plain English/i);
      expect(seen[0]?.user).toBe(body);
      expect(seen[0]?.model).toBe("stub-model");

      const second = await post();
      expect(second.status).toBe(200);
      expect(ExplainResponseSchema.parse(await second.json())).toMatchObject({
        cached: true,
      });
      expect(seen).toHaveLength(1);
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
      const res = await fetch(`${url}/api/explain`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ script: "BEGIN { @x = count(); }\n" }),
      });
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ code: "LLM_UNAVAILABLE" });
    } finally {
      await live.close();
    }
  });

  it("provider errors map to LLM_ERROR or LLM_UNAVAILABLE", async () => {
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
        LLM_GROQ_MODEL: "missing-model",
      },
      llmFetch: stubFetch(() => new Response(null, { status: 404 }), []),
    });
    const addr = await live.listen({ host: "127.0.0.1", port: 0 });
    const url = addr.replace("[::1]", "127.0.0.1");
    try {
      const res = await fetch(`${url}/api/explain`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ script: "BEGIN { @x = count(); }\n" }),
      });
      expect([502, 503]).toContain(res.status);
      expect(await res.json()).toMatchObject({
        code: expect.stringMatching(/LLM_/),
      });
    } finally {
      await live.close();
    }
  });
});

describe("explain rate limit", () => {
  it("rejects over-budget callers with 429 RATE_LIMITED", async () => {
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
      const post = (): Promise<Response> =>
        fetch(`${url}/api/explain`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ script: "BEGIN { @x = count(); }\n" }),
        });
      expect((await post()).status).toBe(200);
      const second = await post();
      expect(second.status).toBe(429);
      expect(await second.json()).toMatchObject({ code: "RATE_LIMITED" });
      expect(second.headers.get("retry-after")).toBe("60");
    } finally {
      await limited.close();
    }
  });

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
      // The generate attempt consumes the single budget even though the
      // dummy agent is offline (503); the limiter runs before the handler.
      expect(gen.status).not.toBe(429);
      const exp = await fetch(`${url}/api/explain`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ script: "BEGIN { @x = count(); }\n" }),
      });
      expect(exp.status).toBe(429);
    } finally {
      await limited.close();
    }
  });
});
