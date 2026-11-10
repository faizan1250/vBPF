import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import type Database from "better-sqlite3";
import yaml from "js-yaml";
import { z } from "zod";

import {
  fetchAgentHealth,
  type AgentHealth,
  type ValidateResponse,
} from "./agent-client.js";
import { indexRecipes, migrate, openDb } from "./db.js";
import {
  RefusalError,
  ValidationFailedError,
  makeMockLlm,
  runGenerate,
} from "./generate.js";
import type {
  LlmClient,
  LlmDetailedResult,
  LlmFeedback,
  LlmOutput,
  LlmUsage,
} from "./llm.js";
import { loadRecipes } from "./recipes.js";
import type { PromptParts } from "./prompts.js";
import { staticValidate } from "./validator.js";

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

export type ProducedStatus = "produced" | "no-events" | "skipped" | "error";

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
  usage?: LlmUsage;
  errors: string[];
  // R2-01 stage A: static validation vs real agent dry-run, tracked per
  // attempt via spies (the retry loop lives in runGenerate).
  static_ok_first_try: boolean;
  static_ok: boolean;
  agent_ok_first_try: boolean;
  agent_ok: boolean;
  script: string;
  provider_model: string;
  produced_events: number | null;
  produced_status: ProducedStatus;
  notes: string;
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
  ) => Promise<ValidateResponse>;
  probeArgsFn?: (url: string, token: string, probe: string) => Promise<string>;
  // Live chains share one LLM chain across cases; tests inject a stub here.
  // Defaults to the deterministic mock echoing the top-1 recipe.
  llmFactory?: (db: Database.Database) => LlmClient;
  // Courtesy pause between cases (ms), for live free-tier budgets.
  delayMs?: number;
  // R2-01 stage A real mode. When true the caller must supply the real
  // search/validate/probe-args functions (no stub fallback) plus the agent
  // endpoint the GenerateDeps and produced-output runs use.
  agentMode?: boolean;
  agentUrl?: string;
  tokenFile?: string;
  // Runs a validated script for 5 s and counts data events. Injected in
  // tests; the CLI wires the real agent run API. Absent means skipped.
  runScriptFn?: (
    agentUrl: string,
    tokenFile: string,
    script: string,
  ) => Promise<{ events: number }>;
}

// One live eval of 30 prompts costs at most 90 LLM calls (3 attempts each).
export const LIVE_CALL_BUDGET = 90;
export const MAX_ATTEMPTS = 3;

export function assertCallBudget(caseCount: number): void {
  if (caseCount * MAX_ATTEMPTS > LIVE_CALL_BUDGET) {
    throw new Error(
      `eval selection too large: ${caseCount} cases * ${MAX_ATTEMPTS} attempts exceeds the ${LIVE_CALL_BUDGET}-call budget (use --limit)`,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runEvalCase(
  db: Database.Database,
  entry: EvalPrompt,
  opts: EvalRunnerOptions,
): Promise<EvalCaseResult> {
  if (opts.agentMode) {
    if (
      opts.searchProbesFn === undefined ||
      opts.validateAgentFn === undefined ||
      opts.probeArgsFn === undefined
    ) {
      throw new Error(
        "agent mode requires real search/validate/probe-args functions (no stub fallback)",
      );
    }
    if (opts.agentUrl === undefined || opts.tokenFile === undefined) {
      throw new Error("agent mode requires agentUrl and tokenFile");
    }
  }
  const agentUrl = opts.agentUrl ?? "http://127.0.0.1:1";
  const tokenFile = opts.tokenFile ?? "eval-mock.token";
  const rawLlm =
    opts.llmFactory?.(db) ??
    makeMockLlm(db, opts.recipesDir, opts.model ?? "mock");
  // Spy per-attempt scripts and static outcomes; the retry loop itself stays
  // in runGenerate. Static is re-checked here with the same default args
  // runGenerate uses, so mock/stub paths are unaffected.
  const attemptScripts: string[] = [];
  const attemptStaticOk: boolean[] = [];
  const agentOutcomes: boolean[] = [];
  let providerModel = rawLlm.model;
  const recordScript = (out: LlmOutput): void => {
    attemptScripts.push(out.script);
    attemptStaticOk.push(
      staticValidate(out.script, { catalog: { mode: "skip" } }).errors
        .length === 0,
    );
  };
  const detailed = (
    rawLlm as LlmClient & {
      generateDetailed?: (
        prompt: string,
        feedback?: LlmFeedback,
        reqOpts?: { signal?: AbortSignal; parts?: PromptParts },
      ) => Promise<LlmDetailedResult>;
    }
  ).generateDetailed;
  const llm: LlmClient & {
    generateDetailed?: (
      prompt: string,
      feedback?: LlmFeedback,
      reqOpts?: { signal?: AbortSignal; parts?: PromptParts },
    ) => Promise<LlmDetailedResult>;
  } =
    typeof detailed === "function"
      ? {
          model: rawLlm.model,
          generate: (prompt, feedback, parts) =>
            rawLlm.generate(prompt, feedback, parts),
          generateDetailed: async (prompt, feedback, reqOpts) => {
            const result = await detailed.call(rawLlm, prompt, feedback, {
              ...(reqOpts?.signal !== undefined
                ? { signal: reqOpts.signal }
                : {}),
              ...(reqOpts?.parts !== undefined ? { parts: reqOpts.parts } : {}),
            });
            providerModel = result.model;
            recordScript(result.output);
            return result;
          },
        }
      : {
          model: rawLlm.model,
          generate: async (prompt, feedback, parts) => {
            const out = await rawLlm.generate(prompt, feedback, parts);
            recordScript(out);
            return out;
          },
        };
  const validateAgentFn =
    opts.validateAgentFn ??
    (async (): Promise<ValidateResponse> => ({
      ok: true,
      errors: [],
      probes: [],
      warnings: [],
      probe_count: 0,
    }));
  const validateSpy = async (
    url: string,
    token: string,
    script: string,
  ): Promise<ValidateResponse> => {
    const res = await validateAgentFn(url, token, script);
    agentOutcomes.push(res.ok);
    return res;
  };
  const started = Date.now();
  let refused = false;
  let ok = false;
  let attempts = 0;
  let chart: string | null = null;
  let script = "";
  let errors: string[] = [];
  // Real provider usage summed across attempts; absent for mock/stub LLMs.
  let realPrompt = 0;
  let realCompletion = 0;
  let hasRealPrompt = false;
  let hasRealCompletion = false;
  try {
    const result = await runGenerate(entry.prompt, {
      deps: {
        db,
        recipesDir: opts.recipesDir,
        agentUrl,
        tokenFile,
        llm,
        searchProbesFn:
          opts.searchProbesFn ?? (async () => [...FAKE_EVAL_PROBES]),
        validateAgentFn: validateSpy,
        ...(opts.probeArgsFn === undefined
          ? {}
          : { probeArgsFn: opts.probeArgsFn }),
      },
      onUsage: (usage) => {
        if (typeof usage.prompt_tokens === "number") {
          hasRealPrompt = true;
          realPrompt += usage.prompt_tokens;
        }
        if (typeof usage.completion_tokens === "number") {
          hasRealCompletion = true;
          realCompletion += usage.completion_tokens;
        }
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
    if (!refused && attemptScripts.length > 0) {
      script = attemptScripts[attemptScripts.length - 1] ?? "";
    }
  }
  const latency_ms = Date.now() - started;
  const static_ok_first_try = (attemptStaticOk[0] ?? false) === true;
  const static_ok = attemptStaticOk.some((v) => v);
  const agent_ok_first_try =
    static_ok_first_try && (agentOutcomes[0] ?? false) === true;
  const agent_ok = agentOutcomes.some((v) => v);
  // Produced output: only validated non-refusal scripts, never must_refuse
  // cases, one 5 s run each (sequential; caller paces cases with delayMs).
  let produced_events: number | null = null;
  let produced_status: ProducedStatus = "skipped";
  let notes = "";
  if (ok && entry.must_refuse) {
    notes =
      "ACCEPTED-UNSAFE-CASE: must_refuse case produced a script accepted by both validators; not executed.";
  } else if (ok && opts.runScriptFn !== undefined) {
    try {
      const run = await opts.runScriptFn(agentUrl, tokenFile, script);
      produced_events = run.events;
      if (run.events > 0) {
        produced_status = "produced";
      } else {
        produced_status = "no-events";
        notes =
          "no data events in the 5 s window; likely a low-traffic probe or a threshold (e.g. 10 ms block-IO filter) with no matching activity.";
      }
    } catch (err) {
      produced_status = "error";
      notes = err instanceof Error ? err.message.slice(0, 200) : "run failed";
    }
  }
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
    ...(hasRealPrompt || hasRealCompletion
      ? {
          usage: {
            ...(hasRealPrompt ? { prompt_tokens: realPrompt } : {}),
            ...(hasRealCompletion ? { completion_tokens: realCompletion } : {}),
          },
        }
      : {}),
    errors,
    static_ok_first_try,
    static_ok,
    agent_ok_first_try,
    agent_ok,
    script,
    provider_model: providerModel,
    produced_events,
    produced_status,
    notes,
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
  tokens_real_total: number;
  // R2-01 stage A: static vs agent dry-run pass counts plus produced output
  // over generated (validated) scripts.
  static_first_try: number;
  static_within_retries: number;
  agent_first_try: number;
  agent_within_retries: number;
  produced_pass: number;
  produced_denominator: number;
  produced_errors: number;
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
  const validated = cases.filter((c) => c.ok);
  return {
    total: cases.length,
    ok_within_retries: validated.length,
    first_try_compile: cases.filter((c) => c.first_try).length,
    produced_output: "SKIP",
    refusal_correct: cases.filter((c) => c.refusal_correct).length,
    refusal_total: cases.length,
    view_match: cases.filter((c) => c.view_match === true).length,
    view_match_denominator: viewDen.length,
    probe_match: cases.filter((c) => c.probe_match === true).length,
    probe_match_denominator: probeDen.length,
    static_first_try: cases.filter((c) => c.static_ok_first_try === true)
      .length,
    static_within_retries: cases.filter((c) => c.static_ok === true).length,
    agent_first_try: cases.filter((c) => c.agent_ok_first_try === true).length,
    agent_within_retries: cases.filter((c) => c.agent_ok === true).length,
    produced_pass: cases.filter((c) => c.produced_status === "produced").length,
    produced_denominator: validated.length,
    produced_errors: cases.filter((c) => c.produced_status === "error").length,
    latency_avg_ms:
      cases.length === 0
        ? 0
        : Math.round(
            cases.reduce((n, c) => n + c.latency_ms, 0) / cases.length,
          ),
    latency_p50_ms:
      lat.length === 0 ? 0 : (lat[Math.floor(lat.length / 2)] ?? 0),
    tokens_approx_total: cases.reduce((n, c) => n + c.tokens_approx, 0),
    tokens_real_total: cases.reduce(
      (n, c) =>
        n + (c.usage?.prompt_tokens ?? 0) + (c.usage?.completion_tokens ?? 0),
      0,
    ),
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
    if (opts.delayMs !== undefined && opts.delayMs > 0) {
      await sleep(opts.delayMs);
    }
  }
  return { cases, summary: summarize(cases), db };
}

export interface EvalCliOptions {
  promptsPath: string;
  outPath: string | null;
  live: boolean;
  limit: number | null;
  delayMs: number;
  agent: boolean;
  agentUrl: string;
  tokenFile: string;
}

function positiveInt(raw: string | undefined, flag: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${flag} needs a positive integer`);
  }
  return value;
}

function nonNegativeInt(raw: string | undefined, flag: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${flag} needs a non-negative integer`);
  }
  return value;
}

// CLI flags for the eval runner. The first positional arg stays the prompts
// file for backward compatibility with `pnpm run eval <path>`.
export function parseEvalArgs(
  argv: string[],
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): EvalCliOptions {
  let promptsPath = join(root, "eval", "prompts.yaml");
  let outPath: string | null = null;
  let live = false;
  let limit: number | null = null;
  let delayMs = 0;
  let agent = false;
  let agentUrl: string | null = null;
  let tokenFile: string | null = null;
  const rest = [...argv];
  while (rest.length > 0) {
    const arg = rest.shift() as string;
    if (arg === "--live") {
      live = true;
    } else if (arg === "--agent") {
      agent = true;
    } else if (arg === "--agent-url") {
      const raw = rest.shift();
      if (raw === undefined || raw === "")
        throw new Error("--agent-url needs a value");
      agentUrl = raw;
    } else if (arg === "--token-file") {
      const raw = rest.shift();
      if (raw === undefined || raw === "")
        throw new Error("--token-file needs a value");
      tokenFile = raw;
    } else if (arg === "--limit") {
      limit = positiveInt(rest.shift(), "--limit");
    } else if (arg === "--delay-ms") {
      delayMs = nonNegativeInt(rest.shift(), "--delay-ms");
    } else if (arg === "--out") {
      const raw = rest.shift();
      if (raw === undefined || raw === "")
        throw new Error("--out needs a path");
      outPath = isAbsolute(raw) ? raw : resolve(root, raw);
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown flag ${arg}`);
    } else {
      promptsPath = isAbsolute(arg) ? arg : resolve(root, arg);
    }
  }
  if (agent && !live) {
    throw new Error("--agent needs --live");
  }
  // Courtesy delay for live free-tier budgets; mock stays instant.
  if (live && delayMs === 0) delayMs = 2000;
  return {
    promptsPath,
    outPath,
    live,
    limit,
    delayMs,
    agent,
    agentUrl: agentUrl ?? env["AGENT_URL"] ?? "http://127.0.0.1:8787",
    tokenFile:
      tokenFile ??
      env["AGENT_TOKEN_FILE"] ??
      env["TOKEN_FILE"] ??
      "./run/agent.token",
  };
}

// Real-mode preflight: the agent must be reachable, running as root, and
// have BTF. Anything else is a hard non-zero failure with no stub fallback.
export async function checkAgentPreflight(
  agentUrl: string,
  tokenFile: string,
  fetchHealth: (
    base: string,
    token: string,
  ) => Promise<AgentHealth> = fetchAgentHealth,
): Promise<AgentHealth> {
  let health: AgentHealth;
  try {
    health = await fetchHealth(agentUrl, tokenFile);
  } catch (err) {
    throw new Error(
      `agent preflight failed: agent unreachable at ${agentUrl} (${err instanceof Error ? err.message : "unknown error"}); not falling back to stubs`,
    );
  }
  if (!health.root) {
    throw new Error(
      `agent preflight failed: agent at ${agentUrl} is not running as root; not falling back to stubs`,
    );
  }
  if (!health.btf) {
    throw new Error(
      `agent preflight failed: agent at ${agentUrl} reports btf: false; not falling back to stubs`,
    );
  }
  if (!health.ready) {
    const detail =
      health.catalog.last_error !== undefined
        ? ` (state=${health.catalog.state}, error=${health.catalog.last_error})`
        : ` (state=${health.catalog.state})`;
    throw new Error(
      `agent preflight failed: agent at ${agentUrl} reports ready: false${detail}; not falling back to stubs`,
    );
  }
  return health;
}

// Generated scripts only, one JSON object per line. Field `prompt` is the
// eval prompt ID, not user data. Never includes tokens or keys.
export interface EvalScriptRecord {
  id: string;
  prompt: string;
  script: string;
  chart_type: string | null;
  attempts: number;
  provider_model: string;
  produced_status: ProducedStatus;
}

export function toScriptRecords(cases: EvalCaseResult[]): EvalScriptRecord[] {
  return cases
    .filter((c) => c.ok && c.script !== "")
    .map((c) => ({
      id: c.id,
      prompt: c.id,
      script: c.script,
      chart_type: c.chart_type,
      attempts: c.attempts,
      provider_model: c.provider_model,
      produced_status: c.produced_status,
    }));
}

export function writeScriptsNdjson(
  path: string,
  cases: EvalCaseResult[],
): void {
  const lines = toScriptRecords(cases).map((r) => JSON.stringify(r));
  writeFileSync(path, lines.length > 0 ? `${lines.join("\n")}\n` : "");
}

export type EvalReportMode = "mock" | "live" | "live+agent";

export interface EvalReportExtra {
  kernel?: string;
  bpftrace?: string;
}

export function renderMarkdown(
  date: string,
  model: string,
  summary: EvalSummary,
  cases: EvalCaseResult[],
  mode: EvalReportMode = "mock",
  extra: EvalReportExtra = {},
): string {
  const staticOnly = mode !== "live+agent";
  const modeLine =
    mode === "live+agent"
      ? `Mode: live+agent (model=${model}${extra.kernel !== undefined ? `, kernel=${extra.kernel}` : ""}${extra.bpftrace !== undefined ? `, bpftrace=${extra.bpftrace}` : ""}). Real agent dry-run compile; generated scripts executed 5 s each.`
      : mode === "live"
        ? `Mode: live static-only (model=${model}). Agent validation stubbed (stock runner, no root): compile = static validator only; static-only; scripts never compiled or executed.`
        : `Mode: mock-only (model=${model}). No secrets, no root, no bpftrace; static-only; scripts never compiled or executed.`;
  const producedLine =
    mode === "live+agent"
      ? "produced-output: generated scripts that produced at least one data event (printf/map/hist/lhist) in 5 s agent runs / scripts that passed validation."
      : "produced-output is SKIP: scripts are compile-validated, never executed.";
  const tokensLine =
    "tokens are real usage when the provider reports it, else approximate (chars/4).";
  const lines = [
    `# vBPF eval report - ${date}`,
    "",
    modeLine,
    producedLine,
    tokensLine,
    "",
    "## Summary",
    "",
    "| metric | value |",
    "| --- | --- |",
    `| total cases | ${summary.total} |`,
    ...(staticOnly
      ? [
          `| passes static validation (first try) | ${summary.static_first_try} |`,
          `| passes static validation (within retries) | ${summary.static_within_retries} |`,
        ]
      : [
          `| passes static validation (first try) | ${summary.static_first_try} |`,
          `| passes static validation (within retries) | ${summary.static_within_retries} |`,
          `| dry-run compile pass (first try) | ${summary.agent_first_try} |`,
          `| dry-run compile pass (within retries) | ${summary.agent_within_retries} |`,
          `| produced-output (generated) | ${summary.produced_pass}/${summary.produced_denominator} |`,
        ]),
    `| produced-output | ${mode === "live+agent" ? `${summary.produced_pass}/${summary.produced_denominator} generated` : `SKIP (${mode})`} |`,
    `| correct-refusal | ${summary.refusal_correct}/${summary.refusal_total} |`,
    `| view-match | ${summary.view_match}/${summary.view_match_denominator} |`,
    `| probe-match${mode === "live+agent" ? " (real catalog)" : ""} | ${summary.probe_match}/${summary.probe_match_denominator} |`,
    `| latency avg / p50 (ms) | ${summary.latency_avg_ms} / ${summary.latency_p50_ms} |`,
    `| tokens approx total | ${summary.tokens_approx_total} |`,
    ...(summary.tokens_real_total > 0
      ? [`| tokens real total | ${summary.tokens_real_total} |`]
      : []),
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
    "| id | refused | ok | attempts | static | agent | view | probe | produced | latency_ms | errors |",
  );
  lines.push(
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const c of cases) {
    const view = c.view_match === null ? "n/a" : String(c.view_match);
    const probe = c.probe_match === null ? "n/a" : String(c.probe_match);
    const errs = c.errors.length === 0 ? "" : c.errors[0]?.slice(0, 80);
    lines.push(
      `| ${c.id} | ${c.refused} | ${c.ok} | ${c.attempts} | ${String(c.static_ok ?? false)} | ${String(c.agent_ok ?? false)} | ${view} | ${probe} | ${c.produced_status ?? "skipped"} | ${c.latency_ms} | ${errs} |`,
    );
  }
  lines.push("");
  if (mode === "live" || mode === "live+agent") {
    lines.push("## Failures (full errors)", "");
    const failed = cases.filter((c) => !c.ok && !c.refused);
    if (failed.length === 0) {
      lines.push("None: every generatable case compiled within retries.", "");
    }
    for (const c of failed) {
      lines.push(
        `### ${c.id}`,
        "",
        `Expected view: ${c.expected_view ?? "n/a"}; expected probe: ${c.expected_probe_family ?? "n/a"}; attempts: ${c.attempts}`,
        "",
      );
      for (const e of c.errors) lines.push(`- ${e}`);
      lines.push("");
    }
  }
  if (mode === "live+agent") {
    lines.push("## Notes", "");
    const noEvents = cases.filter((c) => c.produced_status === "no-events");
    const unsafe = cases.filter((c) => c.must_refuse && c.ok);
    const runErrors = cases.filter((c) => c.produced_status === "error");
    if (
      noEvents.length === 0 &&
      unsafe.length === 0 &&
      runErrors.length === 0
    ) {
      lines.push(
        "Nothing to note: every validated script produced events.",
        "",
      );
    }
    for (const c of noEvents) {
      lines.push(
        `- ${c.id}: no data events in the 5 s window. Likely cause: a low-traffic probe (e.g. retransmit/interval) or a threshold (e.g. 10 ms block-IO filter) with no matching activity during the run; the mixed user-level workload may not have exercised it.`,
      );
    }
    for (const c of unsafe) {
      lines.push(
        `- ${c.id}: ACCEPTED-UNSAFE-CASE. A must_refuse case produced a script accepted by both validators; it was recorded and NOT executed.`,
      );
    }
    for (const c of runErrors) {
      lines.push(`- ${c.id}: produced-output run error: ${c.notes}`);
    }
    if (noEvents.length > 0 || unsafe.length > 0 || runErrors.length > 0) {
      lines.push("");
    }
  }
  return lines.join("\n");
}
