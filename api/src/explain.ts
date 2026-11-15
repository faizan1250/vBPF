import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type Database from "better-sqlite3";
import type { ExplainResponse } from "@vbpf/schemas";

import { getExplanation, putExplanation } from "./db.js";
import { LlmUnavailableError, type ExplainDetailedResult } from "./live-llm.js";
import type { LlmClient } from "./llm.js";
import { loadRecipes } from "./recipes.js";
import { staticValidate } from "./validator.js";

export class ExplainValidationError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super("validation failed");
    this.errors = errors;
  }
}

/** Live-chain capability used for explanations (script text only). */
export interface ExplainLlm {
  explainDetailed(
    script: string,
    opts?: { signal?: AbortSignal },
  ): Promise<ExplainDetailedResult>;
}

/** Live-chain capability for opt-in run-output explanations. */
export interface ExplainResultsLlm {
  explainResultsDetailed(
    script: string,
    output: string,
    opts?: { signal?: AbortSignal },
  ): Promise<ExplainDetailedResult>;
}

export const EXPLAIN_MOCK_MODEL = "mock";
export const EXPLAIN_GENERIC =
  "This bpftrace script attaches probes that aggregate events in-kernel and print a summary.";
export const EXPLAIN_RESULTS_GENERIC =
  "Mock run-output explanation: the script aggregates events in-kernel and the captured output shows the latest snapshot. Re-run with a live LLM to interpret real output.";
export const EXPLAIN_RESULTS_OUTPUT_MAX_CHARS = 4000;

export interface ExplainDeps {
  db: Database.Database;
  recipesDir: string;
  /** Null in mock mode: recipe match or the generic message, no LLM call. */
  llm: (LlmClient & Partial<ExplainLlm>) | null;
}

export interface ExplainResultsDeps {
  /** No db: result explanations are never cached (output may hold host data). */
  recipesDir: string;
  /** Null in mock mode: generic message, no LLM call. */
  llm: (LlmClient & Partial<ExplainResultsLlm>) | null;
}

function mockExplain(
  script: string,
  recipesDir: string,
): { explanation: string; model: string } {
  const norm = script.trim();
  for (const recipe of loadRecipes(recipesDir)) {
    let body: string;
    try {
      body = readFileSync(join(recipesDir, `${recipe.id}.bt`), "utf8");
    } catch {
      continue;
    }
    if (body.trim() === norm) {
      return { explanation: recipe.description, model: EXPLAIN_MOCK_MODEL };
    }
  }
  return { explanation: EXPLAIN_GENERIC, model: EXPLAIN_MOCK_MODEL };
}

export async function explainScriptText(
  script: string,
  deps: ExplainDeps,
  opts?: { signal?: AbortSignal },
): Promise<ExplainResponse> {
  // Static check first: obviously blocked scripts never reach the LLM.
  const stat = staticValidate(script, { catalog: { mode: "skip" } });
  if (stat.errors.length > 0) throw new ExplainValidationError(stat.errors);

  const sha = createHash("sha256").update(script).digest("hex");
  const hit = getExplanation(deps.db, sha);
  if (hit !== undefined) {
    return { explanation: hit.explanation, cached: true, model: hit.model };
  }

  let explanation: string;
  let model: string;
  if (deps.llm !== null && typeof deps.llm.explainDetailed === "function") {
    const live = await deps.llm.explainDetailed(script, opts);
    explanation = live.explanation;
    model = live.model;
  } else if (deps.llm === null) {
    ({ explanation, model } = mockExplain(script, deps.recipesDir));
  } else {
    throw new LlmUnavailableError("live LLM client cannot explain scripts");
  }
  putExplanation(deps.db, { script_sha256: sha, explanation, model });
  return { explanation, cached: false, model };
}

/**
 * Opt-in explanation of a script plus its capped run output. The caller must
 * hold explicit consent (enforced by `consent: true` in the request schema).
 * Never cached: output may contain host data (process names, paths) that must
 * not persist in the explanations table. Never logged.
 */
export async function explainResultsText(
  script: string,
  output: string,
  deps: ExplainResultsDeps,
  opts?: { signal?: AbortSignal },
): Promise<ExplainResponse> {
  const stat = staticValidate(script, { catalog: { mode: "skip" } });
  if (stat.errors.length > 0) throw new ExplainValidationError(stat.errors);
  const capped = output.slice(0, EXPLAIN_RESULTS_OUTPUT_MAX_CHARS);
  if (capped.trim() === "")
    throw new ExplainValidationError(["output is empty"]);

  if (
    deps.llm !== null &&
    typeof deps.llm.explainResultsDetailed === "function"
  ) {
    const live = await deps.llm.explainResultsDetailed(script, capped, opts);
    return { explanation: live.explanation, cached: false, model: live.model };
  }
  if (deps.llm === null) {
    return {
      explanation: EXPLAIN_RESULTS_GENERIC,
      cached: false,
      model: EXPLAIN_MOCK_MODEL,
    };
  }
  throw new LlmUnavailableError("live LLM client cannot explain run output");
}
