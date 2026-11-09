import {
  LlmOutputSchema,
  type LlmClient,
  type LlmDetailedResult,
  type LlmOutput,
} from "./llm.js";

// Live OpenAI-compatible LLM client with ordered provider fallback.
//
// Model identifiers are never hardcoded here: the primary model comes from
// LLM_<NAME>_MODEL (or the generic LLM_MODEL), fallbacks from
// LLM_<NAME>_FALLBACK_MODELS. Keys are discovered from the environment and
// never logged; the health snapshot exposes only counts.

// Caps for outbound traffic. A single request is also bounded by
// LIVE_TIMEOUT_MS; concurrent generations share one semaphore per chain.
export const LIVE_MAX_CONCURRENCY = 4;
export const LIVE_MAX_BODY_BYTES = 256 * 1024;
export const LIVE_MAX_PROMPT_CHARS = 24_000;
export const LIVE_TIMEOUT_MS = 45_000;
export const LIVE_DEFAULT_COOLDOWN_MS = 60_000;
export const LIVE_MAX_COOLDOWN_MS = 300_000;

const JSON_INSTRUCTION = [
  "You are a bpftrace script generator.",
  "Reply with a single JSON object and nothing else.",
  'Keys: "script" (string), "chart_type" (one of table, bar, histogram, timeseries, events),',
  '"explanation" (string), "duration_s" (integer 1-60), "refusal" (string or null).',
].join("\n");

// Short system prompt for /api/explain. Only the script text is ever sent;
// run output (process names, paths, command lines) is never included.
export const EXPLAIN_SYSTEM = [
  "Explain this bpftrace script in plain English.",
  "Reply with 1 short paragraph plus bullets. Do not suggest running anything.",
].join("\n");
export const EXPLAIN_MAX_CHARS = 2048;

export type LiveProviderState =
  "ready" | "cooldown" | "unconfigured" | "exhausted";

export interface LiveProviderSnapshot {
  name: string;
  state: LiveProviderState;
  keys: number;
}

export interface LiveHealth {
  mode: "live";
  providers: LiveProviderSnapshot[];
}

/** No usable provider (none configured, or all cooling down). Maps to 503. */
export class LlmUnavailableError extends Error {}

/** Providers were tried but none produced a usable answer. Maps to 502. */
export class LlmRequestError extends Error {}

interface ProviderPreset {
  baseUrl: string;
  needsKey: boolean;
}

const PRESETS: Record<string, ProviderPreset> = {
  groq: { baseUrl: "https://api.groq.com/openai/v1", needsKey: true },
  cerebras: { baseUrl: "https://api.cerebras.ai/v1", needsKey: true },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", needsKey: true },
  ollama: { baseUrl: "http://127.0.0.1:11434/v1", needsKey: false },
  // Base URL from Google's official OpenAI-compatibility docs
  // (https://ai.google.dev/gemini-api/docs/openai).
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    needsKey: true,
  },
};

function presetFor(
  name: string,
  env: NodeJS.ProcessEnv,
): ProviderPreset | null {
  if (name === "custom") {
    const base = env["LLM_CUSTOM_BASE_URL"]?.trim().replace(/\/$/, "");
    return base === undefined || base === ""
      ? null
      : { baseUrl: base, needsKey: discoverKeys(name, env).length > 0 };
  }
  return PRESETS[name] ?? null;
}

/** Ordered chain from LLM_PROVIDER_CHAIN (default: groq). */
export function parseChain(
  raw: string | undefined,
  fallbackEnv?: NodeJS.ProcessEnv,
): string[] {
  const value = raw ?? fallbackEnv?.["LLM_PROVIDER_CHAIN"] ?? "groq";
  const names = value
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s !== "");
  return names.length > 0 ? names : ["groq"];
}

/**
 * Key discovery for provider NAME: LLM_<NAME>_API_KEY, <NAME>_API_KEY, then
 * <NAME>_API_KEY1..5, de-duplicated, stopping at the first numbering gap.
 */
export function discoverKeys(
  provider: string,
  env: NodeJS.ProcessEnv,
): string[] {
  const upper = provider.toUpperCase();
  const keys: string[] = [];
  const push = (value: string | undefined): void => {
    if (value !== undefined && value !== "" && !keys.includes(value)) {
      keys.push(value);
    }
  };
  push(env[`LLM_${upper}_API_KEY`]);
  push(env[`${upper}_API_KEY`]);
  for (let i = 1; i <= 5; i += 1) {
    const value = env[`${upper}_API_KEY${i}`];
    if (value === undefined || value === "") break;
    push(value);
  }
  return keys;
}

/** Comma-separated LLM_<NAME>_FALLBACK_MODELS. */
export function discoverFallbackModels(
  provider: string,
  env: NodeJS.ProcessEnv,
): string[] {
  const raw = env[`LLM_${provider.toUpperCase()}_FALLBACK_MODELS`] ?? "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/** Primary model: LLM_<NAME>_MODEL, else the generic LLM_MODEL. */
export function discoverModel(
  provider: string,
  env: NodeJS.ProcessEnv,
): string | null {
  const specific = env[`LLM_${provider.toUpperCase()}_MODEL`]?.trim();
  if (specific !== undefined && specific !== "") return specific;
  const generic = env["LLM_MODEL"]?.trim();
  return generic === undefined || generic === "" ? null : generic;
}

interface ProviderRuntime {
  name: string;
  baseUrl: string;
  needsKey: boolean;
  keys: string[];
  disabled: boolean[];
  active: number;
  models: string[];
  cooldownUntil: number;
}

function nextEnabledIndex(p: ProviderRuntime, from: number): number {
  for (let i = Math.max(0, from); i < p.keys.length; i += 1) {
    if (!p.disabled[i]) return i;
  }
  return -1;
}

function hasUsableKey(p: ProviderRuntime): boolean {
  return !p.needsKey || nextEnabledIndex(p, p.active) >= 0;
}

function isConfigured(p: ProviderRuntime): boolean {
  return (
    p.baseUrl !== "" &&
    p.models.length > 0 &&
    (!p.needsKey || p.keys.length > 0)
  );
}

type ProviderOutcome =
  | { ok: true; output: LlmOutput; model: string }
  | { ok: false; kind: "auth"; message: string }
  | { ok: false; kind: "rate"; message: string; cooldownMs: number }
  | { ok: false; kind: "model" | "provider"; message: string };

/** Plain-text explanation result with provider/model attribution. */
export interface ExplainDetailedResult {
  explanation: string;
  model: string;
}

type ExplainOutcome =
  | { ok: true; explanation: string; model: string }
  | { ok: false; kind: "auth"; message: string }
  | { ok: false; kind: "rate"; message: string; cooldownMs: number }
  | { ok: false; kind: "model" | "provider"; message: string };

function parseRetryAfterMs(value: string | null, now: number): number {
  if (value !== null) {
    const secs = Number(value);
    if (Number.isFinite(secs) && secs >= 0) {
      return Math.min(Math.max(secs * 1000, 1000), LIVE_MAX_COOLDOWN_MS);
    }
    const date = Date.parse(value);
    if (Number.isFinite(date)) {
      return Math.min(Math.max(date - now, 1000), LIVE_MAX_COOLDOWN_MS);
    }
  }
  return LIVE_DEFAULT_COOLDOWN_MS;
}

class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly max: number) {}

  acquire(): Promise<() => void> {
    if (this.active < this.max) {
      this.active += 1;
      return Promise.resolve(() => this.release());
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.active += 1;
        resolve(() => this.release());
      });
    });
  }

  private release(): void {
    this.active -= 1;
    this.queue.shift()?.();
  }
}

async function readCappedText(
  res: Response,
  maxBytes: number,
): Promise<string> {
  const announced = res.headers.get("content-length");
  if (announced !== null && Number(announced) > maxBytes) {
    throw new Error(`response exceeds ${maxBytes} byte cap`);
  }
  if (res.body === null) {
    const text = await res.text();
    if (text.length > maxBytes) {
      throw new Error(`response exceeds ${maxBytes} byte cap`);
    }
    return text;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      throw new Error(`response exceeds ${maxBytes} byte cap`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function extractJsonPayload(content: unknown): unknown {
  if (typeof content !== "string") return content;
  const stripped = content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  return JSON.parse(stripped) as unknown;
}

interface ChainOptions {
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
  chain?: string;
  timeoutMs?: number;
  maxBodyBytes?: number;
  maxConcurrency?: number;
}

export class LiveLlmChain implements LlmClient {
  private readonly providers: ProviderRuntime[];
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxBodyBytes: number;
  private readonly semaphore: Semaphore;
  private attribution: string;

  constructor(opts: ChainOptions = {}) {
    const env = opts.env ?? process.env;
    const names = parseChain(opts.chain, env);
    this.fetchFn = opts.fetchFn ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? LIVE_TIMEOUT_MS;
    this.maxBodyBytes = opts.maxBodyBytes ?? LIVE_MAX_BODY_BYTES;
    this.semaphore = new Semaphore(opts.maxConcurrency ?? LIVE_MAX_CONCURRENCY);
    this.providers = names.map((name) => {
      const preset = presetFor(name, env);
      const primary = discoverModel(name, env);
      const models = [
        ...(primary === null ? [] : [primary]),
        ...discoverFallbackModels(name, env),
      ];
      return {
        name,
        baseUrl: preset?.baseUrl ?? "",
        needsKey: preset?.needsKey ?? true,
        keys: discoverKeys(name, env),
        disabled: [],
        active: 0,
        models,
        cooldownUntil: 0,
      } satisfies ProviderRuntime;
    });
    const first = this.providers.find((p) => p.models.length > 0);
    this.attribution =
      first === undefined
        ? "live/unconfigured"
        : `${first.name}/${first.models[0] ?? ""}`;
  }

  get model(): string {
    return this.attribution;
  }

  get configured(): boolean {
    return this.providers.some(isConfigured);
  }

  health(): LiveHealth {
    const now = Date.now();
    return {
      mode: "live",
      providers: this.providers.map((p) => {
        let state: LiveProviderState = "ready";
        if (!isConfigured(p)) state = "unconfigured";
        else if (p.cooldownUntil > now) state = "cooldown";
        else if (!hasUsableKey(p)) state = "exhausted";
        return { name: p.name, state, keys: p.keys.length };
      }),
    };
  }

  async generate(prompt: string): Promise<LlmOutput> {
    return (await this.generateDetailed(prompt)).output;
  }

  /** Plain-English explanation of one script; script text only is sent. */
  async explainDetailed(script: string): Promise<ExplainDetailedResult> {
    const release = await this.semaphore.acquire();
    try {
      return await this.attemptExplain(script);
    } finally {
      release();
    }
  }

  async generateDetailed(prompt: string): Promise<LlmDetailedResult> {
    const release = await this.semaphore.acquire();
    try {
      return await this.attempt(prompt);
    } finally {
      release();
    }
  }

  private async attempt(prompt: string): Promise<LlmDetailedResult> {
    const now = Date.now();
    const configured = this.providers.filter(isConfigured);
    if (configured.length === 0) {
      throw new LlmUnavailableError(
        "no live LLM provider is configured: set a provider key and LLM_<NAME>_MODEL",
      );
    }
    let cooled = 0;
    let last = "no provider attempted";
    for (const p of configured) {
      if (p.cooldownUntil > now) {
        cooled += 1;
        last = `${p.name} is cooling down after a rate limit`;
        continue;
      }
      const outcome = await this.attemptProvider(p, prompt);
      if (outcome.ok) {
        const attribution = `${p.name}/${outcome.model}`;
        this.attribution = attribution;
        return { output: outcome.output, model: attribution };
      }
      if (outcome.kind === "rate") cooled += 1;
      last = outcome.message;
    }
    if (cooled >= configured.length) {
      throw new LlmUnavailableError(
        "all live LLM providers are cooling down after rate limits",
      );
    }
    throw new LlmRequestError(`live LLM request failed: ${last}`);
  }

  // One provider: rotate keys ONLY on 401/403 (revoked key); a 429 cools the
  // whole provider down instead of trying another key of the same account.
  private async attemptProvider(
    p: ProviderRuntime,
    prompt: string,
  ): Promise<ProviderOutcome> {
    for (;;) {
      const keyIndex = nextEnabledIndex(p, p.active);
      if (p.needsKey && keyIndex < 0) {
        return {
          ok: false,
          kind: "model",
          message: `${p.name}: all keys rejected, no usable key left`,
        };
      }
      const key = keyIndex >= 0 ? p.keys[keyIndex] : undefined;
      if (p.needsKey && key === undefined) {
        return {
          ok: false,
          kind: "model",
          message: `${p.name}: all keys rejected, no usable key left`,
        };
      }
      const outcome = await this.attemptModels(p, key, prompt);
      if (outcome.ok || outcome.kind !== "auth") {
        if (!outcome.ok && outcome.kind === "rate") {
          p.cooldownUntil = Date.now() + outcome.cooldownMs;
        }
        return outcome;
      }
      if (keyIndex >= 0) p.disabled[keyIndex] = true;
      p.active = keyIndex + 1;
      if (p.needsKey && nextEnabledIndex(p, p.active) < 0) {
        return {
          ok: false,
          kind: "model",
          message: `${p.name}: all keys rejected, no usable key left`,
        };
      }
    }
  }

  private async attemptModels(
    p: ProviderRuntime,
    key: string | undefined,
    prompt: string,
  ): Promise<ProviderOutcome> {
    let last: ProviderOutcome = {
      ok: false,
      kind: "provider",
      message: `${p.name}: no model configured`,
    };
    for (const model of p.models) {
      const outcome = await this.postChat(p, key, model, prompt);
      if (outcome.ok) return outcome;
      last = outcome;
      // 401/403 (rotate key) and 429 (cool provider) are decided by the
      // caller; model-specific 4xx falls through to the next fallback model.
      if (outcome.kind === "auth" || outcome.kind === "provider")
        return outcome;
    }
    return last;
  }

  private async attemptExplain(script: string): Promise<ExplainDetailedResult> {
    const now = Date.now();
    const configured = this.providers.filter(isConfigured);
    if (configured.length === 0) {
      throw new LlmUnavailableError(
        "no live LLM provider is configured: set a provider key and LLM_<NAME>_MODEL",
      );
    }
    let cooled = 0;
    let last = "no provider attempted";
    for (const p of configured) {
      if (p.cooldownUntil > now) {
        cooled += 1;
        last = `${p.name} is cooling down after a rate limit`;
        continue;
      }
      const outcome = await this.attemptExplainProvider(p, script);
      if (outcome.ok) {
        const attribution = `${p.name}/${outcome.model}`;
        this.attribution = attribution;
        return { explanation: outcome.explanation, model: attribution };
      }
      if (outcome.kind === "rate") cooled += 1;
      last = outcome.message;
    }
    if (cooled >= configured.length) {
      throw new LlmUnavailableError(
        "all live LLM providers are cooling down after rate limits",
      );
    }
    throw new LlmRequestError(`live LLM request failed: ${last}`);
  }

  // Same key semantics as generation: 401/403 rotates the key, 429 cools
  // the whole provider instead of trying another key of the same account.
  private async attemptExplainProvider(
    p: ProviderRuntime,
    script: string,
  ): Promise<ExplainOutcome> {
    for (;;) {
      const keyIndex = nextEnabledIndex(p, p.active);
      if (p.needsKey && keyIndex < 0) {
        return {
          ok: false,
          kind: "model",
          message: `${p.name}: all keys rejected, no usable key left`,
        };
      }
      const key = keyIndex >= 0 ? p.keys[keyIndex] : undefined;
      if (p.needsKey && key === undefined) {
        return {
          ok: false,
          kind: "model",
          message: `${p.name}: all keys rejected, no usable key left`,
        };
      }
      const outcome = await this.attemptExplainModels(p, key, script);
      if (outcome.ok || outcome.kind !== "auth") {
        if (!outcome.ok && outcome.kind === "rate") {
          p.cooldownUntil = Date.now() + outcome.cooldownMs;
        }
        return outcome;
      }
      if (keyIndex >= 0) p.disabled[keyIndex] = true;
      p.active = keyIndex + 1;
      if (p.needsKey && nextEnabledIndex(p, p.active) < 0) {
        return {
          ok: false,
          kind: "model",
          message: `${p.name}: all keys rejected, no usable key left`,
        };
      }
    }
  }

  private async attemptExplainModels(
    p: ProviderRuntime,
    key: string | undefined,
    script: string,
  ): Promise<ExplainOutcome> {
    let last: ExplainOutcome = {
      ok: false,
      kind: "provider",
      message: `${p.name}: no model configured`,
    };
    for (const model of p.models) {
      const outcome = await this.postExplain(p, key, model, script);
      if (outcome.ok) return outcome;
      last = outcome;
      if (outcome.kind === "auth" || outcome.kind === "provider")
        return outcome;
    }
    return last;
  }

  private async postExplain(
    p: ProviderRuntime,
    key: string | undefined,
    model: string,
    script: string,
  ): Promise<ExplainOutcome> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: Response;
    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      if (key !== undefined) headers["authorization"] = `Bearer ${key}`;
      res = await this.fetchFn(`${p.baseUrl}/chat/completions`, {
        method: "POST",
        redirect: "manual",
        signal: ctrl.signal,
        headers,
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: EXPLAIN_SYSTEM },
            { role: "user", content: script.slice(0, LIVE_MAX_PROMPT_CHARS) },
          ],
          temperature: 0.2,
          max_tokens: 600,
        }),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : "request failed";
      return {
        ok: false,
        kind: "provider",
        message: `${p.name}/${model}: ${reason}`,
      };
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 0 || (res.status >= 300 && res.status < 400)) {
      return {
        ok: false,
        kind: "provider",
        message: `${p.name}/${model}: unexpected redirect (${res.status}), not following`,
      };
    }
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        kind: "auth",
        message: `${p.name}: key rejected (${res.status})`,
      };
    }
    if (res.status === 429) {
      return {
        ok: false,
        kind: "rate",
        message: `${p.name}/${model}: rate limited (429)`,
        cooldownMs: parseRetryAfterMs(
          res.headers.get("retry-after"),
          Date.now(),
        ),
      };
    }
    if (res.status === 400 || res.status === 404 || res.status === 422) {
      return {
        ok: false,
        kind: "model",
        message: `${p.name}/${model}: rejected (${res.status})`,
      };
    }
    if (res.status < 200 || res.status >= 300) {
      return {
        ok: false,
        kind: "provider",
        message: `${p.name}/${model}: provider error (${res.status})`,
      };
    }

    let text: string;
    try {
      text = await readCappedText(res, this.maxBodyBytes);
    } catch (err) {
      const reason = err instanceof Error ? err.message : "unreadable body";
      return {
        ok: false,
        kind: "provider",
        message: `${p.name}/${model}: ${reason}`,
      };
    }
    try {
      const envelope = JSON.parse(text) as {
        choices?: Array<{ message?: { content?: unknown } }>;
      };
      const content = envelope.choices?.[0]?.message?.content;
      if (typeof content !== "string" || content.trim() === "") {
        return {
          ok: false,
          kind: "model",
          message: `${p.name}/${model}: missing choices[0].message.content`,
        };
      }
      return {
        ok: true,
        explanation: content.trim().slice(0, EXPLAIN_MAX_CHARS),
        model,
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : "invalid payload";
      return {
        ok: false,
        kind: "model",
        message: `${p.name}/${model}: ${reason}`,
      };
    }
  }

  private async postChat(
    p: ProviderRuntime,
    key: string | undefined,
    model: string,
    prompt: string,
  ): Promise<ProviderOutcome> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: Response;
    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      if (key !== undefined) headers["authorization"] = `Bearer ${key}`;
      res = await this.fetchFn(`${p.baseUrl}/chat/completions`, {
        method: "POST",
        redirect: "manual",
        signal: ctrl.signal,
        headers,
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: JSON_INSTRUCTION },
            {
              role: "user",
              content: prompt.slice(0, LIVE_MAX_PROMPT_CHARS),
            },
          ],
          response_format: { type: "json_object" },
          temperature: 0.2,
          max_tokens: 2000,
        }),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : "request failed";
      return {
        ok: false,
        kind: "provider",
        message: `${p.name}/${model}: ${reason}`,
      };
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 0 || (res.status >= 300 && res.status < 400)) {
      return {
        ok: false,
        kind: "provider",
        message: `${p.name}/${model}: unexpected redirect (${res.status}), not following`,
      };
    }
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        kind: "auth",
        message: `${p.name}: key rejected (${res.status})`,
      };
    }
    if (res.status === 429) {
      return {
        ok: false,
        kind: "rate",
        message: `${p.name}/${model}: rate limited (429)`,
        cooldownMs: parseRetryAfterMs(
          res.headers.get("retry-after"),
          Date.now(),
        ),
      };
    }
    if (res.status === 400 || res.status === 404 || res.status === 422) {
      return {
        ok: false,
        kind: "model",
        message: `${p.name}/${model}: rejected (${res.status})`,
      };
    }
    if (res.status < 200 || res.status >= 300) {
      return {
        ok: false,
        kind: "provider",
        message: `${p.name}/${model}: provider error (${res.status})`,
      };
    }

    let text: string;
    try {
      text = await readCappedText(res, this.maxBodyBytes);
    } catch (err) {
      const reason = err instanceof Error ? err.message : "unreadable body";
      return {
        ok: false,
        kind: "provider",
        message: `${p.name}/${model}: ${reason}`,
      };
    }
    let content: unknown;
    try {
      const envelope = JSON.parse(text) as {
        choices?: Array<{ message?: { content?: unknown } }>;
      };
      content = envelope.choices?.[0]?.message?.content;
      if (content === undefined) {
        return {
          ok: false,
          kind: "provider",
          message: `${p.name}/${model}: missing choices[0].message.content`,
        };
      }
      const parsed = LlmOutputSchema.parse(extractJsonPayload(content));
      return { ok: true, output: parsed, model };
    } catch (err) {
      const reason = err instanceof Error ? err.message : "invalid payload";
      return {
        ok: false,
        kind: "model",
        message: `${p.name}/${model}: ${reason}`,
      };
    }
  }
}

/** Honor Retry-After (seconds or HTTP date), clamped to [1s, 5m]. */
export function cooldownMsForRetryAfter(
  value: string | null,
  now: number,
): number {
  return parseRetryAfterMs(value, now);
}
