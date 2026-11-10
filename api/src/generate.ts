import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type Database from "better-sqlite3";
import type { GenerateResponse } from "@vbpf/schemas";

import {
  AgentOfflineError,
  fetchProbeArgs,
  searchProbes,
  validateScript,
} from "./agent-client.js";
import { ensureSession, insertGeneration, searchRecipes } from "./db.js";
import {
  MockLlm,
  type LlmClient,
  type LlmDetailedResult,
  type LlmFeedback,
  type LlmOutput,
  type LlmUsage,
} from "./llm.js";
import { buildGeneratePrompt, type RecipeWithBody } from "./prompts.js";
import { extractKeywords } from "./retrieval.js";
import { staticValidate, truncateErrors } from "./validator.js";

export interface GenerateDeps {
  db: Database.Database;
  recipesDir: string;
  agentUrl: string;
  tokenFile: string;
  llm: LlmClient;
  searchProbesFn?: typeof searchProbes;
  validateAgentFn?: typeof validateScript;
  probeArgsFn?: typeof fetchProbeArgs;
}

/** Live chains report per-request attribution; MockLlm only has .model. */
type PossiblyDetailedLlm = LlmClient & {
  generateDetailed?: (
    prompt: string,
    feedback?: LlmFeedback,
    opts?: { signal?: AbortSignal },
  ) => Promise<LlmDetailedResult>;
};

async function generateWithAttribution(
  llm: LlmClient,
  prompt: string,
  feedback?: LlmFeedback,
  signal?: AbortSignal,
): Promise<{ out: LlmOutput; model: string; usage?: LlmUsage }> {
  const detailed = (llm as PossiblyDetailedLlm).generateDetailed;
  if (typeof detailed === "function") {
    const result = await detailed.call(
      llm,
      prompt,
      feedback,
      signal === undefined ? undefined : { signal },
    );
    return {
      out: result.output,
      model: result.model,
      ...(result.usage !== undefined ? { usage: result.usage } : {}),
    };
  }
  return { out: await llm.generate(prompt, feedback), model: llm.model };
}

export class RefusalError extends Error {
  readonly generationId: string;
  readonly refusal: string;
  constructor(generationId: string, refusal: string) {
    super(refusal);
    this.generationId = generationId;
    this.refusal = refusal;
  }
}

export class ValidationFailedError extends Error {
  readonly generationId: string;
  readonly errors: string[];
  readonly attempts: number;
  constructor(generationId: string, errors: string[], attempts: number) {
    super("validation failed");
    this.generationId = generationId;
    this.errors = errors;
    this.attempts = attempts;
  }
}

export function loadRecipeBodies(
  recipesDir: string,
  ids: string[],
): Map<string, string> {
  const bodies = new Map<string, string>();
  for (const id of ids) {
    try {
      bodies.set(id, readFileSync(join(recipesDir, `${id}.bt`), "utf8"));
    } catch {
      continue;
    }
  }
  return bodies;
}

export function resolveTopRecipe(
  db: Database.Database,
  recipesDir: string,
): (prompt: string) => RecipeWithBody | null {
  return (prompt: string) => {
    const top = searchRecipes(db, prompt, 1)[0];
    if (top === undefined) return null;
    const bodies = loadRecipeBodies(recipesDir, [top.id]);
    const body = bodies.get(top.id);
    if (body === undefined) return null;
    return { ...top, body };
  };
}

export function makeMockLlm(
  db: Database.Database,
  recipesDir: string,
  model: string,
): MockLlm {
  return new MockLlm(model, resolveTopRecipe(db, recipesDir));
}

// Top 1-3 tracepoints whose `bpftrace -vl` output is injected into
// ==ARG_FORMATS==. Recipe bodies come first (they drive the few-shot),
// then catalog probes from search.
export const MAX_ARG_PROBES = 3;
export const ARG_OUTPUT_CAP = 2000;

const TRACEPOINT_RE = /\btracepoint:[A-Za-z0-9_]+:[A-Za-z0-9_]+/g;
const TRACEPOINT_EXACT_RE = /^tracepoint:[A-Za-z0-9_]+:[A-Za-z0-9_]+$/;

export function selectTracepointProbes(
  recipes: RecipeWithBody[],
  probes: string[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (p: string): boolean => {
    if (seen.has(p)) return false;
    seen.add(p);
    out.push(p);
    return out.length >= MAX_ARG_PROBES;
  };
  for (const r of recipes) {
    for (const m of r.body.match(TRACEPOINT_RE) ?? []) {
      if (push(m)) return out;
    }
  }
  for (const p of probes) {
    if (!TRACEPOINT_EXACT_RE.test(p)) continue;
    if (push(p)) break;
  }
  return out;
}

export function formatProbeArgs(
  entries: Array<{ probe: string; output: string }>,
): string {
  return entries
    .map((e) => `${e.probe}:\n${e.output.slice(0, ARG_OUTPUT_CAP)}`)
    .join("\n\n");
}

function newGenerationId(): string {
  return `gen_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

function newSessionId(): string {
  return `ses_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

export async function runGenerate(
  prompt: string,
  opts: {
    sessionId?: string;
    deps: GenerateDeps;
    onUsage?: (usage: LlmUsage) => void;
    signal?: AbortSignal;
  },
): Promise<GenerateResponse> {
  const { db, recipesDir, agentUrl, tokenFile, llm } = opts.deps;
  const searchFn = opts.deps.searchProbesFn ?? searchProbes;
  const validateFn = opts.deps.validateAgentFn ?? validateScript;
  const sessionId = opts.sessionId ?? newSessionId();
  ensureSession(db, sessionId);
  const generationId = newGenerationId();
  const started = Date.now();

  const topRecipes = searchRecipes(db, prompt, 3);
  const bodies = loadRecipeBodies(
    recipesDir,
    topRecipes.map((r) => r.id),
  );
  const withBodies: RecipeWithBody[] = [];
  for (const r of topRecipes) {
    const body = bodies.get(r.id);
    if (body !== undefined) withBodies.push({ ...r, body });
  }
  const basedOnRecipe = withBodies[0]?.id ?? null;

  let probes: string[] = [];
  try {
    const keywords = extractKeywords(prompt).slice(0, 5).join(" ");
    probes = await searchFn(agentUrl, tokenFile, keywords || prompt);
  } catch {
    probes = [];
  }

  const probeArgsFn = opts.deps.probeArgsFn ?? fetchProbeArgs;
  let argFormats: string | undefined;
  const candidates = selectTracepointProbes(withBodies, probes);
  if (candidates.length > 0) {
    const sections: Array<{ probe: string; output: string }> = [];
    for (const probe of candidates) {
      try {
        const output = await probeArgsFn(agentUrl, tokenFile, probe);
        if (output.trim() !== "") sections.push({ probe, output });
      } catch {
        continue;
      }
    }
    if (sections.length > 0) argFormats = formatProbeArgs(sections);
  }

  const { text: assembled } = buildGeneratePrompt(
    prompt,
    withBodies,
    probes,
    argFormats,
  );

  let attempts = 0;
  let lastErrors: string[] = [];
  let previousScript = "";
  let warnings: string[] = [];
  let modelUsed = llm.model;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    attempts = attempt;
    const generated = await generateWithAttribution(
      llm,
      attempt === 1
        ? assembled
        : `${assembled}\n\n==FEEDBACK==\nPrevious script:\n${previousScript}\nErrors:\n${truncateErrors(lastErrors).join("\n")}\nFix the script and return full JSON again.`,
      attempt === 1
        ? undefined
        : { previousScript, errors: truncateErrors(lastErrors) },
      opts.signal,
    );
    const out = generated.out;
    modelUsed = generated.model;
    if (generated.usage !== undefined) opts.onUsage?.(generated.usage);
    if (out.refusal !== null && out.refusal !== "") {
      const latencyMs = Date.now() - started;
      insertGeneration(db, {
        id: generationId,
        session_id: sessionId,
        prompt,
        script: "",
        chart_type: null,
        explanation: null,
        duration_s: null,
        validation_status: "refused",
        attempts,
        model: modelUsed,
        based_on_recipe: basedOnRecipe,
        warnings: JSON.stringify([]),
        refusal: out.refusal,
        latency_ms: latencyMs,
      });
      throw new RefusalError(generationId, out.refusal);
    }
    previousScript = out.script;
    const stat = staticValidate(out.script);
    warnings = stat.warnings;
    if (stat.errors.length > 0) {
      lastErrors = truncateErrors(stat.errors);
      if (attempt === 3) break;
      continue;
    }
    let agentRes: { ok: boolean; errors: string[] };
    try {
      agentRes = await validateFn(agentUrl, tokenFile, out.script);
    } catch (err) {
      if (err instanceof AgentOfflineError) throw err;
      lastErrors = [err instanceof Error ? err.message : "agent error"];
      if (attempt === 3) break;
      continue;
    }
    if (!agentRes.ok) {
      lastErrors = truncateErrors(agentRes.errors);
      if (attempt === 3) break;
      continue;
    }
    const latencyMs = Date.now() - started;
    insertGeneration(db, {
      id: generationId,
      session_id: sessionId,
      prompt,
      script: out.script,
      chart_type: out.chart_type,
      explanation: out.explanation,
      duration_s: out.duration_s,
      validation_status: "ok",
      attempts,
      model: modelUsed,
      based_on_recipe: basedOnRecipe,
      warnings: JSON.stringify(warnings),
      refusal: null,
      latency_ms: latencyMs,
    });
    return {
      generation_id: generationId,
      script: out.script,
      chart_type: out.chart_type,
      explanation: out.explanation,
      duration_s: out.duration_s,
      warnings,
      validation: { status: "ok", attempts, errors: [] },
      based_on_recipe: basedOnRecipe,
    };
  }

  const latencyMs = Date.now() - started;
  insertGeneration(db, {
    id: generationId,
    session_id: sessionId,
    prompt,
    script: previousScript.slice(0, 8 * 1024),
    chart_type: null,
    explanation: null,
    duration_s: null,
    validation_status: "failed",
    attempts,
    model: modelUsed,
    based_on_recipe: basedOnRecipe,
    warnings: JSON.stringify(warnings),
    refusal: null,
    latency_ms: latencyMs,
  });
  throw new ValidationFailedError(generationId, lastErrors, attempts);
}
