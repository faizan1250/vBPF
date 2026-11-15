import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { apiRepoRoot, resolveRepoPath } from "./paths.js";

describe("repo-root path anchoring (D-99)", () => {
  it("resolves the api module back to the repo root", () => {
    expect(existsSync(join(apiRepoRoot(), "api", "package.json"))).toBe(true);
  });

  it("leaves absolute paths untouched", () => {
    expect(resolveRepoPath("/tmp/tok", "/repo")).toBe("/tmp/tok");
    expect(resolveRepoPath("", "/repo")).toBe("");
  });

  it("passes in-memory database identifiers through", () => {
    expect(resolveRepoPath(":memory:", "/repo")).toBe(":memory:");
    expect(resolveRepoPath("file::memory:?cache=shared", "/repo")).toBe(
      "file::memory:?cache=shared",
    );
  });

  it("anchors relative paths to the root, never cwd", () => {
    expect(resolveRepoPath("./run/agent.token", "/repo")).toBe(
      resolve("/repo", "run", "agent.token"),
    );
    expect(resolveRepoPath("run/api.sqlite3", "/repo")).toBe(
      resolve("/repo", "run", "api.sqlite3"),
    );
  });
});
