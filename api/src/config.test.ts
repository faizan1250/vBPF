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
});
