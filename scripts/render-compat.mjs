/* global console, process */
// Renders docs/compat.md and the README platform table from
// compat/*.json (see I-12). Pure node, no dependencies.
// Usage: node scripts/render-compat.mjs [--check]
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const compatDir = join(root, "compat");
const docsPath = join(root, "docs", "compat.md");
const readmePath = join(root, "README.md");

const BEGIN = "<!-- compat:begin -->";
const END = "<!-- compat:end -->";

const STATUSES = new Set(["verified", "unverified", "not-run"]);
const RECIPE_STATUSES = new Set([
  "available",
  "fallback",
  "unavailable",
  "not-checked",
]);
const ENV_RE = /^[a-z0-9][a-z0-9+._-]*$/;
const DATE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const REPORT_KEYS = new Set([
  "env",
  "status",
  "kernel",
  "distro",
  "bpftrace_version",
  "btf",
  "recorded_at",
  "recipes",
  "tests",
  "notes",
]);

const fail = (msg) => {
  console.error(`compat gate: ${msg}`);
  process.exit(1);
};

function checkStr(value, min, max, label) {
  return (
    typeof value === "string" &&
    value.length >= min &&
    value.length <= max &&
    label.test(value)
  );
}

// Minimal mirror of compat/schema.json (kept dependency-free so the matrix
// workflow needs no JS install). The zod mirror in @vbpf/schemas must match.
export function validateReport(raw, file) {
  const err = (msg) => `${file}: ${msg}`;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(err("top level must be a mapping"));
  }
  for (const key of Object.keys(raw)) {
    if (!REPORT_KEYS.has(key)) throw new Error(err(`unknown key ${key}`));
  }
  for (const key of [
    "env",
    "status",
    "kernel",
    "distro",
    "bpftrace_version",
    "recipes",
    "tests",
    "notes",
  ]) {
    if (!(key in raw)) throw new Error(err(`missing ${key}`));
  }
  if (!checkStr(raw.env, 1, 128, ENV_RE))
    throw new Error(err("bad env (kebab/lowercase filename key)"));
  if (!STATUSES.has(raw.status)) throw new Error(err("bad status"));
  if (!checkStr(raw.kernel, 1, 256, /^[\s\S]+$/))
    throw new Error(err("bad kernel"));
  if (!checkStr(raw.distro, 1, 256, /^[\s\S]+$/))
    throw new Error(err("bad distro"));
  if (!checkStr(raw.bpftrace_version, 1, 64, /^[\s\S]+$/))
    throw new Error(err("bad bpftrace_version"));
  if (typeof raw.btf !== "boolean") throw new Error(err("bad btf"));
  if (raw.recorded_at !== undefined && !DATE_RE.test(raw.recorded_at)) {
    throw new Error(err("bad recorded_at (want YYYY-MM-DD)"));
  }
  if (
    typeof raw.recipes !== "object" ||
    raw.recipes === null ||
    Array.isArray(raw.recipes) ||
    Object.keys(raw.recipes).length < 1
  ) {
    throw new Error(err("recipes must cover at least one recipe"));
  }
  for (const [id, state] of Object.entries(raw.recipes)) {
    if (!RECIPE_STATUSES.has(state)) {
      throw new Error(err(`bad recipe state for ${id}`));
    }
  }
  if (
    typeof raw.tests !== "object" ||
    raw.tests === null ||
    Array.isArray(raw.tests) ||
    !Array.isArray(raw.tests.passed) ||
    !Array.isArray(raw.tests.failed)
  ) {
    throw new Error(err("tests must hold passed/failed lists"));
  }
  for (const list of [raw.tests.passed, raw.tests.failed]) {
    for (const entry of list) {
      if (!checkStr(entry, 1, 256, /^[\s\S]+$/)) {
        throw new Error(err("bad tests entry"));
      }
    }
  }
  if (typeof raw.notes !== "string" || raw.notes.length > 2048) {
    throw new Error(err("bad notes"));
  }
  if (basename(file, ".json") !== raw.env) {
    throw new Error(err(`env ${raw.env} != filename`));
  }
  return raw;
}

export function loadReports(dir = compatDir) {
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch (err) {
    throw new Error(`cannot read ${dir}: ${err.message}`);
  }
  const reports = [];
  for (const file of files) {
    if (file === "schema.json") continue;
    const path = join(dir, file);
    let raw;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      throw new Error(`${file}: cannot parse: ${err.message}`);
    }
    reports.push(validateReport(raw, file));
  }
  reports.sort((a, b) => (a.env < b.env ? -1 : a.env > b.env ? 1 : 0));
  return reports;
}

export function statusCell(report) {
  if (report.status === "verified") {
    return report.recorded_at ? `Verified ${report.recorded_at}` : "Verified";
  }
  if (report.status === "unverified") return "Unverified (workflow added)";
  return "Not run";
}

function recipeIds(reports) {
  const ids = new Set();
  for (const r of reports) {
    for (const id of Object.keys(r.recipes)) ids.add(id);
  }
  return [...ids].sort();
}

export function renderReadmeSection(reports) {
  const lines = [
    "| Environment | Kernel | Status |",
    "| ----------- | ------ | ------ |",
  ];
  for (const r of reports) {
    lines.push(`| \`${r.env}\` | \`${r.kernel}\` | ${statusCell(r)} |`);
  }
  lines.push(
    "",
    "Per-recipe availability and full notes: [`docs/compat.md`](docs/compat.md).",
    "This table is generated from `compat/*.json` by `scripts/render-compat.mjs`; statuses stay honest — nothing is marked verified without a recorded run.",
  );
  return lines.join("\n");
}

export function renderCompatMd(reports) {
  const ids = recipeIds(reports);
  const lines = [
    "# Compatibility matrix",
    "",
    "<!-- Generated by scripts/render-compat.mjs from compat/*.json. Do not edit by hand. -->",
    "",
    "Hosted-runner kernels may lack BTF or some tracepoints; that is recorded",
    "as a finding below, not a failure. Until a matrix job has run green on an",
    "environment, its row stays unverified.",
    "",
    "| Environment | Kernel | Distro | bpftrace | BTF | Status |",
    "| ----------- | ------ | ------ | -------- | --- | ------ |",
  ];
  for (const r of reports) {
    lines.push(
      `| \`${r.env}\` | \`${r.kernel}\` | ${r.distro} | \`${r.bpftrace_version}\` | ${r.btf ? "yes" : "no"} | ${statusCell(r)} |`,
    );
  }
  lines.push("", "## Recipe availability", "");
  lines.push(`| Recipe | ${reports.map((r) => `\`${r.env}\``).join(" | ")} |`);
  lines.push(`| ------ | ${reports.map(() => "---").join(" | ")} |`);
  for (const id of ids) {
    lines.push(
      `| \`${id}\` | ${reports.map((r) => r.recipes[id] ?? "not-checked").join(" | ")} |`,
    );
  }
  lines.push("", "## Per-environment detail", "");
  for (const r of reports) {
    lines.push(`### \`${r.env}\``, "");
    lines.push(`- Status: ${statusCell(r)}`);
    if (r.recorded_at) lines.push(`- Recorded: ${r.recorded_at}`);
    lines.push(`- Tests passed: ${r.tests.passed.length ? "" : "none"}`);
    for (const t of r.tests.passed) lines.push(`  - ${t}`);
    lines.push(`- Tests failed: ${r.tests.failed.length ? "" : "none"}`);
    for (const t of r.tests.failed) lines.push(`  - ${t}`);
    lines.push(`- Notes: ${r.notes}`, "");
  }
  return lines.join("\n") + "\n";
}

export function updateReadme(readme, section) {
  const begin = readme.indexOf(BEGIN);
  const end = readme.indexOf(END);
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error("README compat markers missing or out of order");
  }
  return (
    readme.slice(0, begin + BEGIN.length) +
    "\n" +
    section +
    "\n" +
    readme.slice(end)
  );
}

function main() {
  const check = process.argv.includes("--check");
  let reports;
  try {
    reports = loadReports();
  } catch (err) {
    fail(err.message);
  }
  if (reports.length === 0) fail("no compat/*.json reports found");
  const compatMd = renderCompatMd(reports);
  const section = renderReadmeSection(reports);
  let readme;
  try {
    readme = readFileSync(readmePath, "utf8");
  } catch (err) {
    fail(`cannot read README: ${err.message}`);
  }
  let next;
  try {
    next = updateReadme(readme, section);
  } catch (err) {
    fail(err.message);
  }
  if (check) {
    let current = "";
    try {
      current = readFileSync(docsPath, "utf8");
    } catch {
      fail("docs/compat.md missing; run render-compat.mjs");
    }
    if (current !== compatMd)
      fail("docs/compat.md stale; run render-compat.mjs");
    if (readme !== next)
      fail("README compat table stale; run render-compat.mjs");
    console.log(`compat gate: ${reports.length} reports fresh`);
    return;
  }
  writeFileSync(docsPath, compatMd);
  writeFileSync(readmePath, next);
  console.log(
    `compat gate: wrote docs/compat.md + README (${reports.length} reports)`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
