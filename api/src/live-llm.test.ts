import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";

import type { FastifyInstance } from "fastify";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "./server.js";
import {
  LiveLlmChain,
  LlmRequestError,
  LlmUnavailableError,
  cooldownMsForRetryAfter,
  discoverFallbackModels,
  discoverKeys,
  discoverModel,
  parseChain,
  parseUsage,
  resetDeprecatedGenericModelWarnForTests,
  validateBaseUrl,
} from "./live-llm.js";
import { LlmOutputSchema } from "./llm.js";

const VALID_CONTENT = JSON.stringify(
  LlmOutputSchema.parse({
    script: "BEGIN { @x = count(); }\n",
    chart_type: "events",
    explanation: "Minimal counter probe.",
    duration_s: 10,
    refusal: null,
  }),
);

function chatOk(content: string = VALID_CONTENT): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

type Seen = { url: string; auth: string | null; model: string | null };

function stubFetch(
  handler: (
    url: string,
    init: RequestInit,
    seen: Seen[],
  ) => Response | Promise<Response>,
  seen: Seen[],
): typeof fetch {
  return (async (url: unknown, init?: unknown) => {
    const request = (init ?? {}) as RequestInit;
    const headers = new Headers(request.headers);
    let model: string | null = null;
    try {
      model =
        (JSON.parse(String(request.body)) as { model?: string }).model ?? null;
    } catch {
      model = null;
    }
    const entry: Seen = {
      url: String(url),
      auth: headers.get("authorization"),
      model,
    };
    seen.push(entry);
    return handler(String(url), request, seen);
  }) as typeof fetch;
}

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

describe("key discovery", () => {
  it("orders prefixed, bare, then numbered keys", () => {
    const env = {
      LLM_GROQ_API_KEY: "a",
      GROQ_API_KEY: "b",
      GROQ_API_KEY1: "c",
      GROQ_API_KEY2: "d",
    };
    expect(discoverKeys("groq", env)).toEqual(["a", "b", "c", "d"]);
  });

  it("dedupes and stops at the first numbering gap", () => {
    const env = {
      GROQ_API_KEY1: "same",
      GROQ_API_KEY2: "same",
      GROQ_API_KEY4: "skipped",
    };
    expect(discoverKeys("groq", env)).toEqual(["same"]);
  });

  it("finds nothing when unset", () => {
    expect(discoverKeys("groq", {})).toEqual([]);
  });
});

describe("chain and model discovery", () => {
  it("defaults to groq", () => {
    expect(parseChain(undefined, {})).toEqual(["groq"]);
    expect(parseChain("", {})).toEqual(["groq"]);
  });

  it("splits LLM_PROVIDER_CHAIN", () => {
    expect(
      parseChain(undefined, { LLM_PROVIDER_CHAIN: "groq, cerebras" }),
    ).toEqual(["groq", "cerebras"]);
  });

  it("uses only the provider-specific model", () => {
    expect(
      discoverModel("groq", {
        LLM_GROQ_MODEL: "specific",
        LLM_MODEL: "generic",
      }),
    ).toBe("specific");
    expect(discoverModel("groq", { LLM_MODEL: "generic" })).toBeNull();
    expect(discoverModel("groq", {})).toBeNull();
  });

  it("leaves a provider without its own model unconfigured", () => {
    const chain = new LiveLlmChain({
      env: {
        LLM_PROVIDER_CHAIN: "groq",
        GROQ_API_KEY: "k",
        LLM_MODEL: "generic",
      },
      fetchFn: stubFetch(() => chatOk(), []),
    });
    expect(chain.configured).toBe(false);
    expect(chain.health().providers).toEqual([
      { name: "groq", state: "unconfigured", keys: 1 },
    ]);
  });

  it("never sends a leaked generic model and warns once", async () => {
    const prevModel = process.env["LLM_MODEL"];
    const prevMode = process.env["LLM_MODE"];
    process.env["LLM_MODEL"] = "generic-leak";
    process.env["LLM_MODE"] = "live";
    resetDeprecatedGenericModelWarnForTests();
    const warns: string[] = [];
    const seen: Seen[] = [];
    try {
      const first = new LiveLlmChain({
        env: {
          LLM_PROVIDER_CHAIN: "groq",
          GROQ_API_KEY: "k",
          LLM_GROQ_MODEL: "m1",
        },
        fetchFn: stubFetch(() => chatOk(), seen),
        logger: { warn: (msg) => warns.push(msg) },
      });
      await first.generate("cpu?");
      const second = new LiveLlmChain({
        env: {
          LLM_PROVIDER_CHAIN: "groq",
          GROQ_API_KEY: "k",
          LLM_GROQ_MODEL: "m1",
        },
        fetchFn: stubFetch(() => chatOk(), []),
        logger: { warn: (msg) => warns.push(msg) },
      });
      await second.generate("cpu?");
      expect(warns).toEqual([
        "LLM_MODEL is deprecated and ignored; use LLM_<NAME>_MODEL",
      ]);
      expect(seen.map((s) => s.model)).toEqual(["m1"]);
    } finally {
      if (prevModel === undefined) delete process.env["LLM_MODEL"];
      else process.env["LLM_MODEL"] = prevModel;
      if (prevMode === undefined) delete process.env["LLM_MODE"];
      else process.env["LLM_MODE"] = prevMode;
      resetDeprecatedGenericModelWarnForTests();
    }
  });

  it("splits fallback models", () => {
    expect(
      discoverFallbackModels("groq", {
        LLM_GROQ_FALLBACK_MODELS: "m1, m2,, ",
      }),
    ).toEqual(["m1", "m2"]);
  });
});

describe("validateBaseUrl", () => {
  it("accepts https and strips a trailing slash", () => {
    expect(validateBaseUrl("https://api.groq.com/openai/v1/")).toEqual({
      ok: true,
      url: "https://api.groq.com/openai/v1",
    });
    expect(validateBaseUrl("https://api.groq.com/openai/v1")).toEqual({
      ok: true,
      url: "https://api.groq.com/openai/v1",
    });
  });

  it("accepts http only for loopback and host.docker.internal", () => {
    for (const host of [
      "127.0.0.1",
      "localhost",
      "::1",
      "host.docker.internal",
    ]) {
      const raw =
        host === "::1" ? "http://[::1]:11434/v1" : `http://${host}:11434/v1`;
      const checked = validateBaseUrl(raw);
      expect(checked).toEqual({ ok: true, url: raw });
    }
    expect(validateBaseUrl("http://localhost:11434/v1/")).toEqual({
      ok: true,
      url: "http://localhost:11434/v1",
    });
  });

  it("rejects http to a public host", () => {
    const checked = validateBaseUrl("http://example.com/v1");
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.reason).toContain("example.com");
  });

  it("rejects credentials, query, fragment, and garbage", () => {
    for (const raw of [
      "https://user:pass@example.com/v1",
      "https://user@example.com/v1",
      "https://example.com/v1?key=x",
      "https://example.com/v1#frag",
      "not a url",
      "ftp://example.com/v1",
      "",
    ]) {
      expect(validateBaseUrl(raw).ok).toBe(false);
    }
  });
});

describe("base URL overrides", () => {
  it("overrides a preset only when valid", async () => {
    const seen: Seen[] = [];
    const fetchFn = stubFetch((url) => {
      if (url.startsWith("https://override.example/v1/")) return chatOk();
      return new Response(null, { status: 500 });
    }, seen);
    const chain = new LiveLlmChain({
      env: {
        LLM_PROVIDER_CHAIN: "groq",
        GROQ_API_KEY: "k",
        LLM_GROQ_MODEL: "m1",
        LLM_GROQ_BASE_URL: "https://override.example/v1/",
      },
      fetchFn,
    });
    await chain.generate("cpu?");
    expect(chain.model).toBe("groq/m1");
    expect(seen[0]?.url).toBe("https://override.example/v1/chat/completions");
    expect(chain.health().providers).toEqual([
      { name: "groq", state: "ready", keys: 1 },
    ]);
  });

  it("marks the provider unconfigured on an invalid override", async () => {
    const seen: Seen[] = [];
    const warns: string[] = [];
    const chain = new LiveLlmChain({
      env: {
        LLM_PROVIDER_CHAIN: "groq",
        GROQ_API_KEY: "k",
        LLM_GROQ_MODEL: "m1",
        LLM_GROQ_BASE_URL: "http://example.com/v1",
      },
      fetchFn: stubFetch(() => chatOk(), seen),
      logger: { warn: (msg) => warns.push(msg) },
    });
    expect(chain.configured).toBe(false);
    expect(chain.health().providers).toMatchObject([
      { name: "groq", state: "unconfigured", keys: 1 },
    ]);
    const reason = chain.health().providers[0]?.reason ?? "";
    expect(reason).toContain("example.com");
    await expect(chain.generate("cpu?")).rejects.toBeInstanceOf(
      LlmUnavailableError,
    );
    expect(seen).toHaveLength(0);
    expect(warns).toHaveLength(1);
  });

  it("rejects credentials without leaking them", () => {
    const warns: string[] = [];
    const chain = new LiveLlmChain({
      env: {
        LLM_PROVIDER_CHAIN: "custom",
        LLM_CUSTOM_BASE_URL: "https://user:s3cret-t0k@example.com/v1?k=v",
        LLM_CUSTOM_MODEL: "m1",
        CUSTOM_API_KEY: "k",
      },
      fetchFn: stubFetch(() => chatOk(), []),
      logger: { warn: (msg) => warns.push(msg) },
    });
    expect(chain.configured).toBe(false);
    const snapshot = JSON.stringify(chain.health());
    for (const secret of ["s3cret-t0k", "user", "?k=v", "k=v"]) {
      expect(snapshot).not.toContain(secret);
      for (const w of warns) expect(w).not.toContain(secret);
    }
    expect(snapshot).toContain("example.com");
    expect(warns).toHaveLength(1);
  });

  it("custom keeps keyless behavior with a valid URL", async () => {
    const seen: Seen[] = [];
    const chain = new LiveLlmChain({
      env: {
        LLM_PROVIDER_CHAIN: "custom",
        LLM_CUSTOM_BASE_URL: "http://127.0.0.1:11434/v1",
        LLM_CUSTOM_MODEL: "m1",
      },
      fetchFn: stubFetch((url) => {
        if (url.startsWith("http://127.0.0.1:11434/v1/")) return chatOk();
        return new Response(null, { status: 500 });
      }, seen),
    });
    expect(chain.configured).toBe(true);
    await chain.generate("cpu?");
    expect(seen[0]?.auth).toBeNull();
  });

  it("invalid custom URL unconfigures even with keys", () => {
    const chain = new LiveLlmChain({
      env: {
        LLM_PROVIDER_CHAIN: "custom",
        LLM_CUSTOM_BASE_URL: "http://example.com/v1",
        LLM_CUSTOM_MODEL: "m1",
        CUSTOM_API_KEY: "k",
      },
      fetchFn: stubFetch(() => chatOk(), []),
    });
    expect(chain.configured).toBe(false);
    expect(chain.health().providers[0]).toMatchObject({
      name: "custom",
      state: "unconfigured",
    });
  });
});

describe("401/403 rotates keys", () => {
  it("disables key 1 and uses key 2 for the process lifetime", async () => {
    const seen: Seen[] = [];
    const fetchFn = stubFetch((url) => {
      if (url !== GROQ_URL) return new Response(null, { status: 500 });
      const last = seen[seen.length - 1];
      if (last?.auth === "Bearer good") return chatOk();
      return new Response(null, { status: 401 });
    }, seen);
    const chain = new LiveLlmChain({
      env: {
        LLM_PROVIDER_CHAIN: "groq",
        GROQ_API_KEY1: "bad",
        GROQ_API_KEY2: "good",
        LLM_GROQ_MODEL: "m1",
      },
      fetchFn,
    });
    const first = await chain.generate("cpu?");
    expect(first.script).toContain("BEGIN");
    expect(chain.model).toBe("groq/m1");
    const auths = seen.map((s) => s.auth);
    expect(auths).toEqual(["Bearer bad", "Bearer good"]);

    await chain.generate("cpu?");
    expect(seen.map((s) => s.auth)).toEqual([
      "Bearer bad",
      "Bearer good",
      "Bearer good",
    ]);
  });
});

describe("429 cools the provider, not the key", () => {
  it("falls to the next provider and never tries key 2", async () => {
    const seen: Seen[] = [];
    const fetchFn = stubFetch((url) => {
      if (url === GROQ_URL) {
        return new Response(null, {
          status: 429,
          headers: { "retry-after": "60" },
        });
      }
      return chatOk();
    }, seen);
    const chain = new LiveLlmChain({
      env: {
        LLM_PROVIDER_CHAIN: "groq,cerebras",
        GROQ_API_KEY1: "a1",
        GROQ_API_KEY2: "a2",
        LLM_GROQ_MODEL: "ma",
        CEREBRAS_API_KEY: "b1",
        LLM_CEREBRAS_MODEL: "mb",
      },
      fetchFn,
    });
    const out = await chain.generate("cpu?");
    expect(out.script).toContain("BEGIN");
    expect(chain.model).toBe("cerebras/mb");
    const groqSeen = seen.filter((s) => s.url === GROQ_URL);
    expect(groqSeen).toHaveLength(1);
    expect(groqSeen[0]?.auth).toBe("Bearer a1");

    await chain.generate("cpu?");
    expect(seen.filter((s) => s.url === GROQ_URL)).toHaveLength(1);
    expect(chain.health().providers).toMatchObject([
      { name: "groq", state: "cooldown", keys: 2 },
      { name: "cerebras", state: "ready", keys: 1 },
    ]);
  });

  it("all cooling down maps to unavailable", async () => {
    const seen: Seen[] = [];
    const fetchFn = stubFetch(() => new Response(null, { status: 429 }), seen);
    const chain = new LiveLlmChain({
      env: {
        LLM_PROVIDER_CHAIN: "groq",
        GROQ_API_KEY: "a1",
        LLM_GROQ_MODEL: "ma",
      },
      fetchFn,
    });
    await expect(chain.generate("cpu?")).rejects.toBeInstanceOf(
      LlmUnavailableError,
    );
  });
});

describe("per-model fallback", () => {
  it("tries fallback models with the same key before the next provider", async () => {
    const seen: Seen[] = [];
    const fetchFn = stubFetch((url, init) => {
      const body = JSON.parse(String(init.body)) as { model?: string };
      if (url === GROQ_URL && body.model === "missing") {
        return new Response(null, { status: 404 });
      }
      return chatOk();
    }, seen);
    const chain = new LiveLlmChain({
      env: {
        LLM_PROVIDER_CHAIN: "groq,cerebras",
        GROQ_API_KEY: "k",
        LLM_GROQ_MODEL: "missing",
        LLM_GROQ_FALLBACK_MODELS: "fallback",
        CEREBRAS_API_KEY: "b",
        LLM_CEREBRAS_MODEL: "mb",
      },
      fetchFn,
    });
    await chain.generate("cpu?");
    expect(chain.model).toBe("groq/fallback");
    expect(seen.map((s) => s.model)).toEqual(["missing", "fallback"]);
    expect(seen.map((s) => s.auth)).toEqual(["Bearer k", "Bearer k"]);
  });
});

describe("transport guards", () => {
  it("does not follow redirects", async () => {
    let redirectMode: string | undefined;
    const seen: Seen[] = [];
    const fetchFn = stubFetch((_url, init, seenAcc) => {
      redirectMode = init.redirect;
      const last = seenAcc[seenAcc.length - 1];
      if (last?.url === GROQ_URL) {
        return new Response(null, { status: 302 });
      }
      return chatOk();
    }, seen);
    const chain = new LiveLlmChain({
      env: {
        LLM_PROVIDER_CHAIN: "groq,cerebras",
        GROQ_API_KEY: "k",
        LLM_GROQ_MODEL: "ma",
        CEREBRAS_API_KEY: "b",
        LLM_CEREBRAS_MODEL: "mb",
      },
      fetchFn,
    });
    await chain.generate("cpu?");
    expect(redirectMode).toBe("manual");
    expect(chain.model).toBe("cerebras/mb");
  });

  it("caps response bodies", async () => {
    const seen: Seen[] = [];
    const fetchFn = stubFetch(() => chatOk("x".repeat(1024)), seen);
    const chain = new LiveLlmChain({
      env: {
        LLM_PROVIDER_CHAIN: "groq",
        GROQ_API_KEY: "k",
        LLM_GROQ_MODEL: "ma",
      },
      fetchFn,
      maxBodyBytes: 64,
    });
    await expect(chain.generate("cpu?")).rejects.toBeInstanceOf(
      LlmRequestError,
    );
  });

  it("honors Retry-After bounds", () => {
    expect(cooldownMsForRetryAfter("2", 0)).toBe(2000);
    expect(cooldownMsForRetryAfter("99999", 0)).toBe(300_000);
    expect(cooldownMsForRetryAfter(null, 0)).toBe(60_000);
    expect(cooldownMsForRetryAfter("not-a-date", 0)).toBe(60_000);
  });

  it("caps concurrent outbound requests", async () => {
    let active = 0;
    let peak = 0;
    const seen: Seen[] = [];
    const fetchFn = stubFetch(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((done) => setTimeout(done, 20));
      active -= 1;
      return chatOk();
    }, seen);
    const chain = new LiveLlmChain({
      env: {
        LLM_PROVIDER_CHAIN: "groq",
        GROQ_API_KEY: "k",
        LLM_GROQ_MODEL: "ma",
      },
      fetchFn,
      maxConcurrency: 2,
    });
    await Promise.all(Array.from({ length: 6 }, () => chain.generate("cpu?")));
    expect(peak).toBeLessThanOrEqual(2);
    expect(seen).toHaveLength(6);
  });

  it("health reports counts without key material", () => {
    const chain = new LiveLlmChain({
      env: {
        LLM_PROVIDER_CHAIN: "groq,cerebras",
        GROQ_API_KEY1: "secret-1",
        GROQ_API_KEY2: "secret-2",
        LLM_GROQ_MODEL: "ma",
      },
      fetchFn: (async () => chatOk()) as typeof fetch,
    });
    const health = chain.health();
    expect(health).toEqual({
      mode: "live",
      providers: [
        { name: "groq", state: "ready", keys: 2 },
        { name: "cerebras", state: "unconfigured", keys: 0 },
      ],
    });
    const leaked = JSON.stringify(health).includes("secret");
    expect(leaked).toBe(false);
  });
});

// Live server wiring against a stub provider plus a fake agent.
const TOKEN = "test-token-live";
const RECIPES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "recipes",
);

function startFakeAgent(): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
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
    if (req.method === "GET" && url.pathname === "/v1/probes") {
      send(200, { probes: ["BEGIN"], count: 1 });
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/validate") {
      send(200, { ok: true, errors: [], probes: ["BEGIN"] });
      return;
    }
    send(404, { error: "not found", code: "NOT_FOUND" });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

let dir = "";
let tokenFile = "";
let fake: { url: string; close: () => Promise<void> };
let app: FastifyInstance;
let base = "";
const seen: Seen[] = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "vbpf-live-"));
  tokenFile = join(dir, "agent.token");
  writeFileSync(tokenFile, `${TOKEN}\n`);
  fake = await startFakeAgent();
  const fetchFn = stubFetch((url) => {
    if (url === GROQ_URL) return chatOk();
    return new Response(null, { status: 500 });
  }, seen);
  app = await buildApp({
    agentUrl: fake.url,
    tokenFile,
    dbPath: join(dir, "api.sqlite3"),
    recipesDir: RECIPES_DIR,
    webOrigin: "http://localhost:5173",
    llmMode: "live",
    llmChain: "groq",
    llmEnv: {
      LLM_PROVIDER_CHAIN: "groq",
      GROQ_API_KEY1: "stub-key-1",
      GROQ_API_KEY2: "stub-key-2",
      LLM_GROQ_MODEL: "stub-model",
    },
    llmFetch: fetchFn,
  });
  const addr = await app.listen({ host: "127.0.0.1", port: 0 });
  base = addr.replace("[::1]", "127.0.0.1");
}, 30000);

afterAll(async () => {
  await app?.close();
  await fake?.close();
  if (dir !== "") rmSync(dir, { recursive: true, force: true });
});

describe("live server wiring", () => {
  it("generates through the stub provider with attribution", async () => {
    const res = await fetch(`${base}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "Which processes open the most files?",
      }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).validation).toMatchObject({ status: "ok" });
    const db = new Database(join(dir, "api.sqlite3"), { readonly: true });
    const row = db
      .prepare("SELECT model FROM generations ORDER BY rowid DESC LIMIT 1")
      .get() as { model: string };
    db.close();
    expect(row.model).toBe("groq/stub-model");
    expect(seen[0]?.auth).toBe("Bearer stub-key-1");
  });

  it("health shows the provider ready with a key count and no material", async () => {
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      llm: { mode: string; providers: unknown[] };
    };
    expect(body.llm).toEqual({
      mode: "live",
      providers: [{ name: "groq", state: "ready", keys: 2 }],
    });
    expect(JSON.stringify(body)).not.toContain("stub-key");
  });

  it("live without keys stays 503 LLM_UNAVAILABLE", async () => {
    const unconfigured = await buildApp({
      agentUrl: fake.url,
      tokenFile,
      dbPath: ":memory:",
      recipesDir: RECIPES_DIR,
      webOrigin: "http://localhost:5173",
      llmMode: "live",
      llmChain: "groq",
      llmEnv: {},
      llmFetch: stubFetch(() => chatOk(), []),
    });
    const addr = await unconfigured.listen({ host: "127.0.0.1", port: 0 });
    const url = addr.replace("[::1]", "127.0.0.1");
    try {
      const res = await fetch(`${url}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "cpu?" }),
      });
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ code: "LLM_UNAVAILABLE" });
    } finally {
      await unconfigured.close();
    }
  });
});

describe("parseUsage", () => {
  it("parses numeric usage", () => {
    expect(
      parseUsage({ usage: { prompt_tokens: 12, completion_tokens: 34 } }),
    ).toEqual({ prompt_tokens: 12, completion_tokens: 34 });
  });

  it("ignores missing, partial-garbage, and non-object usage", () => {
    expect(parseUsage({})).toBeUndefined();
    expect(parseUsage({ choices: [] })).toBeUndefined();
    expect(parseUsage({ usage: null })).toBeUndefined();
    expect(parseUsage({ usage: "tokens" })).toBeUndefined();
    expect(parseUsage({ usage: { prompt_tokens: "many" } })).toBeUndefined();
    expect(
      parseUsage({ usage: { prompt_tokens: 7, completion_tokens: -1 } }),
    ).toEqual({ prompt_tokens: 7 });
  });
});

describe("structured per-call logs and usage", () => {
  type Logged = { obj: Record<string, unknown>; msg?: string };

  const makeLogger = (): {
    infos: Logged[];
    warns: string[];
    logger: {
      warn: (msg: string) => void;
      info: (obj: Record<string, unknown>, msg?: string) => void;
    };
  } => {
    const infos: Logged[] = [];
    const warns: string[] = [];
    return {
      infos,
      warns,
      logger: {
        warn: (msg: string) => warns.push(msg),
        info: (obj: Record<string, unknown>, msg?: string) => {
          infos.push({ obj, msg });
        },
      },
    };
  };

  const PROMPT_SENTINEL = "PROMPT-SENTINEL-9z9z";
  const RESPONSE_SENTINEL = "RESPONSE-SENTINEL-8y8y";

  const baseEnv = (): NodeJS.ProcessEnv =>
    ({
      LLM_PROVIDER_CHAIN: "groq",
      GROQ_API_KEY: "k-secret-1",
      LLM_GROQ_MODEL: "m1",
    }) as NodeJS.ProcessEnv;

  const chatWithUsage = (content: string, usage?: unknown): Response => {
    const body: Record<string, unknown> = {
      choices: [{ message: { content } }],
    };
    if (usage !== undefined) body["usage"] = usage;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const validContentWith = (explanation: string): string =>
    JSON.stringify(
      LlmOutputSchema.parse({
        script: "BEGIN { @x = count(); }\n",
        chart_type: "events",
        explanation,
        duration_s: 10,
        refusal: null,
      }),
    );

  it("emits startup and per-call lines with usage, never secrets", async () => {
    const { infos, logger } = makeLogger();
    const seen: Seen[] = [];
    const fetchFn = stubFetch(
      () =>
        chatWithUsage(validContentWith(`probe ok ${RESPONSE_SENTINEL}`), {
          prompt_tokens: 12,
          completion_tokens: 34,
        }),
      seen,
    );
    const chain = new LiveLlmChain({
      env: baseEnv(),
      fetchFn,
      logger,
    });
    const detailed = await chain.generateDetailed(`cpu? ${PROMPT_SENTINEL}`);
    expect(detailed.usage).toEqual({
      prompt_tokens: 12,
      completion_tokens: 34,
    });
    expect(detailed.model).toBe("groq/m1");
    // Startup line plus exactly one per-call line.
    expect(infos).toHaveLength(2);
    expect(infos[0]?.msg).toBe("live llm chain ready");
    expect(infos[0]?.obj).toMatchObject({ mode: "live" });
    const call = infos[1]?.obj;
    expect(infos[1]?.msg).toBe("live llm call");
    expect(call).toMatchObject({
      provider: "groq",
      model: "m1",
      key_index: 0,
      status: 200,
      outcome: "ok",
      usage: { prompt_tokens: 12, completion_tokens: 34 },
    });
    expect(typeof call?.["latency_ms"]).toBe("number");
    expect(typeof call?.["prompt_chars"]).toBe("number");
    const text = JSON.stringify(infos);
    for (const secret of ["k-secret-1", PROMPT_SENTINEL, RESPONSE_SENTINEL]) {
      expect(text).not.toContain(secret);
    }
  });

  it("omits usage when the provider reports none", async () => {
    const { infos, logger } = makeLogger();
    const chain = new LiveLlmChain({
      env: baseEnv(),
      fetchFn: stubFetch(() => chatOk(), []),
      logger,
    });
    const detailed = await chain.generateDetailed("cpu?");
    expect(detailed.usage).toBeUndefined();
    const call = infos.find((l) => l.msg === "live llm call")?.obj;
    expect(call?.["outcome"]).toBe("ok");
    expect("usage" in (call ?? {})).toBe(false);
  });

  it("logs key_index per attempt, never the key", async () => {
    const { infos, logger } = makeLogger();
    const seen: Seen[] = [];
    const fetchFn = stubFetch((url) => {
      const last = seen[seen.length - 1];
      if (last?.auth === "Bearer good-key-xyz") return chatOk();
      expect(url).toBe(GROQ_URL);
      return new Response(null, { status: 401 });
    }, seen);
    const chain = new LiveLlmChain({
      env: {
        LLM_PROVIDER_CHAIN: "groq",
        GROQ_API_KEY1: "bad-key-xyz",
        GROQ_API_KEY2: "good-key-xyz",
        LLM_GROQ_MODEL: "m1",
      },
      fetchFn,
      logger,
    });
    await chain.generate("cpu?");
    const calls = infos
      .filter((l) => l.msg === "live llm call")
      .map((l) => l.obj);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      key_index: 0,
      status: 401,
      outcome: "auth",
    });
    expect(calls[1]).toMatchObject({
      key_index: 1,
      status: 200,
      outcome: "ok",
    });
    const text = JSON.stringify(infos);
    expect(text).not.toContain("bad-key-xyz");
    expect(text).not.toContain("good-key-xyz");
  });

  it("maps transport outcomes without leaking raw errors", async () => {
    const probe = async (
      respond: (
        url: string,
        init: RequestInit,
        seen: Seen[],
      ) => Response | Promise<Response>,
      opts?: { maxBodyBytes?: number },
    ): Promise<Record<string, unknown>> => {
      const { infos, logger } = makeLogger();
      const seen: Seen[] = [];
      const chain = new LiveLlmChain({
        env: baseEnv(),
        fetchFn: stubFetch(respond, seen),
        logger,
        ...(opts?.maxBodyBytes !== undefined
          ? { maxBodyBytes: opts.maxBodyBytes }
          : {}),
      });
      await expect(chain.generateDetailed("cpu?")).rejects.toThrow();
      const call = infos.find((l) => l.msg === "live llm call")?.obj;
      expect(call).toBeDefined();
      return call as Record<string, unknown>;
    };
    await expect(
      probe(() => new Response(null, { status: 429 })),
    ).resolves.toMatchObject({ status: 429, outcome: "rate_limited" });
    await expect(
      probe(() => new Response(null, { status: 401 })),
    ).resolves.toMatchObject({ status: 401, outcome: "auth" });
    await expect(
      probe(() => new Response(null, { status: 400 })),
    ).resolves.toMatchObject({ status: 400, outcome: "bad_request" });
    await expect(
      probe(() => new Response(null, { status: 500 })),
    ).resolves.toMatchObject({ status: 500, outcome: "server" });
    await expect(
      probe(() => new Response(null, { status: 302 })),
    ).resolves.toMatchObject({ status: 302, outcome: "redirect" });
    await expect(
      probe(() => chatWithUsage(JSON.stringify({ bogus: true }))),
    ).resolves.toMatchObject({ status: 200, outcome: "output_invalid" });
    await expect(
      probe(() => chatWithUsage("x".repeat(1024)), { maxBodyBytes: 64 }),
    ).resolves.toMatchObject({ outcome: "too_large" });
    const timeoutCall = await probe(() => {
      throw new DOMException("aborted", "AbortError");
    });
    expect(timeoutCall).toMatchObject({
      status: 0,
      outcome: "timeout",
      error_name: "AbortError",
    });
    // Sanitized message only: short, single-line, no serialized error object.
    expect(typeof timeoutCall["error"]).toBe("string");
    expect((timeoutCall["error"] as string).length).toBeLessThanOrEqual(200);
    expect(timeoutCall).not.toHaveProperty("stack");
  });
});
