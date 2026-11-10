# Decisions

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
