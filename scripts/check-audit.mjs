#!/usr/bin/env node
/* global console, process */
// JS audit gate (I-15): fails on high/critical findings unless each one is
// covered by an unexpired .github/audit-allowlist.json entry carrying a
// reason and an expiry date. Moderate/low findings are reported, not fatal.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ALLOW_PATH = ".github/audit-allowlist.json";
const SEVERITIES = new Set(["high", "critical"]);

function loadAdvisories() {
  let raw;
  try {
    raw = execFileSync("pnpm", ["audit", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    // pnpm exits non-zero when findings exist; the JSON is still on stdout.
    raw = e.stdout ?? "";
  }
  if (!raw.trim()) return {};
  return JSON.parse(raw).advisories ?? {};
}

function loadAllowlist() {
  const allow = JSON.parse(readFileSync(ALLOW_PATH, "utf8"));
  if (!Array.isArray(allow.entries))
    throw new Error(`${ALLOW_PATH}: entries must be an array`);
  const today = new Date().toISOString().slice(0, 10);
  for (const e of allow.entries) {
    if (!e.advisory || !e.reason || !e.expires) {
      throw new Error(
        `${ALLOW_PATH}: entry needs advisory, reason, expires: ${JSON.stringify(e)}`,
      );
    }
    if (e.expires < today)
      throw new Error(`${ALLOW_PATH}: expired entry for ${e.advisory}`);
  }
  return new Map(allow.entries.map((e) => [String(e.advisory), e]));
}

const advisories = loadAdvisories();
const allowlist = loadAllowlist();
const blocking = Object.values(advisories).filter((a) =>
  SEVERITIES.has(a.severity),
);
const uncovered = blocking.filter(
  (a) =>
    !allowlist.has(String(a.id)) &&
    ![a.url, a.title].some((k) => k && allowlist.has(String(k))),
);

for (const a of Object.values(advisories)) {
  if (!SEVERITIES.has(a.severity)) {
    console.log(`audit: note: ${a.severity} ${a.id ?? a.title ?? a.url}`);
  }
}
for (const a of blocking) {
  if (!uncovered.includes(a))
    console.log(
      `audit: waived: ${a.severity} ${a.id} (${allowlist.get(String(a.id))?.expires})`,
    );
}
if (uncovered.length > 0) {
  for (const a of uncovered) {
    console.error(
      `audit: FAIL: uncovered ${a.severity} finding ${a.id ?? ""} ${a.title ?? ""} ${a.url ?? ""}`.trim(),
    );
  }
  process.exit(1);
}
console.log(
  `audit: ok: ${blocking.length} high/critical finding(s), all covered`,
);
