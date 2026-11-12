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
  LIVE_UNAVAILABLE_RETRY_AFTER_S,
  LiveLlmChain,
  LlmRequestError,
  LlmUnavailableError,
  SUBMIT_PROBE_PARAMETERS,
  SUBMIT_PROBE_TOOL_NAME,
  cooldownMsForRetryAfter,
  discoverFallbackModels,
  discoverJsonMode,
  discoverKeys,
  discoverMaxWaiters,
  discoverModel,
  discoverTimeoutMs,
  discoverTotalTimeoutMs,
  discoverWaitTimeoutMs,
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

  it("caps null-body responses in UTF-8 bytes", async () => {
    const over = "é".repeat(40); // 40 chars but 80 UTF-8 bytes
    expect(over.length).toBeLessThan(64);
    expect(Buffer.byteLength(over, "utf8")).toBeGreaterThan(64);
    const nullBody = (text: string): Response =>
      ({
        status: 200,
        headers: new Headers(),
        body: null,
        text: async () => text,
      }) as unknown as Response;
    const infos: Array<{ obj: Record<string, unknown>; msg?: string }> = [];
    const chain = new LiveLlmChain({
      env: {
        LLM_PROVIDER_CHAIN: "groq",
        GROQ_API_KEY: "k",
        LLM_GROQ_MODEL: "ma",
      },
      fetchFn: stubFetch(() => nullBody(over), []),
      logger: {
        warn: () => {},
        info: (obj: Record<string, unknown>, msg?: string) => {
          infos.push({ obj, msg });
        },
      },
      timeoutMs: 5000,
      maxBodyBytes: 64,
    });
    await expect(chain.generate("cpu?")).rejects.toBeInstanceOf(
      LlmRequestError,
    );
    const call = infos.find((l) => l.msg === "live llm call")?.obj;
    expect(call).toMatchObject({ status: 200, outcome: "too_large" });
  });

  it("accepts null-body responses within the byte budget", async () => {
    const content = JSON.stringify(
      LlmOutputSchema.parse({
        script: "BEGIN { @x = count(); }\n",
        chart_type: "events",
        explanation: "héllo wörld",
        duration_s: 10,
        refusal: null,
      }),
    );
    expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(256 * 1024);
    const envelope = JSON.stringify({
      choices: [{ message: { content } }],
    });
    const chain = new LiveLlmChain({
      env: {
        LLM_PROVIDER_CHAIN: "groq",
        GROQ_API_KEY: "k",
        LLM_GROQ_MODEL: "ma",
      },
      fetchFn: stubFetch(
        () =>
          ({
            status: 200,
            headers: new Headers(),
            body: null,
            text: async () => envelope,
          }) as unknown as Response,
        [],
      ),
      timeoutMs: 5000,
    });
    const out = await chain.generate("cpu?");
    expect(out.script).toContain("BEGIN");
  });
});

describe("deadline spans headers and body", () => {
  const stallUntilAbort = (init: RequestInit): Promise<Response> =>
    new Promise((_resolve, reject) => {
      const sig = init.signal as AbortSignal | null | undefined;
      const err = (): Error =>
        sig?.reason instanceof Error
          ? sig.reason
          : new DOMException("aborted", "AbortError");
      if (sig?.aborted) {
        reject(err());
        return;
      }
      sig?.addEventListener("abort", () => reject(err()), { once: true });
    });

  const captureLogger = (): {
    infos: Array<{ obj: Record<string, unknown>; msg?: string }>;
    logger: {
      warn: () => void;
      info: (obj: Record<string, unknown>, msg?: string) => void;
    };
  } => {
    const infos: Array<{ obj: Record<string, unknown>; msg?: string }> = [];
    return {
      infos,
      logger: {
        warn: () => {},
        info: (obj: Record<string, unknown>, msg?: string) => {
          infos.push({ obj, msg });
        },
      },
    };
  };

  it("headers stall trips timeout, cools the provider, and frees the slot", async () => {
    const seen: Seen[] = [];
    const { infos, logger } = captureLogger();
    const fetchFn = stubFetch((url, init) => {
      if (url === GROQ_URL) return stallUntilAbort(init);
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
      logger,
      timeoutMs: 100,
      maxConcurrency: 1,
    });
    const started = Date.now();
    const out = await chain.generate("cpu?");
    expect(Date.now() - started).toBeLessThan(5000);
    expect(out.script).toContain("BEGIN");
    expect(chain.model).toBe("cerebras/mb");
    expect(chain.health().providers).toMatchObject([
      { name: "groq", state: "cooldown" },
      { name: "cerebras", state: "ready" },
    ]);
    const groqCall = infos.find(
      (l) => l.msg === "live llm call" && l.obj["provider"] === "groq",
    )?.obj;
    expect(groqCall).toMatchObject({
      status: 0,
      outcome: "timeout",
      error_name: "AbortError",
    });
    // Sole semaphore slot released: the next request runs, skips the
    // cooling provider, and succeeds instead of hanging.
    const again = await chain.generate("cpu?");
    expect(again.script).toContain("BEGIN");
    expect(seen.filter((s) => s.url === GROQ_URL)).toHaveLength(1);
  });

  it("slow-drip body is aborted by the deadline", async () => {
    let cancelled = false;
    const drip = new ReadableStream({
      async start(ctrl) {
        try {
          for (let i = 0; i < 100; i += 1) {
            await new Promise((done) => setTimeout(done, 25));
            if (cancelled) return;
            ctrl.enqueue(new TextEncoder().encode("x"));
          }
          ctrl.close();
        } catch {
          // Enqueue after cancel throws; the abort already won.
        }
      },
      cancel() {
        cancelled = true;
      },
    });
    const seen: Seen[] = [];
    const { infos, logger } = captureLogger();
    const chain = new LiveLlmChain({
      env: {
        LLM_PROVIDER_CHAIN: "groq",
        GROQ_API_KEY: "k",
        LLM_GROQ_MODEL: "ma",
      },
      fetchFn: stubFetch(
        () =>
          new Response(drip, {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        seen,
      ),
      logger,
      timeoutMs: 120,
      maxConcurrency: 1,
    });
    const started = Date.now();
    await expect(chain.generate("cpu?")).rejects.toBeInstanceOf(
      LlmUnavailableError,
    );
    expect(Date.now() - started).toBeLessThan(5000);
    expect(cancelled).toBe(true);
    const call = infos.find((l) => l.msg === "live llm call")?.obj;
    expect(call).toMatchObject({
      status: 200,
      outcome: "timeout",
      error_name: "AbortError",
    });
    // Slot released and provider cooling: the next call fails fast
    // without touching the network again.
    await expect(chain.generate("cpu?")).rejects.toBeInstanceOf(
      LlmUnavailableError,
    );
    expect(seen).toHaveLength(1);
  });

  it("stalled error body trips timeout with the error status intact", async () => {
    let cancelled = false;
    const stalled = new ReadableStream({
      start() {
        // Never enqueue or close: the error-body read pends until the
        // deadline aborts it.
      },
      cancel() {
        cancelled = true;
      },
    });
    const seen: Seen[] = [];
    const { infos, logger } = captureLogger();
    const chain = new LiveLlmChain({
      env: {
        LLM_PROVIDER_CHAIN: "groq",
        GROQ_API_KEY: "k",
        LLM_GROQ_MODEL: "ma",
      },
      fetchFn: stubFetch(
        () =>
          new Response(stalled, {
            status: 500,
            headers: { "content-type": "application/json" },
          }),
        seen,
      ),
      logger,
      timeoutMs: 100,
      maxConcurrency: 1,
    });
    const started = Date.now();
    await expect(chain.generate("cpu?")).rejects.toBeInstanceOf(
      LlmUnavailableError,
    );
    expect(Date.now() - started).toBeLessThan(5000);
    expect(cancelled).toBe(true);
    const call = infos.find((l) => l.msg === "live llm call")?.obj;
    expect(call).toMatchObject({
      status: 500,
      outcome: "timeout",
      error_name: "AbortError",
    });
    expect(chain.health().providers).toMatchObject([
      { name: "groq", state: "cooldown" },
    ]);
    // 500 never matches the JSON-downgrade retry (400/422 only): one hit.
    expect(seen).toHaveLength(1);
    // Slot released and provider cooling: the next call fails fast without
    // touching the network again.
    await expect(chain.generate("cpu?")).rejects.toBeInstanceOf(
      LlmUnavailableError,
    );
    expect(seen).toHaveLength(1);
  });

  it("body over the cap aborts the stream early", async () => {
    let cancelled = false;
    const flood = new ReadableStream({
      start(ctrl) {
        for (let i = 0; i < 1000; i += 1) {
          ctrl.enqueue(new TextEncoder().encode("x".repeat(32)));
        }
        ctrl.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const { infos, logger } = captureLogger();
    const chain = new LiveLlmChain({
      env: {
        LLM_PROVIDER_CHAIN: "groq",
        GROQ_API_KEY: "k",
        LLM_GROQ_MODEL: "ma",
      },
      fetchFn: stubFetch(
        () =>
          new Response(flood, {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        [],
      ),
      logger,
      timeoutMs: 5000,
      maxBodyBytes: 64,
    });
    const started = Date.now();
    await expect(chain.generate("cpu?")).rejects.toBeInstanceOf(
      LlmRequestError,
    );
    expect(Date.now() - started).toBeLessThan(5000);
    expect(cancelled).toBe(true);
    const call = infos.find((l) => l.msg === "live llm call")?.obj;
    expect(call).toMatchObject({ status: 200, outcome: "too_large" });
  });
});

describe("total budget and waiter limits", () => {
  const stallUntilAbort = (init: RequestInit): Promise<Response> =>
    new Promise((_resolve, reject) => {
      const sig = init.signal as AbortSignal | null | undefined;
      const err = (): Error =>
        sig?.reason instanceof Error
          ? sig.reason
          : new DOMException("aborted", "AbortError");
      if (sig?.aborted) {
        reject(err());
        return;
      }
      sig?.addEventListener("abort", () => reject(err()), { once: true });
    });

  it("reads timeout and waiter env with defaults", () => {
    expect(discoverTimeoutMs({})).toBe(45_000);
    expect(discoverTotalTimeoutMs({})).toBe(90_000);
    expect(discoverMaxWaiters({})).toBe(10);
    expect(discoverWaitTimeoutMs({})).toBe(10_000);
    expect(
      discoverTimeoutMs({ LLM_TIMEOUT_MS: "1000" } as NodeJS.ProcessEnv),
    ).toBe(1000);
    expect(
      discoverTotalTimeoutMs({
        LLM_TOTAL_TIMEOUT_MS: "5000",
      } as NodeJS.ProcessEnv),
    ).toBe(5000);
    expect(discoverTimeoutMs({ LLM_TIMEOUT_MS: "junk" })).toBe(45_000);
    expect(discoverTotalTimeoutMs({ LLM_TOTAL_TIMEOUT_MS: "0" })).toBe(90_000);
  });

  it("three stalling providers stay within the total budget", async () => {
    const seen: Seen[] = [];
    const chain = new LiveLlmChain({
      env: {
        LLM_PROVIDER_CHAIN: "groq,cerebras,openrouter",
        GROQ_API_KEY: "k1",
        LLM_GROQ_MODEL: "m1",
        CEREBRAS_API_KEY: "k2",
        LLM_CEREBRAS_MODEL: "m2",
        OPENROUTER_API_KEY: "k3",
        LLM_OPENROUTER_MODEL: "m3",
      },
      fetchFn: stubFetch((_url, init) => stallUntilAbort(init), seen),
      timeoutMs: 10_000,
      totalTimeoutMs: 700,
    });
    const started = Date.now();
    await expect(chain.generate("cpu?")).rejects.toBeInstanceOf(
      LlmUnavailableError,
    );
    const elapsed = Date.now() - started;
    // Without the budget this would take ~30 s (3 x 10 s per-request).
    expect(elapsed).toBeLessThan(700 + 2000);
    // First attempt ran with min(per-request, remaining); the rest of the
    // budget was exhausted before a second full attempt.
    expect(seen.length).toBeLessThanOrEqual(2);
  });

  it("explain honors the total budget too", async () => {
    const chain = new LiveLlmChain({
      env: {
        LLM_PROVIDER_CHAIN: "groq",
        GROQ_API_KEY: "k",
        LLM_GROQ_MODEL: "m1",
      },
      fetchFn: stubFetch((_url, init) => stallUntilAbort(init), []),
      timeoutMs: 10_000,
      totalTimeoutMs: 400,
    });
    const started = Date.now();
    await expect(
      chain.explainDetailed("BEGIN { @x = count(); }\n"),
    ).rejects.toBeInstanceOf(LlmUnavailableError);
    expect(Date.now() - started).toBeLessThan(400 + 2000);
  });

  it("rejects waiters beyond the cap without touching the network", async () => {
    const seen: Seen[] = [];
    const chain = new LiveLlmChain({
      env: {
        LLM_PROVIDER_CHAIN: "groq",
        GROQ_API_KEY: "k",
        LLM_GROQ_MODEL: "m1",
      },
      fetchFn: stubFetch((_url, init) => stallUntilAbort(init), seen),
      timeoutMs: 800,
      totalTimeoutMs: 8000,
      maxConcurrency: 1,
      maxWaiters: 1,
      waitTimeoutMs: 5000,
    });
    const first = chain.generate("cpu?");
    const second = chain.generate("cpu?");
    await expect(chain.generate("cpu?")).rejects.toBeInstanceOf(
      LlmUnavailableError,
    );
    await expect(first).rejects.toBeInstanceOf(LlmUnavailableError);
    await expect(second).rejects.toBeInstanceOf(LlmUnavailableError);
    expect(seen).toHaveLength(1);
  });

  it("times out queued waiters", async () => {
    const seen: Seen[] = [];
    const chain = new LiveLlmChain({
      env: {
        LLM_PROVIDER_CHAIN: "groq",
        GROQ_API_KEY: "k",
        LLM_GROQ_MODEL: "m1",
      },
      fetchFn: stubFetch((_url, init) => stallUntilAbort(init), seen),
      timeoutMs: 2500,
      totalTimeoutMs: 8000,
      maxConcurrency: 1,
      maxWaiters: 10,
      waitTimeoutMs: 150,
    });
    const first = chain.generate("cpu?");
    const started = Date.now();
    await expect(chain.generate("cpu?")).rejects.toBeInstanceOf(
      LlmUnavailableError,
    );
    expect(Date.now() - started).toBeLessThan(150 + 2000);
    await expect(first).rejects.toBeInstanceOf(LlmUnavailableError);
    expect(seen).toHaveLength(1);
  });

  it("client disconnect aborts the in-flight request", async () => {
    const ctrl = new AbortController();
    const chain = new LiveLlmChain({
      env: {
        LLM_PROVIDER_CHAIN: "groq",
        GROQ_API_KEY: "k",
        LLM_GROQ_MODEL: "m1",
      },
      fetchFn: stubFetch((_url, init) => stallUntilAbort(init), []),
      timeoutMs: 10_000,
      totalTimeoutMs: 10_000,
    });
    const pending = chain.generateDetailed("cpu?", undefined, {
      signal: ctrl.signal,
    });
    ctrl.abort();
    await expect(pending).rejects.toBeInstanceOf(LlmUnavailableError);
  });

  it("budget exhaustion over the route returns 503 with retry_after_s", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vbpf-budget-"));
    const tokenFile = join(dir, "agent.token");
    writeFileSync(tokenFile, `${TOKEN}\n`);
    const fake = await startFakeAgent();
    const stalling = stubFetch((_url, init) => stallUntilAbort(init), []);
    const app = await buildApp({
      agentUrl: fake.url,
      tokenFile,
      dbPath: ":memory:",
      recipesDir: RECIPES_DIR,
      webOrigin: "http://localhost:5173",
      llmMode: "live",
      llmChain: "groq",
      llmEnv: {
        LLM_PROVIDER_CHAIN: "groq",
        GROQ_API_KEY: "k",
        LLM_GROQ_MODEL: "m1",
        LLM_TIMEOUT_MS: "10000",
        LLM_TOTAL_TIMEOUT_MS: "400",
      },
      llmFetch: stalling,
    });
    const addr = await app.listen({ host: "127.0.0.1", port: 0 });
    try {
      const res = await fetch(
        `${addr.replace("[::1]", "127.0.0.1")}/api/generate`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ prompt: "Which processes open files?" }),
        },
      );
      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe(
        String(LIVE_UNAVAILABLE_RETRY_AFTER_S),
      );
      expect(await res.json()).toMatchObject({
        code: "LLM_UNAVAILABLE",
        retry_after_s: LIVE_UNAVAILABLE_RETRY_AFTER_S,
      });
    } finally {
      await app.close();
      await fake.close();
      rmSync(dir, { recursive: true, force: true });
    }
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
    if (req.method === "GET" && url.pathname === "/health") {
      send(200, {
        kernel: "6.8.0",
        bpftrace_version: "bpftrace v0.20.4",
        btf: true,
        root: true,
        tracefs: true,
        uptime_s: 12,
        ready: true,
        catalog: { state: "ready", probes: 1, warnings: [] },
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/probes") {
      send(200, { probes: ["BEGIN"], count: 1 });
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/validate") {
      send(200, {
        ok: true,
        errors: [],
        probes: ["BEGIN"],
        warnings: [],
        probe_count: 1,
      });
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

describe("json modes", () => {
  const validArgs = (): string => VALID_CONTENT;

  const toolEnvelope = (args: string): unknown => ({
    choices: [
      {
        message: {
          tool_calls: [
            { function: { name: SUBMIT_PROBE_TOOL_NAME, arguments: args } },
          ],
        },
      },
    ],
  });

  const startJsonStub = (
    respond: (body: Record<string, unknown>) => {
      status: number;
      json: unknown;
    },
  ): Promise<{
    baseUrl: string;
    requests: Array<Record<string, unknown>>;
    close: () => Promise<void>;
  }> => {
    const requests: Array<Record<string, unknown>> = [];
    const server: Server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => {
        raw += String(chunk);
      });
      req.on("end", () => {
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          body = {};
        }
        requests.push(body);
        const out = respond(body);
        res.writeHead(out.status, { "content-type": "application/json" });
        res.end(JSON.stringify(out.json));
      });
    });
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        const port = typeof addr === "object" && addr !== null ? addr.port : 0;
        resolve({
          baseUrl: `http://127.0.0.1:${port}/v1`,
          requests,
          close: () =>
            new Promise<void>((done) => {
              server.close(() => done());
            }),
        });
      });
    });
  };

  const chainFor = (
    baseUrl: string,
    mode: string | undefined,
    warns?: string[],
  ): LiveLlmChain =>
    new LiveLlmChain({
      env: {
        LLM_PROVIDER_CHAIN: "groq",
        GROQ_API_KEY: "k",
        LLM_GROQ_MODEL: "m1",
        LLM_GROQ_BASE_URL: baseUrl,
        ...(mode === undefined ? {} : { LLM_GROQ_JSON_MODE: mode }),
      } as NodeJS.ProcessEnv,
      ...(warns === undefined
        ? {}
        : { logger: { warn: (msg: string) => warns.push(msg) } }),
    });

  it("reads LLM_<NAME>_JSON_MODE with a json_object default", () => {
    expect(discoverJsonMode("groq", {})).toBe("json_object");
    expect(discoverJsonMode("groq", { LLM_GROQ_JSON_MODE: "garbage" })).toBe(
      "json_object",
    );
    expect(discoverJsonMode("groq", { LLM_GROQ_JSON_MODE: " Tool " })).toBe(
      "tool",
    );
    expect(discoverJsonMode("groq", { LLM_GROQ_JSON_MODE: "NONE" })).toBe(
      "none",
    );
    expect(
      discoverJsonMode("groq", { LLM_GROQ_JSON_MODE: "json_object" }),
    ).toBe("json_object");
  });

  it("json_object sends response_format and keeps JSON in the system message", async () => {
    const stub = await startJsonStub(() => ({
      status: 200,
      json: { choices: [{ message: { content: validArgs() } }] },
    }));
    try {
      const chain = chainFor(stub.baseUrl, undefined);
      const out = await chain.generate("cpu?");
      expect(out.script).toContain("BEGIN");
      expect(stub.requests).toHaveLength(1);
      const body = stub.requests[0] as Record<string, unknown>;
      expect(body["response_format"]).toEqual({ type: "json_object" });
      expect(body).not.toHaveProperty("tools");
      expect(body).not.toHaveProperty("tool_choice");
      const messages = body["messages"] as Array<{ content: string }>;
      expect(messages[0]?.content).toContain("JSON");
    } finally {
      await stub.close();
    }
  });

  it("tool sends one submit_probe tool with forced choice", async () => {
    const stub = await startJsonStub(() => ({
      status: 200,
      json: toolEnvelope(validArgs()),
    }));
    try {
      const chain = chainFor(stub.baseUrl, "tool");
      const out = await chain.generate("cpu?");
      expect(out.script).toContain("BEGIN");
      expect(stub.requests).toHaveLength(1);
      const body = stub.requests[0] as Record<string, unknown>;
      expect(body).not.toHaveProperty("response_format");
      expect(body["tools"]).toEqual([
        {
          type: "function",
          function: {
            name: SUBMIT_PROBE_TOOL_NAME,
            description: "Submit the generated bpftrace probe.",
            parameters: SUBMIT_PROBE_PARAMETERS,
          },
        },
      ]);
      expect(body["tool_choice"]).toEqual({
        type: "function",
        function: { name: SUBMIT_PROBE_TOOL_NAME },
      });
    } finally {
      await stub.close();
    }
  });

  it("none sends no shaping fields", async () => {
    const stub = await startJsonStub(() => ({
      status: 200,
      json: { choices: [{ message: { content: validArgs() } }] },
    }));
    try {
      const chain = chainFor(stub.baseUrl, "none");
      const out = await chain.generate("cpu?");
      expect(out.script).toContain("BEGIN");
      expect(stub.requests).toHaveLength(1);
      const body = stub.requests[0] as Record<string, unknown>;
      expect(body).not.toHaveProperty("response_format");
      expect(body).not.toHaveProperty("tools");
      expect(body).not.toHaveProperty("tool_choice");
    } finally {
      await stub.close();
    }
  });

  it("hand-written schema validates identically to zod", () => {
    // Minimal reader for SUBMIT_PROBE_PARAMETERS (no new dependency).
    // Script uses UTF-8 bytes to match validator.ts; maxLength stays a char
    // hint for providers, zod byte-length refine is authoritative.
    const schemaValid = (value: unknown): boolean => {
      if (typeof value !== "object" || value === null) return false;
      const record = value as Record<string, unknown>;
      if (
        JSON.stringify(Object.keys(record).sort()) !==
        JSON.stringify([
          "chart_type",
          "duration_s",
          "explanation",
          "refusal",
          "script",
        ])
      ) {
        return false;
      }
      if (
        typeof record["script"] !== "string" ||
        new TextEncoder().encode(record["script"]).length > 8 * 1024
      ) {
        return false;
      }
      if (
        !["table", "bar", "histogram", "timeseries", "events"].includes(
          record["chart_type"] as string,
        )
      ) {
        return false;
      }
      if (
        typeof record["explanation"] !== "string" ||
        record["explanation"].length > 2048
      ) {
        return false;
      }
      if (
        typeof record["duration_s"] !== "number" ||
        !Number.isInteger(record["duration_s"]) ||
        (record["duration_s"] as number) < 1 ||
        (record["duration_s"] as number) > 60
      ) {
        return false;
      }
      const refusal = record["refusal"];
      return (
        refusal === null ||
        (typeof refusal === "string" && refusal.length <= 2048)
      );
    };

    const base = {
      script: "BEGIN { @x = count(); }\n",
      chart_type: "events",
      explanation: "ok",
      duration_s: 10,
      refusal: null,
    };
    const samples: unknown[] = [
      base,
      { ...base, refusal: "nope" },
      { ...base, duration_s: 1 },
      { ...base, duration_s: 60 },
      { ...base, chart_type: "nope" },
      { ...base, duration_s: 0 },
      { ...base, duration_s: 61 },
      { ...base, duration_s: 1.5 },
      { ...base, refusal: 42 },
      { ...base, extra: true },
      { ...base, script: "x".repeat(8 * 1024 + 1) },
      { ...base, explanation: "x".repeat(2049) },
      // Byte parity: multi-byte chars under the char count but over bytes.
      { ...base, script: `BEGIN { @x = count(); }\n// ${"é".repeat(4090)}` },
      { ...base, script: "BEGIN { @x = count(); }\n// héllo wörld\n" },
      "just a string",
      null,
    ];
    for (const sample of samples) {
      expect(
        schemaValid(sample),
        `parity for ${JSON.stringify(sample)?.slice(0, 80)}`,
      ).toBe(LlmOutputSchema.safeParse(sample).success);
    }
    expect(SUBMIT_PROBE_PARAMETERS).toEqual({
      type: "object",
      properties: {
        script: { type: "string", maxLength: 8 * 1024 },
        chart_type: {
          type: "string",
          enum: ["table", "bar", "histogram", "timeseries", "events"],
        },
        explanation: { type: "string", maxLength: 2048 },
        duration_s: { type: "integer", minimum: 1, maximum: 60 },
        refusal: { type: ["string", "null"], maxLength: 2048 },
      },
      required: [
        "script",
        "chart_type",
        "explanation",
        "duration_s",
        "refusal",
      ],
      additionalProperties: false,
    });
  });

  it("downgrades to none on a json-mode 400 and retries once", async () => {
    const warns: string[] = [];
    const stub = await startJsonStub((body) => {
      if ("response_format" in body || "tools" in body) {
        return {
          status: 400,
          json: {
            error: {
              message: "response_format json_object is not supported",
              code: "bad_request",
            },
          },
        };
      }
      return {
        status: 200,
        json: { choices: [{ message: { content: validArgs() } }] },
      };
    });
    try {
      const chain = chainFor(stub.baseUrl, "json_object", warns);
      const out = await chain.generate("cpu?");
      expect(out.script).toContain("BEGIN");
      expect(stub.requests).toHaveLength(2);
      expect(stub.requests[0]).toHaveProperty("response_format");
      expect(stub.requests[1]).not.toHaveProperty("response_format");
      expect(stub.requests[1]).not.toHaveProperty("tools");
      expect(warns).toHaveLength(1);

      await chain.generate("cpu?");
      expect(stub.requests).toHaveLength(3);
      expect(stub.requests[2]).not.toHaveProperty("response_format");
      expect(stub.requests[2]).not.toHaveProperty("tools");
      expect(warns).toHaveLength(1);
      expect(chain.health().providers).toMatchObject([
        { name: "groq", state: "ready" },
      ]);
    } finally {
      await stub.close();
    }
  });

  it("downgrades tool mode on a 422 mentioning tool", async () => {
    const warns: string[] = [];
    const stub = await startJsonStub((body) => {
      if ("tools" in body || "tool_choice" in body) {
        return {
          status: 422,
          json: {
            error: { message: "tool_choice is not supported", code: "bad" },
          },
        };
      }
      return {
        status: 200,
        json: { choices: [{ message: { content: validArgs() } }] },
      };
    });
    try {
      const chain = chainFor(stub.baseUrl, "tool", warns);
      const out = await chain.generate("cpu?");
      expect(out.script).toContain("BEGIN");
      expect(stub.requests).toHaveLength(2);
      expect(stub.requests[0]).toHaveProperty("tools");
      expect(stub.requests[1]).not.toHaveProperty("tools");
      expect(warns).toHaveLength(1);
    } finally {
      await stub.close();
    }
  });

  it("keeps other 400s on the model-fallback path", async () => {
    const warns: string[] = [];
    const stub = await startJsonStub(() => ({
      status: 400,
      json: { error: { message: "unknown model id", code: "bad" } },
    }));
    try {
      const chain = chainFor(stub.baseUrl, "json_object", warns);
      await expect(chain.generate("cpu?")).rejects.toBeInstanceOf(
        LlmRequestError,
      );
      expect(stub.requests).toHaveLength(1);
      expect(warns).toHaveLength(0);
    } finally {
      await stub.close();
    }
  });

  it("keeps downgrade scoped to the chain that triggered it", async () => {
    const warnsFirst: string[] = [];
    const warnsSecond: string[] = [];
    const stub = await startJsonStub((body) => {
      if ("response_format" in body || "tools" in body) {
        return {
          status: 400,
          json: {
            error: {
              message: "response_format json_object is not supported",
              code: "bad_request",
            },
          },
        };
      }
      return {
        status: 200,
        json: { choices: [{ message: { content: validArgs() } }] },
      };
    });
    try {
      const first = chainFor(stub.baseUrl, "json_object", warnsFirst);
      const out = await first.generate("cpu?");
      expect(out.script).toContain("BEGIN");
      expect(stub.requests).toHaveLength(2);
      expect(warnsFirst).toHaveLength(1);

      const second = chainFor(stub.baseUrl, "json_object", warnsSecond);
      const out2 = await second.generate("cpu?");
      expect(out2.script).toContain("BEGIN");
      expect(stub.requests).toHaveLength(4);
      expect(stub.requests[2]).toHaveProperty("response_format");
      expect(stub.requests[3]).not.toHaveProperty("response_format");
      expect(warnsSecond).toHaveLength(1);
    } finally {
      await stub.close();
    }
  });
});

describe("openai preset", () => {
  it("posts chat completions with Bearer auth", async () => {
    const seen: Seen[] = [];
    const chain = new LiveLlmChain({
      env: {
        LLM_PROVIDER_CHAIN: "openai",
        OPENAI_API_KEY: "k",
        LLM_OPENAI_MODEL: "m1",
      },
      fetchFn: stubFetch(() => chatOk(), seen),
    });
    expect(chain.configured).toBe(true);
    const out = await chain.generate("cpu?");
    expect(out.chart_type).toBe("events");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(seen[0]?.auth).toBe("Bearer k");
  });

  it("unconfigured without its own model", () => {
    const chain = new LiveLlmChain({
      env: { LLM_PROVIDER_CHAIN: "openai", OPENAI_API_KEY: "k" },
      fetchFn: stubFetch(() => chatOk(), []),
    });
    expect(chain.configured).toBe(false);
    expect(chain.health().providers).toEqual([
      { name: "openai", state: "unconfigured", keys: 1 },
    ]);
  });
});

describe("anthropic native adapter", () => {
  type Captured = { url: string; headers: Headers; body: unknown };

  const captureFetch = (
    handler: (body: unknown) => Response | Promise<Response>,
    captured: Captured[],
  ): typeof fetch =>
    (async (url: unknown, init?: unknown) => {
      const request = (init ?? {}) as RequestInit;
      const headers = new Headers(request.headers);
      let body: unknown = null;
      try {
        body = JSON.parse(String(request.body));
      } catch {
        body = null;
      }
      captured.push({ url: String(url), headers, body });
      return handler(body);
    }) as typeof fetch;

  const messagesOk = (blocks: unknown[], usage?: unknown): Response =>
    new Response(
      JSON.stringify({
        content: blocks,
        ...(usage !== undefined ? { usage } : {}),
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  const anthropicEnv = (extra?: Record<string, string>): NodeJS.ProcessEnv =>
    ({
      LLM_PROVIDER_CHAIN: "anthropic",
      ANTHROPIC_API_KEY: "anthropic-key",
      LLM_ANTHROPIC_MODEL: "m-anthropic",
      ...extra,
    }) as NodeJS.ProcessEnv;

  it("discovers ANTHROPIC_API_KEY names", () => {
    expect(
      discoverKeys("anthropic", {
        LLM_ANTHROPIC_API_KEY: "a",
        ANTHROPIC_API_KEY: "b",
      }),
    ).toEqual(["a", "b"]);
  });

  it("posts native messages with x-api-key and version", async () => {
    const captured: Captured[] = [];
    const chain = new LiveLlmChain({
      env: anthropicEnv(),
      fetchFn: captureFetch(
        () =>
          messagesOk([{ type: "text", text: VALID_CONTENT }], {
            input_tokens: 11,
            output_tokens: 22,
          }),
        captured,
      ),
    });
    expect(chain.configured).toBe(true);
    const detailed = await chain.generateDetailed("cpu?");
    expect(detailed.output.chart_type).toBe("events");
    expect(detailed.usage).toEqual({
      prompt_tokens: 11,
      completion_tokens: 22,
    });
    expect(captured).toHaveLength(1);
    const first = captured[0];
    expect(first?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(first?.headers.get("x-api-key")).toBe("anthropic-key");
    expect(first?.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(first?.headers.get("authorization")).toBeNull();
    const body = first?.body as Record<string, unknown>;
    expect(body["model"]).toBe("m-anthropic");
    expect(typeof body["system"]).toBe("string");
    expect(body["messages"]).toEqual([
      { role: "user", content: expect.any(String) },
    ]);
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("response_format");
  });

  it("forces submit_probe tool in tool mode", async () => {
    const captured: Captured[] = [];
    const chain = new LiveLlmChain({
      env: anthropicEnv({ LLM_ANTHROPIC_JSON_MODE: "tool" }),
      fetchFn: captureFetch(
        () =>
          messagesOk([
            {
              type: "tool_use",
              id: "toolu_1",
              name: SUBMIT_PROBE_TOOL_NAME,
              input: JSON.parse(VALID_CONTENT) as unknown,
            },
          ]),
        captured,
      ),
    });
    const out = await chain.generate("cpu?");
    expect(out.chart_type).toBe("events");
    const body = captured[0]?.body as Record<string, unknown>;
    const tools = body["tools"] as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    expect(tools[0]?.["name"]).toBe(SUBMIT_PROBE_TOOL_NAME);
    expect(tools[0]).toHaveProperty("input_schema");
    expect(body["tool_choice"]).toEqual({
      type: "tool",
      name: SUBMIT_PROBE_TOOL_NAME,
    });
  });

  it("rotates keys on 401", async () => {
    const captured: Captured[] = [];
    const chain = new LiveLlmChain({
      env: anthropicEnv({
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_API_KEY1: "bad",
        ANTHROPIC_API_KEY2: "good",
      }),
      fetchFn: captureFetch(() => {
        const last = captured[captured.length - 1];
        if (last?.headers.get("x-api-key") === "good") {
          return messagesOk([{ type: "text", text: VALID_CONTENT }]);
        }
        return new Response(null, { status: 401 });
      }, captured),
    });
    const out = await chain.generate("cpu?");
    expect(out.chart_type).toBe("events");
    expect(captured).toHaveLength(2);
  });

  it.each([429, 529])("cools down on %i", async (status) => {
    const chain = new LiveLlmChain({
      env: anthropicEnv(),
      fetchFn: captureFetch(() => new Response(null, { status }), []),
    });
    await expect(chain.generate("cpu?")).rejects.toBeInstanceOf(
      LlmUnavailableError,
    );
    expect(chain.health().providers).toEqual([
      { name: "anthropic", state: "cooldown", keys: 1 },
    ]);
  });

  it("maps 400 to model failure", async () => {
    const chain = new LiveLlmChain({
      env: anthropicEnv(),
      fetchFn: captureFetch(
        () => new Response("no such model", { status: 400 }),
        [],
      ),
    });
    await expect(chain.generate("cpu?")).rejects.toBeInstanceOf(
      LlmRequestError,
    );
  });

  it("rejects empty text blocks", async () => {
    const chain = new LiveLlmChain({
      env: anthropicEnv(),
      fetchFn: captureFetch(() => messagesOk([]), []),
    });
    await expect(chain.generate("cpu?")).rejects.toThrow(
      "missing content text",
    );
  });

  it("rejects missing tool_use in tool mode", async () => {
    const chain = new LiveLlmChain({
      env: anthropicEnv({ LLM_ANTHROPIC_JSON_MODE: "tool" }),
      fetchFn: captureFetch(
        () => messagesOk([{ type: "text", text: "no tools here" }]),
        [],
      ),
    });
    await expect(chain.generate("cpu?")).rejects.toThrow(
      `missing content tool_use ${SUBMIT_PROBE_TOOL_NAME}`,
    );
  });

  it("explains via text blocks", async () => {
    const captured: Captured[] = [];
    const chain = new LiveLlmChain({
      env: anthropicEnv(),
      fetchFn: captureFetch(
        () => messagesOk([{ type: "text", text: "  counts opens  " }]),
        captured,
      ),
    });
    const result = await chain.explainDetailed("BEGIN { @x = count(); }\n");
    expect(result.explanation).toBe("counts opens");
    const body = captured[0]?.body as Record<string, unknown>;
    expect(body["system"]).toContain("plain English");
    expect(body["messages"]).toEqual([
      { role: "user", content: "BEGIN { @x = count(); }\n" },
    ]);
  });

  it("parses Anthropic usage names", () => {
    expect(
      parseUsage({ usage: { input_tokens: 5, output_tokens: 9 } }),
    ).toEqual({ prompt_tokens: 5, completion_tokens: 9 });
    expect(
      parseUsage({
        usage: {
          prompt_tokens: 1,
          input_tokens: 2,
          completion_tokens: 3,
          output_tokens: 4,
        },
      }),
    ).toEqual({ prompt_tokens: 1, completion_tokens: 3 });
  });
});
