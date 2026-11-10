# Decisions

## R2-01 Slice 12: eval agent harness (stage A, offline-testable) (2026-11-10)

- **Layer split via spies, not a `runGenerate` rewrite (D-30).**
  `runGenerate` keeps its retry loop and defaults; `runEvalCase` wraps the
  injected LLM (`generate`/`generateDetailed`) and `validateAgentFn` to
  record per-attempt scripts, `staticValidate` outcomes, and agent outcomes.
  `static_ok_first_try`/`agent_ok_first_try` are false whenever the first
  script fails static (the agent is never consulted for it). No behavior
  change on the mock/stub paths — the wrapper only observes.
- **Agent mode is explicit and stub-proof (D-31).** `--agent` needs
  `--live`; `agentMode` throws when any of search/validate/probe-args is
  missing, and `--agent-url`/`--token-file` default from `AGENT_URL` then
  `AGENT_TOKEN_FILE`/`TOKEN_FILE`, else loopback/token-file defaults.
  Preflight (`checkAgentPreflight`, injectable fetch) requires reachable +
  `root: true` + `btf: true`, otherwise a non-zero exit naming the cause
  with "not falling back to stubs". Kernel/bpftrace versions flow into the
  `live+agent` report header.
- **Safety ordering for produced output (D-32).** `must_refuse` cases that
  still validate are marked `refusal_correct: false` with an
  `ACCEPTED-UNSAFE-CASE` note and are never executed; the run helper
  (`runScriptAndCountEvents`: `POST /v1/runs` 5 s + WS stream counting
  `printf`/`map`/`hist`/`lhist` until `summary`) runs only validated
  non-refusal scripts, sequentially. The mixed user-level workload stays a
  documented manual step in `docs/environment.md`, not spawned code, so CI
  and Windows checkouts never fork workload processes.
- **Persistence is scripts-only ndjson (D-33).** `toScriptRecords` keeps
  `{id, prompt: <prompt id>, script, chart_type, attempts, provider_model,
produced_status}` per generated script; no user prompt text, no tokens.
  `make run-live-real` mirrors `run-live` with `--live --agent
--delay-ms 15000`; CI untouched (no live target referenced).
- **Verified:** `tsc --noEmit` clean, eslint clean, prettier clean, api
  vitest 191/191 (23 in `eval.test.ts`: flags, preflight down/not-root/
  no-BTF, static-vs-agent counting, per-layer arithmetic, unsafe-accepted
  never run, agent-mode stub refusal, produced/skipped/error mapping,
  ndjson format, `live+agent` rendering; existing mock/stub tests
  unchanged), mock CLI smoke (`--limit 2`) renders the static-only report,
  and `--live --agent` against a dead agent exits 1 with the preflight
  message.

## R2-02 Slice 11: live client drops the last tail slice (2026-11-10)

- **Last slice removed.** `doPostChat()` sent
  `prompt.slice(0, LIVE_MAX_PROMPT_CHARS)` on the legacy no-parts path; it
  now sends the full prompt. The explain slice went in S10, so no prompt
  truncation remains on any client send path (remaining `slice` calls are
  log/error-body caps, DB field caps, and output truncation). The budget is
  enforced once in `prompts.ts` by shrinking context; the client never
  re-truncates, so the user request and retry feedback cannot be cut off.
- **`LIVE_MAX_PROMPT_CHARS` kept as an alias.** Still re-exported from
  `PROMPT_BUDGET_CHARS` for compatibility; nothing in the client reads it
  anymore.
- **Stability already proven.** The S10 wiring test asserts the system
  message is byte-identical across the initial call and the retry (feedback
  lands only in `<previous_attempt>` in the user message), which keeps
  prefix caching effective. S11 adds a regression test that an oversized
  legacy prompt arrives intact with its tail marker.
- **Verified:** `tsc --noEmit` clean, eslint/prettier clean, full api suite
  181/181 (16 in `prompt-parts.test.ts`: 15 from S10 plus the new
  no-tail-slice fallback test; every existing prompt/generate test
  unchanged).

## R2-02 Slice 10: prompt parts plus plumbing, no live behavior change (2026-11-10)

- **Parts split (D-26).** `buildGeneratePrompt()` additionally returns
  `parts: { system, context, user }` (D-15): system is the static prefix
  plus the JSON output contract plus an untrusted-data rule; context is
  recipes, probes, and arg formats under `Reference data` headings; user is
  the escaped request in a `<user_request>` block. `text` is byte-identical
  to the legacy marker format (probes still capped at 40 there), so the
  mock path, the prompt-order tests, and the eval keep working unchanged.
- **Plumbing (D-27).** `LlmClient.generate` gains an optional third
  parameter; `MockLlm` ignores it by declaring fewer parameters.
  `LiveLlmChain` uses `parts` when present (system message plus context,
  request, and retry feedback in the user message) and falls back to the
  legacy single sliced message otherwise. `generateDetailed` takes `parts`
  in its opts; `runGenerate` passes the same parts through on every
  attempt, with the `==FEEDBACK==` text suffix unchanged for the mock.
- **Escaping (D-28).** `escapeUntrusted()` neutralizes closing tags
  (`</user_request>`, `</previous_attempt>`, case-insensitive),
  `==WORD==` markers (`= =WORD= =`), and control chars except `\n`/`\t`;
  applied to the user request, the previous script, and validator errors.
  System carries no user text, is byte-identical across hostile/benign
  inputs, and is unchanged between attempts (prefix-cache friendly).
  Feedback rides only in the user message as `<previous_attempt>`.
- **Budget (D-29).** `PROMPT_BUDGET_CHARS` (24_000) lives in `llm.ts` and is
  re-exported as `LIVE_MAX_PROMPT_CHARS`, so `prompts.ts` and `live-llm.ts`
  share one constant with no import cycle. Shrink order: probes down to 15,
  then arg sections lowest-ranked first, then recipes down to 1; system,
  request, and feedback are never touched. Exhaustion throws
  `PromptBudgetError`, mapped to 502 `LLM_ERROR` in the generate route.
  Explain drops its 24_000-char slice; `ScriptSchema` (8 KiB) already
  bounds the input.
- **Verified:** `tsc --noEmit` clean, eslint/prettier clean, full api suite
  180/180 (165 existing unchanged + 15 new in `prompt-parts.test.ts`:
  shape, escaping, shrink order, impossible budget, chain wiring, retry
  stability, legacy fallback, full-script explain, runGenerate passthrough,
  mock ignores parts).

## R2-03 Slice 7: overall budget, waiter limits, 503 shape (2026-11-10)

- **Per-attempt `min(per-request, remaining)` (D-16 applied).** A
  `deadline = start + totalTimeoutMs` is captured at `generateDetailed` /
  `explainDetailed` entry; `timeoutFor()` throws `LlmUnavailableError`
  once the budget is exhausted and otherwise returns
  `min(timeoutMs, remaining)` for each `requestChat`. The configured
  `LLM_TOTAL_TIMEOUT_MS` (default 90 s) bounds one chain traversal; the
  three-stall test stays within `total + epsilon` instead of
  `3 x per-request`.
- **Fixed `retry_after_s: 90` on every `LLM_UNAVAILABLE` 503 (D-24).**
  All four `LLM_UNAVAILABLE` sites (unconfigured chain + exhausted
  budget on both routes) send `retry_after_s: 90` plus a `Retry-After: 90`
  header. Fixed, not derived from the configured budget, so clients and
  the route shape stay stable when the budget is tuned; 90 matches the
  default total budget (one budget window of backoff).
- **Waiter env names (D-25).** `LLM_MAX_WAITERS` (default 10) caps queued
  acquirers; `LLM_WAIT_TIMEOUT_MS` (default 10 s) bounds each wait. Both
  live in `EnvSchema`, `.env.example`, and the README alongside
  `LLM_TIMEOUT_MS` / `LLM_TOTAL_TIMEOUT_MS`; the chain also accepts
  ctor overrides. Overflow and wait-timeout reject with busy
  `LlmUnavailableError`, never a network call.
- **Client disconnect aborts in flight.** Each `/api/generate` and
  `/api/explain` handler creates a per-request `AbortController` from the
  response `"close"` (before `writableEnded`; `req.raw` close fires when
  the buffered body is consumed, so it cannot be used) and threads its
  signal through `runGenerate`/`explainScriptText` into `requestChat`; an
  external abort throws `LlmUnavailableError("client disconnected")`
  without cooling the provider. Semaphore slots still release via the
  existing `finally`.
- **Verified:** `tsc --noEmit` clean, eslint/prettier clean, api vitest
  green (new: env-defaults, 3-stall budget bound, explain budget, waiter
  cap, waiter timeout, disconnect abort, route 503 shape; `config.test.ts`
  budget defaults).

## R2-03 Slice 6: deadline spans headers and body (2026-11-10)

- **One timer across fetch + body in `requestChat()`.** The
  `AbortController` and `setTimeout` are created before `fetch` and the
  timer is cleared in the outer `finally`, so a stall after headers
  (slow-drip body) still trips the per-request timeout. The signal is
  passed into `readCappedText()`, whose stream reader registers an abort
  listener that calls `reader.cancel()`; a guarded check after each
  `read()` turns the cancelled read into an `AbortError` instead of a
  truncated body. Over-cap bodies still throw the byte-cap error (and now
  cancel the stream) rather than reporting a timeout.
- **Timeout is a cooling provider failure (D-23).** Fetch-abort and
  body-abort return a new `kind: "timeout"` failure (message `timed out
after <ms>`, `cooldownMs: LIVE_DEFAULT_COOLDOWN_MS`) with log outcome
  `timeout`. Like `rate`, it cools the provider and counts toward the
  all-cooling `LlmUnavailableError`; unlike model 4xx, it aborts the
  model loop and continues with the next provider. Explain paths mirror
  generation. Single-timeout error type changes from `LlmRequestError`
  to `LlmUnavailableError` when it is the only provider; no existing
  test pinned the old type.
- **Verified:** `tsc --noEmit` clean, eslint/prettier clean,
  `live-llm.test.ts` 47/47 (3 new: headers-stall timeout + cooldown +
  slot reuse under `maxConcurrency: 1`, slow-drip abort with stream
  cancel, over-cap early abort), full api suite 155/155.

## R2-04 Slice 5: JSON modes and one-time downgrade (2026-11-10)

- **`LLM_<NAME>_JSON_MODE` (`json_object` default | `tool` | `none`).**
  `discoverJsonMode()` reads the per-provider var (trimmed, case-insensitive;
  unknown or missing falls back to `json_object`). Stored per provider on
  `ProviderRuntime.jsonMode`. Payloads: `json_object` as today
  (`response_format: { type: "json_object" }`, system keeps the word "JSON");
  `tool` sends one `submit_probe` function tool with hand-written
  `SUBMIT_PROBE_PARAMETERS` plus forced
  `tool_choice: { type: "function", function: { name: "submit_probe" } }` and
  parses `choices[0].message.tool_calls[0].function.arguments` (string or
  already-parsed object); `none` sends no shaping fields.
- **Drift risk.** The hand-written schema mirrors `LlmOutputSchema`
  (`api/src/llm.ts`); they can drift when the zod contract changes. Guarded
  by a comment pointer at the constant plus a parity test that asserts 14
  samples (valid, boundaries, each invalid dimension) validate identically
  under zod `safeParse` and a dependency-free reader of the JSON Schema, and
  asserts the constant's literal shape.
- **One-time downgrade.** On a `400`/`422` whose response body matches
  `/response_format|json_object|json mode|tool/i`, the provider's mode flips
  to `none` (module-level set, so it holds for every chain in the process)
  and the same call retries once without cooldown; anything else on
  `400`/`404`/`422` keeps the model-fallback path. Downgrade warns once per
  provider per process. `requestChat` failure results carry a best-effort
  `errorBody` (capped 2000 chars) to support the match; unreadable bodies
  stay `undefined`.
- **Verified:** `tsc --noEmit` clean, eslint/prettier clean, `live-llm.test.ts`
  44/44 (8 new: mode parsing, three stub-HTTP `127.0.0.1:0` mode cases,
  schema parity, json_object-400 and tool-422 downgrade retries, non-JSON 400
  no-downgrade), full api suite 152/152.

## R2-04 Slice 4: per-call logs and token usage (2026-11-10)

- **Optional logger ctor param, pino child in `server.ts`.**
  `LiveLlmChain` accepts `ChainLogger { warn; info? }` (default no-op, so
  tests stay quiet). `server.ts` builds `app.log.child({ component:
"live-llm" })` once and adapts it (`warn`/`info` forward to the child),
  so startup and per-call lines go through pino with the component field
  instead of a bare `{ warn }` wrapper.
- **One info line per provider call.** `postChat`/`postExplain` log via
  `logCall` with exactly `provider`, `model`, `key_index` (number, `-1`
  when keyless, never the key), `status` (HTTP code, `0` with no
  response), `outcome` (`ok`, `rate_limited`, `auth`, `bad_request`,
  `server`, `timeout`, `too_large`, `redirect`, `output_invalid`),
  `latency_ms`, `prompt_chars` (sent length), `usage` (when reported),
  plus `error` (provider/model-prefixed message, single-line, capped at
  200 chars) and `error_name` on failures. Never prompt/response text,
  headers, keys, or raw error objects. Fallback behavior (`auth` rotates
  the key, `429` cools the provider, `4xx` tries the next model) is
  unchanged; the log taxonomy is finer than the returned kinds.
- **Startup info line.** One `info` at construction: `mode: "live"` plus
  per-provider `name`, `models`, and key count only.
- **Usage parsing.** `parseUsage()` reads numeric `usage.prompt_tokens` /
  `usage.completion_tokens` (floor, ignore garbage) and exposes them as
  optional `LlmDetailedResult.usage`. `runGenerate` forwards each
  attempt's usage through an optional `onUsage` callback (no signature
  change for `server.ts`); the eval sums it across retries into
  `EvalCaseResult.usage` and `EvalSummary.tokens_real_total`, rendering
  `| tokens real total |` when nonzero while keeping the approx total
  labelled "approx". No DB migration (D-18); storage stays logs + eval
  report only.
- **Verified:** `tsc --noEmit` clean, eslint/prettier clean, full api
  suite 144/144 (10 new: usage parse, per-call fields, key-index
  rotation, 8-outcome mapping, startup line, eval real/summed/approx
  paths, pino-capture hygiene in `keys-hygiene.test.ts`).

## R2-04 Slice 3: remove generic model fallback (2026-11-10)

- **`discoverModel()` reads only `LLM_<NAME>_MODEL`.** The generic
  `LLM_MODEL` fallback is deleted, so a key without its own model leaves
  `models` empty and the existing `isConfigured` check marks the provider
  `unconfigured` (no network, `503 LLM_UNAVAILABLE` when nothing is
  configured). Header and doc comments updated to match.
- **Deprecation path.** `LLM_MODEL` stays in `config.ts` for parse
  compatibility but defaults to `"mock"` (mock-mode label only); removed
  from `.env.example`. `LiveLlmChain` calls
  `warnDeprecatedGenericModel()` at construction, which reads
  `process.env` directly and warns once per process with exactly
  "LLM_MODEL is deprecated and ignored; use LLM_<NAME>_MODEL" when set
  with `LLM_MODE=live`. `resetDeprecatedGenericModelWarnForTests()` is a
  test-only reset for the once flag.
- **Tests.** `live-llm.test.ts` model case now asserts generic is ignored
  (`null`); new cases cover unconfigured-without-model and the
  warn-once/leak-never-sent path; `config.test.ts` asserts the `mock`
  default. Remaining `claude-sonnet-5-5` hits (`README.md` config row,
  `generate.test.ts` live fixture label) stay for the R2-05 docs slice.
- **Verified:** `tsc --noEmit` clean, eslint/prettier clean, api vitest
  green.

## R2-04 Slice 2: base-URL validation (2026-11-10)

- **Exported `validateBaseUrl()` in `api/src/live-llm.ts`.** `https:`, or
  `http:` only for `127.0.0.1`/`localhost`/`::1` (`[::1]` form included) plus
  `host.docker.internal`; rejects credentials, query, fragment, non-http(s)
  schemes, and unparseable input; strips trailing slashes. Failure reasons
  name only the host so they are safe for health/logs.
- **Override, don't replace.** `LLM_<NAME>_BASE_URL` overrides a known
  preset only when valid; otherwise that provider gets `baseUrl: ""`
  (existing `isConfigured` marks it `unconfigured`, so no `Authorization`
  header can reach the network) plus one construction-time `warn` and a
  host-only `reason` on `LiveProviderSnapshot`. `LLM_CUSTOM_BASE_URL` keeps
  its keyless (`needsKey = keys.length > 0`) behavior under the same rule.
- **Minimal logger seam.** `ChainOptions.logger` is `{ warn }`-only with a
  no-op default (tests stay quiet); `server.ts` passes
  `{ warn: (msg) => app.log.warn(msg) }`. The per-call pino logger of slice
  (d) can widen this without conflict. `LlmProviderHealthSchema` gains an
  optional `reason` (max 300 chars); ready providers omit the key, so
  existing exact-match health assertions still pass.
- **Verified:** `tsc --noEmit` clean, eslint/prettier clean, full api suite
  131/131 (28 in `live-llm.test.ts` incl. the validation table, override,
  and credential-hygiene cases; 2 in `keys-hygiene.test.ts` incl. the new
  credentialed-URL rejection probe).

## R2-04 Slice 1: shared live-LLM transport (2026-11-10)

- **One request path.** `postChat()` and `postExplain()` duplicated fetch,
  redirect/status handling, and body-cap reads. Extracted `requestChat()` +
  `classifyResponse()` in `api/src/live-llm.ts`, used by both; the two
  callers now only build their payload and parse `text`. Error strings,
  status mapping, key-rotation/cooldown behavior, timeouts, and caps are
  byte-identical to before.
- **Timer lifecycle untouched.** `clearTimeout` still runs when `fetch`
  resolves (headers received). Spanning headers + body and the total
  deadline belong to R2-03; this slice intentionally changes no timing.
- **Public surface stable.** `parseChain`, `discoverKeys`,
  `discoverFallbackModels`, `discoverModel`, `cooldownMsForRetryAfter`,
  constants, error classes, and `LiveLlmChain` shape unchanged; no version
  bump (target stays 0.3.0). New `TransportFailure` / payload types are
  module-private.
- **Verified:** `tsc --noEmit` clean, prettier/eslint clean,
  `live-llm.test.ts` 19/19 unchanged, full api suite 121/121.

## R-26: Release preparation v0.2.0, local only (2026-11-10)

- **Version bumps: 4 `package.json` files to `0.2.0`** (root, `api`, `web`,
  `packages/schemas`). No agent version constant exists — the agent reports
  only the runtime bpftrace version (`health.go`), so there was nothing to
  bump there. No other `version:` fields in the repo outside `pnpm-lock.yaml`
  (dependency pins, untouched).
- **`CHANGELOG.md` finalized from the R-15 draft.** `## [Unreleased]` became
  `## [0.2.0] — 2026-11-10`; the "stays with R-26" paragraph now records the
  local tag and the maintainer push/publish step. `RELEASE_NOTES_v0.2.0.md`
  needed no content change (numbers already match the R-02/R-07 evidence);
  its draft banner stays until the maintainer publishes.
- **`SECURITY.md` deliberately untouched.** Its `0.1.x` supported line stands
  until `v0.2.0` is _published_, not merely tagged; the CHANGELOG security
  note now says exactly that.
- **`docs/launch.md` is drafts only, never posted.** Five drafts (Show HN,
  r/linux, r/devops, r/ebpf, X thread) reusing the README's own Postman/`curl`
  analogy and the committed live-eval numbers.
- **Release gate verified before tagging:** R-01 (#17), R-02 (#19), R-12
  (#28), R-13 (#29), R-15 (#41), R-16 (#31), R-17 (#32), R-18 (#33), R-19
  (#34), R-20 (#35), R-21 (#36), R-22 (#37), R-23 (#38) all merged; P1
  (R-04–R-11) merged with untestable platforms labeled "untested" per D-9.
  Gate run 2026-11-10: recipes-check 10/10, `go vet`/`gofmt`/`golangci-lint`
  clean, `tsc --noEmit` clean (api, web), `shellcheck` clean, `eslint` clean,
  `prettier --check .` clean for every tracked file, api vitest 121/121, web
  vitest 46/46, agent `go test ./...` and `go test -race ./...` all packages
  ok. Two environment notes, both pre-existing and unrelated to this diff:
  (a) `prettier --check .` also flags untracked `remaining.md` (orchestrator
  scratch, left untouched); (b) agent tests cannot execute on Windows (the
  `.sh` fixture replay is not a Win32 executable, and AppControl blocks the
  compiled parser test binary), so they were run in WSL from a byte-identical
  copy (`agent/` + `scripts/fake-bpftrace.sh` + `fixtures/`), then the copy
  was deleted. Tag `v0.2.0` created locally with `git tag -a`; nothing
  pushed, no PR raised — branch and tag stay local per D-12.
- **No test-sync item.** Version bumps, changelog finalization, and launch
  drafts change no logic; verification is the green `make lint && make test`
  gate run itself.

## R-15: README and docs truth pass (2026-11-10)

- **Next release is `v0.2.0`, not `v0.1.1` (D-4 confirmed).** Changes since
  the `v0.1.0` tag are new features and API additions (live generation,
  explain, run summaries, generation binding), so semver minor applies.
  `CHANGELOG.md` (Keep a Changelog) and draft `RELEASE_NOTES_v0.2.0.md`
  created; version bumps, the annotated tag, and publishing stay with R-26.
  `SECURITY.md` supported line stays `0.1.x` until `v0.2.0` ships.
- **`loadConfig` ignored `LLM_PROVIDER_CHAIN` (fixed).** `EnvSchema`
  declared it but `loadConfig` never passed the env value through, so any
  configured chain silently became `groq`. One-line fix plus
  `api/src/config.test.ts` regression test. Chosen over doc-weakening
  because ordered fallback is core R-01 behavior.
- **`make -C eval run-live` paced too fast (fixed).** The Makefile default
  `--delay-ms 2000` reproduces the R-02 run-1 `429` collapse; the verified
  run used `15000` (~8 min wall clock). Makefile default raised to `15000`
  to match the README command and R-02 evidence.
- **Go badge drift (fixed).** README badge and two mentions said Go 1.23;
  `agent/go.mod`, `agent/Dockerfile`, CI, and docs all pin 1.27 since R-21.
  README corrected to 1.27.
- **Stale counts corrected.** Fixtures cover all 10 recipes (was "5 of
  10"); eval adversarial row now reads 4/4 refused with 30/30
  refusal-correct overall, matching `eval/reports/2026-11-09-live.md`.
- **Privacy wording updated.** The old "unless you explicitly use an
  'Explain these results' feature when it is available" predated R-12;
  README now states the Explain button sends only script text and probe
  output is never sent to the LLM, matching `EXPLAIN_SYSTEM` and
  `docs/security.md`.
- **Duration/`BPFTRACE_*` rows clarified, not re-plumbed.** Values match
  the agent/API enforced caps, but they are compiled defaults rather than
  live env knobs; the README footnote now says so. Making them truly
  env-driven is a follow-up, not folded into this diff.
- **Verified:** every README link resolves to a file in the repo, and
  every `make` target named in the README (`setup`, `lint`, `test`,
  `test-integration`, `api-dev`, `web-dev`, `eval`, `eval run-live`)
  exists in `Makefile` / `eval/Makefile`.

## R-24: Demo GIF without a human (2026-11-10)

- **`scripts/make-demo.sh` owns the whole pipeline.** Fixture build (`VITE_FIXTURE_MODE=1`), loopback `vite preview`, Playwright record (`web/playwright.demo.config.ts`, video on), ffmpeg palette GIF to `docs/assets/demo.gif` (640 px, 8 fps, bayer dither; 560 px/7 fps fallback), with an 8 MB hard gate. Result: 63 s, 6.2 MB.
- **`web/e2e/demo.spec.ts` is excluded from the default suite** (`testIgnore`), so CI `test:e2e` stays mock-only. Prompts map to fixture chart kinds by keyword (`histogram`→hist, `start`→events, else bar); backend health/recipes are route-stubbed so the tape shows "agent online" with no API running.
- **Fixture bug fixed, not worked around.** Switching chart type between generations re-ran `useRunStream` with the stale runId and phantom-started the old run (`setRunPhase("running")` unconditionally). The effect now attaches only when a run is in flight (`starting`/`running`/`stopping`); regression test in `useRunStream.test.tsx`. No reload hacks in the demo.
- **Recording runs where the toolchain is.** WSL has no node, so the committed GIF was recorded on Windows with the same commands the script runs; `shellcheck` is clean. Fixture data is synthetic (`bash`/`curl` pids, in-kernel aggregates), so no paths, usernames, or keys appear.

## R-23: Security and community files (2026-11-10)

- **Root `SECURITY.md` is a thin pointer, `docs/security.md` stays canonical.** The root file holds only the supported-versions table (latest minor line, `0.1.x`, only), the GitHub private vulnerability reporting link ("Security" tab, "Report a vulnerability"), and the 3-business-day acknowledgement target. No email contact anywhere, per D-6.
- **`CODE_OF_CONDUCT.md` is Contributor Covenant 2.1 verbatim except enforcement.** The `[INSERT CONTACT METHOD]` slot points at the same private channel (Security tab report) or the repository owner, so conduct reports stay out of public issues and no inbox needs monitoring.
- **README no longer duplicates the reporting instructions.** The privacy section points at `SECURITY.md`; the contributing section points at `CODE_OF_CONDUCT.md` and `SECURITY.md`. `CONTRIBUTING.md` already carries the private-reporting line, so it was left untouched.

## R-19: SQLite hygiene (2026-11-10)

- **Pragmas on every connection (`applyPragmas`, called by both `openDb` and `migrate`).** `journal_mode=WAL` (kept), `foreign_keys=ON`, `busy_timeout=5000`, `synchronous=NORMAL`, `trusted_schema=OFF`. `migrate` re-applies them so test/raw handles get them too; scope is the two API entry points (`openDb` in `server.ts`/`eval.ts`), no pooling layer exists to update.
- **`PRAGMA user_version` steps 1→3, no try/catch `ALTER`.** Fresh databases build the v1 baseline then walk the same steps as legacy files; each step runs in its own transaction and stamps the version. A `user_version` newer than `SCHEMA_VERSION` throws instead of silently running (fail fast on downgrade).
- **FK constraints only on fresh tables.** `generations.session_id REFERENCES sessions(id)` and `runs.generation_id REFERENCES generations(id)` are in the baseline `CREATE TABLE`; pre-existing files keep their shape (SQLite cannot `ADD CONSTRAINT`, and a rebuild risks data for no gain — the API already rejects unknown `generation_id` before insert). Enforcement is pragma-level for legacy DBs, constraint-level for new ones.
- **`PRAGMA optimize` on shutdown.** New `closeDb` runs `optimize` then closes; `server.ts` `onClose` uses it. `eval.ts` never closed its handle (unchanged, out of scope).
- **Tests.** v0.1.0-file migration (exact v0.1.0 DDL, rows preserved, defaults backfilled, idempotent), FK rejection on both child tables plus a valid-insert control, pragma-value assertions, newer-schema rejection; the R-18 test now seeds parent rows for the new constraint.

## R-18: Bind runs to confirmed generations (2026-11-10)

- **Unknown `generation_id` rejected before the agent call (404 `NOT_FOUND`).** Failing fast avoids occupying the agent's single-run slot on bad input. The agent still independently re-validates every script on run creation; the binding never bypasses it (covered by a `bad-probe` proxy test).
- **`edited` is exact string inequality** (`script !== generation.script`). No normalization: any byte difference counts as edited. `script_sha256` is stored but never returned by `GET /api/runs/:id` (per the R-13 exclusion); `generation_id`/`edited` are metadata and are returned.
- **Migration reuses the existing try/catch `ALTER` pattern** (`generation_id`, `script_sha256`, `edited`), so pre-R-18 database files upgrade in place; fresh databases get `edited` in `CREATE TABLE`. Idempotent, verified by `db.test.ts` against an old-schema file.
- **UI wiring deferred.** `createRun` still posts script-only; passing the confirmed `generation_id` from the confirm modal is a follow-up, not part of this diff.

## R-16: Agent WebSocket origin allowlist (2026-11-10)

- **Default deny, explicit allowlist.** `handleStream` passes `Config.AllowedOrigins` to `websocket.Accept` as `OriginPatterns`; empty (the default) refuses every browser `Origin` with 403. Requests without an `Origin` header (server-to-server, like the API relay dial) and same-host origins are always accepted by the library, so the API path keeps working with no change.
- **Bearer token still gates first.** The `auth` middleware wraps the stream route, so a missing/wrong token is 401 before origin is even evaluated; origin is defense-in-depth, not the primary gate.
- **Config surface mirrors the token file.** `AGENT_ALLOWED_ORIGINS` (comma-separated, `server.SplitOrigins`) with a `--allowed-origins` serve-flag override; entries use the library's `path.Match` semantics (plain host or `scheme://host`).
- **Verification.** New `origin_test.go`: browser `Origin` → 403 by default, no-`Origin` + valid token → stream reads, allowlisted `Origin` → stream reads, non-allowlisted → 403, bad token → 401.

## R-14: Sessions and export, Option A (2026-11-10)

- **Client-side history for this release; server-side sessions deferred to v0.3.** History entries persist in browser localStorage (`vbpf:history:v1`, cap 50 entries, 200 sampled events each) with re-run and JSON-download export per entry. Smallest change: already works, no new routes.
- **No server sessions/export API.** `generations.session_id` groups rows in SQLite and the API accepts an optional `session_id` on generate, but there is no sessions store, list/get endpoint, or server export. The UI footnote and code comment already state this; README now says so too.
- **Export verified secret-free.** `exportEntry` emits only `exported_at`, `prompt`, `script`, `chart_type`, `explanation`, `duration_s`, `warnings`, `run_id`, `exit_reason`, `events_sample` — no keys, tokens, or credentials. Probe output samples may echo observed paths by nature of tracing; fixtures stay scrubbed per R-06.

## R-13: Run summaries and GET /api/runs/:id (2026-11-10)

- **Persistence point is the API WS relay.** Summary envelopes forwarded upstream→client also update the `runs` row (`state`, `ended_at`, `events_count`, `bytes`, `dropped`, `exit_reason`). Stream end covers both natural completion and timeout, since the agent ends every run with a summary event.
- **`exit_reason` → `state` mapping mirrors the agent's `finalState`.** `completed`/`timeout` → `completed`, `cancelled` → `stopping`, anything else (`failed`, `limit_bytes`, unknown) → `failed`.
- **Stop paths mark `stopping` + `ended_at` immediately** (`POST /api/runs/:id/stop` and a `stop` message over the run websocket). Counts arrive with the later summary event if a stream is attached; a run stopped with no stream attached keeps `summary: null`. No backfill: the agent has no GET-run endpoint to poll, and adding one is out of scope.
- **`GET /api/runs/:id` returns metadata + summary only** (`run_id`, `state`, `duration_s`, `started_at`, `ended_at`, `summary`). `script_text`/`script_sha256` are deliberately excluded. Unknown, empty, or overlong ids are 404 `NOT_FOUND`.
- **No migration.** The `runs` table already had `ended_at`, `events_count`, `bytes`, `dropped`, and `exit_reason` columns; only the writes were missing.

## R-12: /api/explain and the Explain panel (2026-11-10)

- **Shared rate-limit bucket with generate.** One fixed-window limiter (10 req/min/IP) guards both `POST /api/generate` and `POST /api/explain`; a generate consumes explain budget and vice versa. Reason: both hit paid LLM quota, and one shared budget is the smallest change that protects free-tier limits.
- **Static failures are 422, not LLM calls.** `staticValidate` runs before cache lookup and before any provider call; blocked scripts return `422 VALIDATION_FAILED` with the error list and never reach the network (verified by test asserting zero stub-fetch calls).
- **Cache keyed by SHA-256 in a new `explanations` table** (`script_sha256` PK, explanation, model, created_at), via `INSERT OR REPLACE`; only successful explanations are stored.
- **Mock mode matches on trimmed body equality** (`body.trim() === script.trim()`) and returns the recipe's `description`; otherwise a fixed generic sentence. Rationale: trailing-newline differences between generated and stored bodies should not defeat the match.
- **Live explain reuses the R-01 chain, not the generate path.** New `LiveLlmChain.explainDetailed` posts the same short system prompt with the script as the user message (no `response_format: json_object`), same key-rotation (401/403), provider-cooldown (429), fallback-model, timeout, body-cap, and semaphore semantics. Key rotation on 429 stays forbidden by design.
- **Web keeps the generation summary and adds a walkthrough section.** `ExplainSection` posts `{ script }`, shows "Explaining…" while pending, `role="alert"` on error with a retry label, and `via <model> · cached` attribution on success. Editing the script invalidates a prior walkthrough. Fixture mode returns canned text without network.

## R-10: Docker and e2e (2026-11-10)

- **"Fails fast" means abort on terminal state.** R-10 asks that
  `quickstart.sh` fail fast on unhealthy services; the script previously
  slept the full 36×5 s even when a service was already `unhealthy`. The
  loop now exits immediately on `unhealthy`/`exited`/`dead`, while
  `starting`/`created`/`restarting` still get the full wait (a container
  observed mid-startup must not be mistaken for a dead one). Verified with
  a stubbed-`docker` harness (unhealthy → exit 1 in 0 s; healthy and
  starting→healthy → exit 0).
- **Stop-after-timeout 404 is expected, not a bug.** The container E2E run
  ended by its own 10 s timeout before `/stop` was called, so the API
  correctly returned 404 `NOT_FOUND`; the streamed summary
  (`exit_reason "timeout"`, 0 dropped) is the run's completion record.
- **Local e2e needed no fix.** Both Playwright specs passed first run;
  vite proxy ECONNREFUSED lines are inherent to the mocked setup, not
  flakes.

## R-07: Real produced-output (2026-11-10)

- **Recipe scripts stand in for generations.** The eval harness does not persist generated scripts, and the live report's probe-match was 26/26, so generations use the same probes as the 10 recipes. 9/10 produced events in the 5 s window; zero live LLM calls needed.
- **dns workload is python, not getent.** `getent hosts localhost` produced zero `getaddrinfo` uprobe hits over 15 s (it bypasses `getaddrinfo` on this libc); python `socket.getaddrinfo` hits reliably (227-hit direct-bpftrace control run). `scripts/produced-output.sh` uses the python loop.
- **Harness deadlock fixed before commit.** First script version called bare `wait` before killing the `tcp-connects` http.server, wedging the run; fixed to kill all workloads first, single `wait` after (shellcheck-clean).
- **slow-disk-io 5 s zero is a measurement.** Recipe counts only ≥10 ms block IO; a 10 s retest with the same workload class produced 1 map event, so the recipe works — the window had no slow IO. Recorded `no`, not a failure.
- **No leftovers.** `pgrep -a bpftrace` empty, `tc qdisc show dev lo` back to `noqueue` after the run.

## R-05: Unrun tests (2026-11-10)

- **Stale kill-mid-run assertion.** `TestIntegrationKillMidRun` (never run on a real kernel before) asserted the post-DELETE summary `exit_reason` is `completed`/`timeout`, but the runner's ctx-cancel path reports `cancelled` — already unit-tested (`runner_test.go`) and mapped to run state `"stopping"` by `finalState`. Fixed the test to expect `runner.ReasonCancelled`; no production code changed.
- **Root `go` PATH gap.** Same class as D-R04-1: Go 1.26.2 lives in the user's local bin, absent from root's PATH. Invocations pass `GO=/home/faizan/.local/bin/go`; no Makefile change.

## R-02: Live eval and prompt tuning (2026-11-10)

- **Run 1 (baseline, invalidated by rate limits).** `eval --live --delay-ms 2000` against `groq/openai/gpt-oss-120b`: 11/11 attempted generatable cases compiled first-try (100%), adversarial-03 correctly refused ("Reading /etc/shadow is disallowed"). After 7 calls the provider returned 429; the chain cooled down (60 s, `Retry-After` honored) and the remaining 19 cases failed with `attempts: 0`. Verdict: numbers measure pacing, not model quality — no prompt change made (tuning round 0 of 3).
- **Pacing fix for run 2.** Free-tier 429s kill the rest of a run because cooldown is process-lifetime by design (R-01: 429 never rotates keys). Re-running with `--delay-ms 15000` (~8 min wall clock, still ≤90 calls). Agent validation stays stubbed (stock runner, no root); compile = static validator only.
- **Run 2 (real signal, 2026-11-10).** 25/26 generatable first-try (96%), 25/26 within retries (96%), view/probe-match 25/25, adversarial 2/4. Failures are not model quality: `direct-08` died on a transport `fetch failed`; `adversarial-02/03` were refused in prose but returned `chart_type: null, duration_s: 0`, failing `LlmOutputSchema` before the retry loop. No validator change.
- **Run 2 (real signal, 2026-11-10).** 25/26 generatable first-try (96%), 25/26 within retries (96%), view/probe-match 25/25, adversarial 2/4. Failures are not model quality: `direct-08` died on a transport `fetch failed`; `adversarial-02/03` were refused in prose but returned `chart_type: null, duration_s: 0`, failing `LlmOutputSchema` before the retry loop. No validator change.
- **Tuning round 1 (of 3).** `api/prompts/system.md`: refusal must keep the contract valid (`script: ""`, `chart_type: "events"`, `explanation`: the refusal reason, `duration_s: 10`). Regression test asserts the assembled prompt carries the refusal-contract wording. Run 3 re-runs the full set.
- **Run 3 (targets met, 2026-11-10).** 26/26 generatable first-try (100%), 26/26 within retries, view/probe-match 26/26, refusal-correct 30/30 (adversarial 4/4). Model `groq/openai/gpt-oss-120b`, `--delay-ms 15000`, ~30 LLM calls. Report `eval/reports/2026-11-09-live.md`; README eval table now shows live numbers labeled with mode and model. Agent validation still stubbed (no root); produced-output stays SKIP for P1 (R-07). One prompt-tuning round used of 3; live runs used 3 of 3/day.

## R-01: Live LLM client with provider fallback (2026-11-10)

- **Chain default `groq`.** `LLM_PROVIDER_CHAIN=groq` in `.env.example` and local `.env`. Supported presets: `groq`, `cerebras`, `openrouter`, `ollama`, `custom` (`LLM_CUSTOM_BASE_URL`).
- **Gemini preset included.** Google's official docs (ai.google.dev Gemini API OpenAI compatibility) confirm the OpenAI-compatible base URL `https://generativelanguage.googleapis.com/v1beta/openai`, so `gemini` ships as a preset alongside `custom`.
- **Key semantics.** `401/403` disables the key for the process lifetime and advances to the next key; `429` never rotates to another key of the same provider (shared account quota, and rotation could violate provider terms) — the provider cools down (default 60 s, `Retry-After` honored, capped at 5 m) and the chain moves on.
- **Model choice (live probe 2026-11-10).** `GET <groq-base>/models` returned 11 IDs; after dropping non-chat IDs (whisper/tts/guard/embed/transcri/moderation/speech/playai) and preferring production over preview/beta/experimental and larger instruct models first, JSON-mode smoke tests gave: winner `openai/gpt-oss-120b` (200, passed `LlmOutputSchema`). `allam-2-7b` returned 200 but failed the schema; three audio models returned 400; one request reset mid-probe. No passing alternates, so `LLM_GROQ_FALLBACK_MODELS` is left unset by default. Written to local `.env` only (`LLM_GROQ_MODEL=openai/gpt-oss-120b`); `.env.example` keeps a comment-only placeholder.
- **Attribution without races.** `runGenerate` prefers `generateDetailed()` (per-request `{output, model}`) over the shared `llm.model` getter, so concurrent requests record the right `provider/model` in `generations.model`.
- **Health shape.** `GET /api/health` gains an optional top-level `llm: {mode, providers[]}` block (`ready`/`cooldown`/`unconfigured`/`exhausted`, key counts, no key material). Mock mode reports `{mode: "mock", providers: []}`; existing contract tests updated. No model IDs or keys are hardcoded in code or logs.
- **Transport guards.** `redirect: "manual"` (3xx fails over, never followed), 256 KB response cap, 45 s timeout, 4-way concurrent-request semaphore, 24 k-char prompt cap.
- **Errors.** No usable provider (or all cooling) → 503 `LLM_UNAVAILABLE`; providers tried but unusable → 502 `LLM_ERROR`. Mock mode and CI are unchanged (no secrets, live 503 only when unconfigured).
- **Live verification (2026-11-10).** With local keys and `LLM_MODE=live`, `POST /api/generate` for "Which processes open the most files?" returned 200 `validation ok` in 1 attempt; `generations.model` = `groq/openai/gpt-oss-120b`; health showed groq `ready` with 3 keys. Real-agent validation was out of scope here (no root); agent validation used a stub.

## R-03: Real tracepoint argument formats (2026-11-10)

- **Agent `GET /v1/probe-args?probe=<name>` (authenticated).** Probe must exactly match a catalog entry (`Catalog.Contains`); anything else is 404 `NOT_FOUND` before any exec, so odd names (`;`, `$()`, `*`, paths) never reach the process. Empty/too-long (>256 chars) is 400 `VALIDATION_FAILED`. Exec is argv-only (`bpftrace -vl <probe>`, no shell) with a 3 s timeout and output capped at 8 KB; timeout → 504 `TIMEOUT`, exec failure → 500 `PROBE_ARGS_FAILED`.
- **API injection in `runGenerate`.** Candidates are the top 1-3 tracepoints: exact `tracepoint:cat:name` matches from recipe bodies first, then catalog probes from search (wildcards skipped). Each fetched via `fetchProbeArgs` (3 s timeout, 8 KB cap), formatted as `<probe>:\n<output>` with each output truncated to 2000 chars, and inserted into `==ARG_FORMATS==`. Any per-probe failure is skipped; if all fail, the prompt uses `ARG_FORMATS_FALLBACK` (previous stub text, renamed — `ARG_FORMATS_STUB` export is gone).
- **Live check.** WSL2 (Ubuntu, bpftrace v0.20.2, root): `bpftrace -vl 'tracepoint:block:block_rq_issue'` returns the struct (`dev`, `sector`, `nr_sector`, `bytes`, `rwbs`, `comm`, `cmd`), well under 8 KB. Agent binary itself was not run against WSL here (Go tests cover the handler with an injected `ProbeArgsFunc`); real-agent E2E stays with P1.

## R2-01 Slice 13: final real run (stage B) + 2 tuning rounds (2026-11-10)

- **Operator setup (D-33).** Branch feat/r2-01-s13-real from main 355738a. Agent bin/agent serve as root via wsl -u root with a user-created token file; /health reported root: true, btf: true, kernel 6.6.87.2-microsoft-standard-WSL2, bpftrace v0.20.2. Live chain groq/openai/gpt-oss-120b (3 local keys, never committed). Mixed user-level workload (find/true/http.server+curl/getaddrinfo/dd loops, normal user, no tc/netem) ran detached during every full run; all loops plus the agent were stopped and pgrep-verified clean afterwards. Token file lives at gitignored run/agent.token.
- **Portable make live targets (D-34).** eval/Makefile run-live/run-live-real used pnpm run eval with a -- separator: under cmd/make the literal -- is forwarded to eval-cli (unknown flag --), while PowerShell strips it. Fixed to forward args without the separator. pnpm exec was tried first but fails under make shell. Verified via mock --limit runs under cmd. CI (make eval, mock-only, Linux) is unaffected.
- **Relative token-file default (D-35, known footgun, not changed).** AGENT_TOKEN_FILE=./run/agent.token resolves against the api/ cwd when invoked via pnpm, so bare make fails preflight (agent token unreadable). Workaround: absolute AGENT_TOKEN_FILE env override. Left unchanged for a later slice; recorded so the next run does not rediscover it.
- **Windows Node crash, one lost run (D-36).** One full attempt crashed about 1.5 min in with exit 3221226505 (0xC0000409) right after a 15.5k-event/1.2 MB produced-output stream; no report, no Application-log entry. The identical retry completed cleanly: treated as a flaky native crash, not a harness bug. Budget used today: 1 spawn-fail + 1 partial + 3 full live runs (smoke --limit 2 separate). No further full runs today.
- **Tuning round 1 (D-37).** Baseline: first-try 20/26, within-retries 21/26, adversarial 4/4, produced 19/21. Misses: direct-03/paraphrased-03 (uprobe:libc:getaddrinfo rejected by dry-run catalog), direct-06 (invented tracepoint:mm_vmscan:direct_reclaim_begin), direct-05 (sched_process_fork arg errors), direct-10 (false refusal on packet-loss tracing). In-scope changes: GOTCHAS gained exec-not-fork, software:page-faults, tcp_retransmit_skb lines; system.md refusal policy gained bounded-observability-is-legitimate. A recipe change to the resolved uprobe path was tried and REVERTED after direct /v1/validate + /v1/runs probes proved both uprobe forms fail with PROBE_NOT_FOUND (4-way matrix, all rejected). Validation run: 23/26 within-retries, refusal 30/30, first-try still 20/26.
- **Tuning round 2 (D-38).** direct-10 then failed as invented tracepoint:net:net_dev_xmit_drop, so the TCP gotcha gained a negative clause (tracepoint:net:* does not exist). Final run: direct-10 passes first-try, but direct-06 regressed to invented tracepoint:oom:killer (model variance). Final: first-try 20/26 (76.9%, target 80% MISS), within-retries 23/26 (88.5%, target 95% MISS), adversarial 4/4 PASS, produced 20/23 (87.0%, target 80% PASS), correct-refusal 30/30, static 26/26, probe-match 23/23, view-match 22/23, real tokens 68028. No round 3: within-retries is unreachable in-scope (see D-39) and the live-run budget is spent.
- **Gap analysis (D-39, real numbers published as-is).** (1) uprobe dry-run catalog gap: the agent catalog (built from bpftrace -l, which never enumerates uprobes) rejects every uprobe script at /v1/validate AND /v1/runs, while direct bin/agent run attaches the same probe fine (R-07: 101 events). This blocks the dns-lookups cases permanently for prompt-only tuning; fixing it needs agent catalog work (later slice, never by loosening validation). (2) Dry-run feedback quality: direct-05 retries got BTF-debug plus AST-dump noise instead of the actionable compiler error, so the retry loop could not self-correct (feedback-extraction work, out of scope). (3) Model probe-invention variance across identical runs caps first-try gains from static gotchas; run-to-run swing was about 1 case. README/CHANGELOG eval-table updates stay with R2-05; the old static report is header-noted as superseded here.
