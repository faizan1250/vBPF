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
  localRunOrigin,
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
    expect(err.fixHint).toBeUndefined();
  });

  it("carries optional fixHint on AGENT_NOT_READY", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: "agent probe catalog not ready",
              code: "AGENT_NOT_READY",
              fix_hint: "Mount debugfs/tracefs and retry.",
            }),
            { status: 503, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    await expect(validateScript("BEGIN { }")).rejects.toMatchObject({
      status: 503,
      code: "AGENT_NOT_READY",
      message: "agent probe catalog not ready",
      fixHint: "Mount debugfs/tracefs and retry.",
    });
    vi.unstubAllGlobals();
  });

  it("returns warnings and probe_count from validateScript", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          ok: true,
          errors: [],
          probes: ["tracepoint:sched:*"],
          warnings: ["Wildcard probe tracepoint:sched:* expands to 8 probes."],
          probe_count: 8,
        }),
      ),
    );
    await expect(
      validateScript("tracepoint:sched:* { @c = count(); }"),
    ).resolves.toEqual({
      ok: true,
      errors: [],
      probes: ["tracepoint:sched:*"],
      warnings: ["Wildcard probe tracepoint:sched:* expands to 8 probes."],
      probe_count: 8,
    });
    vi.unstubAllGlobals();
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

describe("createRun generation binding", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts generation_id when provided", async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: unknown) => {
        body = JSON.parse((init as { body: string }).body) as Record<
          string,
          unknown
        >;
        return Response.json({ run_id: "run_1", state: "running" });
      }),
    );
    await expect(createRun("BEGIN { }", 10, "gen_123")).resolves.toEqual({
      run_id: "run_1",
      state: "running",
    });
    expect(body).toMatchObject({
      script: "BEGIN { }",
      duration_s: 10,
      generation_id: "gen_123",
    });
  });

  it("omits generation_id when absent", async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: unknown) => {
        body = JSON.parse((init as { body: string }).body) as Record<
          string,
          unknown
        >;
        return Response.json({ run_id: "run_1", state: "running" });
      }),
    );
    await createRun("BEGIN { }", 10);
    expect(body).not.toHaveProperty("generation_id");
  });
});

describe("localRunOrigin", () => {
  it("marks a pristine generation without a recipe as generated", () => {
    expect(
      localRunOrigin("BEGIN { }", {
        script: "BEGIN { }",
        based_on_recipe: null,
      }),
    ).toBe("generated");
  });

  it("marks a pristine recipe-based generation as recipe", () => {
    expect(
      localRunOrigin("BEGIN { }", {
        script: "BEGIN { }",
        based_on_recipe: "cpu-by-process",
      }),
    ).toBe("recipe");
  });

  it("marks a modified script as edited", () => {
    expect(
      localRunOrigin("BEGIN { @b = 2; }", {
        script: "BEGIN { @a = 1; }",
        based_on_recipe: null,
      }),
    ).toBe("edited");
  });

  it("marks a run without a generation as edited", () => {
    expect(localRunOrigin("BEGIN { }", null)).toBe("edited");
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
