import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Repo-root anchoring for file paths documented as repo-relative
// (AGENT_TOKEN_FILE, DATABASE_PATH, RECIPES_DIR).
//
// Footgun (D-35): the API runs with cwd=api/ under `pnpm -C api` (bare make,
// eval live targets), so a bare "./run/agent.token" resolved against cwd
// points at api/run/agent.token instead of <root>/run/agent.token and
// preflight fails with "agent token unreadable". Relative paths are
// therefore resolved against the repo root, never cwd; absolute paths
// (including explicit absolute overrides) pass through untouched.

export function apiRepoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function resolveRepoPath(pathValue: string, root: string): string {
  if (pathValue === "" || isAbsolute(pathValue)) return pathValue;
  // better-sqlite3 identifiers, not files: :memory: and file: URIs.
  if (pathValue === ":memory:" || pathValue.startsWith("file:")) {
    return pathValue;
  }
  return resolve(root, pathValue);
}
