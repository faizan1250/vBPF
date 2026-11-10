import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "./server.js";

// Realistic-looking fake secrets. Live only in memory; never committed.
const FAKE_GROQ_KEY = `gsk_${"a".repeat(48)}`;
const FAKE_AGENT_TOKEN = `agent-token-${"b".repeat(32)}`;
const SECRETS = [FAKE_GROQ_KEY, FAKE_AGENT_TOKEN];

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

let dir = "";
let tokenFile = "";
let fake: Server | null = null;
let fakeUrl = "";
let app: FastifyInstance | null = null;
let base = "";
let captured = "";

const recipesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "recipes",
);

let originalWrite: typeof process.stdout.write;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "vbpf-keys-"));
  tokenFile = join(dir, "agent.token");
  writeFileSync(tokenFile, `${FAKE_AGENT_TOKEN}\n`);

  fake = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(HEALTH));
    void req;
  });
  await new Promise<void>((resolve) => fake?.listen(0, "127.0.0.1", resolve));
  const addr = fake.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  fakeUrl = `http://127.0.0.1:${port}`;

  // Capture pino output: Fastify logs to stdout by default.
  originalWrite = process.stdout.write.bind(process.stdout);
  captured = "";
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    captured += String(chunk);
    return (originalWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;

  app = await buildApp({
    agentUrl: fakeUrl,
    tokenFile,
    dbPath: join(dir, "api.sqlite3"),
    recipesDir,
    webOrigin: "http://localhost:5173",
    llmMode: "live",
    llmChain: "groq",
    llmEnv: {
      ...process.env,
      LLM_PROVIDER_CHAIN: "groq",
      LLM_GROQ_MODEL: "fake-model",
      GROQ_API_KEY: FAKE_GROQ_KEY,
    } as NodeJS.ProcessEnv,
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

describe("keys hygiene", () => {
  it("exposes no key material via health or logs", async () => {
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      llm?: { providers?: Array<{ name?: string; keys?: unknown }> };
    };
    const bodyText = JSON.stringify(body);

    for (const secret of SECRETS) {
      expect(bodyText).not.toContain(secret);
      expect(bodyText).not.toContain(secret.slice(0, 16));
    }
    // Counts only: providers expose a numeric key count, never values.
    for (const p of body.llm?.providers ?? []) {
      expect(typeof p.keys).toBe("number");
    }
    expect(body.llm?.providers?.[0]).toMatchObject({ name: "groq", keys: 1 });

    // Let pino flush, then assert logs carry no key material either.
    await new Promise((r) => setTimeout(r, 250));
    for (const secret of SECRETS) {
      expect(captured).not.toContain(secret);
      expect(captured).not.toContain(secret.slice(0, 16));
    }
  });

  it("rejects a credentialed base URL without leaking it", async () => {
    const cred = `u${"c".repeat(15)}:p${"d".repeat(15)}`;
    const bad = await buildApp({
      agentUrl: fakeUrl,
      tokenFile,
      dbPath: ":memory:",
      recipesDir,
      webOrigin: "http://localhost:5173",
      llmMode: "live",
      llmChain: "groq",
      llmEnv: {
        LLM_PROVIDER_CHAIN: "groq",
        GROQ_API_KEY: FAKE_GROQ_KEY,
        LLM_GROQ_MODEL: "fake-model",
        LLM_GROQ_BASE_URL: `https://${cred}@example.com/v1`,
      } as NodeJS.ProcessEnv,
    });
    const addr = await bad.listen({ host: "127.0.0.1", port: 0 });
    try {
      const res = await fetch(
        `${addr.replace("[::1]", "127.0.0.1")}/api/health`,
      );
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toContain(cred);
      expect(text).toContain("unconfigured");
      expect(text).toContain("example.com");
    } finally {
      await bad.close();
    }
    await new Promise((r) => setTimeout(r, 250));
    expect(captured).not.toContain(cred);
  });
});

describe("live-llm log hygiene", () => {
  it("per-call logs carry fields but no key, prompt, or response text", async () => {
    const promptSentinel = `PROMPT-SENTINEL-${"p".repeat(8)}`;
    const responseSentinel = `RESPONSE-SENTINEL-${"r".repeat(8)}`;
    const content = JSON.stringify({
      script: "BEGIN { @x = count(); }\n",
      chart_type: "events",
      explanation: `minimal probe ${responseSentinel}`,
      duration_s: 10,
      refusal: null,
    });
    const stubFetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content } }],
          usage: { prompt_tokens: 11, completion_tokens: 22 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;
    const stubbed = await buildApp({
      agentUrl: fakeUrl,
      tokenFile,
      dbPath: ":memory:",
      recipesDir,
      webOrigin: "http://localhost:5173",
      llmMode: "live",
      llmChain: "groq",
      llmEnv: {
        LLM_PROVIDER_CHAIN: "groq",
        LLM_GROQ_MODEL: "fake-model",
        GROQ_API_KEY: FAKE_GROQ_KEY,
      } as NodeJS.ProcessEnv,
      llmFetch: stubFetch,
    });
    const addr = await stubbed.listen({ host: "127.0.0.1", port: 0 });
    try {
      await fetch(`${addr.replace("[::1]", "127.0.0.1")}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: `Which processes open files? ${promptSentinel}`,
        }),
      });
    } finally {
      await stubbed.close();
    }
    await new Promise((r) => setTimeout(r, 250));
    expect(captured).toContain("live llm chain ready");
    expect(captured).toContain("live llm call");
    expect(captured).toContain('"outcome":"ok"');
    expect(captured).toContain('"prompt_tokens":11');
    for (const secret of [...SECRETS, promptSentinel, responseSentinel]) {
      expect(captured).not.toContain(secret);
      expect(captured).not.toContain(secret.slice(0, 16));
    }
  });
});
