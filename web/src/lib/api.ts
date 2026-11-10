import type {
  ChartType,
  EventEnvelope,
  GenerateResponse,
  HealthResponse,
  Recipe,
  ValidateResponse,
} from "@vbpf/schemas";

// Caps mirror packages/schemas + api/src/validator.ts. Enforced client-side
// for fast feedback; the server re-validates authoritatively.
export const MAX_PROMPT_CHARS = 2000;
export const MAX_SCRIPT_BYTES = 8 * 1024;
export const MIN_DURATION_S = 1;
export const MAX_DURATION_S = 60;
export const MAX_SESSION_ID_CHARS = 128;

export type ValidateResult = ValidateResponse;

export interface CreateRunResult {
  run_id: string;
  state: string;
}

export interface StopRunResult {
  run_id: string;
  state: string;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly fixHint?: string;

  constructor(status: number, code: string, message: string, fixHint?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    if (fixHint !== undefined) this.fixHint = fixHint;
  }
}

// Fixture replay for UI work without root/agent. Enabled with
// VITE_FIXTURE_MODE=1; all network calls are bypassed.
export function fixtureMode(): boolean {
  return import.meta.env["VITE_FIXTURE_MODE"] === "1";
}

async function parseError(res: Response): Promise<never> {
  let code = "INTERNAL";
  let message = `request failed (${res.status})`;
  let fixHint: string | undefined;
  try {
    const body = (await res.json()) as {
      error?: unknown;
      code?: unknown;
      fix_hint?: unknown;
    };
    if (typeof body.error === "string" && body.error !== "")
      message = body.error;
    if (typeof body.code === "string" && body.code !== "") code = body.code;
    if (typeof body.fix_hint === "string" && body.fix_hint !== "")
      fixHint = body.fix_hint;
  } catch {
    try {
      const text = await res.text();
      if (text !== "") message = text.slice(0, 500);
    } catch {
      /* keep default */
    }
  }
  throw new ApiError(res.status, code, message, fixHint);
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) await parseError(res);
  return (await res.json()) as T;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) await parseError(res);
  return (await res.json()) as T;
}

function scriptByteLength(script: string): number {
  return new TextEncoder().encode(script).length;
}

function rejectOversizeScript(script: string): ApiError | null {
  const bytes = scriptByteLength(script);
  if (bytes <= MAX_SCRIPT_BYTES) return null;
  // Mirrors api/src/validator.ts ("script exceeds 8 KB"); the server
  // re-validates authoritatively.
  return new ApiError(
    400,
    "VALIDATION_FAILED",
    `script exceeds 8 KB (${bytes} bytes)`,
  );
}

export function generatePrompt(
  prompt: string,
  sessionId?: string,
): Promise<GenerateResponse> {
  const trimmed = prompt.trim().slice(0, MAX_PROMPT_CHARS);
  if (trimmed === "")
    return Promise.reject(
      new ApiError(400, "VALIDATION_FAILED", "prompt is empty"),
    );
  return postJson<GenerateResponse>("/api/generate", {
    prompt: trimmed,
    ...(sessionId
      ? { session_id: sessionId.slice(0, MAX_SESSION_ID_CHARS) }
      : {}),
  });
}

export function validateScript(script: string): Promise<ValidateResult> {
  const oversize = rejectOversizeScript(script);
  if (oversize) return Promise.reject(oversize);
  return postJson<ValidateResult>("/api/validate", { script });
}

export function createRun(
  script: string,
  durationS: number,
): Promise<CreateRunResult> {
  const oversize = rejectOversizeScript(script);
  if (oversize) return Promise.reject(oversize);
  const duration = Math.min(
    MAX_DURATION_S,
    Math.max(MIN_DURATION_S, Math.round(durationS)),
  );
  return postJson<CreateRunResult>("/api/runs", {
    script,
    duration_s: duration,
  });
}

export function stopRun(runId: string): Promise<StopRunResult> {
  return postJson<StopRunResult>(
    `/api/runs/${encodeURIComponent(runId)}/stop`,
    {},
  );
}

export function fetchHealth(): Promise<HealthResponse> {
  return getJson<HealthResponse>("/api/health");
}

export function fetchRecipes(query = ""): Promise<{ recipes: Recipe[] }> {
  const q = query.trim().slice(0, 256);
  return getJson<{ recipes: Recipe[] }>(
    `/api/recipes${q === "" ? "" : `?q=${encodeURIComponent(q)}`}`,
  );
}

// Server-side probe walkthrough. Shows loading and error states; the
// generation summary stays visible above while the walkthrough loads.
export interface ExplainResult {
  explanation: string;
  cached: boolean;
  model: string;
}

export function explainScript(script: string): Promise<ExplainResult> {
  const oversize = rejectOversizeScript(script);
  if (oversize) return Promise.reject(oversize);
  return postJson<ExplainResult>("/api/explain", { script });
}

export type {
  ChartType,
  EventEnvelope,
  GenerateResponse,
  HealthResponse,
  Recipe,
  ValidateResponse,
};
