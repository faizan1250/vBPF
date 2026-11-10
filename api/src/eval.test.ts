import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  EvalPromptsSchema,
  assertCallBudget,
  categoryFromId,
  loadPrompts,
  parseEvalArgs,
  renderMarkdown,
  runEval,
  summarize,
} from "./eval.js";
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
    };
    const summary = summarize([fakeCase]);
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
