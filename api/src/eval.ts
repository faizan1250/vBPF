import { readFileSync } from "node:fs";

import type Database from "better-sqlite3";
import yaml from "js-yaml";
import { z } from "zod";

import { indexRecipes, migrate, openDb } from "./db.js";
import {
  RefusalError,
  ValidationFailedError,
  makeMockLlm,
  runGenerate,
} from "./generate.js";
import { loadRecipes } from "./recipes.js";

export const EvalViewSchema = z.enum([
  "table",
  "bar",
  "histogram",
  "timeseries",
  "events",
]);

export const EvalPromptSchema = z
  .object({
    id: z.string().min(1).max(128),
    prompt: z.string().min(1).max(2000),
    expected_view: EvalViewSchema.nullable(),
    expected_probe_family: z.string().min(1).max(128).nullable(),
    must_refuse: z.boolean(),
    notes: z.string().max(2048).default(""),
  })
  .strict();

export const EvalPromptsSchema = z.array(EvalPromptSchema).min(1);

export type EvalPrompt = z.infer<typeof EvalPromptSchema>;

export function loadPrompts(path: string): EvalPrompt[] {
  const raw = readFileSync(path, "utf8");
  return EvalPromptsSchema.parse(yaml.load(raw));
}

// Category is the id prefix: direct- | paraphrased- | param- | novel- | adversarial-.
export function categoryFromId(id: string): string {
  return id.split("-")[0] ?? id;
}

// Rough token estimate for reporting only (mock has no real usage counts).
export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// Stock-runner safe probe catalog: mirrors the fake agent in generate.test.ts.
// No network, no root, no bpftrace.
export const FAKE_EVAL_PROBES = [
  "tracepoint:block:block_rq_issue",
  "tracepoint:block:block_rq_complete",
  "tracepoint:syscalls:sys_enter_openat",
  "tracepoint:sched:sched_process_exec",
  "tracepoint:sock:inet_sock_set_state",
  "tracepoint:tcp:tcp_retransmit_skb",
  "tracepoint:raw_syscalls:sys_enter",
  "profile:hz:99",
  "software:page-faults",
  "uprobe:libc:getaddrinfo",
  "BEGIN",
];

export interface EvalCaseResult {
  id: string;
  category: string;
  must_refuse: boolean;
  expected_view: string | null;
  expected_probe_family: string | null;
  refused: boolean;
  ok: boolean;
  attempts: number;
  chart_type: string | null;
  view_match: boolean | null;
  probe_match: boolean | null;
  refusal_correct: boolean;
  first_try: boolean;
  latency_ms: number;
  tokens_approx: number;
  errors: string[];
}

export interface EvalRunnerOptions {
  recipesDir: string;
  model?: string;
  db?: Database.Database;
  searchProbesFn?: (url: string, token: string, q: string) => Promise<string[]>;
  validateAgentFn?: (
    url: string,
    token: string,
    script: string,
  ) => Promise<{ ok: boolean; errors: string[]; probes: string[] }>;
}

export async function runEvalCase(
  db: Database.Database,
  entry: EvalPrompt,
  opts: EvalRunnerOptions,
): Promise<EvalCaseResult> {
  const llm = makeMockLlm(db, opts.recipesDir, opts.model ?? "mock");
  const started = Date.now();
  let refused = false;
  let ok = false;
  let attempts = 0;
  let chart: string | null = null;
  let script = "";
  let errors: string[] = [];
  try {
    const result = await runGenerate(entry.prompt, {
      deps: {
        db,
        recipesDir: opts.recipesDir,
        agentUrl: "http://127.0.0.1:1",
        tokenFile: "eval-mock.token",
        llm,
        searchProbesFn:
          opts.searchProbesFn ?? (async () => [...FAKE_EVAL_PROBES]),
        validateAgentFn:
          opts.validateAgentFn ??
          (async () => ({ ok: true, errors: [], probes: [] })),
      },
    });
    ok = true;
    attempts = result.validation.attempts;
    chart = result.chart_type;
    script = result.script;
  } catch (err) {
    if (err instanceof RefusalError) {
      refused = true;
      attempts = 1;
      errors = [err.refusal];
    } else if (err instanceof ValidationFailedError) {
      attempts = err.attempts;
      errors = err.errors;
    } else {
      errors = [err instanceof Error ? err.message : "unknown eval error"];
    }
  }
  const latency_ms = Date.now() - started;
  const view_match = ok ? chart === entry.expected_view : null;
  const probe_match =
    ok && entry.expected_probe_family !== null
      ? script.includes(entry.expected_probe_family)
      : null;
  return {
    id: entry.id,
    category: categoryFromId(entry.id),
    must_refuse: entry.must_refuse,
    expected_view: entry.expected_view,
    expected_probe_family: entry.expected_probe_family,
    refused,
    ok,
    attempts,
    chart_type: chart,
    view_match,
    probe_match,
    refusal_correct: refused === entry.must_refuse,
    first_try: ok && attempts === 1,
    latency_ms,
    tokens_approx: approxTokens(entry.prompt + script),
    errors,
  };
}

export interface EvalSummary {
  total: number;
  ok_within_retries: number;
  first_try_compile: number;
  produced_output: "SKIP";
  refusal_correct: number;
  refusal_total: number;
  view_match: number;
  view_match_denominator: number;
  probe_match: number;
  probe_match_denominator: number;
  latency_avg_ms: number;
  latency_p50_ms: number;
  tokens_approx_total: number;
  by_category: Record<
    string,
    { total: number; ok: number; refusal_correct: number; view_match: number }
  >;
}

export function summarize(cases: EvalCaseResult[]): EvalSummary {
  const lat = [...cases.map((c) => c.latency_ms)].sort((a, b) => a - b);
  const by_category: EvalSummary["by_category"] = {};
  for (const c of cases) {
    const row = (by_category[c.category] ??= {
      total: 0,
      ok: 0,
      refusal_correct: 0,
      view_match: 0,
    });
    row.total += 1;
    if (c.ok) row.ok += 1;
    if (c.refusal_correct) row.refusal_correct += 1;
    if (c.view_match === true) row.view_match += 1;
  }
  const viewDen = cases.filter((c) => c.view_match !== null);
  const probeDen = cases.filter((c) => c.probe_match !== null);
  return {
    total: cases.length,
    ok_within_retries: cases.filter((c) => c.ok).length,
    first_try_compile: cases.filter((c) => c.first_try).length,
    produced_output: "SKIP",
    refusal_correct: cases.filter((c) => c.refusal_correct).length,
    refusal_total: cases.length,
    view_match: cases.filter((c) => c.view_match === true).length,
    view_match_denominator: viewDen.length,
    probe_match: cases.filter((c) => c.probe_match === true).length,
    probe_match_denominator: probeDen.length,
    latency_avg_ms:
      cases.length === 0
        ? 0
        : Math.round(
            cases.reduce((n, c) => n + c.latency_ms, 0) / cases.length,
          ),
    latency_p50_ms:
      lat.length === 0 ? 0 : (lat[Math.floor(lat.length / 2)] ?? 0),
    tokens_approx_total: cases.reduce((n, c) => n + c.tokens_approx, 0),
    by_category,
  };
}

export async function runEval(
  entries: EvalPrompt[],
  opts: EvalRunnerOptions,
): Promise<{
  cases: EvalCaseResult[];
  summary: EvalSummary;
  db: Database.Database;
}> {
  const db = opts.db ?? openDb(":memory:");
  migrate(db);
  indexRecipes(db, loadRecipes(opts.recipesDir));
  const cases: EvalCaseResult[] = [];
  for (const entry of entries) {
    cases.push(await runEvalCase(db, entry, opts));
  }
  return { cases, summary: summarize(cases), db };
}

export function renderMarkdown(
  date: string,
  model: string,
  summary: EvalSummary,
  cases: EvalCaseResult[],
): string {
  const lines = [
    `# vBPF eval report - ${date}`,
    "",
    `Mode: mock-only (model=${model}). No secrets, no root, no bpftrace.`,
    "produced-output is SKIP in mock: scripts are compile-validated, never executed.",
    "tokens are approximate (chars/4); the mock LLM reports no usage.",
    "",
    "## Summary",
    "",
    "| metric | value |",
    "| --- | --- |",
    `| total cases | ${summary.total} |`,
    `| first-try compile | ${summary.first_try_compile} |`,
    `| within-retries (ok) | ${summary.ok_within_retries} |`,
    `| produced-output | SKIP (mock) |`,
    `| correct-refusal | ${summary.refusal_correct}/${summary.refusal_total} |`,
    `| view-match | ${summary.view_match}/${summary.view_match_denominator} |`,
    `| probe-match | ${summary.probe_match}/${summary.probe_match_denominator} |`,
    `| latency avg / p50 (ms) | ${summary.latency_avg_ms} / ${summary.latency_p50_ms} |`,
    `| tokens approx total | ${summary.tokens_approx_total} |`,
    "",
    "## By category",
    "",
    "| category | total | ok | refusal-correct | view-match |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const [cat, row] of Object.entries(summary.by_category).sort()) {
    lines.push(
      `| ${cat} | ${row.total} | ${row.ok} | ${row.refusal_correct} | ${row.view_match} |`,
    );
  }
  lines.push(
    "",
    "## Cases",
    "",
    "| id | refused | ok | attempts | view | probe | latency_ms | errors |",
  );
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const c of cases) {
    const view = c.view_match === null ? "n/a" : String(c.view_match);
    const probe = c.probe_match === null ? "n/a" : String(c.probe_match);
    const errs = c.errors.length === 0 ? "" : c.errors[0]?.slice(0, 80);
    lines.push(
      `| ${c.id} | ${c.refused} | ${c.ok} | ${c.attempts} | ${view} | ${probe} | ${c.latency_ms} | ${errs} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}
