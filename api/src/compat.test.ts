import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CompatReportSchema } from "@vbpf/schemas";
import { describe, expect, it } from "vitest";

import {
  loadReports,
  renderCompatMd,
  renderReadmeSection,
  statusCell,
  updateReadme,
  validateReport,
} from "../../scripts/render-compat.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const compatDir = join(root, "compat");

const reportFiles = () =>
  readdirSync(compatDir).filter(
    (f) => f.endsWith(".json") && f !== "schema.json",
  );

const recipeIds = () =>
  readdirSync(join(root, "recipes"))
    .filter((f) => f.endsWith(".yaml") && !f.startsWith("_"))
    .map((f) => f.slice(0, -".yaml".length))
    .sort();

describe("compat schema", () => {
  it("parses every committed report", () => {
    const files = reportFiles();
    expect(files.length).toBeGreaterThanOrEqual(1);
    for (const file of files) {
      const raw = JSON.parse(readFileSync(join(compatDir, file), "utf8"));
      expect(() => CompatReportSchema.parse(raw)).not.toThrow();
    }
  });

  it("rejects bad status, empty recipes, and unknown keys", () => {
    const base = JSON.parse(
      readFileSync(join(compatDir, "wsl2-ubuntu-24.04.json"), "utf8"),
    );
    expect(() =>
      CompatReportSchema.parse({ ...base, status: "supported" }),
    ).toThrow();
    expect(() => CompatReportSchema.parse({ ...base, recipes: {} })).toThrow();
    expect(() => CompatReportSchema.parse({ ...base, extra: true })).toThrow();
  });
});

describe("compat renderer", () => {
  it("sorts reports and skips schema.json", () => {
    const reports = loadReports(compatDir);
    expect(reports.map((r) => r.env)).toEqual(
      [...reports.map((r) => r.env)].sort(),
    );
    expect(reports.some((r) => r.env === "schema")).toBe(false);
  });

  it("throws on missing dir and env/filename mismatch", () => {
    expect(() => loadReports(join(compatDir, "nope"))).toThrow();
    const base = JSON.parse(
      readFileSync(join(compatDir, "wsl2-ubuntu-24.04.json"), "utf8"),
    );
    expect(() =>
      validateReport({ ...base, env: "other" }, "wsl2-ubuntu-24.04.json"),
    ).toThrow();
  });

  it("keeps unrun rows honest", () => {
    for (const r of loadReports(compatDir)) {
      if (r.status === "verified") {
        expect(statusCell(r)).toMatch(/^Verified/);
        expect(r.recorded_at).toMatch(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/);
      } else {
        expect(statusCell(r)).toMatch(/Not run|Unverified/);
        expect(Object.values(r.recipes)).toEqual(
          Object.values(r.recipes).map(() => "not-checked"),
        );
      }
    }
    const md = renderCompatMd(loadReports(compatDir));
    expect(md).not.toMatch(/\| `ubuntu-22\.04`.*\| Verified/);
    expect(md).toContain("Unverified (workflow added)");
  });

  it("covers every recipe in the library", () => {
    const ids = recipeIds();
    expect(ids.length).toBeGreaterThanOrEqual(10);
    for (const r of loadReports(compatDir)) {
      for (const id of ids) {
        expect(r.recipes[id]).toBeDefined();
      }
    }
  });

  it("matches the committed generated files", () => {
    const reports = loadReports(compatDir);
    expect(readFileSync(join(root, "docs", "compat.md"), "utf8")).toBe(
      renderCompatMd(reports),
    );
    const readme = readFileSync(join(root, "README.md"), "utf8");
    expect(updateReadme(readme, renderReadmeSection(reports))).toBe(readme);
  });

  it("requires README markers", () => {
    expect(() => updateReadme("no markers here", "x")).toThrow();
  });
});
