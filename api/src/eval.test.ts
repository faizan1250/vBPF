import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  EvalPromptsSchema,
  categoryFromId,
  loadPrompts,
  runEval,
  summarize,
} from "./eval.js";
import { isRefusalPrompt } from "./llm.js";

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
});
