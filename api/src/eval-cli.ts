import { mkdirSync, writeFileSync } from "node:fs";
import { platform, release } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadDotenv } from "dotenv";

import {
  FAKE_EVAL_PROBES,
  assertCallBudget,
  assertDailyBudget,
  checkAgentPreflight,
  coreSubset,
  DEFAULT_REPEAT,
  loadPrompts,
  parseEvalArgs,
  renderMarkdown,
  reportFileName,
  runEval,
  runEvalRepeat,
  summarize,
  writeScriptsNdjson,
} from "./eval.js";
import {
  fetchProbeArgs,
  runScriptAndCountEvents,
  searchProbes,
  validateScript,
} from "./agent-client.js";
import { closeDb } from "./db.js";
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
// Runner kernel label for non-agent modes (scripts never execute there).
const runner = `${platform()} ${release()} (runner)`;

if (!opts.live) {
  const entries = loadPrompts(opts.promptsPath);
  const selected = opts.coreOnly
    ? coreSubset(entries)
    : opts.limit === null
      ? entries
      : entries.slice(0, opts.limit);
  const repeat = opts.repeat ?? DEFAULT_REPEAT;
  if (repeat > 1) {
    const {
      rounds,
      repeat: stats,
      db,
    } = await runEvalRepeat(
      selected,
      {
        recipesDir,
        model: "mock",
        delayMs: opts.delayMs,
      },
      repeat,
    );
    closeDb(db);
    mkdirSync(reportsDir, { recursive: true });
    const first = rounds[0] ?? [];
    const summary =
      stats.round_summaries[stats.round_summaries.length - 1] ??
      summarize(first);
    const outPath =
      opts.outPath ??
      join(
        reportsDir,
        reportFileName(date, {
          live: false,
          agent: false,
          coreOnly: opts.coreOnly,
          repeat,
        }),
      );
    writeScriptsNdjson(outPath.replace(/\.md$/, "-scripts.ndjson"), first);
    writeFileSync(
      outPath,
      renderMarkdown(date, "mock", summary, first, "mock", {
        repeat: stats,
        runner,
      }),
    );
    process.stdout.write(`${JSON.stringify(summary)}\n${outPath}\n`);
  } else {
    const { cases, summary, db } = await runEval(selected, {
      recipesDir,
      model: "mock",
      delayMs: opts.delayMs,
    });
    closeDb(db);
    mkdirSync(reportsDir, { recursive: true });
    const outPath =
      opts.outPath ??
      join(
        reportsDir,
        reportFileName(date, {
          live: false,
          agent: false,
          coreOnly: opts.coreOnly,
          repeat,
        }),
      );
    writeScriptsNdjson(outPath.replace(/\.md$/, "-scripts.ndjson"), cases);
    writeFileSync(
      outPath,
      renderMarkdown(date, "mock", summary, cases, "mock", { runner }),
    );
    process.stdout.write(`${JSON.stringify(summary)}\n${outPath}\n`);
  }
} else if (!opts.agent) {
  const entries = loadPrompts(opts.promptsPath);
  const selected = opts.coreOnly
    ? coreSubset(entries)
    : opts.limit === null
      ? entries
      : entries.slice(0, opts.limit);
  const repeat = opts.repeat ?? DEFAULT_REPEAT;
  assertCallBudget(selected.length, repeat);
  if (!opts.coreOnly) assertDailyBudget(reportsDir, date, opts.force);
  const chain = new LiveLlmChain({ env: process.env });
  if (!chain.configured) {
    process.stderr.write(
      "eval --live: no live provider configured (set a provider key and model in the local .env, never CI)\n",
    );
    process.exit(1);
  }
  const runOpts = {
    recipesDir,
    model: chain.model,
    llmFactory: () => chain,
    searchProbesFn: async () => [...FAKE_EVAL_PROBES],
    validateAgentFn: async () => ({
      ok: true,
      errors: [],
      probes: [],
      warnings: [],
      probe_count: 0,
    }),
    // No agent on a stock runner: reuse the static fallback text.
    probeArgsFn: async () => "",
    delayMs: opts.delayMs,
  } as const;
  const name = reportFileName(date, {
    live: true,
    agent: false,
    coreOnly: opts.coreOnly,
    repeat,
  });
  if (repeat > 1) {
    const {
      rounds,
      repeat: stats,
      db,
    } = await runEvalRepeat(
      selected,
      {
        ...runOpts,
      },
      repeat,
    );
    const first = rounds[0] ?? [];
    const summary =
      stats.round_summaries[stats.round_summaries.length - 1] ??
      summarize(first);
    closeDb(db);
    mkdirSync(reportsDir, { recursive: true });
    const outPath = opts.outPath ?? join(reportsDir, name);
    writeScriptsNdjson(outPath.replace(/\.md$/, "-scripts.ndjson"), first);
    writeFileSync(
      outPath,
      renderMarkdown(date, chain.model, summary, first, "live", {
        repeat: stats,
        runner,
      }),
    );
    process.stdout.write(`${JSON.stringify(summary)}\n${outPath}\n`);
  } else {
    const { cases, summary, db } = await runEval(selected, runOpts);
    closeDb(db);
    mkdirSync(reportsDir, { recursive: true });
    const outPath = opts.outPath ?? join(reportsDir, name);
    writeScriptsNdjson(outPath.replace(/\.md$/, "-scripts.ndjson"), cases);
    writeFileSync(
      outPath,
      renderMarkdown(date, chain.model, summary, cases, "live", { runner }),
    );
    process.stdout.write(`${JSON.stringify(summary)}\n${outPath}\n`);
  }
} else {
  // Real mode: no stubs, no silent fallback. Preflight first.
  let health;
  try {
    health = await checkAgentPreflight(opts.agentUrl, opts.tokenFile);
  } catch (err) {
    process.stderr.write(
      `eval --live --agent: ${err instanceof Error ? err.message : "preflight failed"}\n`,
    );
    process.exit(1);
  }
  const entries = loadPrompts(opts.promptsPath);
  const selected = opts.coreOnly
    ? coreSubset(entries)
    : opts.limit === null
      ? entries
      : entries.slice(0, opts.limit);
  const repeat = opts.repeat ?? DEFAULT_REPEAT;
  assertCallBudget(selected.length, repeat);
  if (!opts.coreOnly) assertDailyBudget(reportsDir, date, opts.force);
  const chain = new LiveLlmChain({ env: process.env });
  if (!chain.configured) {
    process.stderr.write(
      "eval --live --agent: no live provider configured (set a provider key and model in the local .env, never CI)\n",
    );
    process.exit(1);
  }
  const runOpts = {
    recipesDir,
    model: chain.model,
    llmFactory: () => chain,
    agentMode: true,
    agentUrl: opts.agentUrl,
    tokenFile: opts.tokenFile,
    searchProbesFn: searchProbes,
    validateAgentFn: validateScript,
    probeArgsFn: fetchProbeArgs,
    runScriptFn: (agentUrl: string, tokenFile: string, script: string) =>
      runScriptAndCountEvents(agentUrl, tokenFile, script, 5),
    delayMs: opts.delayMs,
  } as const;
  const name = reportFileName(date, {
    live: true,
    agent: true,
    coreOnly: opts.coreOnly,
    repeat,
  });
  if (repeat > 1) {
    const {
      rounds,
      repeat: stats,
      db,
    } = await runEvalRepeat(
      selected,
      {
        ...runOpts,
      },
      repeat,
    );
    const first = rounds[0] ?? [];
    const summary =
      stats.round_summaries[stats.round_summaries.length - 1] ??
      summarize(first);
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
    closeDb(db);
    mkdirSync(reportsDir, { recursive: true });
    const outPath = opts.outPath ?? join(reportsDir, name);
    writeFileSync(
      outPath,
      renderMarkdown(date, modelLabel, summary, first, "live+agent", {
        kernel: health.kernel,
        bpftrace: health.bpftrace_version,
        repeat: stats,
      }),
    );
    writeScriptsNdjson(outPath.replace(/\.md$/, "-scripts.ndjson"), first);
    process.stdout.write(`${JSON.stringify(summary)}\n${outPath}\n`);
  } else {
    const { cases, summary, db } = await runEval(selected, runOpts);
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
    closeDb(db);
    mkdirSync(reportsDir, { recursive: true });
    const outPath = opts.outPath ?? join(reportsDir, name);
    writeFileSync(
      outPath,
      renderMarkdown(date, modelLabel, summary, cases, "live+agent", {
        kernel: health.kernel,
        bpftrace: health.bpftrace_version,
      }),
    );
    writeScriptsNdjson(outPath.replace(/\.md$/, "-scripts.ndjson"), cases);
    process.stdout.write(`${JSON.stringify(summary)}\n${outPath}\n`);
  }
}
