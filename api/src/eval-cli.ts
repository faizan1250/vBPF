import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadDotenv } from "dotenv";

import {
  FAKE_EVAL_PROBES,
  assertCallBudget,
  loadPrompts,
  parseEvalArgs,
  renderMarkdown,
  runEval,
} from "./eval.js";
import { LiveLlmChain } from "./live-llm.js";

const srcDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(srcDir, "..", "..");
const recipesDir = join(repoRoot, "recipes");
const reportsDir = join(repoRoot, "eval", "reports");

// Root .env holds local provider keys (gitignored, never committed).
// dotenv never overrides real environment values.
loadDotenv({ path: join(repoRoot, ".env") });

const opts = parseEvalArgs(process.argv.slice(2), repoRoot);
const date = new Date().toISOString().slice(0, 10);

if (!opts.live) {
  const entries = loadPrompts(opts.promptsPath);
  const selected = opts.limit === null ? entries : entries.slice(0, opts.limit);
  const { cases, summary, db } = await runEval(selected, {
    recipesDir,
    model: "mock",
    delayMs: opts.delayMs,
  });
  db.close();
  mkdirSync(reportsDir, { recursive: true });
  const outPath = opts.outPath ?? join(reportsDir, `${date}.md`);
  writeFileSync(outPath, renderMarkdown(date, "mock", summary, cases));
  process.stdout.write(`${JSON.stringify(summary)}\n${outPath}\n`);
} else {
  const entries = loadPrompts(opts.promptsPath);
  const selected = opts.limit === null ? entries : entries.slice(0, opts.limit);
  assertCallBudget(selected.length);
  const chain = new LiveLlmChain({ env: process.env });
  if (!chain.configured) {
    process.stderr.write(
      "eval --live: no live provider configured (set a provider key and model in the local .env, never CI)\n",
    );
    process.exit(1);
  }
  const { cases, summary, db } = await runEval(selected, {
    recipesDir,
    model: chain.model,
    llmFactory: () => chain,
    searchProbesFn: async () => [...FAKE_EVAL_PROBES],
    validateAgentFn: async () => ({ ok: true, errors: [], probes: [] }),
    // No agent on a stock runner: reuse the static fallback text.
    probeArgsFn: async () => "",
    delayMs: opts.delayMs,
  });
  let modelLabel = chain.model;
  try {
    const rows = db
      .prepare("SELECT DISTINCT model FROM generations")
      .all() as Array<{ model: string }>;
    const seen = [...new Set(rows.map((r) => r.model).filter(Boolean))];
    if (seen.length > 0) modelLabel = seen.join(", ");
  } catch {
    // Report label only; keep the chain attribution.
  }
  db.close();
  mkdirSync(reportsDir, { recursive: true });
  const outPath = opts.outPath ?? join(reportsDir, `${date}-live.md`);
  writeFileSync(
    outPath,
    renderMarkdown(date, modelLabel, summary, cases, "live"),
  );
  process.stdout.write(`${JSON.stringify(summary)}\n${outPath}\n`);
}
