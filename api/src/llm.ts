import { z } from "zod";

import { ChartTypeSchema, DurationSchema } from "@vbpf/schemas";

import type { RecipeWithBody } from "./prompts.js";

export const LlmOutputSchema = z
  .object({
    script: z.string().max(8 * 1024),
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
  generate(prompt: string, feedback?: LlmFeedback): Promise<LlmOutput>;
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

const REFUSAL_PATTERNS = [
  /\bkill\b/i,
  /\brm\s+-?-?r?f?\b/i,
  /\bshadow\b/i,
  /\bpasswd\b/i,
  /\btrace every kernel/i,
  /\bwipe\b/i,
  /\bsystem\s*\(/i,
  /\bsignal\s*\(/i,
  /\boverride\s*\(/i,
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
