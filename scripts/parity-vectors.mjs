/* global console, process */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const vectorsPath = join(root, "packages", "schemas", "validator-vectors.json");
const goTest = join(
  root,
  "agent",
  "internal",
  "server",
  "validator_vectors_test.go",
);
const tsTest = join(root, "api", "src", "validator-vectors.test.ts");

const CODES = new Set([
  "CATALOG_UNAVAILABLE",
  "VALIDATION_FAILED",
  "PROBE_NOT_FOUND",
  "LIMIT_EXCEEDED",
  "BLOCKED_CALL",
  "UNKNOWN_CALL",
]);

const fail = (msg) => {
  console.error(`parity gate: ${msg}`);
  process.exit(1);
};

let vectors;
try {
  vectors = JSON.parse(readFileSync(vectorsPath, "utf8"));
} catch (err) {
  fail(`cannot parse ${vectorsPath}: ${err.message}`);
}
if (!Array.isArray(vectors) || vectors.length < 50) {
  fail(`expected >= 50 vectors, got ${vectors?.length ?? "none"}`);
}
const ids = new Set();
for (const v of vectors) {
  if (typeof v?.id !== "string" || !/^[a-z0-9-]+$/.test(v.id))
    fail(`bad id: ${v?.id}`);
  if (ids.has(v.id)) fail(`duplicate id: ${v.id}`);
  ids.add(v.id);
  if (v.catalog !== "enforce" && v.catalog !== "skip")
    fail(`bad catalog in ${v.id}`);
  if (v.known !== undefined && !Array.isArray(v.known))
    fail(`bad known in ${v.id}`);
  if (typeof v.script !== "string") fail(`bad script in ${v.id}`);
  if (
    typeof v.expect?.ok !== "boolean" ||
    !Array.isArray(v.expect?.error_codes)
  ) {
    fail(`bad expect in ${v.id}`);
  }
  for (const c of v.expect.error_codes) {
    if (!CODES.has(c)) fail(`unknown code ${c} in ${v.id}`);
  }
  if (
    v.expect.ok
      ? v.expect.error_codes.length !== 0
      : v.expect.error_codes.length !== 1
  ) {
    fail(`error_codes must be [] when ok and [code] when rejecting: ${v.id}`);
  }
}

// Both suites must consume the same file with no per-side skips: any vector
// in the file is executed by both sides by construction.
for (const [path, label] of [
  [goTest, "Go"],
  [tsTest, "TS"],
]) {
  let src;
  try {
    src = readFileSync(path, "utf8");
  } catch {
    fail(`${label} vectors test missing: ${path}`);
  }
  if (!src.includes("validator-vectors.json"))
    fail(`${label} test does not load the shared vectors file`);
  if (/\bt\.Skip\b|\.skip\(|it\.skip\b|describe\.skip\b/.test(src)) {
    fail(`${label} vectors test contains a skip marker`);
  }
}

console.log(
  `parity gate: ${vectors.length} vectors wired in Go + TS, no skips`,
);
