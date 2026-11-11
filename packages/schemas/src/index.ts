import { z } from "zod";

// Script cap is UTF-8 bytes (matches the Go agent's len() and the web
// TextEncoder check). TextEncoder works in Node and browsers, unlike Buffer.
export const MAX_SCRIPT_BYTES = 8 * 1024;

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

export const ScriptSchema = z
  .string()
  .min(1)
  .refine((s) => utf8ByteLength(s) <= MAX_SCRIPT_BYTES, {
    message: `Too big: expected string to have <=${MAX_SCRIPT_BYTES} UTF-8 bytes`,
  });

export const DurationSchema = z.number().int().min(1).max(60);

export const ValidateRequestSchema = z
  .object({ script: ScriptSchema })
  .strict();

export const ValidateResponseSchema = z
  .object({
    ok: z.boolean(),
    errors: z.array(z.string()),
    probes: z.array(z.string()),
    warnings: z.array(z.string()),
    probe_count: z.number().int().nonnegative(),
  })
  .strict();

export const ExplainRequestSchema = z.object({ script: ScriptSchema }).strict();

export const ExplainResponseSchema = z
  .object({
    explanation: z.string().min(1).max(2048),
    cached: z.boolean(),
    model: z.string().min(1).max(128),
  })
  .strict();

export const CreateRunRequestSchema = z
  .object({
    script: ScriptSchema,
    duration_s: DurationSchema.optional(),
    generation_id: z.string().min(1).max(128).optional(),
  })
  .strict();

export const CreateRunResponseSchema = z
  .object({ run_id: z.string().min(1), state: z.string().min(1) })
  .strict();

export const StopRunResponseSchema = z
  .object({ run_id: z.string().min(1), state: z.string().min(1) })
  .strict();

// Terminal per-run totals as emitted by the agent's summary event.
export const AgentRunSummarySchema = z
  .object({
    events: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
    dropped: z.number().int().nonnegative(),
    duration_ms: z.number().int(),
    exit_reason: z.string().min(1).max(64),
  })
  .passthrough();

export const RunSummarySchema = z
  .object({
    events_count: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
    dropped: z.number().int().nonnegative(),
    exit_reason: z.string().min(1).max(64),
  })
  .strict();

// GET /api/runs/:id: metadata plus the persisted summary. script_text and
// script_sha256 are deliberately excluded; generation_id/edited expose the
// R-18 generation binding without leaking script bytes.
export const GetRunResponseSchema = z
  .object({
    run_id: z.string().min(1),
    state: z.string().min(1),
    duration_s: DurationSchema,
    started_at: z.number().int().nonnegative(),
    ended_at: z.number().int().nonnegative().nullable(),
    generation_id: z.string().min(1).max(128).nullable(),
    edited: z.boolean(),
    summary: RunSummarySchema.nullable(),
  })
  .strict();

export const RecipeSchema = z
  .object({
    id: z.string().min(1).max(128),
    title: z.string().min(1).max(256),
    description: z.string().max(2048),
    tags: z.array(z.string().max(64)).max(32),
    view: z.string().min(1).max(32),
  })
  .strict();

export const RecipeListResponseSchema = z
  .object({ recipes: z.array(RecipeSchema) })
  .strict();

export const CatalogStateSchema = z.enum(["loading", "ready", "failed"]);

export const CatalogStatusSchema = z
  .object({
    state: CatalogStateSchema,
    probes: z.number().int().nonnegative(),
    refreshed_at: z.string().min(1).optional(),
    stale_since: z.string().min(1).optional(),
    last_error: z.string().min(1).optional(),
    warnings: z.array(z.string()),
  })
  .strict();

export const AgentHealthSchema = z
  .object({
    kernel: z.string(),
    bpftrace_version: z.string(),
    btf: z.boolean(),
    root: z.boolean(),
    tracefs: z.boolean(),
    uptime_s: z.number(),
    ready: z.boolean(),
    catalog: CatalogStatusSchema,
  })
  .strict();

export const LlmProviderHealthSchema = z
  .object({
    name: z.string().min(1).max(64),
    state: z.enum(["ready", "cooldown", "unconfigured", "exhausted"]),
    keys: z.number().int().min(0),
    reason: z.string().min(1).max(300).optional(),
  })
  .strict();

export const LlmHealthSchema = z
  .object({
    mode: z.enum(["mock", "live"]),
    providers: z.array(LlmProviderHealthSchema).max(16),
  })
  .strict();

export const HealthResponseSchema = z
  .object({
    ok: z.literal(true),
    llm: LlmHealthSchema.optional(),
    agent: z.union([
      z
        .object({
          reachable: z.literal(true),
          health: AgentHealthSchema,
          warnings: z.array(z.string()),
        })
        .strict(),
      z
        .object({
          reachable: z.literal(false),
          code: z.literal("AGENT_OFFLINE"),
          error: z.string(),
        })
        .strict(),
    ]),
  })
  .strict();

export const EventEnvelopeSchema = z
  .object({
    run_id: z.string().min(1),
    seq: z.number().int().nonnegative(),
    ts: z.number().int().nonnegative(),
    kind: z.enum([
      "status",
      "printf",
      "map",
      "hist",
      "lhist",
      "lost",
      "stderr",
      "summary",
    ]),
    data: z.unknown(),
  })
  .passthrough();

export const AgentErrorCodeSchema = z.enum([
  "UNAUTHORIZED",
  "NOT_FOUND",
  "VALIDATION_FAILED",
  "PROBE_NOT_FOUND",
  "LIMIT_EXCEEDED",
  "CATALOG_UNAVAILABLE",
  "TIMEOUT",
  "PROBE_ARGS_FAILED",
]);

export const ApiErrorCodeSchema = z.enum([
  "AGENT_OFFLINE",
  "AGENT_NOT_READY",
  "LLM_UNAVAILABLE",
  "LLM_ERROR",
  "RATE_LIMITED",
  "REFUSAL",
  "VALIDATION_FAILED",
  "PROBE_NOT_FOUND",
  "LIMIT_EXCEEDED",
  "NOT_FOUND",
  "FORBIDDEN",
  "INTERNAL",
]);

export const ErrorBodySchema = z
  .object({
    error: z.string().min(1),
    code: z.string().min(1),
    fix_hint: z.string().min(1).optional(),
  })
  .passthrough();

export const ChartTypeSchema = z.enum([
  "table",
  "bar",
  "histogram",
  "timeseries",
  "events",
]);

export const GenerateRequestSchema = z
  .object({
    prompt: z.string().min(1).max(2000),
    session_id: z.string().min(1).max(128).optional(),
  })
  .strict();

export const GenerateValidationSchema = z
  .object({
    status: z.enum(["ok", "failed"]),
    attempts: z.number().int().min(1).max(3),
    errors: z.array(z.string()),
  })
  .strict();

export const GenerateResponseSchema = z
  .object({
    generation_id: z.string().min(1),
    script: ScriptSchema,
    chart_type: ChartTypeSchema,
    explanation: z.string().min(1).max(2048),
    duration_s: DurationSchema,
    warnings: z.array(z.string()),
    validation: GenerateValidationSchema,
    based_on_recipe: z.string().min(1).nullable(),
  })
  .strict();

export type ValidateRequest = z.infer<typeof ValidateRequestSchema>;
export type ValidateResponse = z.infer<typeof ValidateResponseSchema>;
export type ExplainRequest = z.infer<typeof ExplainRequestSchema>;
export type ExplainResponse = z.infer<typeof ExplainResponseSchema>;
export type CreateRunRequest = z.infer<typeof CreateRunRequestSchema>;
export type CreateRunResponse = z.infer<typeof CreateRunResponseSchema>;
export type StopRunResponse = z.infer<typeof StopRunResponseSchema>;
export type AgentRunSummary = z.infer<typeof AgentRunSummarySchema>;
export type RunSummary = z.infer<typeof RunSummarySchema>;
export type GetRunResponse = z.infer<typeof GetRunResponseSchema>;
export type Recipe = z.infer<typeof RecipeSchema>;
export type CatalogState = z.infer<typeof CatalogStateSchema>;
export type CatalogStatus = z.infer<typeof CatalogStatusSchema>;
export type AgentHealth = z.infer<typeof AgentHealthSchema>;
export type AgentErrorCode = z.infer<typeof AgentErrorCodeSchema>;
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;
export type LlmProviderHealth = z.infer<typeof LlmProviderHealthSchema>;
export type LlmHealth = z.infer<typeof LlmHealthSchema>;
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;
export type ChartType = z.infer<typeof ChartTypeSchema>;
export type GenerateRequest = z.infer<typeof GenerateRequestSchema>;
export type GenerateResponse = z.infer<typeof GenerateResponseSchema>;
export type GenerateValidation = z.infer<typeof GenerateValidationSchema>;
