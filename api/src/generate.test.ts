import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";

import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenerateResponseSchema, type GenerateResponse } from "@vbpf/schemas";

import { buildApp } from "./server.js";
import { indexRecipes, migrate, openDb } from "./db.js";
import {
  RefusalError,
  ValidationFailedError,
  formatProbeArgs,
  runGenerate,
  selectTracepointProbes,
} from "./generate.js";
import { LlmOutputSchema, MockLlm } from "./llm.js";
import {
  ARG_FORMATS_FALLBACK,
  buildGeneratePrompt,
  GOTCHAS,
  SYSTEM_PROMPT,
  type RecipeWithBody,
} from "./prompts.js";
import { loadRecipes } from "./recipes.js";
import { parseHeaderTargets, staticValidate } from "./validator.js";

const RECIPES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "recipes",
);
const TOKEN = "test-token-generate";

function makeDb(): Database.Database {
  const db = openDb(":memory:");
  migrate(db);
  indexRecipes(db, loadRecipes(RECIPES_DIR));
  return db;
}

function cpuRecipe(): RecipeWithBody {
  return {
    id: "cpu-by-process",
    title: "CPU by process",
    description: "Samples on-CPU stacks.",
    tags: ["cpu"],
    view: "bar",
    body: "profile:hz:99\n{\n  @cpu[comm] = count();\n}\n",
  };
}

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
      send(200, {
        probes: [
          "tracepoint:block:block_rq_issue",
          "tracepoint:block:block_rq_complete",
          "tracepoint:syscalls:sys_enter_openat",
          "tracepoint:sched:sched_process_exec",
          "tracepoint:sock:inet_sock_set_state",
          "tracepoint:tcp:tcp_retransmit_skb",
          "tracepoint:raw_syscalls:sys_enter",
          "profile:hz:99",
          "software:page-faults",
          "uprobe:libc:getaddrinfo",
          "BEGIN",
        ],
        count: 11,
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/probe-args") {
      const probe = url.searchParams.get("probe") ?? "";
      const known = [
        "tracepoint:block:block_rq_issue",
        "tracepoint:block:block_rq_complete",
        "tracepoint:syscalls:sys_enter_openat",
        "tracepoint:sched:sched_process_exec",
        "tracepoint:sock:inet_sock_set_state",
        "tracepoint:tcp:tcp_retransmit_skb",
        "tracepoint:raw_syscalls:sys_enter",
      ];
      if (!known.includes(probe)) {
        send(404, { error: "unknown probe", code: "NOT_FOUND" });
      } else {
        send(200, {
          probe,
          output: `${probe}\n  int field_${probe.length};\n`,
        });
      }
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/validate") {
      let raw = "";
      req.on("data", (c) => {
        raw += c;
      });
      req.on("end", () => {
        const body = JSON.parse(raw as string) as { script?: string };
        const script = body.script ?? "";
        if (script.includes("bad-probe")) {
          send(200, {
            ok: false,
            errors: ["probe not found: bad-probe"],
            probes: [],
            warnings: [],
            probe_count: 0,
          });
        } else if (
          script.includes("system(") ||
          script.includes("--unsafe") ||
          script.includes("#include")
        ) {
          send(200, {
            ok: false,
            errors: ["blocked construct"],
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

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "vbpf-generate-"));
  tokenFile = join(dir, "agent.token");
  writeFileSync(tokenFile, `${TOKEN}\n`);
  fake = await startFakeAgent();
  app = await buildApp({
    agentUrl: fake.url,
    tokenFile,
    dbPath: join(dir, "api.sqlite3"),
    recipesDir: RECIPES_DIR,
    webOrigin: "http://localhost:5173",
    llmModel: "mock",
    llmMode: "mock",
  });
  const addr = await app.listen({ host: "127.0.0.1", port: 0 });
  base = addr.replace("[::1]", "127.0.0.1");
}, 30000);

afterAll(async () => {
  await app?.close();
  await fake?.close();
  if (dir !== "") rmSync(dir, { recursive: true, force: true });
});

describe("prompt assembly order", () => {
  it("orders static prefix, recipes, probes, arg formats, user", () => {
    const recipes = [cpuRecipe()];
    const probes = ["profile:hz:99", "BEGIN"];
    const { text, staticPrefix } = buildGeneratePrompt(
      "which processes use CPU?",
      recipes,
      probes,
    );
    expect(staticPrefix).toBe(`${SYSTEM_PROMPT}\n\n${GOTCHAS}`);
    const order = [
      "==SYSTEM==",
      "==RECIPES==",
      "==PROBES==",
      "==ARG_FORMATS==",
      "==USER==",
    ].map((m) => text.indexOf(m));
    for (const idx of order) expect(idx).toBeGreaterThanOrEqual(0);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).toContain("cpu-by-process");
    expect(text).toContain("profile:hz:99");
    expect(text).toContain("which processes use CPU?");
  });

  it("caps probes at 40", () => {
    const many = Array.from(
      { length: 60 },
      (_, i) => `tracepoint:syscalls:sys_enter_${i}`,
    );
    const { text } = buildGeneratePrompt("hi", [], many);
    expect(text).not.toContain("sys_enter_59");
    expect(text).toContain("sys_enter_39");
  });

  it("falls back to canned formats when no args provided", () => {
    const { text } = buildGeneratePrompt("hi", [], [], undefined);
    expect(text).toContain(ARG_FORMATS_FALLBACK);
  });

  it("injects real arg formats when provided", () => {
    const injected =
      "tracepoint:syscalls:sys_enter_openat:\n  const char * filename;\n";
    const { text } = buildGeneratePrompt("hi", [], [], injected);
    expect(text).toContain(injected);
    expect(text).not.toContain(ARG_FORMATS_FALLBACK);
  });

  it("keeps the output contract valid on refusal", () => {
    const { text } = buildGeneratePrompt("hi", [], [], undefined);
    expect(text).toContain("When refusing");
  });
});

describe("tracepoint selection", () => {
  it("prefers recipe tracepoints then catalog probes, capped at 3", () => {
    const recipes: RecipeWithBody[] = [
      {
        ...cpuRecipe(),
        body: "tracepoint:block:block_rq_issue { @x = count(); }\ntracepoint:syscalls:sys_enter_openat { @y = count(); }\n",
      },
    ];
    const probes = [
      "tracepoint:sock:inet_sock_set_state",
      "tracepoint:tcp:tcp_retransmit_skb",
      "tracepoint:syscalls:sys_enter_openat",
      "kprobe:tcp_v4_connect",
      "tracepoint:syscalls:*",
    ];
    expect(selectTracepointProbes(recipes, probes)).toEqual([
      "tracepoint:block:block_rq_issue",
      "tracepoint:syscalls:sys_enter_openat",
      "tracepoint:sock:inet_sock_set_state",
    ]);
  });

  it("skips wildcards and non-tracepoints", () => {
    expect(
      selectTracepointProbes([], ["kprobe:tcp_v4_connect", "BEGIN"]),
    ).toEqual([]);
    expect(
      selectTracepointProbes(
        [],
        ["tracepoint:syscalls:*", "tracepoint:block:block_rq_issue"],
      ),
    ).toEqual(["tracepoint:block:block_rq_issue"]);
  });

  it("caps formatted output per probe", () => {
    const out = formatProbeArgs([
      { probe: "tracepoint:a:b", output: `x${"y".repeat(5000)}` },
    ]);
    expect(out).toContain("tracepoint:a:b:");
    expect(out.length).toBeLessThanOrEqual("tracepoint:a:b:\n".length + 2000);
  });
});

describe("probe-args injection", () => {
  it("fetches top tracepoint args into the llm prompt", async () => {
    const db = makeDb();
    let seenPrompt = "";
    const stub = {
      model: "mock",
      generate: async (prompt: string) => {
        seenPrompt = prompt;
        return LlmOutputSchema.parse({
          script: "tracepoint:syscalls:sys_enter_openat { @x = count(); }\n",
          chart_type: "events",
          explanation: "ok",
          duration_s: 10,
          refusal: null,
        });
      },
    };
    await runGenerate("who is opening files", {
      deps: {
        db,
        recipesDir: RECIPES_DIR,
        agentUrl: fake.url,
        tokenFile,
        llm: stub,
        searchProbesFn: async () => ["tracepoint:syscalls:sys_enter_openat"],
        validateAgentFn: async () => ({
          ok: true,
          errors: [],
          probes: [],
          warnings: [],
          probe_count: 1,
        }),
        probeArgsFn: async () =>
          "tracepoint:syscalls:sys_enter_openat\n  const char * filename;\n",
      },
    });
    expect(seenPrompt).toContain("==ARG_FORMATS==");
    expect(seenPrompt).toContain("filename");
    expect(seenPrompt).not.toContain(ARG_FORMATS_FALLBACK);
    db.close();
  });

  it("falls back when probe-args fetch fails", async () => {
    const db = makeDb();
    let seenPrompt = "";
    const stub = {
      model: "mock",
      generate: async (prompt: string) => {
        seenPrompt = prompt;
        return LlmOutputSchema.parse({
          script: "tracepoint:syscalls:sys_enter_openat { @x = count(); }\n",
          chart_type: "events",
          explanation: "ok",
          duration_s: 10,
          refusal: null,
        });
      },
    };
    await runGenerate("who is opening files", {
      deps: {
        db,
        recipesDir: RECIPES_DIR,
        agentUrl: fake.url,
        tokenFile,
        llm: stub,
        searchProbesFn: async () => ["tracepoint:syscalls:sys_enter_openat"],
        validateAgentFn: async () => ({
          ok: true,
          errors: [],
          probes: [],
          warnings: [],
          probe_count: 1,
        }),
        probeArgsFn: async () => {
          throw new Error("agent down");
        },
      },
    });
    expect(seenPrompt).toContain(ARG_FORMATS_FALLBACK);
    db.close();
  });

  it("fake agent serves the probe-args contract", async () => {
    const { fetchProbeArgs } = await import("./agent-client.js");
    const output = await fetchProbeArgs(
      fake.url,
      tokenFile,
      "tracepoint:block:block_rq_issue",
    );
    expect(output).toContain("tracepoint:block:block_rq_issue");
    await expect(
      fetchProbeArgs(fake.url, tokenFile, "tracepoint:nope:missing"),
    ).rejects.toThrow();
  });
});

describe("mock llm contract", () => {
  it("returns valid JSON echoing top-1 recipe", async () => {
    const top = cpuRecipe();
    const llm = new MockLlm("mock", () => top);
    const out = await llm.generate("==USER== cpu hogs");
    expect(() => LlmOutputSchema.parse(out)).not.toThrow();
    expect(out.refusal).toBeNull();
    expect(out.script).toContain("profile:hz:99");
    expect(out.chart_type).toBe("bar");
    expect(out.duration_s).toBeGreaterThanOrEqual(1);
    expect(out.duration_s).toBeLessThanOrEqual(60);
    expect(out.script.length).toBeLessThanOrEqual(8 * 1024);
  });
});

describe("refusal", () => {
  it("mock refuses kill-process prompts", async () => {
    const llm = new MockLlm("mock", () => cpuRecipe());
    const out = await llm.generate(
      "==USER== Kill the process using the most CPU",
    );
    expect(out.refusal).toBeTruthy();
  });

  it("runGenerate persists refusal", async () => {
    const db = makeDb();
    const llm = new MockLlm("mock", () => cpuRecipe());
    try {
      await runGenerate("Kill the process using the most CPU", {
        deps: {
          db,
          recipesDir: RECIPES_DIR,
          agentUrl: fake.url,
          tokenFile,
          llm,
          searchProbesFn: async () => [],
        },
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(RefusalError);
    }
    const row = db
      .prepare("SELECT validation_status, refusal FROM generations LIMIT 1")
      .get() as { validation_status: string; refusal: string };
    expect(row.validation_status).toBe("refused");
    expect(row.refusal).toBeTruthy();
    db.close();
  });

  it("POST /api/generate returns 422 REFUSAL", async () => {
    const res = await fetch(`${base}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Kill the process using the most CPU" }),
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: "REFUSAL" });
  });
});

describe("retry loop", () => {
  it("feeds truncated errors back and succeeds on retry", async () => {
    const db = makeDb();
    const good = "tracepoint:syscalls:sys_enter_openat { @x = count(); }\n";
    let calls = 0;
    const stub = {
      model: "mock",
      generate: async (_prompt: string, feedback?: { errors: string[] }) => {
        calls += 1;
        if (calls === 1) {
          return LlmOutputSchema.parse({
            script: "tracepoint:syscalls:bad-probe { @x = count(); }\n",
            chart_type: "events",
            explanation: "first attempt",
            duration_s: 10,
            refusal: null,
          });
        }
        expect(feedback?.errors.join("\n")).toContain("probe not found");
        return LlmOutputSchema.parse({
          script: good,
          chart_type: "events",
          explanation: "fixed",
          duration_s: 10,
          refusal: null,
        });
      },
    };
    const result = await runGenerate("who is opening files", {
      deps: {
        db,
        recipesDir: RECIPES_DIR,
        agentUrl: fake.url,
        tokenFile,
        llm: stub,
        searchProbesFn: async () => [],
        validateAgentFn: async (_u: string, _t: string, script: string) => ({
          ok: !script.includes("bad-probe"),
          errors: script.includes("bad-probe")
            ? ["probe not found: bad-probe"]
            : [],
          probes: [],
          warnings: [],
          probe_count: 1,
        }),
      },
    });
    expect(result.validation).toMatchObject({ status: "ok", attempts: 2 });
    expect(result.script).toBe(good);
    db.close();
  });

  it("fails after 3 attempts with last errors", async () => {
    const db = makeDb();
    const stub = {
      model: "mock",
      generate: async () =>
        LlmOutputSchema.parse({
          script: "tracepoint:syscalls:bad-probe { @x = count(); }\n",
          chart_type: "events",
          explanation: "always bad",
          duration_s: 10,
          refusal: null,
        }),
    };
    try {
      await runGenerate("bad probe forever", {
        deps: {
          db,
          recipesDir: RECIPES_DIR,
          agentUrl: fake.url,
          tokenFile,
          llm: stub,
          searchProbesFn: async () => [],
          validateAgentFn: async () => ({
            ok: false,
            errors: ["probe not found: bad-probe"],
            probes: [],
            warnings: [],
            probe_count: 0,
          }),
        },
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationFailedError);
      expect((err as ValidationFailedError).attempts).toBe(3);
    }
    db.close();
  });
});

describe("static validator rejects 25 bad scripts", () => {
  const known = ["BEGIN", "tracepoint:block:block_rq_issue"];
  const bad: Array<[string, string[] | undefined]> = [
    ["", undefined],
    ["   \n  ", undefined],
    ["x".repeat(8 * 1024 + 1), undefined],
    ['BEGIN { system("ls"); }', undefined],
    ["BEGIN { signal(1); }", undefined],
    ["BEGIN { override(1); }", undefined],
    ['BEGIN { cat("/etc/passwd"); }', undefined],
    ["BEGIN { @x = count(); } --unsafe", undefined],
    ["#include <stdio.h>\nBEGIN { @x = count(); }", undefined],
    ["#define FOO 1\nBEGIN { @x = count(); }", undefined],
    ["  #  include <x>\nBEGIN { @x = count(); }", undefined],
    ["hello world, no probes here", undefined],
    ["kprobe:* { @x = count(); }", undefined],
    ["tracepoint:*:* { @x = count(); }", undefined],
    ["* { @x = count(); }", undefined],
    ["tracepoint:*:block_rq_issue { @x = count(); }", undefined],
    ["uprobe:foo:bar { @x = count(); }", undefined],
    ["uretprobe:relative/path { @x = count(); }", undefined],
    ["tracepoint:block:block_rq_issue { @x = count(); }", ["BEGIN"]],
    ["tracepoint:syscalls:sys_enter_openat { @x = count(); }", ["BEGIN"]],
    ["tracepoint:foo:bar* { @x = count(); }", ["BEGIN"]],
    [
      "tracepoint:block:item* { @x = count(); }",
      Array.from({ length: 60 }, (_, i) => `tracepoint:block:item${i}`).concat([
        "tracepoint:block:block_rq_issue",
      ]),
    ],
    ['kprobe:tcp_v4_connect { system("x"); }', undefined],
    ["BEGIN { @x = count(); }\n#define HACK 1", undefined],
    ['tracepoint:raw_syscalls:sys_enter { system("id"); }', undefined],
  ];
  it("rejects every bad script", () => {
    expect(bad).toHaveLength(25);
    for (const [script, knownProbes] of bad) {
      const { errors } = staticValidate(script, {
        catalog: { mode: "enforce", known: knownProbes ?? known },
      });
      expect(errors.length, script.slice(0, 60)).toBeGreaterThan(0);
    }
  });

  it("accepts all recipe bodies", () => {
    const recipes = loadRecipes(RECIPES_DIR);
    expect(recipes.length).toBeGreaterThanOrEqual(10);
    for (const r of recipes) {
      const body = readFileSync(join(RECIPES_DIR, `${r.id}.bt`), "utf8");
      const { errors } = staticValidate(body, { catalog: { mode: "skip" } });
      expect(errors, r.id).toEqual([]);
    }
  });
});

describe("generations persistence", () => {
  it("stores a row per successful generation", async () => {
    const db = makeDb();
    const llm = new MockLlm("mock", () => cpuRecipe());
    const result = await runGenerate("cpu hogs", {
      deps: {
        db,
        recipesDir: RECIPES_DIR,
        agentUrl: fake.url,
        tokenFile,
        llm,
        searchProbesFn: async () => ["profile:hz:99"],
        validateAgentFn: async () => ({
          ok: true,
          errors: [],
          probes: [],
          warnings: [],
          probe_count: 1,
        }),
      },
    });
    const row = db
      .prepare(
        "SELECT id, session_id, prompt, script, chart_type, validation_status, attempts, model, based_on_recipe, warnings, latency_ms FROM generations WHERE id = ?",
      )
      .get(result.generation_id) as Record<string, unknown>;
    expect(row["id"]).toBe(result.generation_id);
    expect(row["prompt"]).toBe("cpu hogs");
    expect(row["script"]).toBe(result.script);
    expect(row["validation_status"]).toBe("ok");
    expect(row["attempts"]).toBe(1);
    expect(JSON.parse(row["warnings"] as string)).toEqual(result.warnings);
    expect(row["based_on_recipe"]).toBe("cpu-by-process");
    expect(typeof row["latency_ms"]).toBe("number");
    db.close();
  });
});

describe("POST /api/generate", () => {
  it("returns a validated generation", async () => {
    const res = await fetch(`${base}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "Which processes are using the most CPU?",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as GenerateResponse;
    expect(() => GenerateResponseSchema.parse(body)).not.toThrow();
    expect(body.script.length).toBeLessThanOrEqual(8 * 1024);
    expect(body.duration_s).toBeGreaterThanOrEqual(1);
    expect(body.duration_s).toBeLessThanOrEqual(60);
    expect(body.validation.status).toBe("ok");
    expect(body.generation_id).toMatch(/^gen_/);
  });

  it("rejects empty prompt", async () => {
    const res = await fetch(`${base}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects oversize prompt", async () => {
    const res = await fetch(`${base}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "x".repeat(2001) }),
    });
    expect(res.status).toBe(400);
  });

  it("live mode without key reports LLM_UNAVAILABLE", async () => {
    const live = await buildApp({
      agentUrl: fake.url,
      tokenFile,
      dbPath: ":memory:",
      recipesDir: RECIPES_DIR,
      webOrigin: "http://localhost:5173",
      llmModel: "claude-sonnet-5-5",
      llmMode: "live",
      llmChain: "groq",
      llmEnv: {},
    });
    const addr = await live.listen({ host: "127.0.0.1", port: 0 });
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
      await live.close();
    }
  });
});

describe("generate rate limit", () => {
  it("rejects over-budget callers with 429 RATE_LIMITED", async () => {
    const limited = await buildApp({
      agentUrl: fake.url,
      tokenFile,
      dbPath: ":memory:",
      recipesDir: RECIPES_DIR,
      webOrigin: "http://localhost:5173",
      llmModel: "mock",
      llmMode: "mock",
      generateRateLimit: { max: 2, windowMs: 60_000 },
    });
    const addr = await limited.listen({ host: "127.0.0.1", port: 0 });
    const url = addr.replace("[::1]", "127.0.0.1");
    try {
      const post = (): Promise<Response> =>
        fetch(`${url}/api/generate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ prompt: "Which processes use CPU?" }),
        });
      expect((await post()).status).toBe(200);
      expect((await post()).status).toBe(200);
      const third = await post();
      expect(third.status).toBe(429);
      expect(await third.json()).toMatchObject({ code: "RATE_LIMITED" });
      expect(third.headers.get("retry-after")).toBe("60");
    } finally {
      await limited.close();
    }
  });

  it("budgets are per IP, not global", async () => {
    const limited = await buildApp({
      agentUrl: fake.url,
      tokenFile,
      dbPath: ":memory:",
      recipesDir: RECIPES_DIR,
      webOrigin: "http://localhost:5173",
      llmModel: "mock",
      llmMode: "mock",
      generateRateLimit: { max: 1, windowMs: 60_000 },
    });
    try {
      const post = (ip: string) =>
        limited.inject({
          method: "POST",
          url: "/api/generate",
          payload: { prompt: "cpu?" },
          remoteAddress: ip,
          headers: { host: "localhost", "content-type": "application/json" },
        });
      expect((await post("10.0.0.1")).statusCode).toBe(200);
      expect((await post("10.0.0.1")).statusCode).toBe(429);
      expect((await post("10.0.0.2")).statusCode).toBe(200);
    } finally {
      await limited.close();
    }
  });

  it("budgets follow the forwarded client IP behind the proxy", async () => {
    const limited = await buildApp({
      agentUrl: fake.url,
      tokenFile,
      dbPath: ":memory:",
      recipesDir: RECIPES_DIR,
      webOrigin: "http://localhost:5173",
      llmModel: "mock",
      llmMode: "mock",
      generateRateLimit: { max: 1, windowMs: 60_000 },
    });
    try {
      // Same socket IP (the nginx hop) for every caller; only X-Forwarded-For
      // differs, as the proxy sets it per connection.
      const post = (forwardedFor: string) =>
        limited.inject({
          method: "POST",
          url: "/api/generate",
          payload: { prompt: "cpu?" },
          remoteAddress: "172.18.0.2",
          headers: {
            host: "localhost",
            "content-type": "application/json",
            "x-forwarded-for": forwardedFor,
          },
        });
      expect((await post("10.0.0.1")).statusCode).toBe(200);
      expect((await post("10.0.0.1")).statusCode).toBe(429);
      expect((await post("10.0.0.2")).statusCode).toBe(200);
    } finally {
      await limited.close();
    }
  });
});

describe("validator limits", () => {
  it("rejects wildcards expanding past the probe cap", () => {
    const known = Array.from(
      { length: 60 },
      (_, i) => `tracepoint:block:item${i}`,
    );
    const { errors } = staticValidate(
      "tracepoint:block:item* { @cnt = count(); }",
      { catalog: { mode: "enforce", known } },
    );
    expect(errors.join(" ")).toContain("too many");
  });

  it("warns on per-event printf from raw_syscalls", () => {
    const { errors, warnings } = staticValidate(
      'tracepoint:raw_syscalls:sys_enter { printf("%d\\n", pid); }',
      { catalog: { mode: "skip" } },
    );
    expect(errors).toEqual([]);
    expect(warnings.join(" ")).toContain("High-frequency");
  });

  it("rejects huge scripts before they reach the agent", () => {
    const { errors } = staticValidate(
      `BEGIN { printf("${"x".repeat(9 * 1024)}"); }`,
      { catalog: { mode: "skip" } },
    );
    expect(errors.join(" ")).toContain("8 KB");
  });

  it("rejects broad provider wildcards without a catalog", () => {
    for (const script of [
      "tracepoint:*:foo { @x = count(); }",
      "kprobe:* { @x = count(); }",
      "kprobe:ab* { @x = count(); }",
    ]) {
      expect(
        staticValidate(script, { catalog: { mode: "skip" } }).errors.length,
      ).toBeGreaterThan(0);
    }
  });
});

describe("validator comment and continuation stripping", () => {
  it("rejects comment-split and continuation-split bypasses", () => {
    const cases: Array<[string, string, RegExp]> = [
      [
        "cat block comment",
        'BEGIN { cat/*x*/("/etc/shadow"); }',
        /blocked call/,
      ],
      [
        "cat line comment",
        'BEGIN { cat//c\n("/etc/shadow"); }',
        /blocked call/,
      ],
      [
        "cat multi comment",
        'BEGIN { cat /*a*/ /*b\nc*/ ("/etc/shadow"); }',
        /blocked call/,
      ],
      ["system block comment", 'BEGIN { system/*x*/("id"); }', /blocked call/],
      ["signal block comment", "BEGIN { signal/*x*/(9); }", /blocked call/],
      ["override block comment", "BEGIN { override/*x*/(0); }", /blocked call/],
      [
        "comment before include",
        "/*x*/#include <stdio.h>\nBEGIN {}",
        /blocked syntax: #include\/#define/,
      ],
      [
        "comment inside define",
        "#/*x*/define FOO cat\nBEGIN {}",
        /blocked syntax: #include\/#define/,
      ],
      [
        "line continuation include",
        "#\\\ninclude <x>\nBEGIN {}",
        /blocked syntax: #include\/#define/,
      ],
      [
        "line continuation inside cat",
        'BEGIN { ca\\\nt("/etc/shadow"); }',
        /blocked call/,
      ],
      [
        "line continuation crlf cat",
        'BEGIN { ca\\\r\nt("/etc/shadow"); }',
        /blocked call/,
      ],
      [
        "line continuation before paren",
        'BEGIN { cat\\\n("/etc/shadow"); }',
        /blocked call/,
      ],
      [
        "multiline comment before define",
        "struct s{}; /*\n*/#define X 1\nBEGIN {}",
        /blocked syntax: #include\/#define/,
      ],
      [
        "crlf line comment cat",
        'BEGIN { cat//\r\n("/etc/shadow"); }',
        /blocked call/,
      ],
      ["unclosed block comment", "BEGIN { /*", /unclosed block comment/],
      ["unclosed slash-star-slash", "BEGIN { /*/", /unclosed block comment/],
      ["line comment only", "// only comment", /no probes found/],
      ["block comment only", "/* only comment */", /no probes found/],
      [
        "non-nested block comment",
        '/* outer /* inner */ cat("/etc/shadow"); BEGIN {}',
        /blocked call/,
      ],
      [
        "comment backslash does not join line",
        '// comment\\\nBEGIN { cat("/etc/shadow"); }',
        /blocked call/,
      ],
      [
        "quote in line comment ignored",
        '// "\nBEGIN { cat/*x*/("/etc/shadow"); }',
        /blocked call/,
      ],
      [
        "quote in block comment ignored",
        '/* " */ BEGIN { cat/*x*/("/etc/shadow"); }',
        /blocked call/,
      ],
      [
        "escaped backslash closes string",
        'BEGIN { printf("a\\\\"); cat/*x*/("/etc/shadow"); }',
        /blocked call/,
      ],
      [
        "comment delimiter strings sandwich",
        'BEGIN { printf("/*"); cat("/etc/shadow"); printf("*/"); }',
        /blocked call/,
      ],
      [
        "unterminated string resets at newline",
        'BEGIN { printf("unterminated\ncat/*x*/("/etc/shadow"); }',
        /blocked call/,
      ],
      [
        "unterminated string backslash newline",
        'BEGIN { printf("unterminated\\\ncat/*x*/("/etc/shadow"); }',
        /blocked call/,
      ],
      [
        "unterminated string backslash crlf",
        'BEGIN { printf("unterminated\\\r\ncat/*x*/("/etc/shadow"); }',
        /blocked call/,
      ],
    ];
    for (const [name, script, pattern] of cases) {
      const { errors } = staticValidate(script, { catalog: { mode: "skip" } });
      expect(errors.join("; "), name).toMatch(pattern);
    }
  });

  it("ignores commented fake probes", () => {
    const res = staticValidate('// BEGIN {}\ncat/*x*/("/etc/shadow")', {
      catalog: { mode: "skip" },
    });
    expect(res.probes).toEqual([]);
    expect(res.errors.join("; ")).toMatch(/blocked call/);
    expect(res.errors.join("; ")).toMatch(/no probes found/);
  });

  it("preserves strings, predicates, division, and strips comments from probes", () => {
    const known = [
      "tracepoint:block:block_rq_issue",
      "tracepoint:block:block_rq_complete",
    ];

    for (const script of [
      'BEGIN { printf("http://x /*y*/"); }',
      "// open /* inside line comment\nBEGIN { @x = count(); }",
      "/* // inside block comment */ BEGIN { @x = count(); }",
      "/**/BEGIN { @x = count(); }",
    ]) {
      const res = staticValidate(script, {
        catalog: { mode: "enforce", known },
      });
      expect(res.errors, script).toEqual([]);
      expect(res.probes, script).toEqual(["BEGIN"]);
    }

    const commented = staticValidate(
      "// comment mentioning BEGIN tracepoint:foo:bar\ntracepoint:block:block_rq_issue { @x = count(); }",
      { catalog: { mode: "enforce", known } },
    );
    expect(commented.errors).toEqual([]);
    expect(commented.probes).toEqual(["tracepoint:block:block_rq_issue"]);

    const slashRes = staticValidate(
      "tracepoint:block:block_rq_complete /@start[args->dev]/ { @lat = hist((nsecs - @start[args->dev]) / 1000); }",
      { catalog: { mode: "enforce", known } },
    );
    expect(slashRes.errors).toEqual([]);
    expect(slashRes.probes).toEqual(["tracepoint:block:block_rq_complete"]);
  });

  it("checks printf warning against cleaned script", () => {
    const commentedOut = staticValidate(
      'tracepoint:raw_syscalls:sys_enter { // printf("%d\\n", pid);\n @x = count(); }',
      { catalog: { mode: "skip" } },
    );
    expect(commentedOut.errors).toEqual([]);
    expect(commentedOut.warnings).toEqual([]);

    const commentSplit = staticValidate(
      'tracepoint:raw_syscalls:sys_enter { printf/*x*/("%d\\n", pid); }',
      { catalog: { mode: "skip" } },
    );
    expect(commentSplit.errors).toEqual([]);
    expect(commentSplit.warnings.join(" ")).toContain("High-frequency");
  });

  it("stores raw script with comments intact on runGenerate", async () => {
    const db = makeDb();
    const rawScript =
      "// header comment\ntracepoint:syscalls:sys_enter_openat { @x = count(); }\n";
    let agentSeen = "";
    const stub = {
      model: "mock",
      generate: async () =>
        LlmOutputSchema.parse({
          script: rawScript,
          chart_type: "events",
          explanation: "ok",
          duration_s: 10,
          refusal: null,
        }),
    };
    const result = await runGenerate("who is opening files", {
      deps: {
        db,
        recipesDir: RECIPES_DIR,
        agentUrl: fake.url,
        tokenFile,
        llm: stub,
        searchProbesFn: async () => ["tracepoint:syscalls:sys_enter_openat"],
        validateAgentFn: async (_u, _t, script) => {
          agentSeen = script;
          return {
            ok: true,
            errors: [],
            probes: [],
            warnings: [],
            probe_count: 1,
          };
        },
      },
    });
    expect(agentSeen).toBe(rawScript);
    expect(result.script).toBe(rawScript);
    const row = db
      .prepare("SELECT script FROM generations WHERE id = ?")
      .get(result.generation_id) as { script: string };
    expect(row.script).toBe(rawScript);
    db.close();
  });
});

describe("validator probe allowlist and header parser parity", () => {
  const known = [
    "BEGIN",
    "END",
    "tracepoint:block:block_rq_issue",
    "tracepoint:block:block_rq_complete",
    "tracepoint:raw_syscalls:sys_enter",
    "kprobe:do_sys_open",
    "kretprobe:do_sys_open",
    "uprobe:/lib/x86_64-linux-gnu/libc.so.6:getaddrinfo",
    'uprobe:/lib/libc.so.6:"Foo::bar(int, int)"',
  ];

  it("rejects standalone, block-piggybacked, and comma-piggybacked unlisted probes and aliases", () => {
    const unlisted: Array<[string, string]> = [
      ["fentry:tcp_connect", "fentry"],
      ["fexit:tcp_connect", "fexit"],
      ["kfunc:tcp_connect", "kfunc"],
      ["kretfunc:tcp_connect", "kretfunc"],
      ["rawtracepoint:sched_switch", "rawtracepoint"],
      ["watchpoint:0x1000:4:w", "watchpoint"],
      ["asyncwatchpoint:0x1000:4:w", "asyncwatchpoint"],
      ["hardware:cache-misses:1000", "hardware"],
      ["usdt:/bin/sh:*", "usdt"],
      ["iter:task", "iter"],
      ["k:tcp_v4_connect", "k"],
      ["kr:tcp_v4_connect", "kr"],
      ["t:syscalls:sys_enter_openat", "t"],
      ["u:/lib/x86_64-linux-gnu/libc.so.6:malloc", "u"],
      ["ur:/lib/x86_64-linux-gnu/libc.so.6:malloc", "ur"],
      ["U:/bin/app:p", "U"],
      ["p:hz:99", "p"],
      ["i:s:1", "i"],
      ["s:cpu-clock:100", "s"],
      ["h:cache-misses:1000", "h"],
      ["rt:sched_switch", "rt"],
      ["f:tcp_connect", "f"],
      ["fr:tcp_connect", "fr"],
      ["w:0x1000:4:w", "w"],
      ["aw:0x1000:4:w", "aw"],
      ["B", "B"],
      ["E", "E"],
      ["B:1", "B"],
      ["E:1", "E"],
      ["begin", "begin"],
      ["end", "end"],
    ];

    for (const [probe, provider] of unlisted) {
      for (const script of [
        `${probe} { @x = count(); }`,
        `BEGIN {}\n${probe} { @x = count(); }`,
        `BEGIN, ${probe} { @x = count(); }`,
      ]) {
        const res = staticValidate(script, {
          catalog: { mode: "enforce", known },
        });
        expect(res.errors.join("; "), script).toContain(
          `provider not allowed: ${provider}`,
        );
        expect(res.errors.join("; "), script).not.toContain("probe not found");
      }
    }
  });

  it("rejects config, macro, malformed headers, unbalanced syntax, and string spoofing", () => {
    const cases: Array<[string, string, RegExp]> = [
      [
        "config with spaces",
        "config = { max_probes = 999; }",
        /invalid probe header/,
      ],
      [
        "compact config",
        "config={max_probes=999;}",
        /provider not allowed: config=/,
      ],
      [
        "macro definition",
        "macro m() { @x = count(); }",
        /invalid probe header/,
      ],
      [
        "multiline comma mixed",
        "kprobe:do_sys_open,\nu:./evil:fn { @x = count(); }",
        /provider not allowed: u/,
      ],
      [
        "BEGIN with target",
        "BEGIN:evil {}",
        /invalid probe header: BEGIN\/END cannot have target/,
      ],
      [
        "END with target",
        "END:evil {}",
        /invalid probe header: BEGIN\/END cannot have target/,
      ],
      ["leading colon", ":foo {}", /invalid probe header: invalid colon/],
      ["trailing colon", "kprobe: {}", /invalid probe header: invalid colon/],
      [
        "empty comma target",
        "BEGIN, {}",
        /invalid probe header: empty probe target/,
      ],
      [
        "empty header",
        "{ @x = count(); }",
        /invalid probe header: empty probe header/,
      ],
      [
        "second empty header",
        "BEGIN {} { @x = count(); }",
        /invalid probe header: empty probe header/,
      ],
      [
        "struct mixed comma",
        "struct s, fentry:evil {}",
        /invalid probe header/,
      ],
      ["struct with predicate", "struct s /1/ {}", /invalid probe header/],
      [
        "unclosed action block",
        "BEGIN { @x = count();",
        /invalid probe syntax: unclosed action block/,
      ],
      [
        "unexpected closing brace",
        "BEGIN {} }",
        /invalid probe syntax: unexpected closing brace/,
      ],
      [
        "lone closing brace",
        "}",
        /invalid probe syntax: unexpected closing brace/,
      ],
      [
        "unclosed predicate",
        "BEGIN /pid == 1 { @x = count(); }",
        /invalid probe syntax: unclosed predicate/,
      ],
      [
        "unclosed paren in predicate",
        "BEGIN /(pid == 1/ {}",
        /invalid probe syntax: unclosed predicate/,
      ],
      [
        "unexpected token after predicate",
        "BEGIN /1/ extra {}",
        /invalid probe header: unexpected token after predicate/,
      ],
      [
        "missing action block",
        "BEGIN {} fentry:evil",
        /invalid probe header: missing action block/,
      ],
      [
        "missing action block after predicate",
        "BEGIN /1/",
        /invalid probe header: missing action block/,
      ],
      [
        "unclosed quote in target",
        'uprobe:/bin/app:"unclosed\n{}',
        /invalid probe header: unclosed quote/,
      ],
      [
        "spoofed BEGIN in string",
        'fentry:vfs_read { printf("BEGIN"); }',
        /provider not allowed: fentry/,
      ],
      [
        "spoofed catalog probe in string",
        'u:./evil:fn { $s = "tracepoint:block:block_rq_issue"; }',
        /provider not allowed: u/,
      ],
      [
        "unknown probe wording injection",
        "unknown probe {}",
        /invalid probe header/,
      ],
      [
        "quoted unknown probe injection",
        '"unknown probe":foo {}',
        /invalid probe header/,
      ],
    ];

    for (const [name, script, pattern] of cases) {
      const res = staticValidate(script, {
        catalog: { mode: "enforce", known },
      });
      const joined = res.errors.join("; ");
      expect(joined, name).toMatch(pattern);
      expect(joined.toLowerCase(), name).not.toMatch(
        /probe not found|unknown probe|no such probe|too many probes/,
      );
    }
  });

  it("preserves valid multi-slash uprobe paths, quoted C++ header parsing, predicates, structs, and strings", () => {
    const parsedCpp = parseHeaderTargets(
      'uprobe:/lib/libc.so.6:"Foo::bar(int, int)"',
    );
    expect(parsedCpp.errs).toEqual([]);
    expect(parsedCpp.targets).toEqual([
      'uprobe:/lib/libc.so.6:"Foo::bar(int, int)"',
    ]);
    const rejectedCpp = staticValidate(
      'uprobe:/lib/libc.so.6:"Foo::bar(int, int)" { @x = count(); }',
      { catalog: { mode: "enforce", known } },
    );
    expect(rejectedCpp.code).toBe("VALIDATION_FAILED");
    expect(rejectedCpp.errors.join("; ")).toContain("invalid uprobe symbol");

    const valid: Array<[string, string[]]> = [
      [
        'BEGIN { printf("tracepoint:foo:bar"); $s = "kprobe:*"; $t = 1 ? 2 : 3; }',
        ["BEGIN"],
      ],
      [
        'uprobe:/lib/x86_64-linux-gnu/libc.so.6:getaddrinfo { printf("%s\\n", str(arg0)); }',
        ["uprobe:/lib/x86_64-linux-gnu/libc.so.6:getaddrinfo"],
      ],
      [
        "tracepoint:raw_syscalls:sys_enter{@x=count();}END{clear(@x);}",
        ["tracepoint:raw_syscalls:sys_enter", "END"],
      ],
      [
        "tracepoint:block:block_rq_complete\n/@start[args->dev, args->sector]/\n{ @x = count(); }",
        ["tracepoint:block:block_rq_complete"],
      ],
      [
        'tracepoint:block:block_rq_complete /(nsecs / 1000) > 10 && comm == "a/b"/ { @x = count(); }',
        ["tracepoint:block:block_rq_complete"],
      ],
      [
        "struct s { int x; }; enum e { A = 1 }; union u { int y; }; BEGIN { @x = count(); }",
        ["BEGIN"],
      ],
      [
        "kprobe:do_sys_open,\nkretprobe:do_sys_open { @x = count(); }",
        ["kprobe:do_sys_open", "kretprobe:do_sys_open"],
      ],
    ];

    for (const [script, wantProbes] of valid) {
      const res = staticValidate(script, {
        catalog: { mode: "enforce", known },
      });
      expect(res.errors, script).toEqual([]);
      expect(res.probes, script).toEqual(wantProbes);
    }

    const stringFalseWarning = staticValidate(
      'BEGIN { printf("tracepoint:raw_syscalls:sys_enter"); }',
      { catalog: { mode: "enforce", known } },
    );
    expect(stringFalseWarning.errors).toEqual([]);
    expect(stringFalseWarning.warnings).toEqual([]);
  });

  it("rejects non-BEGIN/END allowed providers missing a colon target", () => {
    const providers = [
      "tracepoint",
      "kprobe",
      "kretprobe",
      "uprobe",
      "uretprobe",
      "profile",
      "interval",
      "software",
    ];
    for (const provider of providers) {
      for (const script of [
        `${provider} { @x = count(); }`,
        `BEGIN {}\n${provider} { @x = count(); }`,
        `BEGIN, ${provider} { @x = count(); }`,
      ]) {
        const emptyCat = staticValidate(script, {
          catalog: { mode: "enforce", known: [] },
        });
        expect(emptyCat.code).toBe("CATALOG_UNAVAILABLE");

        for (const res of [
          staticValidate(script, { catalog: { mode: "skip" } }),
          staticValidate(script, { catalog: { mode: "enforce", known } }),
        ]) {
          const joined = res.errors.join("; ");
          expect(joined, script).toContain(
            `invalid probe header: missing target for provider ${provider}`,
          );
          expect(joined.toLowerCase(), script).not.toMatch(
            /probe not found|unknown probe|no such probe|too many probes/,
          );
        }
      }
    }

    for (const valid of [
      "BEGIN { @x = count(); }",
      "END { @x = count(); }",
      "BEGIN, END { @x = count(); }",
    ]) {
      expect(
        staticValidate(valid, { catalog: { mode: "enforce", known } }).errors,
        valid,
      ).toEqual([]);
    }
  });
});
