import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ApiError,
  MAX_DURATION_S,
  MAX_PROMPT_CHARS,
  MAX_SCRIPT_BYTES,
  MIN_DURATION_S,
  createRun,
  explainScript,
  generatePrompt,
  validateScript,
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

describe("script size cap", () => {
  it("rejects oversize scripts in validateScript without fetching", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const big = "x".repeat(MAX_SCRIPT_BYTES + 1);
    await expect(validateScript(big)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message: expect.stringMatching(/exceeds 8 KB/) as unknown as string,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("rejects oversize scripts in createRun without fetching", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const big = "x".repeat(MAX_SCRIPT_BYTES + 1);
    await expect(createRun(big, 10)).rejects.toMatchObject({
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
  it("rejects oversize scripts without fetching", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const big = "x".repeat(MAX_SCRIPT_BYTES + 1);
    await expect(explainScript(big)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message: expect.stringMatching(/exceeds 8 KB/) as unknown as string,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("posts the script and returns the walkthrough", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          explanation: "Counts opens.",
          cached: false,
          model: "mock",
        }),
      ),
    );
    await expect(explainScript("BEGIN { @x = count(); }")).resolves.toEqual({
      explanation: "Counts opens.",
      cached: false,
      model: "mock",
    });
  });

  it("surfaces server errors as ApiError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "bad", code: "X" }), {
            status: 422,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    await expect(
      explainScript("BEGIN { @x = count(); }"),
    ).rejects.toMatchObject({
      code: "X",
      status: 422,
    });
  });
});
