import { describe, expect, it } from "vitest";

import { loadConfig } from "./config.js";

describe("loadConfig provider chain", () => {
  it("defaults to groq", () => {
    expect(loadConfig({}).LLM_PROVIDER_CHAIN).toBe("groq");
  });

  it("passes through LLM_PROVIDER_CHAIN from the environment", () => {
    expect(
      loadConfig({ LLM_PROVIDER_CHAIN: "cerebras,groq" }).LLM_PROVIDER_CHAIN,
    ).toBe("cerebras,groq");
  });

  it("defaults the deprecated LLM_MODEL to mock", () => {
    expect(loadConfig({}).LLM_MODEL).toBe("mock");
  });

  it("defaults the LLM timeout and waiter budgets", () => {
    const cfg = loadConfig({});
    expect(cfg.LLM_TIMEOUT_MS).toBe(45_000);
    expect(cfg.LLM_TOTAL_TIMEOUT_MS).toBe(90_000);
    expect(cfg.LLM_MAX_WAITERS).toBe(10);
    expect(cfg.LLM_WAIT_TIMEOUT_MS).toBe(10_000);
  });

  it("passes timeout and waiter budgets through", () => {
    const cfg = loadConfig({
      LLM_TIMEOUT_MS: "1000",
      LLM_TOTAL_TIMEOUT_MS: "2000",
      LLM_MAX_WAITERS: "2",
      LLM_WAIT_TIMEOUT_MS: "300",
    });
    expect(cfg.LLM_TIMEOUT_MS).toBe(1000);
    expect(cfg.LLM_TOTAL_TIMEOUT_MS).toBe(2000);
    expect(cfg.LLM_MAX_WAITERS).toBe(2);
    expect(cfg.LLM_WAIT_TIMEOUT_MS).toBe(300);
  });
});
