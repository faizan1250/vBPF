import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { AgentProxyError } from "./agent-client.js";
import { indexRecipes, migrate, openDb } from "./db.js";
import { runGenerate } from "./generate.js";
import { LlmOutputSchema } from "./llm.js";
import { loadRecipes } from "./recipes.js";
import { MAX_PROBES, staticValidate } from "./validator.js";

const RECIPES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "recipes",
);

describe("validator catalog mode requirement and fail-closed readiness", () => {
  it("requires explicit catalog option at compile time", () => {
    // @ts-expect-error staticValidate requires an explicit catalog option
    const call = (): unknown => staticValidate("BEGIN { @x = count(); }");
    expect(typeof call).toBe("function");
  });

  it("fails closed with CATALOG_UNAVAILABLE when enforce catalog is empty", () => {
    for (const script of [
      "BEGIN { @x = count(); }",
      "END {}",
      "tracepoint:block:block_rq_issue { @x = count(); }",
    ]) {
      const res = staticValidate(script, {
        catalog: { mode: "enforce", known: [] },
      });
      expect(res.code).toBe("CATALOG_UNAVAILABLE");
      expect(res.errors[0]).toContain("catalog unavailable");
      expect(res.probe_count).toBe(0);
    }
  });
});

describe("validator libc uprobe allowlist and hot symbol warnings", () => {
  const known = ["tracepoint:block:block_rq_issue"];

  it("accepts libc alias and canonical libc paths without catalog entries", () => {
    for (const script of [
      "uprobe:libc:malloc { @x = count(); }",
      "uretprobe:libc:getaddrinfo { @x = count(); }",
      "uprobe:/lib/libc.so.6:malloc { @x = count(); }",
      "uprobe:/lib64/libc.so:calloc { @x = count(); }",
      "uprobe:/usr/lib/libc.so.6:free { @x = count(); }",
      "uprobe:/usr/lib64/libc-2.31.so:getaddrinfo { @x = count(); }",
      "uprobe:/lib/x86_64-linux-gnu/libc.so.6:malloc { @x = count(); }",
      "uretprobe:/usr/lib/aarch64-linux-gnu/libc.so.6:_pthread_cleanup_push { @x = count(); }",
    ]) {
      const res = staticValidate(script, {
        catalog: { mode: "enforce", known },
      });
      expect(res.errors, script).toEqual([]);
      expect(res.probe_count).toBe(1);
    }
  });

  it("rejects non-libc binaries, traversals, bad symbols, and usdt", () => {
    const bad = [
      "usdt:/lib/x86_64-linux-gnu/libc.so.6:probe { @x = count(); }",
      "uprobe:/bin/ls:main { @x = count(); }",
      "uprobe:/tmp/libc.so.6:malloc { @x = count(); }",
      "uprobe:/lib/x86_64-linux-gnu/sub/libc.so.6:malloc { @x = count(); }",
      "uprobe:/lib/evil/libc.so.6:malloc { @x = count(); }",
      "uprobe:/lib/../usr/lib/libc.so.6:malloc { @x = count(); }",
      "uprobe:/lib/./libc.so.6:malloc { @x = count(); }",
      "uprobe:/lib//libc.so.6:malloc { @x = count(); }",
      "uprobe:/lib/libc.so.6/:malloc { @x = count(); }",
      "uprobe:/lib/libcrypt.so.1:crypt { @x = count(); }",
      "uprobe:libc { @x = count(); }",
      "uprobe:libc:malloc+0x10 { @x = count(); }",
      "uprobe:libc:0x401000 { @x = count(); }",
      "uprobe:libc:* { @x = count(); }",
      "uprobe:libc:mal* { @x = count(); }",
      "uprobe:libc:m?lloc { @x = count(); }",
      "uprobe:/lib/libc.so.6:malloc:extra { @x = count(); }",
      'uprobe:/lib/libc.so.6:"Foo::bar(int, int)" { @x = count(); }',
    ];
    for (const script of bad) {
      const res = staticValidate(script, {
        catalog: { mode: "enforce", known },
      });
      expect(res.errors.length, script).toBeGreaterThan(0);
      expect(res.code, script).toBe("VALIDATION_FAILED");
    }
  });

  it("emits warnings for hot libc symbols", () => {
    for (const sym of [
      "malloc",
      "free",
      "memcpy",
      "memset",
      "strlen",
      "read",
      "write",
    ]) {
      const res = staticValidate(`uprobe:libc:${sym} { @x = count(); }`, {
        catalog: { mode: "skip" },
      });
      expect(res.errors, sym).toEqual([]);
      expect(res.warnings.join(" "), sym).toContain(sym);
    }
    const cold = staticValidate("uprobe:libc:getaddrinfo { @x = count(); }", {
      catalog: { mode: "skip" },
    });
    expect(cold.errors).toEqual([]);
    expect(cold.warnings).toEqual([]);
  });
});

describe("validator wildcard rules and total MaxProbes occurrence sum", () => {
  const known = [
    "tracepoint:block:block_rq_issue",
    "tracepoint:block:block_rq_complete",
    "tracepoint:syscalls:sys_enter_openat",
    "kprobe:vfs_read",
    "kprobe:vfs_write",
    "kretprobe:tcp_v4_connect",
    ...Array.from({ length: 30 }, (_, i) => `tracepoint:sched:sched_${i}`),
    ...Array.from({ length: 25 }, (_, i) => `tracepoint:net:net_${i}`),
  ];

  it("allows tight tracepoint and kprobe/kretprobe wildcard prefixes", () => {
    for (const [script, want] of [
      ["tracepoint:block:* { @x = count(); }", 2],
      ["tracepoint:syscalls:sys_enter_* { @x = count(); }", 1],
      ["kprobe:vfs_* { @x = count(); }", 2],
      ["kretprobe:tcp_* { @x = count(); }", 1],
    ] as const) {
      const res = staticValidate(script, {
        catalog: { mode: "enforce", known },
      });
      expect(res.errors, script).toEqual([]);
      expect(res.probe_count, script).toBe(want);
      expect(res.warnings.join(" ")).toContain("expands to");
    }
  });

  it("rejects disallowed wildcard shapes", () => {
    for (const script of [
      "* { @x = count(); }",
      "kprobe:* { @x = count(); }",
      "kprobe:a* { @x = count(); }",
      "kprobe:ab* { @x = count(); }",
      "kretprobe:ab* { @x = count(); }",
      "tracepoint:*:* { @x = count(); }",
      "tracepoint:*:block_rq_issue { @x = count(); }",
      "tracepoint:blo*:block_rq_issue { @x = count(); }",
      "tracepoint:block:*_rq_issue { @x = count(); }",
      "kprobe:vfs_*_read { @x = count(); }",
      "kprobe:vfs_rea? { @x = count(); }",
      "tracepoint:block:item[0]* { @x = count(); }",
      "profile:hz:* { @x = count(); }",
      "interval:s:* { @x = count(); }",
      "software:* { @x = count(); }",
    ]) {
      const res = staticValidate(script, {
        catalog: { mode: "enforce", known },
      });
      expect(res.code, script).toBe("VALIDATION_FAILED");
    }
  });

  it("returns PROBE_NOT_FOUND with suggestions for zero-match wildcards", () => {
    const res = staticValidate("tracepoint:block:missing_* { @x = count(); }", {
      catalog: { mode: "enforce", known },
    });
    expect(res.code).toBe("PROBE_NOT_FOUND");
    expect(res.errors.join("; ")).toContain("did you mean: tracepoint:block:");
  });

  it("counts occurrences toward MaxProbes in enforce and skip modes", () => {
    const exactly50 =
      "tracepoint:block:block_rq_issue { @x = count(); }\n".repeat(MAX_PROBES);
    const res50 = staticValidate(exactly50, {
      catalog: { mode: "enforce", known },
    });
    expect(res50.errors).toEqual([]);
    expect(res50.probe_count).toBe(50);

    const over51Skip = staticValidate(`${exactly50}BEGIN {}`, {
      catalog: { mode: "skip" },
    });
    expect(over51Skip.code).toBe("LIMIT_EXCEEDED");
    expect(over51Skip.probe_count).toBe(51);

    const dupWildEnforce = staticValidate(
      "tracepoint:sched:*, tracepoint:net:* { @x = count(); }",
      { catalog: { mode: "enforce", known } },
    );
    expect(dupWildEnforce.code).toBe("LIMIT_EXCEEDED");
    expect(dupWildEnforce.probe_count).toBe(55);
  });
});

describe("runGenerate fail-fast on 503 CATALOG_UNAVAILABLE", () => {
  it("aborts after 1 LLM call without entering the retry loop", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vbpf-gen-unready-"));
    const tokenFile = join(dir, "agent.token");
    writeFileSync(tokenFile, "tok\n");
    const db = openDb(":memory:");
    migrate(db);
    indexRecipes(db, loadRecipes(RECIPES_DIR));
    let llmCalls = 0;
    const llm = {
      model: "mock",
      generate: async () => {
        llmCalls += 1;
        return LlmOutputSchema.parse({
          script: "BEGIN { @x = count(); }\n",
          chart_type: "events",
          explanation: "ok",
          duration_s: 10,
          refusal: null,
        });
      },
    };
    try {
      await expect(
        runGenerate("count events", {
          deps: {
            db,
            recipesDir: RECIPES_DIR,
            agentUrl: "http://127.0.0.1:1",
            tokenFile,
            llm,
            searchProbesFn: async () => [],
            validateAgentFn: async () => {
              throw new AgentProxyError(
                503,
                JSON.stringify({
                  error: "probe catalog not ready",
                  code: "CATALOG_UNAVAILABLE",
                }),
                "2",
              );
            },
          },
        }),
      ).rejects.toMatchObject({ status: 503, code: "CATALOG_UNAVAILABLE" });
      expect(llmCalls).toBe(1);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
