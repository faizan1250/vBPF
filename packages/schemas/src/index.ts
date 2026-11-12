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

// Run provenance (I-14): where the run's script came from. Derived
// server-side, never accepted from the client.
export const RunOriginSchema = z.enum(["generated", "edited", "recipe"]);

export const CreateRunResponseSchema = z
  .object({
    run_id: z.string().min(1),
    state: z.string().min(1),
    origin: RunOriginSchema,
  })
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
// script_sha256 are deliberately excluded; generation_id/edited/origin expose
// the R-18 generation binding and the I-14 provenance without leaking bytes.
export const GetRunResponseSchema = z
  .object({
    run_id: z.string().min(1),
    state: z.string().min(1),
    duration_s: DurationSchema,
    started_at: z.number().int().nonnegative(),
    ended_at: z.number().int().nonnegative().nullable(),
    generation_id: z.string().min(1).max(128).nullable(),
    edited: z.boolean(),
    origin: RunOriginSchema,
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

// Shared validator taxonomy: both implementations (agent Go, API TS) return
// the same code for every vector in validator-vectors.json. Severity order
// for multi-error scripts: BLOCKED_CALL > UNKNOWN_CALL > PROBE_NOT_FOUND >
// LIMIT_EXCEEDED > VALIDATION_FAILED; CATALOG_UNAVAILABLE is fail-closed.
export const VALIDATOR_ERROR_CODES = [
  "CATALOG_UNAVAILABLE",
  "VALIDATION_FAILED",
  "PROBE_NOT_FOUND",
  "LIMIT_EXCEEDED",
  "BLOCKED_CALL",
  "UNKNOWN_CALL",
] as const;

export const ValidatorErrorCodeSchema = z.enum(VALIDATOR_ERROR_CODES);

export type ValidatorErrorCode = z.infer<typeof ValidatorErrorCodeSchema>;

// One parity vector: both suites load validator-vectors.json and assert the
// same ok verdict and error code. Message text may differ between Go and TS.
export const ValidatorVectorSchema = z
  .object({
    id: z.string().min(1).max(128),
    script: z.string().max(32 * 1024),
    catalog: z.enum(["enforce", "skip"]),
    known: z.array(z.string().max(256)).max(512).optional(),
    expect: z
      .object({
        ok: z.boolean(),
        error_codes: z.array(ValidatorErrorCodeSchema).max(8),
      })
      .strict(),
  })
  .strict();

export const ValidatorVectorsSchema = z.array(ValidatorVectorSchema).min(1);

export type ValidatorVector = z.infer<typeof ValidatorVectorSchema>;
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
export type RunOrigin = z.infer<typeof RunOriginSchema>;
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

// Kernel/platform matrix (I-12): one compat/<env>.json per environment.
// Mirrors compat/schema.json; scripts/render-compat.mjs enforces the same
// shape dependency-free so the matrix workflow needs no JS install.
export const CompatStatusSchema = z.enum(["verified", "unverified", "not-run"]);

export const CompatRecipeStatusSchema = z.enum([
  "available",
  "fallback",
  "unavailable",
  "not-checked",
]);

export const CompatReportSchema = z
  .object({
    env: z.string().min(1).max(128),
    status: CompatStatusSchema,
    kernel: z.string().min(1).max(256),
    distro: z.string().min(1).max(256),
    bpftrace_version: z.string().min(1).max(64),
    btf: z.boolean(),
    recorded_at: z
      .string()
      .regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/)
      .optional(),
    recipes: z
      .record(z.string(), CompatRecipeStatusSchema)
      .refine((r) => Object.keys(r).length >= 1, {
        message: "recipes must cover at least one recipe",
      }),
    tests: z
      .object({
        passed: z.array(z.string().min(1).max(256)),
        failed: z.array(z.string().min(1).max(256)),
      })
      .strict(),
    notes: z.string().max(2048),
  })
  .strict();

export type CompatReport = z.infer<typeof CompatReportSchema>;
