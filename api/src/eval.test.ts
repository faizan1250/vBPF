import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync as readFileSyncNode } from "node:fs";
import { tmpdir } from "node:os";

import { describe, expect, it, vi } from "vitest";

import {
  EvalPromptsSchema,
  assertCallBudget,
  categoryFromId,
  checkAgentPreflight,
  loadPrompts,
  parseEvalArgs,
  renderMarkdown,
  runEval,
  summarize,
  toScriptRecords,
  writeScriptsNdjson,
} from "./eval.js";
import type { AgentHealth } from "./agent-client.js";
import { LlmOutputSchema, isRefusalPrompt, type LlmClient } from "./llm.js";

const PROMPTS_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "eval",
  "prompts.yaml",
);
const RECIPES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "recipes",
);

describe("eval prompts", () => {
  it("loads 30 entries with the planned category split", () => {
    const entries = loadPrompts(PROMPTS_PATH);
    expect(entries).toHaveLength(30);
    const counts = new Map<string, number>();
    for (const e of entries) {
      counts.set(
        categoryFromId(e.id),
        (counts.get(categoryFromId(e.id)) ?? 0) + 1,
      );
    }
    expect(counts.get("direct")).toBe(10);
    expect(counts.get("paraphrased")).toBe(8);
    expect(counts.get("param")).toBe(4);
    expect(counts.get("novel")).toBe(4);
    expect(counts.get("adversarial")).toBe(4);
  });

  it("has unique ids and refusal flags only on adversarial entries", () => {
    const entries = loadPrompts(PROMPTS_PATH);
    expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length);
    for (const e of entries) {
      if (categoryFromId(e.id) === "adversarial") {
        expect(e.must_refuse).toBe(true);
        expect(e.expected_view).toBeNull();
        expect(isRefusalPrompt(e.prompt)).toBe(true);
      } else {
        expect(e.must_refuse).toBe(false);
        expect(e.expected_view).not.toBeNull();
        expect(isRefusalPrompt(e.prompt)).toBe(false);
      }
    }
  });

  it("rejects malformed prompt files", () => {
    expect(() =>
      EvalPromptsSchema.parse([
        {
          id: "direct-99",
          prompt: "",
          expected_view: "bogus",
          expected_probe_family: null,
          must_refuse: false,
          notes: "",
        },
      ]),
    ).toThrow();
  });
});

describe("eval runner", () => {
  it("scores a direct hit and a refusal", async () => {
    const entries = loadPrompts(PROMPTS_PATH);
    const subset = entries.filter(
      (e) => e.id === "direct-01" || e.id === "adversarial-01",
    );
    expect(subset).toHaveLength(2);
    const { cases, summary, db } = await runEval(subset, {
      recipesDir: RECIPES_DIR,
      model: "mock",
    });
    try {
      const direct = cases.find((c) => c.id === "direct-01");
      const adversarial = cases.find((c) => c.id === "adversarial-01");
      expect(direct?.ok).toBe(true);
      expect(direct?.first_try).toBe(true);
      expect(direct?.refusal_correct).toBe(true);
      expect(direct?.view_match).toBe(true);
      expect(adversarial?.refused).toBe(true);
      expect(adversarial?.refusal_correct).toBe(true);
      expect(summary.total).toBe(2);
      expect(summary.refusal_correct).toBe(2);
    } finally {
      db.close();
    }
  });

  it("summarizes empty input without crashing", () => {
    expect(summarize([]).total).toBe(0);
  });

  it("labels live reports without touching mock output", () => {
    const fakeCase = {
      id: "direct-01",
      category: "direct",
      must_refuse: false,
      expected_view: "bar" as const,
      expected_probe_family: "profile",
      refused: false,
      ok: true,
      attempts: 1,
      chart_type: "bar" as const,
      view_match: true as const,
      probe_match: true as const,
      refusal_correct: true,
      first_try: true,
      latency_ms: 1,
      tokens_approx: 10,
      errors: [] as string[],
      static_ok_first_try: true,
      static_ok: true,
      agent_ok_first_try: true,
      agent_ok: true,
      script: "profile:hz:99 { @x = count(); }\n",
      provider_model: "stub",
      produced_events: null as number | null,
      produced_status: "skipped" as const,
      notes: "",
    };
    const summary = summarize([fakeCase]);
    expect(summary.static_first_try).toBe(1);
    expect(summary.static_within_retries).toBe(1);
    expect(summary.agent_first_try).toBe(1);
    expect(summary.agent_within_retries).toBe(1);
    const live = renderMarkdown(
      "2026-11-10",
      "groq/test",
      summary,
      [fakeCase],
      "live",
    );
    expect(live).toContain("Mode: live");
    expect(live).toContain("SKIP (live)");
    const mock = renderMarkdown("2026-11-10", "mock", summary, []);
    expect(mock).toContain("Mode: mock-only");
  });
});

describe("eval --live wiring", () => {
  it("uses the injected llm factory (refusal path)", async () => {
    const entries = loadPrompts(PROMPTS_PATH).filter(
      (e) => e.id === "adversarial-01",
    );
    const { cases, db } = await runEval(entries, {
      recipesDir: RECIPES_DIR,
      model: "stub",
      llmFactory: () => ({
        model: "stub",
        generate: async () =>
          LlmOutputSchema.parse({
            script: "",
            chart_type: "events",
            explanation: "",
            duration_s: 10,
            refusal: "nope",
          }),
      }),
    });
    try {
      expect(cases).toHaveLength(1);
      expect(cases[0]?.refused).toBe(true);
      expect(cases[0]?.refusal_correct).toBe(true);
    } finally {
      db.close();
    }
  });

  it("passes probeArgsFn through to prompt assembly", async () => {
    const entries = loadPrompts(PROMPTS_PATH).filter(
      (e) => e.id === "direct-01",
    );
    let seen = "";
    const { cases, db } = await runEval(entries, {
      recipesDir: RECIPES_DIR,
      model: "stub",
      llmFactory: () => ({
        model: "stub",
        generate: async (prompt: string) => {
          seen = prompt;
          return LlmOutputSchema.parse({
            script: "profile:hz:99 { @x = count(); }\n",
            chart_type: "bar",
            explanation: "ok",
            duration_s: 10,
            refusal: null,
          });
        },
      }),
      probeArgsFn: async () => "",
    });
    try {
      expect(cases[0]?.ok).toBe(true);
      expect(seen).toContain("==ARG_FORMATS==");
    } finally {
      db.close();
    }
  });

  it("enforces the 90-call live budget", () => {
    expect(() => assertCallBudget(30)).not.toThrow();
    expect(() => assertCallBudget(31)).toThrow();
  });

  it("parses live flags with safe defaults", () => {
    const root = "/repo";
    const base = parseEvalArgs([], root);
    expect(base.live).toBe(false);
    expect(base.limit).toBeNull();
    expect(base.delayMs).toBe(0);
    const live = parseEvalArgs(
      ["--live", "--limit", "5", "--delay-ms", "500"],
      root,
    );
    expect(live.live).toBe(true);
    expect(live.limit).toBe(5);
    expect(live.delayMs).toBe(500);
    // Courtesy delay for free-tier budgets.
    expect(parseEvalArgs(["--live"], root).delayMs).toBe(2000);
    expect(() => parseEvalArgs(["--limit", "0"], root)).toThrow();
    expect(() => parseEvalArgs(["--bogus"], root)).toThrow();
  });
});

describe("eval token usage", () => {
  const validOutput = (script: string): object => ({
    script,
    chart_type: "bar",
    explanation: "ok",
    duration_s: 10,
    refusal: null,
  });

  it("uses real usage when the LLM reports it", async () => {
    const entries = loadPrompts(PROMPTS_PATH).filter(
      (e) => e.id === "direct-01",
    );
    const stub = {
      model: "stub",
      generate: async () => LlmOutputSchema.parse(validOutput("unused")),
      generateDetailed: async () =>
        Promise.resolve({
          output: LlmOutputSchema.parse(
            validOutput("profile:hz:99 { @x = count(); }\n"),
          ),
          model: "stub/m",
          usage: { prompt_tokens: 10, completion_tokens: 20 },
        }),
    } as unknown as LlmClient;
    const { cases, summary, db } = await runEval(entries, {
      recipesDir: RECIPES_DIR,
      model: "stub",
      llmFactory: () => stub,
    });
    try {
      expect(cases).toHaveLength(1);
      expect(cases[0]?.ok).toBe(true);
      expect(cases[0]?.usage).toEqual({
        prompt_tokens: 10,
        completion_tokens: 20,
      });
      expect(summary.tokens_real_total).toBe(30);
      const md = renderMarkdown("2026-11-10", "stub", summary, cases, "live");
      expect(md).toContain("| tokens real total | 30 |");
      expect(md).toContain("else approximate");
    } finally {
      db.close();
    }
  });

  it("sums usage across retries", async () => {
    const entries = loadPrompts(PROMPTS_PATH).filter(
      (e) => e.id === "direct-01",
    );
    let calls = 0;
    const stub = {
      model: "stub",
      generate: async () => LlmOutputSchema.parse(validOutput("unused")),
      generateDetailed: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            output: LlmOutputSchema.parse(validOutput("not valid bpf{{{{")),
            model: "stub/m",
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          };
        }
        return {
          output: LlmOutputSchema.parse(
            validOutput("profile:hz:99 { @x = count(); }\n"),
          ),
          model: "stub/m",
          usage: { prompt_tokens: 2, completion_tokens: 3 },
        };
      },
    } as unknown as LlmClient;
    const { cases, db } = await runEval(entries, {
      recipesDir: RECIPES_DIR,
      model: "stub",
      llmFactory: () => stub,
      // Agent authority: the retry is driven by the agent verdict, so the
      // first script must be agent-rejected (the static pre-check is advisory).
      validateAgentFn: async (_url, _token, script) =>
        script.includes("not valid bpf")
          ? {
              ok: false,
              errors: ["agent rejects first script"],
              probes: [],
              warnings: [],
              probe_count: 0,
            }
          : {
              ok: true,
              errors: [],
              probes: [],
              warnings: [],
              probe_count: 0,
            },
    });
    try {
      expect(cases[0]?.ok).toBe(true);
      expect(cases[0]?.attempts).toBe(2);
      expect(cases[0]?.usage).toEqual({
        prompt_tokens: 3,
        completion_tokens: 4,
      });
    } finally {
      db.close();
    }
  });

  it("falls back to approx without usage", async () => {
    const entries = loadPrompts(PROMPTS_PATH).filter(
      (e) => e.id === "direct-01",
    );
    const { cases, summary, db } = await runEval(entries, {
      recipesDir: RECIPES_DIR,
      model: "mock",
    });
    try {
      expect(cases[0]?.usage).toBeUndefined();
      expect(summary.tokens_real_total).toBe(0);
      expect(summary.tokens_approx_total).toBeGreaterThan(0);
      const md = renderMarkdown("2026-11-10", "mock", summary, cases);
      expect(md).toContain("| tokens approx total |");
      expect(md).not.toContain("tokens real total");
    } finally {
      db.close();
    }
  });
});

describe("eval agent flags", () => {
  it("parses agent flags with env defaults", () => {
    const root = "/repo";
    const base = parseEvalArgs([], root, {});
    expect(base.agent).toBe(false);
    expect(base.agentUrl).toBe("http://127.0.0.1:8787");
    expect(base.tokenFile).toBe("./run/agent.token");
    const full = parseEvalArgs(
      [
        "--live",
        "--agent",
        "--agent-url",
        "http://127.0.0.1:9999",
        "--token-file",
        "/tmp/tok",
      ],
      root,
      {},
    );
    expect(full.live).toBe(true);
    expect(full.agent).toBe(true);
    expect(full.agentUrl).toBe("http://127.0.0.1:9999");
    expect(full.tokenFile).toBe("/tmp/tok");
    expect(
      parseEvalArgs([], root, {
        AGENT_URL: "http://127.0.0.1:8788",
        AGENT_TOKEN_FILE: "/env/tok",
      }).agentUrl,
    ).toBe("http://127.0.0.1:8788");
    expect(() => parseEvalArgs(["--agent"], root, {})).toThrow();
    expect(() =>
      parseEvalArgs(["--live", "--agent", "--bogus"], root, {}),
    ).toThrow();
    expect(() =>
      parseEvalArgs(["--live", "--agent", "--agent-url"], root, {}),
    ).toThrow();
  });
});

describe("eval agent preflight", () => {
  const healthy = (): Promise<AgentHealth> =>
    Promise.resolve({
      kernel: "6.6.87-test",
      bpftrace_version: "v0.20.2",
      btf: true,
      root: true,
      tracefs: true,
      uptime_s: 1,
      ready: true,
      catalog: {
        state: "ready",
        probes: 11,
        warnings: [],
      },
    });

  it("passes when reachable as root with BTF and ready catalog", async () => {
    const health = await checkAgentPreflight(
      "http://127.0.0.1:1",
      "tok",
      healthy,
    );
    expect(health.kernel).toBe("6.6.87-test");
    expect(health.bpftrace_version).toBe("v0.20.2");
  });

  it("fails when the agent is down, not root, lacks BTF, or catalog not ready", async () => {
    await expect(
      checkAgentPreflight("http://127.0.0.1:1", "tok", async () => {
        throw new Error(" refused");
      }),
    ).rejects.toThrow(/not falling back to stubs/);
    await expect(
      checkAgentPreflight("http://127.0.0.1:1", "tok", async () => ({
        ...(await healthy()),
        root: false,
      })),
    ).rejects.toThrow(/not running as root/);
    await expect(
      checkAgentPreflight("http://127.0.0.1:1", "tok", async () => ({
        ...(await healthy()),
        btf: false,
      })),
    ).rejects.toThrow(/btf: false/);
    await expect(
      checkAgentPreflight("http://127.0.0.1:1", "tok", async () => ({
        ...(await healthy()),
        ready: false,
        catalog: {
          state: "failed",
          probes: 0,
          last_error: "tracefs unavailable",
          warnings: [],
        },
      })),
    ).rejects.toThrow(/ready: false/);
  });
});

describe("eval static vs agent layers", () => {
  const validOutput = (script: string): object => ({
    script,
    chart_type: "bar",
    explanation: "ok",
    duration_s: 10,
    refusal: null,
  });
  const validScript = "profile:hz:99 { @x = count(); }\n";

  it("counts static pass but failed dry-run as not compiled", async () => {
    const entries = loadPrompts(PROMPTS_PATH).filter(
      (e) => e.id === "direct-01",
    );
    const stub = {
      model: "stub",
      generate: async () => LlmOutputSchema.parse(validOutput(validScript)),
    } as unknown as LlmClient;
    const { cases, db } = await runEval(entries, {
      recipesDir: RECIPES_DIR,
      model: "stub",
      llmFactory: () => stub,
      validateAgentFn: async () => ({
        ok: false,
        errors: ["fake dry-run: unknown probe"],
        probes: [],
        warnings: [],
        probe_count: 0,
      }),
    });
    try {
      expect(cases).toHaveLength(1);
      expect(cases[0]?.ok).toBe(false);
      expect(cases[0]?.attempts).toBe(3);
      expect(cases[0]?.static_ok).toBe(true);
      expect(cases[0]?.static_ok_first_try).toBe(true);
      expect(cases[0]?.agent_ok).toBe(false);
      expect(cases[0]?.agent_ok_first_try).toBe(false);
      expect(cases[0]?.errors.join(" ")).toContain("fake dry-run");
    } finally {
      db.close();
    }
  });

  it("tracks first-try vs within-retries per layer", async () => {
    const entries = loadPrompts(PROMPTS_PATH).filter(
      (e) => e.id === "direct-01",
    );
    const stub = {
      model: "stub/m",
      generate: async () => LlmOutputSchema.parse(validOutput(validScript)),
    } as unknown as LlmClient;
    let agentCalls = 0;
    const { cases, summary, db } = await runEval(entries, {
      recipesDir: RECIPES_DIR,
      model: "stub",
      llmFactory: () => stub,
      validateAgentFn: async () => {
        agentCalls += 1;
        return agentCalls === 1
          ? {
              ok: false,
              errors: ["fake dry-run: retry me"],
              probes: [],
              warnings: [],
              probe_count: 0,
            }
          : { ok: true, errors: [], probes: [], warnings: [], probe_count: 1 };
      },
    });
    try {
      expect(cases[0]?.ok).toBe(true);
      expect(cases[0]?.attempts).toBe(2);
      expect(cases[0]?.static_ok_first_try).toBe(true);
      expect(cases[0]?.static_ok).toBe(true);
      expect(cases[0]?.agent_ok_first_try).toBe(false);
      expect(cases[0]?.agent_ok).toBe(true);
      expect(cases[0]?.provider_model).toBe("stub/m");
      expect(cases[0]?.script).toContain("profile:hz:99");
      expect(summary.static_first_try).toBe(1);
      expect(summary.static_within_retries).toBe(1);
      expect(summary.agent_first_try).toBe(0);
      expect(summary.agent_within_retries).toBe(1);
    } finally {
      db.close();
    }
  });

  it("flags an accepted must_refuse script and never runs it", async () => {
    const entries = loadPrompts(PROMPTS_PATH).filter(
      (e) => e.id === "adversarial-01",
    );
    expect(entries).toHaveLength(1);
    const stub = {
      model: "stub",
      generate: async () => LlmOutputSchema.parse(validOutput(validScript)),
    } as unknown as LlmClient;
    const runSpy = vi.fn(async () => ({ events: 3 }));
    const { cases, db } = await runEval(entries, {
      recipesDir: RECIPES_DIR,
      model: "stub",
      llmFactory: () => stub,
      validateAgentFn: async () => ({
        ok: true,
        errors: [],
        probes: [],
        warnings: [],
        probe_count: 1,
      }),
      agentMode: true,
      agentUrl: "http://127.0.0.1:1",
      tokenFile: "test.token",
      searchProbesFn: async () => [],
      probeArgsFn: async () => "",
      runScriptFn: runSpy,
    });
    try {
      expect(cases[0]?.ok).toBe(true);
      expect(cases[0]?.refusal_correct).toBe(false);
      expect(cases[0]?.produced_status).toBe("skipped");
      expect(cases[0]?.produced_events).toBeNull();
      expect(cases[0]?.notes).toContain("ACCEPTED-UNSAFE-CASE");
      expect(runSpy).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it("requires real functions in agent mode", async () => {
    const entries = loadPrompts(PROMPTS_PATH).filter(
      (e) => e.id === "direct-01",
    );
    await expect(
      runEval(entries, {
        recipesDir: RECIPES_DIR,
        model: "stub",
        agentMode: true,
        agentUrl: "http://127.0.0.1:1",
        tokenFile: "test.token",
      }),
    ).rejects.toThrow(/no stub fallback/);
  });

  it("maps produced runs to produced, no-events, and error", async () => {
    const entries = loadPrompts(PROMPTS_PATH).filter(
      (e) => e.id === "direct-01",
    );
    const stub = {
      model: "stub",
      generate: async () => LlmOutputSchema.parse(validOutput(validScript)),
    } as unknown as LlmClient;
    const baseOpts = {
      recipesDir: RECIPES_DIR,
      model: "stub",
      llmFactory: () => stub,
      validateAgentFn: async () => ({
        ok: true,
        errors: [],
        probes: [],
        warnings: [],
        probe_count: 1,
      }),
    };
    const { cases: produced, db: db1 } = await runEval(entries, {
      ...baseOpts,
      runScriptFn: async () => ({ events: 5 }),
    });
    try {
      expect(produced[0]?.produced_status).toBe("produced");
      expect(produced[0]?.produced_events).toBe(5);
    } finally {
      db1.close();
    }
    const { cases: quiet, db: db2 } = await runEval(entries, {
      ...baseOpts,
      runScriptFn: async () => ({ events: 0 }),
    });
    try {
      expect(quiet[0]?.produced_status).toBe("no-events");
      expect(quiet[0]?.notes).toContain("5 s window");
    } finally {
      db2.close();
    }
    const {
      cases: broken,
      summary,
      db: db3,
    } = await runEval(entries, {
      ...baseOpts,
      runScriptFn: async () => {
        throw new Error("boom");
      },
    });
    try {
      expect(broken[0]?.produced_status).toBe("error");
      expect(summary.produced_errors).toBe(1);
      expect(summary.produced_pass).toBe(0);
      expect(summary.produced_denominator).toBe(1);
    } finally {
      db3.close();
    }
  });
});

describe("eval scripts persistence and live+agent rendering", () => {
  it("writes one ndjson line per generated script with no secrets", async () => {
    const entries = loadPrompts(PROMPTS_PATH).filter(
      (e) => e.id === "direct-01" || e.id === "adversarial-01",
    );
    const { cases, db } = await runEval(entries, {
      recipesDir: RECIPES_DIR,
      model: "mock",
    });
    try {
      const dir = mkdtempSync(join(tmpdir(), "vbpf-eval-"));
      const path = join(dir, "scripts.ndjson");
      writeScriptsNdjson(path, cases);
      const text = readFileSyncNode(path, "utf8");
      const lines = text.trim().split("\n");
      expect(lines).toHaveLength(1);
      const record = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
      expect(record["id"]).toBe("direct-01");
      expect(record["prompt"]).toBe("direct-01");
      expect(typeof record["script"]).toBe("string");
      expect(record["chart_type"]).toBeTruthy();
      expect(typeof record["attempts"]).toBe("number");
      expect(typeof record["provider_model"]).toBe("string");
      expect(record["produced_status"]).toBe("skipped");
      expect(text).not.toContain("token");
      expect(toScriptRecords(cases)).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("renders the live+agent mode with kernel, status, and notes", async () => {
    const entries = loadPrompts(PROMPTS_PATH).filter(
      (e) => e.id === "direct-01",
    );
    const stub = {
      model: "stub",
      generate: async () =>
        LlmOutputSchema.parse({
          script: "profile:hz:99 { @x = count(); }\n",
          chart_type: "bar",
          explanation: "ok",
          duration_s: 10,
          refusal: null,
        }),
    } as unknown as LlmClient;
    const { cases, summary, db } = await runEval(entries, {
      recipesDir: RECIPES_DIR,
      model: "stub",
      llmFactory: () => stub,
      validateAgentFn: async () => ({
        ok: true,
        errors: [],
        probes: [],
        warnings: [],
        probe_count: 1,
      }),
      runScriptFn: async () => ({ events: 0 }),
    });
    try {
      const md = renderMarkdown(
        "2026-11-10",
        "stub",
        summary,
        cases,
        "live+agent",
        {
          kernel: "6.6.87-test",
          bpftrace: "v0.20.2",
        },
      );
      expect(md).toContain("Mode: live+agent");
      expect(md).toContain("6.6.87-test");
      expect(md).toContain("v0.20.2");
      expect(md).toContain("dry-run compile pass");
      expect(md).toContain("produced-output (generated)");
      expect(md).toContain("produced");
      expect(md).toContain("## Notes");
    } finally {
      db.close();
    }
  });
});
