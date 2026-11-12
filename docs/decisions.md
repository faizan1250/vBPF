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

- **Unknown `generation_id` rejected before the agent call (400 `VALIDATION_FAILED`).** Failing fast avoids occupying the agent's single-run slot on bad input. The agent still independently re-validates every script on run creation; the binding never bypasses it (covered by a `bad-probe` proxy test).
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

## R2-05 Slice 15: docs truth pass (2026-11-10)

- **Config table (D-40).** README drops the `LLM_MODEL` row entirely instead of marking it deprecated in place: the variable is ignored by the live chain, so a table row would imply it works. One sentence in the providers section records the deprecation (`LLM_MODEL` is mock-label only; setting it with `LLM_MODE=live` logs one warning). New rows cover exactly the env the code reads: `LLM_<NAME>_MODEL` (required, else `unconfigured`), `LLM_<NAME>_FALLBACK_MODELS`, `LLM_<NAME>_JSON_MODE` (unknown values fall back to `json_object`, matching `discoverJsonMode`), `LLM_<NAME>_BASE_URL`, `LLM_CUSTOM_BASE_URL`, plus the four timeout/wait vars already documented. `.env.example` gains comment-only `LLM_GROQ_JSON_MODE` and `LLM_GROQ_BASE_URL` examples; `LLM_MODEL` was already absent. No `claude-sonnet-5-5` remains in any doc, config default, or `.env.example` (the `generate.test.ts` live-fixture label is a test string, not a default, and is untouched).
- **Hash-checked wording (D-41).** Safety-model row now uses the D-21 sentence verbatim (stores SHA-256 plus an `edited` flag; no client-hash verification). `docs/security.md` carries no hash claim, so nothing changed there.
- **Eval table (D-42).** README shows the real-agent numbers (model `groq/openai/gpt-oss-120b`, kernel `6.6.87.2-microsoft-standard-WSL2`, bpftrace `v0.20.2`) with static validation split from dry-run compile and the two missed dry-run targets labelled as missed (per D-39, published as-is; no round 3). Links cover both reports plus the scripts ndjson; static-only modes are described as reporting "passes static validation" only, never "compiles". `run-live-real` is added to the run-it-yourself block and verified present in `eval/Makefile`.
- **Scope (D-43).** Launch drafts (`docs/launch.md`) still quote the old static `26/26 compiled first try` lines, and the Go-minimum / CHANGELOG / local-tag work stay with the release re-prep slice (versions in Slice 17). This slice touches README, `.env.example`, and this file only — no logic, so no test-sync item.
- **Verified:** all 15 relative README links resolve to files in the repo; every `make` target named in the README (`setup`, `lint`, `test`, `test-integration`, `api-dev`, `web-dev`, `eval`, `eval run-live`, `eval run-live-real`) exists in `Makefile` / `eval/Makefile`; `prettier --check` clean on edited files.

## R2-05 Slice 16: Go minimum 1.26 (2026-11-10)

- **Probe (D-44).** Real toolchain downloads via `GOTOOLCHAIN=go1.X.Y` in WSL
  (go1.24.13, go1.25.14, go1.26.10, go1.27.3), each running `go build ./...`,
  `go vet ./...`, `go test -race -count=1 ./...`, `govulncheck ./...` against
  a scratch copy of `agent/` plus `fixtures/`. go1.24 FAILS hard:
  `golang.org/x/sys@v0.44.0 requires go >= 1.25.0` (downgrading x/sys to
  chase 1.24 rejected: dep churn, and older x/sys predates current vuln
  fixes). go1.25.14 passes build/vet/test but FAILS govulncheck (exit 3):
  8 stdlib findings (GO-2026-6809, GO-2026-6617/6613/6612/6611, GO-2026-6608,
  GO-2026-6607, GO-2026-6603), all fixed only in go1.26.9/1.26.10 — no fix
  available on the 1.25 line, so 1.25 cannot satisfy `make vuln`. go1.26.10
  and go1.27.3 pass all four checks with `govulncheck` clean. Floor is
  `go 1.26`: `go mod tidy` under go1.26.10 is a go.mod no-op and only drops
  two stale `x/sys v0.29.0` hash lines from `go.sum`.
- **Builder tracks the floor.** `agent/Dockerfile` uses
  `golang:1.26-bookworm` (active tag, verified via the Docker Hub API), so
  the release artifact builds on the minimum toolchain.
- **CI covers floor and latest, no drift.** `lint` and `vuln` read the floor
  from `agent/go.mod` via `go-version-file`; new `test-unit-min` job runs
  `go test -race ./...` on the floor; `test-unit` keeps the `1.27.x` pin for
  the latest verified toolchain. `integration-manual.yml` keeps `1.27.x`
  (privileged kernel runs want latest, not the floor).
- **Docs.** README badge/requirements/stack and both `docs/environment.md`
  tool lines now say Go 1.26+. `CONTRIBUTING.md` carries no Go version, so
  nothing changed there. `docs/security.md` history (R-21: 1.23 to 1.27) and
  `docs/launch.md` stay untouched for the release re-prep slice (D-43).
- **Verified:** in-repo `go build`, `go vet`, `gofmt -l` (clean),
  `go test -race -count=1` (all 5 packages ok), and `govulncheck` (clean)
  under `GOTOOLCHAIN=go1.26.10`; `ci.yml` parses as valid YAML.

## R2-05 Slice 17: 0.3.0 release re-prep, local only (2026-11-10)

- **New 0.3.0 instead of folding into 0.2.0 (D-45).** remaining-2.md said fold into v0.2.0 while the tag was unpushed, but the local v0.2.0 tag already points at 4791f58 and main has since gained the full R2 stack (single request path, base-URL validation, LLM_MODEL removal, per-call logs, usage, JSON modes, total budget, prompt parts, live+agent eval, docs truth, Go 1.26 floor). A new 0.3.0 section keeps the shipped 0.2.0 notes immutable and gives the R2 work its own version line; root/api/web/schemas all bump to 0.3.0 locally. Slice instruction overrides remaining-2.md D-22 on this point.
- **Static-compile purge (D-46).** docs/launch.md gate now names the live+agent report as the launch evidence and every draft quotes dry-run numbers only (20/26 first-try, 23/26 retries, 20/23 produced, 30/30 refusal-correct); no draft says static-only output 'compiles'. RELEASE_NOTES_v0.2.0.md untouched; new RELEASE_NOTES_v0.3.0.md carries the R2 summary plus the LLM_MODEL breaking-change note.
- **Tag discipline (D-47).** Remote v0.3.0 verified empty via git ls-remote before tagging; local annotated tag v0.3.0 created with -f and never pushed. Branch and tag stay local: no push, no PR, no publish from this slice.

## Issue #60: Validator hardening, uprobe libc resolution, wildcard caps, scrubbed env, and fail-closed catalog (2026-11-11)

- **Tight libc uprobe resolution, scrubbed child env, strict wildcards, and fail-closed startup (D-48).** Closed the uprobe dry-run gap identified in D-39 without loosening validation: (1) Both `api/src/validator.ts` and `agent/internal/server/` restrict `uprobe`/`uretprobe` to `"libc"` or canonical `/lib*`/`/usr/lib*` (plus multiarch `^[a-z0-9_]+-linux-[a-z0-9]+$`) `libc.so*` paths with plain identifier symbols (`^[A-Za-z_][A-Za-z0-9_]*$`), skip `bpftrace -l` global catalog lookup for uprobes, and verify host FS containment (`EvalSymlinks`, regular file, root `uid == 0`, `!0o022`) plus bounded `bpftrace -l 'uprobe:<target>:<symbol>'` existence (resolving `"libc"` across allowed directories if needed) behind OS-specific Unix/Windows helpers so `go test` and `GOOS=linux` cross-builds both work hermetically; hot libc symbols (`malloc`, `free`, `memcpy`, `memset`, `strlen`, `read`, `write`) emit validator warnings. (2) Wildcards allow a single trailing `*` only (`tracepoint:<subsys>:*`, `tracepoint:<subsys>:<prefix>*`, `kprobe:<prefix>*`, `kretprobe:<prefix>*` with prefix >= 3); total probe occurrences count every literal/synthetic probe plus expanded wildcard counts against shared `limits.MaxProbes` (50) and report `probe_count` up to the Web UI (`"expands to N probes"`). (3) All child exec calls in `agent/` drop `os.Environ()` in favor of `limits.ChildEnv` (forwarding `BPFTRACE_*` caps to `DefaultDryRun` as well as `runner.Run`, and forwarding `FAKE_*` vars only when `testing.Testing()` is true). (4) Agent catalog startup is non-blocking with `1s`..`30s` exponential backoff and immutable atomic snapshots that never clobber a good catalog; unready catalogs keep `/health` at `200` (`ready: false`) while failing `/v1/validate` and `/v1/runs` closed (`503 CATALOG_UNAVAILABLE`), propagated as `503 AGENT_NOT_READY` through `/api/*` and surfaced in `TopBar`, `PromptPanel`, `RunControls`, and `ConfirmModal`.

## Review batch 1 (PR76): Windows ownership bypass + uretprobe provider preservation (2026-11-11)

- **M1: bypass uid-0 on Windows, keep the rest (D-49).** `defaultFileRootOwned` on Windows returned `false` unconditionally, so every explicit-path uprobe failed with "not owned by root" on Windows prod — fail-closed DoS with no security benefit, since Windows `FileInfo.Sys()` never carries a uid. Real SID check (Administrators/SYSTEM via GetFileSecurity) rejected: new `x/sys/windows` surface, unverifiable on Linux CI, marginal gain for the local file-hijack model. `uprobe_windows.go` now returns `true` with the rationale in-comment; allowlist, symlink containment, regular-file, and SafeMode (read-only-attribute-derived) checks still apply.
- **M2: preserve parsed provider in `-l` queries (D-50).** `VerifyProbes` discarded the provider and queried `uprobe:<target>:<symbol>` for all three branches, so a return-only symbol failed as `PROBE_NOT_FOUND` for `uretprobe:` scripts and vice versa. All three `ListProbe` calls plus the two `bpftrace -l` hint strings now use the parsed `provider` (`uprobe`/`uretprobe`, already allowlisted by `parseUprobeProbe`); the stale `TestUprobeHostFSChecksAndListProbe` assertion encoding the bug now expects `uretprobe:<path>:<symbol>`.
- **Verified:** `gofmt` clean, `go vet ./...` clean, `GOOS=linux go build ./...` clean, full `internal/server` + `parser` + `limits` suites pass on Windows (incl. new `TestUprobeProviderPreservedInListQuery`, `TestUretprobeLibcAliasPreservesProvider`, and `uprobe_windows_test.go` bypass/containment/SafeMode trio). `internal/runner` + `cmd/agent` failures are pre-existing Windows-only env issues (`.sh` fixture not a Win32 executable, per R-26), untouched by this diff.

## Review batch TS (2026-11-11)

- **Overbroad 503 scoped to code (D-51).** `isCatalogUnavailableResponse` and both `AgentProxyError` paths now require `code === CATALOG_UNAVAILABLE`; unparseable bodies fall back to status 503 (mirrors `proxyVerbatim` catch). A 503 with another code forwards verbatim and retries instead of mapping to `AGENT_NOT_READY`.
- **Run-id cap unified at 128 (D-52).** `GET /api/runs/:id` and `POST .../stop` drop 256 to 128 to match WS `isSafeId`; `routerOptions.maxParamLength: 256` lets overlong ids reach the handlers for a 404 instead of Fastify 414.
- **Script cap is UTF-8 bytes (D-53).** `LlmOutputSchema.script` uses a `TextEncoder` byte-length refine (8 KiB) to match the validator; `SUBMIT_PROBE_PARAMETERS.maxLength` stays a provider char hint with zod authoritative. Parity test covers multi-byte over-budget scripts.
- **Hygiene nits (D-54).** `keys-hygiene` builds a minimal `llmEnv` without `process.env` spread; `escapeFts` strips NUL; `eval-cli`/`db.test` use `closeDb`; `gitleaks-action` moves to v3 SHA `e0c47f4`; 403 gates log via `req.log.warn`.
- **Verified:** `tsc --noEmit` clean, eslint clean on touched files, `vitest run` 245 passed.

## I-02: server-owned run monitoring, headless finalize (2026-11-12)

- **Verify-first (D-23 applied, D-62).** The issue text ("stores completion only when a browser WS is attached") no longer reproduces on `main` 8399143: `startRunObserver` (review batches) already persists the summary headless and fails dead streams, and `contract.test.ts` already pins headless finalize, flaky-observer retry, and http-only failure. Kept all of that untouched; this slice adds only the missing pieces from the spec: hard deadline, restart reconcile, and idempotent writes.
- **Deadline owns the tail (D-63).** Live monitors arm `duration_s + grace` (default 15 s, `monitorGraceMs` override for tests); reconnect backoff is capped at 3 tries and the deadline timer is unref'd, cleared on summary, and tracked in `observerTimers` for shutdown. The monitor keeps no event buffers (counters and the summary only), so its memory is bounded regardless of run length. Deadline expiry records `failed` with `monitor_timeout` (live) or `api_restart` (reconcile sweep). Transport-loss exhaustion keeps the historical outcome (live: failed with null summary, pinned by test; reconcile: `api_restart`) rather than conflating it with a timeout.
- **Restart sweep reuses the stream (D-64).** `buildApp` lists `running`/`stopping` rows and starts one monitor each with the row's original `started_at`, so an already-expired deadline fails fast with a short floor (`min(grace, 2 s)`) that still gives the agent one chance to answer from its retained-summary replay. No agent GET endpoint needed: the WS replay is the "query the agent once" path; a lost agent surfaces as `api_restart` after the same backoff.
- **Idempotent writes at the SQL layer (D-65).** `persistRunSummary` and `failRunWithReason` touch only `running`/`stopping` rows, so monitor and viewer relay can both call them; `markRunStopping` transitions only `running` (a late stop after completion is a no-op instead of regressing the row). `markRunFailedIfActive` now covers `stopping` too: a requested stop still awaits the agent summary, so a dead stream must fail it as well.
- **Verified:** new `db.test.ts` block (double-summary ignored, summary onto stopping, reason-gated fail, stopping failure, unfinished listing) and new `contract.test.ts` block (viewer disconnects midway, stop-after-completion keeps summary, silent run → `monitor_timeout`, restart with retained summary → completed, restart with lost agent → `api_restart`). Full api suite 258/258, `tsc --noEmit` clean, eslint clean, prettier clean. Agent code untouched.

## I-01: control-plane events never dropped (2026-11-11)

- **Rule lives in one place (D-55).** New `parser.Kind` string type with `IsControl()`: `status`, `summary`, `lost` are control; `printf`, `map`, `hist`, `lhist`, `stderr` are data. `Event.Kind` changed from `string` to `Kind` (JSON unchanged); `dataKinds` retyped to `map[Kind]bool`; four compile ripples fixed (`parser_test` fixture struct, `runs_test`/`main_test` kinds slices). Cancellation/failure travel as status/summary payloads in this codebase, so no extra kinds needed.
- **Publish split (D-56).** Control path bypasses the rate window entirely (never counted, never shed, always history-appended); data path keeps the 500/s cap and the `dropped` counter. `deliverLocked` (data) sheds the oldest queued **data** event when the subscriber queue reaches the data watermark (`subBuffer`, 256); queued control is never evicted for data. `deliverControlLocked` evicts data first and only sheds when the queue already holds a full buffer of control — unreachable given bounded control emission per run (status ×few, lost ≤1/s, one summary), guarded by an error log, never counted in `dropped`.
- **Headroom without channel replacement (D-57).** Subscriber channels are now `subBuffer + controlReserve` (256+64): the "grow by one bounded by 64" maps to physical headroom above the 256 data watermark. Same-channel drain-and-resend eviction (non-blocking receives) avoids the stranding deadlock a channel swap would cause with the concurrent stream reader. Custom small channels in tests keep watermark = cap.
- **Exactly one summary (D-58).** A second `summary` publish is ignored and error-logged (Run gained a `*log` pointer so zero-value test literals stay safe); no `sync.Once` needed since publish already holds the mutex.
- **No summary, no error is failure (D-59).** `finalState` returns `failed` on the empty path (never `completed`); `finishRun` synthesizes a `no_summary` summary event (history-appended + fanned out, so late subscribers get a terminal event via the existing `summaryEvent()` fallback) and logs at error level. API side needs nothing: `AgentRunSummarySchema.exit_reason` is an open string and `persistRunSummary` maps unknown reasons to `failed`.
- **`dropped` counts only data (D-60).** Retention eviction (`clearHistoryLocked`, `trimHistoryToBudgetLocked`) now skips control events in the counter; rate and backpressure paths never counted control to begin with (lost events are emitted as control and reset the accumulator).
- **Deterministic bursts (D-61).** Run gained an injectable `clock` (nil = wall clock) so the 499/500/501/5,000/50,000 table never straddles a rate window; wall-clock behavior unchanged in production.
- **Verify-first (D-23 applied).** A 600-data + status + summary repro FAILS on pristine `main` (status shed) and passes with the fix; repro run in `/tmp` scratch copies, working tree untouched.
- **Verified:** `gofmt` clean, `go vet ./...` clean, full agent `go test -race -count=1 ./...` green in WSL on a byte-identical copy (all 5 packages), including the new `control_events_test.go` (burst table, slow-subscriber, no-summary, double-summary, kind classification) and unchanged neighbors (`TestBurstDoesNotDropTerminalSummary`, `TestBackpressureDropOldest`, `TestRateCap500`). `-race` cannot run on Windows (no gcc); `make lint/test` not runnable here (`/bin/sh`, pnpm absent) — Go equivalents run instead; api/web untouched.

## I-03: token-level, default-deny validator (2026-11-12)

- **Verify-first (D-23 applied, D-66).** The old `blockedCalls` regex (`\b(system|signal|override|cat)\s*\(`) provably allows `exec(`, `SYSTEM(`, and `#pragma` (no allowlist existed; `includeRe` covered only `include|define`), so unknown-call and non-include preprocessor corpus cases validate clean on `main`. The mirrored 60-case corpus fails there by reading and passes with the fix.
- **One lexer, two outputs (D-67).** `lexScript` (Go + TS, behavior-identical) emits tokens for call detection and rebuilds the cleaned source that the unchanged probe-header parser consumes, so comment/string handling has a single source of truth. Line continuations join identifiers (C semantics, preserving the old unified-token verdicts); any `#` outside strings/comments is a preprocessor error, subsuming the old `includeRe`.
- **Allowlist scope (D-68).** Spec starter list plus `strlen`, `buf`, `cgroupid` — all long-standing read-only bpftrace builtins. Everything else, including case variants (`SYSTEM(`/unknown, not blocked), reads as `UNKNOWN_CALL`; `macro` definition position is skipped (a use like `m()` still flags). Severity order: `BLOCKED_CALL` > `UNKNOWN_CALL` > `PROBE_NOT_FOUND` > `LIMIT_EXCEEDED`, anticipating the I-04 shared error codes.
- **Caps and their tests (D-69).** 10,000-token and 128-nesting-depth caps; the token cap is unreachable via `StaticValidate` (8 KiB size check fires first) so both sides unit-test it at the lexer layer (`TestLexerTokenLimit`, `lexScript` cap test). Token flood uses repeated `1,` (each pair is 2 tokens).
- **Verified:** full api suite 263/263 (`tsc`, eslint, prettier clean), agent `internal/server` + full `./internal/...` green in WSL with `-race` on the lexer tests, recipes (10) and all 23 committed ndjson scripts validate clean in both suites, web `TopBar.test.tsx` green with the two new hint entries, `docs/security.md` taxonomy updated.

## I-04: shared parity vectors + agent authority (2026-11-12)

- **Single JSON file, spec-shaped entries (D-70).** `packages/schemas/validator-vectors.json` is a bare array of `{ id, script, catalog, known?, expect: { ok, error_codes[] } }` (73 vectors: 33 accepts incl. UTF-8 byte boundaries at exactly/over 8 KiB, all providers, wildcards, uprobe paths/symbols, comment/string smuggling; 40 rejects incl. blocked/unknown calls, preprocessor, unterminated constructs, control/NUL bytes, lookalike parens, caps, empty catalog). Bare array keeps both loaders trivial (`encoding/json` in Go, `readFileSync` + zod in TS); the canonical six-code taxonomy lives once as `ValidatorErrorCodeSchema` in `@vbpf/schemas` instead of a file header. Kept the existing six codes (no finer `WILDCARD_INVALID`/`UPROBE_TARGET_INVALID` split): new codes would change the `/v1/runs` + API contract and every classifier test for no parity gain — the acceptance is identical codes on both sides, which the vectors enforce. `expect.error_codes` is `[]` when ok and the single verdict code when rejecting (severity order from D-68), since both sides surface one taxonomy code per verdict.
- **Authority: agent wins everywhere it can be asked (D-71).** `POST /api/validate` and `POST /api/runs` lost their `--unsafe` substring shortcuts and proxy every script to the agent. `runGenerate` lost its TS-error early-continue: the skip-mode TS check now contributes warnings only, the agent verdict drives retry/accept, and a TS-reject/agent-accept divergence is recorded as a `validator discrepancy` warning (should be unreachable while vectors pass). Scope is the static layer: `/v1/validate` and `/v1/runs` additionally run host uprobe-FS checks and bpftrace dry-run, which stay agent-only by nature. `/api/explain` keeps its TS-only gate (read-only, never executes).
- **Substring `--unsafe` checks removed on both sides (D-72).** `validator.ts` rejected any script _containing_ `--unsafe`, even inside strings (`printf("--unsafe")` failed) — a false positive the Go validator never had, and a local veto contradicting D-71. The agent argv is fixed (never carries `--unsafe`), so the text is harmless content: inside strings/comments it is opaque, and stray text after a block fails header parsing identically on both sides (pinned by `string-holds-unsafe-text` and `trailing-text-after-block` vectors). Existing `--unsafe` test expectations survive via the trailing-text path.
- **Parity gate (D-73).** `scripts/parity-vectors.mjs` (pure node, no deps) validates shape, unique kebab-case ids, catalog enum, code universe, and the `[]`/`[code]` expect invariant, then asserts both suites reference the shared file and contain no skip markers — structurally any vector in the file executes on both sides. `make parity` runs the gate plus both vector suites; CI gained a `parity` job.
- **Verified:** `node scripts/parity-vectors.mjs` prints 73 wired with no skips; new `validator-vectors.test.ts` (2 tests) and `TestValidatorVectors` (73 subtests) pass 73/73 on both sides with identical `ok`/code verdicts; full api suite 267/267, `tsc --noEmit` clean (api + `@vbpf/schemas`), eslint/prettier clean; agent `go vet`/`gofmt` clean, full `./internal/...` green in WSL plus `-race` on the validator/classifier subset; recipes (10) and all committed ndjson scripts still validate clean via the existing suites; `make parity` runs the gate plus both vector suites, CI `parity` job added. Agent code untouched (vectors pin the static layer only).

## I-11: raise real compile rates (2026-11-12)

- **Scope (D-74).** Prompt/feedback layer only; validators untouched in verdict behavior (suggestion text only). Branch `fix/i-11-compile-rates` from main 1abb081. Six mechanisms per the issue: (1) `api/src/feedback.ts` — strip ANSI, drop banner/libbpf/deprecation noise, keep the first actionable located error (`path:line:col: ERROR`, stdin or the validator temp file), cap ~300 chars, one hint from a 7-class rule table (tracepoint args, `@` vars, type mismatch, probe-not-found, wildcard caps, blocked/unknown calls, single-quote chars). Only the feedback copy is shaped; stored errors and eval Failures stay raw. (2) Did-you-mean to 5 (prefix tier, then same-scope edit-distance tier capped at `max(4, len/4)`, then scope-listing backfill only when no prefix hit), mirrored exactly in `agent/internal/server/validate.go` + `api/src/validator.ts` with shared unit expectations; uprobe candidates filtered to the allowlist (libc/canonical path) on both sides. (3) Prompt binds the offered list (`Use only these probes... Do not invent probe names`, plus `Start from the first recipe...` preference) with a closest-listed-probe escape hatch for vague/novel asks. (4) Static `PATTERNS` block (latency-histogram skeleton, count-by-comm, interval snapshot-and-clear) in `==PATTERNS==` + `### Reference data: patterns`. (5) Retry: shaped error + previous script on attempts 2-3, `adapt recipe <id>` nudge on attempt 3. (6) Local pre-check `outOfListProbes` rejects invented probes before spending a dry-run, but only after a `/v1/probe-args` existence check (exact catalog match) so valid-but-unlisted probes (search is whole-string substring) still reach the agent; transport errors fail open to the authoritative dry-run.
- **Tuning rounds, all core-only (D-75).** Round 1 (live static, stub catalog of 11 probes): hard constraint caused 5 false refusals (novel-01..04, ambiguous-01), 19 generatable ok. Round 2 (+closest-probe escape hatch): 23 ok, refusal 29/30; only novel-02 still refused (stub catalog genuinely lacks a read-size probe). Round 3 (live+agent, WSL2 root + bpftrace 0.20.2, real 108k-probe catalog, round-2 prompt + existence check + shaping overhaul): static 23/23 generatable first-try; dry-run first-try 16/17 decided (94.1%), within-retries 17/17 (100%); raw rates 16/24 and 17/24 with 5 Groq fetch aborts (attempts:0, `This operation was aborted`) and 2 false refusals counted as failures. Zero compile failures: every script that reached the agent passed within retries; novel-01 (sched_switch) passed first-try via the existence check, novel-05 passed on attempt 3, paraphrase-02 (single-quote char) passed first-try via the new hint path. 3 tuning rounds used of 3; ~140 live calls of the 400-call budget; no full live run today (would exceed the remaining call budget).
- **Residuals (honest).** novel-03 refused (catalog on this kernel has `tracepoint:oom/*` but the model judged none suitable), ambiguous-01 refused as unbounded; both are refusal-calibration, not compile, issues. The 5 aborts are provider-transport flakes (direct Groq fetch, unrelated to the agent forwarder; no completions recorded). Oracles 0/8 and produced 7/17 are Windows-runner artifacts (sentinel workloads spawn `sh`, absent here); scripts themselves executed in the WSL agent. Full 127-case live+agent re-run with loopback workloads is pending a Linux host (or tomorrow's call budget).
- **Agent-on-WSL harness notes (D-76).** Cross-compiled the agent on Windows (`GOOS=linux GOARCH=amd64`), served in WSL as root on loopback only (the binary correctly refuses non-loopback bind), bridged to Windows via a threaded `127.0.0.1:8787 -> <wsl-ip>:8788` python forwarder (token auth unchanged; forwarder + 0600 token copy removed after the runs). Preflight once flaked on its 3 s timeout (cold `/health` ~1.1 s through the forwarder); warm retries pass in <130 ms.
- **Verified:** api suite 304/304 + `tsc --noEmit` clean (16 files incl. new `feedback.ts`/`feedback.test.ts`); agent `internal/server` green (new suggestion tests); `gofmt` clean; CRLF normalized to repo LF; mock full eval 85/85 generatable + 42/42 refusals + 0 unsafe. Runner-package failure (`TestDataEmitErrorStopsChildAndPreservesError` timing on Windows) is pre-existing and untouched (no runner files in the diff).

## I-12: kernel and platform matrix in CI (2026-11-12)

- **Record, don't fail (D-77).** `.github/workflows/kernel-matrix.yml` (`workflow_dispatch` + weekly Monday schedule, mock-only, no secrets) has two jobs: `hosted` (matrix `ubuntu-22.04`/`ubuntu-24.04`: install bpftrace + iperf3, build the agent, `make test-integration` under sudo, recipe check, produced-output) and `vm-kernels` (matrix 5.10/5.15/6.1/6.6 via virtme-ng). Setup steps fail the job when broken; test steps use `continue-on-error` and every outcome is recorded into `compat/<env>.json` via `scripts/collect-compat.sh`; missing BTF/probes are findings, never failures. The JSON uploads as an artifact — a maintainer downloads, reviews, and commits it; nothing self-pushes. Stock runners have no `/dev/kvm` or virtme-ng, so the VM job normally records `not-run` (an honest stub, not a failure); the virtme-ng attempt is real but degrades gracefully. Actions SHA-pinned like the rest of CI (`upload-artifact@ea165f8d...` v4.6.2, corroborated across independent pins); `runs-on` labels are GitHub-hosted images and not SHA-pinnable — recorded, not fixed.
- **Schema once, enforced twice (D-78).** `compat/schema.json` (draft-07, mirroring `recipe.schema.json`) is canonical; `CompatReportSchema` in `@vbpf/schemas` is its zod mirror so vitest pins it. `scripts/render-compat.mjs` (pure node, no deps) re-validates dependency-free for the matrix workflow, renders `docs/compat.md`, and replaces the README table between `compat:begin/end` markers. Statuses stay honest: `verified` only with a recorded run, `unverified`/`not-run` otherwise, `fallback` reserved (no recipe declares a fallback path yet). `docs/compat.md` is prettier-ignored (fully generated) and the README block sits inside `prettier-ignore` wrappers, so `prettier --check` and `--check` freshness agree byte-for-byte.
- **Probe listing without root surprises (D-79).** `collect-compat.sh` reads `requires` from each `recipes/*.yaml` (flow style, one or two lines), checks `bpftrace -l` verbatim, and resolves `uprobe:libc:<sym>` across `ldconfig -p` `libc.so` paths plus common multiarch locations (bare-alias listing never enumerates). Recipe verdict is `available` iff every require lists, else `unavailable`. Test outcomes arrive via repeatable `--pass/--fail` flags (newline-joined, so commas/parens in labels survive); the script exits 0 once the report is written — only usage/env errors exit nonzero. `shellcheck` clean.
- **No evidence lost (D-80).** `compat/wsl2-ubuntu-24.04.json` and `compat/compose-quickstart.json` transcribe the R-04/R-05/R-09/R-10 survey logs verbatim (recorded_at 2026-11-10, notes cite the source sections); hosted and VM stubs carry `n/a` placeholders with notes saying so. Kept `docs/environment.md` as the dated survey log (append-only, untouched); `docs/compat.md` is the generated matrix.

## I-07: container and proxy hardening (2026-11-12)

- **TRUST_PROXY explicit, fail-closed (D-81).** `api/src/server.ts` `parseTrustProxy` maps `"false"`/empty/unset to Fastify `trustProxy: false` (socket address keyed; spoofed `X-Forwarded-For` ignored); an IP/CIDR allowlist passes through (compose: `172.28.0.0/16`, the fixed `vbpf` bridge subnet, so only the nginx hop is trusted); `"true"` trusts all (tests only, never in front of untrusted clients); a bare hop count fails closed to `false` because Fastify cannot validate the immediate peer from a count — this deliberately narrows the issue spec ("hop count or CIDR"), recorded in `docs/deployment.md`. Decision number note: `implementation.md` calls this D-30, but D-30 is already taken in this file, so it is D-81 here.
- **Non-root without a USER line (D-82).** The API image keeps no `USER` because the entrypoint must start as root to stage the root-owned `0600` agent token; it then re-execs via `setpriv --reuid=node --regid=node --clear-groups` so no root PID remains (`NODE_ENV=production` added). Web uses `nginxinc/nginx-unprivileged` (pinned digest, uid 101, port 8080). Compose adds `cap_drop: [ALL]`, `no-new-privileges`, `read_only: true` with `tmpfs`, mem/pid limits, `restart: unless-stopped` for api+web; the agent is untouched (I-08 owns its privilege reduction).
- **nginx second layer (D-83).** `server_tokens off`, `client_max_body_size 64k` on API locations (matches the API's own 64 KB cap), `proxy_connect_timeout 5s` / `proxy_send_timeout 30s` with read kept at 120 s (90 s LLM budget + 60 s max run stream), `limit_req` 10r/m on the exact `/api/generate` and `/api/explain` locations mirroring the API's shared bucket, `Permissions-Policy` header; no HSTS (plain-HTTP loopback front door; set it at the TLS terminator).
- **Verified:** new `parseTrustProxy` unit tests (default false, hop-count fail-closed, allowlist passthrough), new spoofed-header rate-limit test (untrusted peer ignored), `config.test.ts` TRUST_PROXY defaults, `nginx.conf.test.ts` shape tests (banner, 64k, timeouts, limit_req, Permissions-Policy), `scripts/check-headers.sh` smoke script, CI `nginx -t` against the pinned image + `docker compose config` + `docker compose build`.
- **Verified:** `collect-compat.sh` run in WSL against the real kernel/bpftrace (facts correct; unprivileged listing honestly records unavailable); `render-compat.mjs --check` green; new `api/src/compat.test.ts` 8/8 (schema parse/reject, loader order, honesty invariants, full recipe coverage, generated-file freshness); full api suite green, `tsc --noEmit` clean (api + schemas), eslint/prettier clean, `shellcheck` clean; workflow YAML parses; ci.yml `compat-check` job is static (node only). `actionlint` unavailable on this machine — noted, not substituted.

## I-08: reduce agent privilege (2026-11-12)

- **Minimal caps are enough, no SYS_ADMIN/DAC_READ_SEARCH (D-84).** Number
  note: `implementation.md` calls this D-29, but D-29 is already taken in
  this file (prompt budget), so it is D-84 here. Compose drops
  `privileged`/`pid: host` for `cap_add: [BPF, PERFMON, SYS_RESOURCE]` +
  `cap_drop: [ALL]` + `no-new-privileges:true` with `:ro` tracefs/debugfs;
  `SYS_ADMIN`/`DAC_READ_SEARCH` were not added because nothing needed
  them: the limited container binds, catalogs (`bpftrace -l`, 107555
  probes on the Docker Desktop 6.6.87.2-microsoft-standard-WSL2 kernel),
  dry-run compiles, runs, and stops a tracepoint recipe
  (`scripts/check-privilege.sh` PASS). Previous behavior is kept only as
  `docker-compose.privileged.yml` (fallback override, documented use).
- **Hardening at three layers.** Systemd (`deploy/vbpf-agent.service`,
  dedicated `vbpf-agent` user, ambient/bounding retain set,
  `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`,
  `PrivateTmp`, `RuntimeDirectory=vbpf`, `LimitMEMLOCK=infinity`,
  `AF_UNIX/INET/INET6` + `@system-service bpf perf_event_open`) scores
  **3.5 OK** under
  `systemd-analyze security` (systemd 255); in-process
  (`agent/internal/priv`: `PR_SET_NO_NEW_PRIVS` + `capset` mask to the
  retain set, inheritable cleared, final set logged, best-effort so
  unprivileged dev/CI keeps working) reports
  `eff=[cap_bpf,cap_perfmon,cap_sys_resource]` in the container log.
  `MemoryDenyWriteExecute` omitted on purpose: bpftrace JITs BPF programs
  (LLVM needs WX at runtime), so MDWE would break every run. No `USER`
  line in the agent image: the in-process drop already confines PID 1
  (`CapEff=000000c001000000`, `CapInh=0`).
- **Container uprobe scope is namespace-local.** Uprobes resolve by inode
  in the agent's mount namespace, so `uprobe:libc` in compose targets the
  container's libc, never the host's: the same path stat'ed
  `151:284263` (dev:inode) inside the agent image vs `2128:435056` on the
  WSL2 host (2026-11-12). `TestUprobeResolvesWithinAgentMountNamespace`
  pins that resolution never leaves the checker's root. Documented in
  README limitations and `docs/security.md`, with the read-only host-lib
  bind-mount escape hatch. Native runs are unaffected.
- **Verified:** new `internal/priv` unit tests 8/8 (retain mask, fake-ops
  Harden asserting SYS_ADMIN dropped + final set logged, failure
  tolerance, status parsing); new uprobe namespace test passes;
  `scripts/check-privilege.sh` PASS on Docker Desktop (health, validate +
  dry-run, run, stop + 404 re-stop, PID 1 caps exact, `privileged=false`,
  no pid mode, `:ro` tracefs write fails, `mknod`/`mount` fail);
  `systemd-analyze security` 3.5 OK recorded above; `shellcheck` clean;
  base + fallback `docker compose config` valid; full agent/api/web suites
  per the report.

## I-13: provider presets and native Anthropic adapter (2026-11-12)

- **Decision number note (D-85).** `implementation.md` calls this D-33, but
  D-33 is already taken in this file (R2-01 Slice 12 persistence), so it is
  D-85 here.
- **`openai` preset (D-85).** `https://api.openai.com/v1` on the existing
  OpenAI-compatible client. Verified against OpenAI's official docs before
  shipping: servers `https://api.openai.com/v1` (openai-openapi
  `openapi.yaml` / platform `api-definition.yaml`), `POST
/chat/completions`, and `response_format: { type: "json_object" }` JSON
  mode per the Chat Completions reference. Key required; same
  `LLM_OPENAI_MODEL` / fallback / JSON-mode / base-URL-override semantics
  as every other OpenAI-kind preset.
- **Native Anthropic Messages adapter, no compat-layer option (D-85).**
  Anthropic's own docs disqualify the OpenAI-compatibility endpoint for
  this chain: it is "primarily intended to test and compare model
  capabilities, and is not considered a long-term or production-ready
  solution", and it accepts only `json_schema` with `strict: true` — a
  request setting `json_object` (this chain's default) returns a 400 error
  (OpenAI SDK compatibility: limitations). So `anthropic` is a second
  transport kind in `live-llm.ts`, reusing the shared timeout, 256 KB body
  cap, manual-redirect, semaphore, key-rotation/cooldown, model-fallback,
  and one-time JSON downgrade rules: `POST {base}/messages` with
  `x-api-key` (never `Authorization: Bearer`) plus `anthropic-version:
2023-06-01` (the long-stable version; newer versions drop the
  `temperature` param generation still sends). Top-level `system` plus a
  single user message; `tool` mode sends one `submit_probe` tool with a
  forced `tool_choice: { type: "tool", name }` and parses the matching
  `tool_use` block's `input`; `json_object`/`none` send no shaping (the
  JSON-only system instruction still applies) and parse concatenated
  `text` blocks. Usage maps `input_tokens`/`output_tokens` onto
  `prompt_tokens`/`completion_tokens` in shared `parseUsage`. Error
  mapping is status-based and unchanged, except 529 (Anthropic's overload
  signal) cools the provider like 429. Explain posts the same short
  system prompt as the user-visible script text and parses text blocks.
- **Chain default stays `groq`; `.env.example` stays secret-free.** New
  presets only extend the chain; no committed keys, CI stays mock-only.
- **Verified:** `tsc --noEmit` clean, `live-llm.test.ts` 71/71 (13 new:
  openai URL/Bearer/unconfigured; anthropic request shape, headers, and
  no-Bearer-leak; native tool-call round trip; text-mode JSON parse; 401
  rotation; 429 + 529 cooldown; 400 model failure; missing-text and
  missing-tool_use rejections; explain text blocks; usage-name mapping;
  key discovery), full api suite green; eslint/prettier clean.

## I-14: run provenance end to end (2026-11-12)

- **Decision number note (D-86).** `implementation.md` calls this D-30+ like
  several earlier issues, but those numbers are taken in this file; I-14 is
  D-86 here.
- **Taxonomy (D-86).** `origin` is derived server-side in one place
  (`deriveRunOrigin` in `api/src/db.ts`), never from client input
  (`CreateRunRequest` unchanged, still `.strict()`). The generation binding
  decides first: pristine script plus `generations.based_on_recipe` set
  (the recipe ID the generation names) reads `recipe`; pristine with no
  recipe reads `generated`; any byte difference reads `edited` (R-18 exact
  inequality kept). Only generation-less runs consult the recipe library:
  sha256 of the trimmed script against trimmed `recipes/*.bt` bodies
  (trailing-newline robust, mirroring the explain mock) reads `recipe`,
  anything else `edited`. A generation-linked script that happens to match
  a recipe body still reads `edited`: the binding wins, so the rule stays
  predictable. Rationale for `based_on_recipe` over pure hashing: the mock
  LLM echoes recipe bodies verbatim, so hashing alone would label almost
  every pristine mock generation `recipe` and leave `generated`
  untestable; the recipe-ID branch keeps all three origins reachable.
- **Storage (D-86).** v4 migration (`SCHEMA_VERSION` 3→4, `origin TEXT NOT
NULL DEFAULT 'edited'` in both the baseline DDL and the step, following
  the v3 precedent). Backfill is SQL-only and conservative: pristine
  generation-bound rows become `generated`/`recipe` via `based_on_recipe`;
  generation-less rows keep `edited` (a pre-upgrade pasted recipe reads
  `edited` — accepted, dev databases only). `insertRun` takes the derived
  origin; the hash set is built once at startup from the recipe library.
- **API surface (D-86).** `RunOriginSchema` in `@vbpf/schemas`; `origin` is
  required on both `CreateRunResponse` (201 carries the derived origin so
  the web never guesses) and `GetRunResponse`. The agent's own `{run_id,
state}` shape is parsed with `.omit({ origin: true })` since the agent
  knows nothing of provenance. `script_sha256` stays out of GET (R-13);
  tests assert the stored hash by reading the suite database file instead.
- **Web (D-86).** `createRun` result gains `origin`, stored as `runOrigin`
  and recorded into history; `HistoryEntry` gains `origin`, shown as a
  badge (`generated` ok, `recipe` info, `edited` warn) and included in the
  JSON export. The only client-side derivation is `localRunOrigin`
  (fixture mode, no backend), mirroring the server's generation branch;
  fixture scripts are synthetic so generation-less fixture runs read
  `edited`. ConfirmModal still forwards `generation_id` for
  generated/edited runs and omits it for recipe runs — that behavior was
  already correct; tests now pin all three shapes plus the stored origin.
- **Verified:** `tsc --noEmit` clean (api, web); eslint clean on touched
  files; prettier clean; api vitest 346/346 (12 new: 7 in `db.test.ts`
  derivation/backfill, 5 black-box in `contract.test.ts` covering the 201,
  GET, and stored `script_sha256` for generated/edited/recipe×2 paths);
  web vitest 77/77 (new: `localRunOrigin` 4/4, origin-storage on run
  success, per-origin history recording, export carries origin).

## I-15: supply-chain automation (2026-11-12)

- **Scope (D-87).** Dependabot, CodeQL, Scorecard, SBOM-as-CI-artifact,
  audit/vuln gates, `SECURITY.md` versions, `docs/supply-chain.md`. The
  release workflow itself (tag builds, signing, publishing) stays in I-16;
  the CI `sbom` job uses the exact anchore step I-16 will reuse so the
  release only adds attachment, not new tooling.
- **Verify-first (D-87).** `scripts/check-supply-chain.sh` was written
  before any config and failed 10/12 checks on `main` (no dependabot,
  codeql, scorecard, sbom/audit jobs, stale `SECURITY.md`, no
  supply-chain doc); existing SHA pins and the empty allowlist passed.
- **CodeQL default suite (D-87).** Default `security-and-quality` queries,
  no `security-extended`: extended adds noise that blocks PRs on
  non-exploitable paths; the validator/parser already carry targeted
  security tests (I-03 to I-05).
- **SPDX, not CycloneDX (D-87).** `anchore/sbom-action` defaults to
  SPDX JSON and the release checklist (checksums, attestations) already
  speaks SPDX; one format everywhere.
- **No Scorecard badge yet (D-87).** Per the spec the badge lands only
  after the first successful run, so this diff adds no README badge.
- **Gate asymmetry (D-87).** `govulncheck` fails on any finding (no
  severity gate exists, so this is stricter than asked); `pnpm audit`
  fails only on high/critical with waivers confined to
  `.github/audit-allowlist.json` entries that each carry a reason and an
  unexpired `YYYY-MM-DD` expiry. Moderate/low audit findings are logged,
  not fatal. gitleaks stays zero-tolerance.
- **Action SHAs (D-87).** Resolved from the GitHub API at write time:
  codeql-action v3 `9418214`, scorecard-action v2.5.0 `fa7117d`,
  sbom-action v0.24.3 `66cbf4b`; existing checkout/setup/upload pins
  reused verbatim. actionlint v1.7.12 via pinned `go install`.
- **Verified:** gate green; `make audit` green (0 findings);
  actionlint green (installed v1.7.12 locally for the check);
  `prettier --check` + eslint clean on touched files; `make lint`
  and `make test` green (or SKIP-equivalent where the runner lacks root).

## I-16: release pipeline (2026-11-12)

- **Scope (D-88).** Tag push `v*` publishes; `workflow_dispatch`
  (default dry run) and PRs touching release files, `docs/install.md`,
  `deploy/`, the agent Dockerfile, or `agent/cmd/agent/main.go` only
  build. One `plan` job derives `dry_run`/`version` so every publish
  step gates on a single output; a tag never publishes without the
  full test suite and both doc/supply-chain gates passing first.
- **No nfpm .deb (D-88).** Spec marks it optional; skipped so the diff
  stays reviewable. Static binaries plus GHCR images cover the
  documented install paths; revisit only on maintainer request.
- **Version injection (D-88).** `var version = "dev"` in
  `agent/cmd/agent/main.go` with a `--version` flag and a serve-startup
  log line; release builds inject the tag with
  `-ldflags "-X main.version=..."`, and `agent/Dockerfile` takes it as
  `ARG VERSION=dev` (CI builds without the arg still say `dev`).
  No version constants bumped anywhere else.
- **One trust root (D-88).** Binaries and all four SPDX SBOMs land in
  one `dist/`, `sha256sums.txt` covers every file, and keyless cosign
  signs the checksums bundle plus the three pushed image digests; SLSA
  provenance attests the same set. Release notes are the `CHANGELOG.md`
  section matching the tag, extracted by awk (missing section fails
  the job); the GitHub release is created with preinstalled `gh`
  instead of a third pinned action.
- **Action SHAs (D-88).** Resolved from the GitHub API at write time:
  setup-qemu v3 `c7c5346`, setup-buildx v3 `8d2750c`, login v3
  `c94ce9f`, build-push v6 `10e90e3`, attest v2 `e8998f9`,
  cosign-installer v3 `398d4b0`, download-artifact v4 `d3f86a1`;
  existing checkout/setup/upload/sbom pins reused verbatim (a local
  pin cross-check caught two single-char transcription slips before
  commit).
- **Verified:** actionlint green on all workflows; `check-docs.sh`
  and `check-supply-chain.sh` green; `go vet` clean and
  `TestVersionFlag` green (`TestRunWithFake` fails on this Windows
  checkout only — fork/exec of the `.sh` fixture — and is untouched by
  this diff). Live dry run marked unverified: no tag pushed and no
  GHCR publish performed locally, per the no-push hard stop.

## I-18: Positioning and discoverability (2026-11-12)

- **Tagline leads with the differentiator (spec wording).** README top now
  reads 'Ask in plain English, review the exact probe, run it behind a
  safety gate, watch live charts.' New 'Why vBPF' subsection: safety
  layers, human confirmation, live views, offline mode (recipe-only needs
  no key; local models over loopback; probe output never leaves the
  machine).
- **Competitor claims verified from READMEs on 2026-11-12, links cited, no
  disparagement.** GPTtrace (eunomia-bpf/GPTtrace): self-described
  experiment 'not suitable for production use', CLI natural-language to
  bpftrace/BCC with retry on load errors, points users to MCPtrace.
  MCPtrace (eunomia-bpf/MCPtrace): MCP server giving AI assistants
  bpftrace access; README states 'No script validation - trust the AI
  client to generate safe scripts' (60 s max, 10k-line buffer, poll-based
  results). Comparison table keeps bpftrace/BCC and adds both.
- **New docs/faq.md** answers the five spec questions with pointers to the
  README sections that stay canonical. New docs/maintainer-checklist.md
  holds the exact repo-metadata gh commands plus the other one-time steps;
  agents must not run them (only the tag placeholder differs from the
  spec text, to avoid pinning a stale version in docs).
- **Social preview docs/assets/social.png (1280x640)** composited from the
  committed demo: header band with name plus short pitch, body is demo.gif
  frame 210 (prompt, script, live bar chart), the brightest sampled frame,
  resized with LANCZOS. No staged or synthetic pixels beyond the header
  text.
- **Verified (corrected Phase 5):** `bash scripts/check-docs.sh` claimed
  green here but was RED on 7 cross-file anchors in docs/faq.md (the
  checker validated anchors against the linking file, not the target);
  fixed to extract headings from `$target` (with `2>/dev/null || true`
  guard), now green; prettier check clean on edited/new markdown;
  social.png opens at exactly 1280x640.

## I-19: Contributor funnel and recipe growth (2026-11-12)

- **Scope (D-89).** 20 new recipes (30 total), all tracepoint/uprobe, no
  kprobes: exec-snoop-args, setuid-calls, ptrace-attach,
  connects-by-process, accepts-listens, bind-calls, mounts, module-loads,
  unlinks, openat-errors, syscall-io-latency, runqueue-latency, oom-kills,
  signal-generation, fork-rate, syscall-errors, tcp-state-changes,
  page-cache-misses, block-io-sizes, dns-lookups-by-process. `sys_exit_*`
  tracepoints carry only the return value, so openat-errors and
  syscall-io-latency pair enter/exit via maps keyed by `tid` (always delete
  on both outcomes).
- **openat2 twin (D-89).** Modern glibc opens via `openat2`, so an
  openat-only recipe misses most opens (proven: `cat` of a missing file
  fired nothing until `sys_enter_openat2`/`sys_exit_openat2` were added).
  `docs/writing-recipes.md` tells contributors to watch syscall twins.
- **`__data_loc` strings need `str()` (D-89).** `module:module_load`
  `name` and `oom:mark_victim` `comm` read as integers without it
  (dry-run error). bpftrace `for` is map-iteration only; the argv count in
  exec-snoop-args uses `while` with pointer arithmetic instead.
- **OOM workload (D-90).** A plain 200 MB allocation survives a 50M memcg
  (1G swap pages it out); the sentinel hog does `mlockall(MCL_FUTURE)`
  then touches per-page, so the killer fires in under a second.
  `oom:mark_victim` is confirmed emitted for memcg kills (52 victims in an
  8 s agent run). One attach-time `tracepoint not found` for
  `oom:mark_victim` never reproduced; treated as environmental noise.
- **Funnel (D-91).** `recipes/_template.bt` + `recipes/_template.yaml`
  (skipped by name in `validate-recipes.sh` and `collect-compat.sh`;
  `_template.bt` still passes `TestLexerAcceptsRecipes`), plus
  `scripts/new-recipe.sh`, `make recipe-check ID=<id>`
  (`scripts/recipe-check.sh`: schema, static rules, dry-run when bpftrace
  is present, fixture presence), `docs/writing-recipes.md`, CONTRIBUTING
  first-contribution steps with the label vocabulary (`good first issue`,
  `recipe`, `kernel-report`, `help wanted`), and `scripts/compat-report.sh`
  (reuses `collect-compat.sh`, prints paste-ready markdown for
  `kernel.yml`). `produced-output.sh` now covers all 30 recipes with a
  sentinel workload each. Fuzz corpus not regenerated: no CI gate enforces
  freshness and seeds are inputs, not assertions.
- **Verified (D-92).** On WSL2 (6.6.87.2-microsoft-standard, bpftrace
  v0.20.2, 2026-11-12): `bpftrace -d` clean for all 30; `make
recipe-check` green for all 30; full agent `produced-output.sh` run:
  28/30 produced events (page-faults-by-process and
  slow-disk-io-by-process recorded zero events, a measurement not a
  failure, same as 2026-11-10). `compat/wsl2-ubuntu-24.04.json` refreshed
  and `docs/compat.md` regenerated. `make test-integration`: all green
  except `TestLoadOrCreateToken_ChmodOrPermError`, a root artifact (the
  test assumes unprivileged chmod fails; root bypasses it), pre-existing
  and unrelated to recipes; recorded in the report's failed list.
  `validate-recipes` (30), `check-docs`, `compat-check`, shellcheck,
  prettier, and the Go server/parser suites are green.
- **Verified (corrected Phase 5, D-92 scope).** The I-19 commit message
  implied a green api suite, but RED review on `feat/i-19-recipes` found
  2 vitest failures: `compat.test.ts > covers every recipe in the library`
  (7 stale reports still listed only the original 10 recipes) and
  `eval.test.ts > scores a direct hit` (direct-01 mock top-1 flipped
  cpu-by-process to new-processes). Both are fixed in Phase 5 (D-93); the
  WSL2 kernel measurements above stand.

## I-19 Phase 5 fix: RED blockers, OOM reaping, nits (2026-11-13)

- **Scope (D-93).** No recipe content changes; index, harness, reports, and
  formatting only.
- **Compat backfill (Blocker 1).** The 7 stale reports
  (compose-quickstart, ubuntu-22.04/24.04, vm-kernel-5.10/5.15/6.1/6.6)
  each gained the 20 new recipe ids as `"not-checked"` (sorted, 30 total
  like `wsl2-ubuntu-24.04.json`). `renderCompatMd` renders a missing key
  as `not-checked`, so `docs/compat.md` and the README table are
  byte-identical (`render-compat.mjs --check` passes untouched) and the
  honesty invariant holds (stale rows stay `not-run`/`verified`-as-was,
  new cells `not-checked`).
- **Porter-stemmed recipe index (Blocker 2, implementation fix).**
  Root cause, measured: the prompt "Which processes are using the most
  CPU?" builds `"processes" OR "using" OR "cpu"`; `new-processes` is the
  only indexed doc containing the literal plural `processes` (id+title,
  df=1), so its BM25 beat cpu-by-process 4.459 to 4.156 despite `cpu`
  matching four cpu-by-process columns. `api/src/db.ts` is now
  `SCHEMA_VERSION 5` with `tokenize='porter'` on `recipes_index` (both
  sides stem: `processes`/`process`, `lookups`/`lookup`), plus
  `migrateTo5` which rebuilds the table preserving rows. cpu-by-process
  is top-1 again; all 10 retrieval top-3 cases stay green. Pinned by a
  top-1 test in `retrieval.test.ts` and a v5 migration test in
  `db.test.ts`; no expectation was edited (the direct-01 mapping to
  cpu-by-process in `eval/prompts.yaml` is correct, so tuning — the
  preferred option — won over justification).
- **OOM teardown (Major).** The memcg hog parent forks one hog per cycle
  and waitpids it, so `kill $WORKLOAD_PIDS` orphaned any in-flight hog
  (reparented, invisible to the PID list). The OOM workload now starts
  under `setsid` (`OOM_SESID` tracks the session leader) and
  `stop_workloads` group-kills it (`kill -- -"$OOM_SESID"`) with
  `pkill -f vbpf-oom-hog` (marker comment in the hog source) as backstop.
  Also: `UNLINK_TEST_FILE` is reset after removal, and the fixed
  `/sys/fs/cgroup/vbpf-oom-probe` path is documented as serial-only (a
  concurrent second run would fight over the same memcg).
- **Nits.** `prettier --write` on accepts-listens, openat-errors,
  setuid-calls, syscall-io-latency yamls (multi-line flow arrays; the
  `collect-compat.sh` awk accumulator and `yaml.safe_load` both accept
  them, probes verified unchanged). `shellcheck -S warning` clean on the
  harness edit.
- **Verified:** full api suite green (2 RED failures fixed, porter
  migration + top-1 pins added), `tsc --noEmit` clean, eslint/prettier
  clean, `render-compat.mjs --check` green with byte-identical docs,
  shellcheck clean.

## I-20: launch content drafts (2026-11-13)

- **Scope (D-94).** Drafts only, never posted from this diff: new
  docs/launch-post.md plus Lobsters, eBPF-community, shared-FAQ,
  checklist, and metrics sections in docs/launch.md. No version
  bumps, no tags, no publish, no posting. Target stays 0.3.x.
- **Numbers discipline (D-95).** Every numeric claim traces to a
  tracked report, and only eval/reports/2026-11-10-live-real.md
  (live+agent, groq/openai/gpt-oss-120b, 6.6.87.2-microsoft-standard-WSL2,
  bpftrace v0.20.2) is quoted for compile/execution: static 26/26,
  dry-run 20/26 first-try (23/26 retries), produced 20/23, refusal
  30/30. Static-only reports (2026-11-09.md, 2026-11-09-live.md) are
  named for the honesty story and never quoted as compiles. Variance
  is the observed tuning-round spread (n=1 full run), never a
  standard deviation. PR/commit links use full GitHub URLs (remote is
  faizan1250/vBPF) with SHAs verified in the local git log.
- **Verified:** bash scripts/check-docs.sh green, prettier --check
  clean on touched markdown, article and post drafts committed marked
  DRAFT.

## I-21: roadmap reorder (2026-11-13)

- **Scope (D-96).** Docs-only: README roadmap reordered per the issue
  (sessions/export first, then opt-in Explain results with a
  data-sharing notice, then Kubernetes/container targeting via cgroup
  IDs; libbpf/CO-RE backend and multi-host TLS agents last as the
  largest scope), plus one sentence on why. No implementation, no
  version bump (target stays 0.3.x).
- **Consistency (D-96).** docs/launch-post.md already lists sessions,
  Kubernetes/cgroup, then multi-host in that order, so no change
  needed there; README limitations (single-host, bpftrace-only) and
  the deferred-to-v0.3 sessions note already match the new order.
- **Verified:** bash scripts/check-docs.sh green, prettier --check
  clean on touched markdown.

## I-23: published threat model (2026-11-12)

- **Scope (D-97).** Docs-only: new docs/threat-model.md per the issue
  (assets, six actors, four trust boundaries, 16-row STRIDE table with
  every mitigation pointing at a file or test, four residual risks
  stated plainly), plus one-line links from the README privacy section
  and SECURITY.md. No implementation, no version bump (target stays
  0.3.x).
- **Grounding (D-97).** Every table row cites a path verified to exist
  in this tree (agent/internal/server/\*, api/src/\*,
  packages/schemas/validator-vectors.json, eval/prompts.yaml,
  deploy/vbpf-agent.service); no test names are invented. New doc uses
  only env names, make targets, ports, and helper scripts the
  docs-check gate already knows, so `bash scripts/check-docs.sh` stays
  green.
- **Verified:** bash scripts/check-docs.sh green; prettier --check
  clean on docs/threat-model.md, README.md, and SECURITY.md
  (docs/decisions.md carries pre-existing prettier drift outside this
  diff, verified against HEAD and left untouched).
