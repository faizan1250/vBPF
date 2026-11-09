import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ApiError,
  MAX_DURATION_S,
  MAX_PROMPT_CHARS,
  MAX_SCRIPT_BYTES,
  MIN_DURATION_S,
  explainScript,
  generatePrompt,
} from "./api.js";

describe("caps", () => {
  it("matches server contracts", () => {
    expect(MAX_PROMPT_CHARS).toBe(2000);
    expect(MAX_SCRIPT_BYTES).toBe(8 * 1024);
    expect(MIN_DURATION_S).toBe(1);
    expect(MAX_DURATION_S).toBe(60);
  });
});

describe("ApiError", () => {
  it("carries code and status", () => {
    const err = new ApiError(503, "AGENT_OFFLINE", "agent offline");
    expect(err.code).toBe("AGENT_OFFLINE");
    expect(err.status).toBe(503);
  });
});

describe("generatePrompt", () => {
  it("rejects empty prompts without fetching", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(generatePrompt("   ")).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("explainScript", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  it("degrades to null when the endpoint is missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 404 })),
    );
    await expect(explainScript()).resolves.toBeNull();
  });
});
