import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ApiError,
  MAX_DURATION_S,
  MAX_EXPLAIN_RESULTS_OUTPUT_CHARS,
  MAX_PROMPT_CHARS,
  MAX_SCRIPT_BYTES,
  MIN_DURATION_S,
  createRun,
  explainResults,
  explainScript,
  fetchSession,
  fetchSessionExport,
  fetchSessions,
  generatePrompt,
  localRunOrigin,
  setApiToken,
  validateScript,
  wsTokenQuery,
} from "./api.js";

afterEach(() => {
  try {
    localStorage.removeItem("vbpf_api_token");
  } catch {
    // jsdom always has localStorage; ignore otherwise.
  }
  vi.unstubAllGlobals();
});

describe("api token", () => {
  function stubStorage(): Map<string, string> {
    const backing = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => (backing.has(k) ? backing.get(k)! : null),
      setItem: (k: string, v: string) => void backing.set(k, v),
      removeItem: (k: string) => void backing.delete(k),
    });
    return backing;
  }

  it("attaches the stored token as a bearer header", async () => {
    stubStorage();
    setApiToken("tok-123");
    let seen: HeadersInit | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        seen = init?.headers;
        return Response.json({ ok: true });
      }),
    );
    await validateScript("BEGIN { }");
    expect(new Headers(seen).get("authorization")).toBe("Bearer tok-123");
  });

  it("sends no auth header without a stored token", async () => {
    let seen: HeadersInit | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        seen = init?.headers;
        return Response.json({ ok: true });
      }),
    );
    await validateScript("BEGIN { }");
    expect(new Headers(seen).get("authorization")).toBeNull();
  });

  it("builds the ws query token only when set", () => {
    stubStorage();
    expect(wsTokenQuery()).toBe("");
    setApiToken("tok-123");
    expect(wsTokenQuery()).toBe("?token=tok-123");
  });
});

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

  it("posts session_id when provided", async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: unknown) => {
        body = JSON.parse((init as { body: string }).body) as Record<
          string,
          unknown
        >;
        return Response.json({
          run_id: "run_1",
          state: "running",
          origin: "generated",
          session_id: "ses_1",
        });
      }),
    );
    await expect(
      createRun("BEGIN { }", 10, "gen_123", "ses_1"),
    ).resolves.toMatchObject({
      run_id: "run_1",
      session_id: "ses_1",
    });
    expect(body).toMatchObject({
      script: "BEGIN { }",
      duration_s: 10,
      generation_id: "gen_123",
      session_id: "ses_1",
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

  it("omits session_id when absent", async () => {
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
    await createRun("BEGIN { }", 10, "gen_123");
    expect(body).not.toHaveProperty("session_id");
  });
});

describe("server sessions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches the session list with a bounded limit", async () => {
    let url = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        url = String(input);
        return Response.json({ sessions: [] });
      }),
    );
    await expect(fetchSessions()).resolves.toEqual({ sessions: [] });
    expect(url).toBe("/api/sessions?limit=50");
    await fetchSessions(500);
    expect(url).toBe("/api/sessions?limit=200");
  });

  it("fetches one session and its export by encoded id", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        seen.push(String(input));
        return Response.json({
          id: "ses_1",
          title: "t",
          created_at: 1,
          generations: [],
          runs: [],
        });
      }),
    );
    await fetchSession("ses_1");
    await fetchSessionExport("ses_1");
    expect(seen).toEqual(["/api/sessions/ses_1", "/api/sessions/ses_1/export"]);
  });

  it("rejects an empty session id without fetching", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(fetchSession("")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(fetchSessionExport("")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
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

describe("explainResults", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("matches the server output cap", () => {
    expect(MAX_EXPLAIN_RESULTS_OUTPUT_CHARS).toBe(4000);
  });

  it("rejects empty output without fetching", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(explainResults("BEGIN { }", "   ")).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("posts script, capped output, and consent", async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: unknown) => {
        body = JSON.parse((init as { body: string }).body) as Record<
          string,
          unknown
        >;
        return Response.json({
          explanation: "bash did 42 opens.",
          cached: false,
          model: "mock",
        });
      }),
    );
    await expect(
      explainResults("BEGIN { @x = count(); }", "[#1 printf] hi"),
    ).resolves.toEqual({
      explanation: "bash did 42 opens.",
      cached: false,
      model: "mock",
    });
    expect(body).toMatchObject({
      script: "BEGIN { @x = count(); }",
      output: "[#1 printf] hi",
      consent: true,
    });
  });

  it("caps output client-side", async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: unknown) => {
        body = JSON.parse((init as { body: string }).body) as Record<
          string,
          unknown
        >;
        return Response.json({
          explanation: "x",
          cached: false,
          model: "mock",
        });
      }),
    );
    await explainResults("BEGIN { }", "y".repeat(5000));
    expect((body["output"] as string).length).toBe(
      MAX_EXPLAIN_RESULTS_OUTPUT_CHARS,
    );
    expect(body["consent"]).toBe(true);
  });
});
