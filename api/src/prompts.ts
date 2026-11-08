import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Recipe } from "@vbpf/schemas";

export interface RecipeWithBody extends Recipe {
  body: string;
}

const FALLBACK_SYSTEM = [
  "You generate safe, minimal bpftrace scripts.",
  "Forbidden: system(), signal(), override(), cat(, --unsafe, #include, #define.",
  "Prefer aggregation (count(), hist()) over per-event printf.",
  "Output JSON: script, chart_type, explanation, duration_s, refusal.",
].join("\n");

// Static, cacheable prefix: dialect gotchas that never change per request.
export const GOTCHAS = [
  "Tracepoint arg names differ per tracepoint; use args->field exactly as listed.",
  "Use str() for char* strings, comm/pid/tid builtins for identity, nsecs for time.",
  "Latency pattern: @start[tid] = nsecs on entry, (nsecs - @start[tid]) on exit, then delete(@start[tid]).",
  "Always delete() temporary map keys; clear() snapshot maps after print().",
].join("\n");

// No agent endpoint exposes `bpftrace -vl`; hardcode the safe subset instead.
export const ARG_FORMATS_STUB = [
  "Arg formats (stub): tracepoint:block:block_rq_issue has args->dev, args->sector;",
  "tracepoint:syscalls:sys_enter_openat has args->filename (use str());",
  "tracepoint:sock:inet_sock_set_state has args->newstate, args->family, ntop(args->saddr/daddr).",
  "When unsure, use comm/pid only and avoid guessing arg names.",
].join("\n");

export function loadSystemPrompt(): string {
  try {
    const dir = dirname(fileURLToPath(import.meta.url));
    return readFileSync(join(dir, "..", "prompts", "system.md"), "utf8").trim();
  } catch {
    return FALLBACK_SYSTEM;
  }
}

export const SYSTEM_PROMPT = loadSystemPrompt();

export function formatRecipeFewShot(recipe: RecipeWithBody): string {
  return [
    `### Recipe ${recipe.id}`,
    `Title: ${recipe.title}`,
    `Description: ${recipe.description}`,
    `View: ${recipe.view}`,
    "Script:",
    recipe.body.trim(),
  ].join("\n");
}

export interface AssembledPrompt {
  text: string;
  staticPrefix: string;
}

export function buildGeneratePrompt(
  prompt: string,
  recipes: RecipeWithBody[],
  probes: string[],
): AssembledPrompt {
  const staticPrefix = `${SYSTEM_PROMPT}\n\n${GOTCHAS}`;
  const recipeBlock =
    recipes.length === 0
      ? "Recipes: none matched; write minimal bpftrace from probes only."
      : recipes.map(formatRecipeFewShot).join("\n\n");
  const probeBlock =
    probes.length === 0
      ? "Probes: catalog unavailable; use BEGIN/END or well-known tracepoints only."
      : `Probes:\n${probes.slice(0, 40).join("\n")}`;
  const text = [
    "==SYSTEM==",
    staticPrefix,
    "==RECIPES==",
    recipeBlock,
    "==PROBES==",
    probeBlock,
    "==ARG_FORMATS==",
    ARG_FORMATS_STUB,
    "==USER==",
    prompt.trim(),
  ].join("\n\n");
  return { text, staticPrefix };
}
