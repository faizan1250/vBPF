import { describe, expect, it } from "vitest";

import {
  FIXTURE_RECIPES,
  FIXTURE_SCENARIOS,
  fixtureEvents,
  fixtureScenarioForPrompt,
  fixtureScenarioId,
} from "./fixtures.js";

const CANONICAL_PROMPTS: Record<string, string> = {
  "slow-disk": "Which processes are doing the slowest disk I/O?",
  "new-processes": "Show new processes as they start",
  "tcp-retransmits": "Show TCP retransmits over time",
  "syscall-counts": "Count system calls by process",
  "dns-lookups": "Which processes are doing DNS lookups?",
};

describe("fixture scenarios", () => {
  it("covers the five required scenarios with distinct scripts", () => {
    expect(FIXTURE_SCENARIOS).toHaveLength(5);
    for (const [id, prompt] of Object.entries(CANONICAL_PROMPTS)) {
      const scenario = FIXTURE_SCENARIOS.find((s) => s.id === id);
      expect(scenario?.prompt).toBe(prompt);
    }
    const scripts = new Set(FIXTURE_SCENARIOS.map((s) => s.script));
    expect(scripts.size).toBe(5);
  });

  it("routes each canonical prompt to its scenario", () => {
    expect(fixtureScenarioForPrompt(CANONICAL_PROMPTS["slow-disk"]!).id).toBe(
      "slow-disk",
    );
    expect(
      fixtureScenarioForPrompt(CANONICAL_PROMPTS["new-processes"]!).chart,
    ).toBe("events");
    expect(
      fixtureScenarioForPrompt(CANONICAL_PROMPTS["tcp-retransmits"]!).chart,
    ).toBe("timeseries");
    expect(
      fixtureScenarioForPrompt(CANONICAL_PROMPTS["syscall-counts"]!).id,
    ).toBe("syscall-counts");
    expect(
      fixtureScenarioForPrompt(CANONICAL_PROMPTS["dns-lookups"]!).chart,
    ).toBe("table");
  });

  it("keeps the histogram keyword route for latency views", () => {
    const scenario = fixtureScenarioForPrompt(
      "Histogram of TCP retransmit latency by process",
    );
    expect(scenario.chart).toBe("histogram");
  });

  it("defaults unknown prompts to syscall counts", () => {
    expect(fixtureScenarioForPrompt("hello world")!.id).toBe("syscall-counts");
  });

  it("round-trips scenario ids through run ids", () => {
    expect(fixtureScenarioId("run_fixture_slow-disk_123")).toBe("slow-disk");
    expect(fixtureScenarioId("run_fixture_dns-lookups_456")).toBe(
      "dns-lookups",
    );
    expect(fixtureScenarioId("run_fixture_1")).toBe("default");
    expect(fixtureScenarioId("run_1")).toBe("default");
  });

  it("exposes five sanitized offline recipes", () => {
    expect(FIXTURE_RECIPES).toHaveLength(5);
    for (const recipe of FIXTURE_RECIPES) {
      expect(recipe.id).toMatch(/^[a-z0-9-]+$/);
      expect(recipe.description).not.toBe("");
    }
    const views = new Set(FIXTURE_RECIPES.map((r) => r.view));
    expect(views).toEqual(new Set(["bar", "events", "timeseries", "table"]));
  });

  it("replays sanitized data with no usernames, paths, or hostnames", () => {
    const payloads: string[] = FIXTURE_SCENARIOS.map((s) => s.script);
    for (const chart of [
      "bar",
      "events",
      "histogram",
      "timeseries",
      "table",
    ] as const) {
      for (const id of ["slow-disk", "dns-lookups", "default"]) {
        for (const tick of [1, 2]) {
          payloads.push(
            JSON.stringify(fixtureEvents(chart, "run_fixture_x_1", tick, id)),
          );
        }
      }
    }
    for (const payload of payloads) {
      expect(payload).not.toMatch(
        /\/home\/|\/root\/|\/etc\/|\/var\/|\/usr\/|\/tmp\/|C:\\|passwd|shadow|example\.(com|org|net)|https?:\/\//,
      );
    }
  });
});
