import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type Database from "better-sqlite3";
import { beforeAll, describe, expect, it } from "vitest";

import { indexRecipes, migrate, openDb, searchRecipes } from "./db.js";
import { loadRecipes } from "./recipes.js";
import { buildFtsQuery, extractKeywords } from "./retrieval.js";

const RECIPES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "recipes",
);

let db: Database.Database;

beforeAll(() => {
  db = openDb(":memory:");
  migrate(db);
  indexRecipes(db, loadRecipes(RECIPES_DIR));
});

describe("extractKeywords", () => {
  it("folds case and drops stopwords", () => {
    expect(extractKeywords("Show me the CPU usage")).toEqual(["cpu", "usage"]);
  });

  it("expands synonyms", () => {
    expect(extractKeywords("slow disk")).toContain("latency");
    expect(extractKeywords("disk")).toEqual(
      expect.arrayContaining(["disk", "block", "io"]),
    );
    expect(extractKeywords("NETWORK")).toContain("tcp");
  });
});

describe("buildFtsQuery", () => {
  it("quotes terms and ors them", () => {
    expect(buildFtsQuery(["cpu", "process"])).toBe('"cpu" OR "process"');
  });

  it("splits multi-word synonyms", () => {
    expect(buildFtsQuery(["block io"])).toBe('"block" OR "io"');
  });

  it("strips fts metacharacters", () => {
    expect(buildFtsQuery(['a"b*c'])).toBe('"abc"');
  });

  it("neutralizes quote, wildcard, operator, and dash inputs", () => {
    expect(buildFtsQuery(['"'])).toBe("");
    expect(buildFtsQuery(["*"])).toBe("");
    expect(buildFtsQuery(["NEAR("])).toBe('"NEAR("');
    expect(buildFtsQuery(["AND"])).toBe('"AND"');
    expect(buildFtsQuery(["-"])).toBe('"-"');
  });

  it("maps empty input to empty query", () => {
    expect(buildFtsQuery([])).toBe("");
    expect(buildFtsQuery([""])).toBe("");
    expect(buildFtsQuery(["   "])).toBe("");
  });

  it("strips nul bytes", () => {
    const nul = String.fromCharCode(0);
    expect(buildFtsQuery([`a${nul}b`])).toBe('"ab"');
    expect(buildFtsQuery([nul])).toBe("");
  });

  it("executes hostile queries without fts errors", () => {
    const inputs = [
      ['a"b'],
      ["a*b"],
      ["NEAR("],
      ["NEAR(cpu, process)"],
      ["AND"],
      ["OR"],
      ["NOT"],
      ["-"],
      ["-cpu"],
      ["cpu:process"],
      ["(cpu)"],
      ['"; DROP TABLE recipes_index; --'],
    ];
    for (const keywords of inputs) {
      const match = buildFtsQuery(keywords);
      if (match === "") continue;
      expect(() =>
        db
          .prepare(
            "SELECT count(*) AS n FROM recipes_index WHERE recipes_index MATCH ?",
          )
          .get(match),
      ).not.toThrow();
    }
  });

  it("handles raw prompts without fts errors", () => {
    const prompts = [
      '"',
      "*",
      "NEAR(cpu, process)",
      "AND OR NOT",
      "-",
      "",
      "   ",
      '"; DROP TABLE recipes_index; --',
      "cpu:process",
      "-cpu",
    ];
    for (const prompt of prompts) {
      expect(() => searchRecipes(db, prompt, 3)).not.toThrow();
    }
  });
});

describe("recipe retrieval", () => {
  const cases: Array<[prompt: string, id: string]> = [
    ["Which processes are using the most CPU?", "cpu-by-process"],
    ["Show me a histogram of block I/O latency", "block-latency-histogram"],
    ["Stream DNS lookups with the calling process", "dns-lookups"],
    [
      "Which files are being opened, show openat calls",
      "files-opened-by-process",
    ],
    ["Show newly started processes and exec events", "new-processes"],
    [
      "Count page faults by process, check memory pressure",
      "page-faults-by-process",
    ],
    [
      "My disk is SLOW, which processes have slow disk IO?",
      "slow-disk-io-by-process",
    ],
    ["Count syscalls by process name", "syscall-counts-by-process"],
    ["Show new network connections over TCP with endpoints", "tcp-connects"],
    ["Graph TCP retransmits and packet loss over time", "tcp-retransmits"],
  ];

  for (const [prompt, id] of cases) {
    it(`ranks ${id} in top 3`, () => {
      const ids = searchRecipes(db, prompt, 3).map((r) => r.id);
      expect(ids).toContain(id);
    });
  }
});
