import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ValidatorVectorsSchema } from "@vbpf/schemas";
import { describe, expect, it } from "vitest";

import { staticValidate } from "./validator.js";

const VECTORS_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "packages",
  "schemas",
  "validator-vectors.json",
);

const vectors = ValidatorVectorsSchema.parse(
  JSON.parse(readFileSync(VECTORS_PATH, "utf8")),
);

describe("shared validator vectors", () => {
  it("has unique kebab-case ids and a non-trivial corpus", () => {
    expect(vectors.length).toBeGreaterThanOrEqual(50);
    const ids = vectors.map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it("matches the agent verdict (ok and error code) for every vector", () => {
    for (const v of vectors) {
      const res = staticValidate(v.script, {
        catalog:
          v.catalog === "enforce"
            ? { mode: "enforce", known: v.known ?? [] }
            : { mode: "skip" },
      });
      if (v.expect.ok) {
        expect(res.errors, v.id).toEqual([]);
        expect(v.expect.error_codes, v.id).toEqual([]);
      } else {
        expect(res.errors.length, v.id).toBeGreaterThan(0);
        expect(v.expect.error_codes, v.id).toHaveLength(1);
        expect(res.code, v.id).toBe(v.expect.error_codes[0]);
      }
    }
  });
});
