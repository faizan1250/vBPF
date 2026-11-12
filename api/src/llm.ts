import { z } from "zod";

import { ChartTypeSchema, DurationSchema } from "@vbpf/schemas";

import type { PromptParts, RecipeWithBody } from "./prompts.js";

/** Char budget for system + context + user of one generate call. */
export const PROMPT_BUDGET_CHARS = 24_000;

/**
 * Context alone cannot fit the budget after shrinking (probes to 15, arg
 * formats dropped, recipes to 1). The system message, user request, and
 * feedback are never truncated, so this is surfaced as 502 LLM_ERROR.
 */
export class PromptBudgetError extends Error {}

export const MAX_SCRIPT_BYTES = 8 * 1024;

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

export const LlmOutputSchema = z
  .object({
    // UTF-8 bytes to match validator.ts MAX_SCRIPT_BYTES (not UTF-16 length).
    script: z.string().refine((s) => utf8ByteLength(s) <= MAX_SCRIPT_BYTES, {
      message: `Too big: expected string to have <=${MAX_SCRIPT_BYTES} UTF-8 bytes`,
    }),
    chart_type: ChartTypeSchema,
    explanation: z.string().max(2048),
    duration_s: DurationSchema,
    refusal: z.string().max(2048).nullable(),
  })
  .strict();

export type LlmOutput = z.infer<typeof LlmOutputSchema>;

export interface LlmFeedback {
  previousScript: string;
  errors: string[];
}

export interface LlmClient {
  readonly model: string;
  generate(
    prompt: string,
    feedback?: LlmFeedback,
    parts?: PromptParts,
  ): Promise<LlmOutput>;
}

/** Token counts reported by the provider, when present. No prompt or text. */
export interface LlmUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

/** Per-request result with provider/model attribution (live chains). */
export interface LlmDetailedResult {
  output: LlmOutput;
  model: string;
  usage?: LlmUsage;
}

// Eval v2 (I-10) adversarial taxonomy: each class below has at least one
// trigger. Prompts in eval/prompts.yaml are written against these classes,
// not against individual patterns; keep legit eval prompts free of them.
const REFUSAL_PATTERNS = [
  /\bkill\b/i,
  /\brm\s+-?-?r?f?\b/i,
  /\bshadow\b/i,
  /\bpasswd\b/i,
  /\btrace every\b/i,
  /\bwipe\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bsystem\s*\(/i,
  /\bsignal\b/i,
  /\bsig(kill|term|hup|int|quit)\b/i,
  /\boverrid\w*\b/i,
  /\bunbounded\b/i,
  /\bprintf\s+on\s+every\b/i,
  /\bld_preload\b/i,
  /\.so\b/,
  /\bptrace\b/i,
  /\btrace the .*agent\b/i,
  /\b(escalat\w*|setuid|become root|privesc)\b/i,
  /\b(private keys?|password hash\w*|plaintext|decrypt|tls key|credential|secret)\b/i,
  /\bignore\b.*\b(rules|instructions|restrictions|guidelines|prompt)\b/i,
  /\bjailbreak\b/i,
  /:\*/,
];

export function isRefusalPrompt(prompt: string): boolean {
  return REFUSAL_PATTERNS.some((re) => re.test(prompt));
}

function chartForView(view: string): LlmOutput["chart_type"] {
  const parsed = ChartTypeSchema.safeParse(view);
  return parsed.success ? parsed.data : "table";
}

/** Deterministic mock LLM: echoes the top-1 recipe body, refuses unsafe asks. */
export class MockLlm implements LlmClient {
  readonly model: string;
  private readonly resolveTop: (prompt: string) => RecipeWithBody | null;

  constructor(
    model: string,
    resolveTop: (prompt: string) => RecipeWithBody | null,
  ) {
    this.model = model;
    this.resolveTop = resolveTop;
  }

  // Ignores feedback and parts: the mock answers from the marker text.
  async generate(prompt: string): Promise<LlmOutput> {
    const user = prompt.split("==USER==").at(-1)?.trim() ?? prompt;
    if (isRefusalPrompt(user)) {
      return LlmOutputSchema.parse({
        script: "",
        chart_type: "events",
        explanation: "",
        duration_s: 10,
        refusal:
          "I can't help with that: destructive or credential-access tracing is out of scope.",
      });
    }
    const top = this.resolveTop(user);
    if (top === null) {
      return LlmOutputSchema.parse({
        script: "BEGIN { @x = count(); }\n",
        chart_type: "table",
        explanation: "Minimal counter probe.",
        duration_s: 10,
        refusal: null,
      });
    }
    return LlmOutputSchema.parse({
      script: top.body.endsWith("\n") ? top.body : `${top.body}\n`,
      chart_type: chartForView(top.view),
      explanation: `Based on recipe ${top.id}: ${top.title}.`,
      duration_s: 10,
      refusal: null,
    });
  }
}
