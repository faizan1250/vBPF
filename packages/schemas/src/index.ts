import { z } from "zod";

export const ScriptSchema = z.string().min(1).max(8 * 1024);

export const DurationSchema = z.number().int().min(1).max(60);

export const ValidateRequestSchema = z
  .object({ script: ScriptSchema })
  .strict();

export const ValidateResponseSchema = z
  .object({
    ok: z.boolean(),
    errors: z.array(z.string()),
    probes: z.array(z.string()),
  })
  .strict();

export const CreateRunRequestSchema = z
  .object({ script: ScriptSchema, duration_s: DurationSchema.optional() })
  .strict();

export const CreateRunResponseSchema = z
  .object({ run_id: z.string().min(1), state: z.string().min(1) })
  .strict();

export const StopRunResponseSchema = z
  .object({ run_id: z.string().min(1), state: z.string().min(1) })
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

export const AgentHealthSchema = z
  .object({
    kernel: z.string(),
    bpftrace_version: z.string(),
    btf: z.boolean(),
    root: z.boolean(),
    tracefs: z.boolean(),
    uptime_s: z.number(),
  })
  .strict();

export const HealthResponseSchema = z
  .object({
    ok: z.literal(true),
    agent: z.union([
      z.object({ reachable: z.literal(true), health: AgentHealthSchema }).strict(),
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
  .strict()
  .passthrough();

export const ErrorBodySchema = z
  .object({ error: z.string().min(1), code: z.string().min(1) })
  .strict()
  .passthrough();

export type ValidateRequest = z.infer<typeof ValidateRequestSchema>;
export type ValidateResponse = z.infer<typeof ValidateResponseSchema>;
export type CreateRunRequest = z.infer<typeof CreateRunRequestSchema>;
export type CreateRunResponse = z.infer<typeof CreateRunResponseSchema>;
export type Recipe = z.infer<typeof RecipeSchema>;
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;
