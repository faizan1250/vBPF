import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ValidatorVectorsSchema } from "@vbpf/schemas";
import { describe, expect, it } from "vitest";

import {
  collectCalls,
  lexScript,
  MAX_SCRIPT_BYTES,
  MAX_VALIDATOR_ERROR_LEN,
  staticValidate,
} from "./validator.js";

// Property tests for I-05 (TS mirror of the Go fuzz targets). No new
// dependency: a hand-written mulberry32 PRNG plus string-level mutators over
// the shared vectors, recipes, and committed eval scripts as seeds.
// Invariants per input: no throw, bounded runtime, denied calls always
// rejected, no error/warning past the length cap, deterministic verdicts.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RECIPES_DIR = join(REPO_ROOT, "recipes");
const NDJSON_PATH = join(
  REPO_ROOT,
  "eval",
  "reports",
  "2026-11-10-live-real-scripts.ndjson",
);
const VECTORS_PATH = join(
  REPO_ROOT,
  "packages",
  "schemas",
  "validator-vectors.json",
);

// Mirrors DENIED_CALLS in validator.ts (kept local so the test fails loudly
// if the validator's deny list drifts without this file being updated).
const DENIED = new Set(["system", "signal", "override", "cat"]);

const SKIP = { catalog: { mode: "skip" } } as const;
const MUTANTS_PER_SEED = 4;
const CASE_TIME_MS = 1000;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function loadSeeds(): string[] {
  const seeds: string[] = [];
  const vectors = ValidatorVectorsSchema.parse(
    JSON.parse(readFileSync(VECTORS_PATH, "utf8")),
  );
  for (const v of vectors) seeds.push(v.script);
  for (const f of readdirSync(RECIPES_DIR).filter((x) => x.endsWith(".bt"))) {
    seeds.push(readFileSync(join(RECIPES_DIR, f), "utf8"));
  }
  for (const line of readFileSync(NDJSON_PATH, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    seeds.push((JSON.parse(line) as { script: string }).script);
  }
  return seeds.filter((s) => typeof s === "string");
}

const FLIP_ALPHABET = [
  "(",
  ")",
  "{",
  "}",
  ";",
  ",",
  "*",
  "?",
  "[",
  "#",
  "/",
  '"',
  "\\",
  "\n",
  "\0",
  "\x1b",
  "\x7f",
  "é",
  "（",
  "）",
  "с",
  " ",
  ":",
];

function mutate(rng: () => number, base: string): string {
  const op = Math.floor(rng() * 8);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]!;
  switch (op) {
    case 0: {
      // Inject a denied or unknown call before the last action close.
      const call = pick([
        'system("id");',
        "signal(9);",
        "override(0);",
        'cat("/etc/passwd");',
        'exec("id");',
        "nosuchfn_vbpf(1);",
      ]);
      const idx = base.lastIndexOf("}");
      return idx < 0
        ? `${base}\nBEGIN { ${call} }`
        : `${base.slice(0, idx)} ${call} ${base.slice(idx)}`;
    }
    case 1: {
      // Hide denied text inside a comment or string (must stay accepted).
      const hidden = pick([
        `/* system("id"); */ `,
        `// signal(9)\n`,
        `printf("override(cat("); `,
      ]);
      const at = Math.floor(rng() * (base.length + 1));
      return `${base.slice(0, at)}${hidden}${base.slice(at)}`;
    }
    case 2: {
      // Random byte-level edits, including control and non-ASCII bytes.
      const chars = Array.from(base);
      const edits = 1 + Math.floor(rng() * 3);
      for (let i = 0; i < edits; i += 1) {
        const at = Math.floor(rng() * (chars.length + 1));
        chars.splice(at, 0, pick(FLIP_ALPHABET));
      }
      return chars.join("");
    }
    case 3:
      return `${base} ${pick(["#include <x>", "#define HACK 1", "--unsafe", "*", "uprobe:libc:m*", "kprobe:ab*"])}`;
    case 4: {
      // Splice: join this seed with a random other seed.
      const other = pick(SEEDS);
      const cutA = Math.floor(rng() * (base.length + 1));
      const cutB = Math.floor(rng() * (other.length + 1));
      return base.slice(0, cutA) + other.slice(cutB);
    }
    case 5:
      return base.slice(0, Math.floor(rng() * (base.length + 1)));
    case 6: {
      // Duplicate a random chunk (probe-count and nesting pressure).
      if (base.length === 0) return base;
      const at = Math.floor(rng() * base.length);
      const len = 1 + Math.floor(rng() * Math.min(64, base.length - at));
      return base + base.slice(at, at + len).repeat(1 + Math.floor(rng() * 4));
    }
    default:
      return base;
  }
}

const SEEDS = loadSeeds();

function checkInvariants(script: string): void {
  const t0 = performance.now();
  const lexed = lexScript(script);
  const { calls } = collectCalls(lexed.toks);
  const res = staticValidate(script, SKIP);
  const dt = performance.now() - t0;
  expect(dt, "validator exceeded time bound").toBeLessThan(CASE_TIME_MS);
  for (const e of [...res.errors, ...res.warnings]) {
    expect(
      Array.from(e).length,
      `message past cap: ${e.slice(0, 80)}`,
    ).toBeLessThanOrEqual(MAX_VALIDATOR_ERROR_LEN);
  }
  const denied = calls.filter((c) => DENIED.has(c));
  if (denied.length > 0) {
    expect(
      res.errors.length,
      `denied call accepted: ${denied.join(",")}`,
    ).toBeGreaterThan(0);
    if (Buffer.byteLength(script, "utf8") <= MAX_SCRIPT_BYTES) {
      expect(res.code, `denied call misclassified: ${denied.join(",")}`).toBe(
        "BLOCKED_CALL",
      );
    }
  }
  const again = staticValidate(script, SKIP);
  expect(again, "validator is not deterministic").toEqual(res);
}

describe("validator fuzz seeds", () => {
  it("loads a non-trivial corpus from vectors, recipes, and eval scripts", () => {
    expect(SEEDS.length).toBeGreaterThanOrEqual(100);
  });

  it("validates every seed without throwing", () => {
    for (const seed of SEEDS) {
      expect(() => checkInvariants(seed), seed.slice(0, 80)).not.toThrow();
    }
  });
});

describe("validator mutants", () => {
  it("preserves invariants across deterministic mutations", () => {
    const rng = mulberry32(0x05f5);
    let cases = 0;
    for (const seed of SEEDS) {
      for (let i = 0; i < MUTANTS_PER_SEED; i += 1) {
        const mutant = mutate(rng, seed);
        expect(
          () => checkInvariants(mutant),
          mutant.slice(0, 80),
        ).not.toThrow();
        cases += 1;
      }
    }
    expect(cases).toBeGreaterThanOrEqual(400);
  });
});
