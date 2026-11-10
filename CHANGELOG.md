# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] — 2026-11-10

Live-client hardening, prompt isolation, bounded LLM latency, real-kernel
eval numbers, and config truth. Tag `v0.3.0` is prepared locally; pushing
the tag and publishing the release are maintainer one-time steps.

### Added

- Single live-LLM request path: `postChat()` and `postExplain()` share one
  `requestChat()` plus one `classifyResponse()`; no duplicated status
  handling (R2-04a).
- Base-URL validation (`validateBaseUrl`) for `LLM_CUSTOM_BASE_URL` and
  per-provider `LLM_<NAME>_BASE_URL`: https required except loopback
  (`127.0.0.1`, `localhost`, `::1`, `host.docker.internal`); credentials,
  query, and fragment rejected; trailing slash stripped. Invalid URLs mark
  the provider `unconfigured` with a host-only reason and never reach the
  network (R2-04b).
- Per-provider `LLM_<NAME>_JSON_MODE` (`json_object` default | `tool` |
  `none`); `tool` mode uses a `submit_probe` function tool whose parameters
  mirror `LlmOutputSchema`, with a forced `tool_choice`. One-time automatic
  downgrade to `none` (process lifetime, single retry, no cooldown) on
  `400/422` matching `/response_format|json_object|json mode|tool/i`
  (R2-04f).
- Structured per-call provider logs (optional pino child logger, no-op
  default): `provider`, `model`, `key_index`, `status`, `outcome`, `latency_ms`,
  `prompt_chars`, `usage`. Never prompt/response text, headers, keys, or raw
  errors. Startup line records mode, providers, models, key counts (R2-04d).
- Real token usage (`usage.prompt_tokens` / `usage.completion_tokens`) on
  `LlmDetailedResult` when the provider reports it; eval prefers real usage
  and labels the fallback "approx" (R2-04e).
- Overall LLM deadline `LLM_TOTAL_TIMEOUT_MS` (default 90000): every
  `generate`/`explain` attempt uses `min(per-request, remaining)`; budget
  exhaustion throws `LlmUnavailableError`, served as 503 `LLM_UNAVAILABLE`
  with `retry_after_s` and a `Retry-After` header (R2-03).
- Prompt isolation: `buildGeneratePrompt()` returns `parts`
  (`system`/`context`/`user`); `LiveLlmChain` sends a stable system message
  (static prefix + JSON contract + untrusted-data rule) and a user message
  (reference context, then `<user_request>`, then `<previous_attempt>` on
  retries). Closing tags and `==WORD==` markers in user text are escaped;
  control characters stripped. Truncation shrinks context (probes to 15,
  then arg formats, then recipes to 1) and never the system message, user
  request, or feedback block. No tail slice remains in generate or explain
  (R2-02).
- Real-agent eval mode (`--agent` with `--agent-url`/`--token-file`):
  preflight requires reachable + `root: true` + `btf: true` (no stub
  fallback); generated scripts are dry-run compiled by the real agent and
  each validated script runs 5 s with produced-output counting
  (`printf`/`map`/`hist`/`lhist`); `must_refuse` cases that validate are
  flagged `ACCEPTED-UNSAFE-CASE` and never run. Reports record kernel and
  bpftrace versions, per-case `produced_status`, and script persistence to
  `eval/reports/<date>-live-real-scripts.ndjson`. `make -C eval run-live-real`
  added; CI stays mock-only (R2-01).
- Live+agent eval numbers (model `groq/openai/gpt-oss-120b`, kernel
  `6.6.87.2-microsoft-standard-WSL2`, bpftrace `v0.20.2`): static 26/26,
  dry-run first-try 20/26, within-retries 23/26, produced-output 20/23 of
  validated generated scripts, refusal-correct 30/30, probe-match 23/23,
  view-match 22/23, real tokens 68028. Report:
  `eval/reports/2026-11-10-live-real.md`. The two dry-run targets (80% /
  95%) were missed and are published as-is with a gap analysis (agent
  catalog rejects uprobe scripts, noisy dry-run feedback, model variance);
  no round 3 within budget (R2-01 stage B).
- Config: `LLM_<NAME>_MODEL` (required per provider), `LLM_<NAME>_FALLBACK_MODELS`,
  `LLM_<NAME>_JSON_MODE`, `LLM_<NAME>_BASE_URL`, `LLM_CUSTOM_BASE_URL`,
  `LLM_TIMEOUT_MS` (45000), `LLM_TOTAL_TIMEOUT_MS` (90000) documented in
  README and `.env.example`; Go minimum lowered to 1.26 (verified floor;
  CI runs floor + latest) (R2-05a/d).

### Changed

- **Breaking (live config): `LLM_MODEL` is deprecated and ignored in live
  mode.** `discoverModel()` returns only `LLM_<NAME>_MODEL`; a provider with
  no model is `unconfigured`. The config default is `"mock"` (mock-mode
  label only); setting `LLM_MODEL` with `LLM_MODE=live` logs one warning:
  "LLM_MODEL is deprecated and ignored; use LLM_<NAME>_MODEL". Removed
  from `.env.example` and the README config table (R2-04c).
- Request deadline spans headers and body: the abort timer clears only
  after the capped body is fully read; header stall or slow-drip body fails
  with `outcome: "timeout"` into short cooldown (R2-03).
- Semaphore releases in `finally` on every path; waiters capped at 10 with
  a 10 s wait timeout, then `LlmUnavailableError("busy")` (R2-03).
- README evaluation table uses real-mode labels ("Passes static
  validation", "Compiles on a real kernel (dry-run)", "Produces events
  when run (generated scripts)"), names model and kernel, links both
  reports, and never calls static-only numbers "compiles" (R2-05c).
- Human-confirmation wording: "You see the exact script. The API stores its
  SHA-256 and whether it differs from the generated version, and the agent
  independently re-validates every script before it runs." (R2-05b).
- Launch gate (`docs/launch.md`) references the real-agent report; all
  drafts quote dry-run numbers, never static-only "compiles" claims
  (R2-05e).

### Security

- See `docs/security.md` (canonical) and `SECURITY.md` (reporting).
  Supported versions remain `0.1.x` until release; the supported-versions
  table then moves to `0.3.x`.

## [0.2.0] — 2026-11-10

Per decision D-4, the changes since `v0.1.0` are new features and API
additions (live AI generation, explain, run summaries), so the next release
is `v0.2.0`, not `v0.1.1`. Tag `v0.2.0` is prepared locally; pushing the tag
and publishing the release are maintainer one-time steps.

### Added

- Live LLM generation with ordered provider fallback (`groq` default;
  `cerebras`, `openrouter`, `ollama`, `gemini`, `custom` supported), key
  rotation on `401/403`, provider cooldown on `429`, per-provider fallback
  models, and key-count-only health reporting (R-01).
- Real tracepoint argument formats injected into the generation prompt via
  agent `GET /v1/probe-args` (R-03).
- `POST /api/explain` with static-first validation, SHA-256 result cache,
  and an "Explain this probe" walkthrough panel in the UI (R-12).
- Run summaries persisted on stream end plus `GET /api/runs/:id`
  (metadata + summary only; no script text) (R-13).
- `POST /api/runs` accepts an optional `generation_id`; unknown ids are
  rejected and script edits are flagged (R-18).
- Agent WebSocket origin allowlist, deny-by-default (R-16).
- Wildcard bind guard: `0.0.0.0` requires `AGENT_ALLOW_WILDCARD_BIND=1`
  (R-17).
- SQLite hygiene: `foreign_keys`, `busy_timeout`, `synchronous=NORMAL`,
  `trusted_schema=OFF` on every connection, `PRAGMA user_version`
  migrations, `PRAGMA optimize` on shutdown (R-19).
- Hardened FTS5 query builder with quoting and input audits (R-20).
- Dependency audit fixes (`vitest` 4, `zod` 4, `vite` 6, `esbuild` /
  `minimatch` overrides; Go baseline 1.23 to 1.27) and `govulncheck` /
  `go test -race` coverage (R-21).
- Keys hygiene: gitleaks in CI plus a test that `/api/health` and logs
  never contain key material (R-22).
- `SECURITY.md`, `CODE_OF_CONDUCT.md`, and README links to them (R-23).
- Scripted fixture-mode demo GIF (`scripts/make-demo.sh`) referenced from
  the README (R-24).
- Live eval report with real scores, produced-output numbers from 5 s
  agent runs, platform matrix, overhead table, and Docker quickstart
  verification (R-02, R-07–R-10).
- Captured fixtures for all 10 recipes (R-06 follow-up; README now says
  all 10, not 5 of 10).
- `CHANGELOG.md` and `RELEASE_NOTES_v0.2.0.md` (this release).

### Fixed

- `loadConfig` dropped `LLM_PROVIDER_CHAIN`, so a configured chain was
  silently replaced by the `groq` default; the env value is now passed
  through, with a regression test (R-15).
- `make -C eval run-live` paced at `--delay-ms 2000`, which trips free-tier
  `429`s; the default is now `15000` to match the verified live run and
  the README's ~8 min paced run (R-15).
- Go version badges and mentions corrected from 1.23 to 1.27 to match
  `agent/go.mod`, `agent/Dockerfile`, and CI (R-15).
- README privacy note now states the Explain button sends only script
  text, and the adversarial row reads 4/4 refused (30/30 refusal-correct
  overall) to match the live report (R-15).

### Security

- See `docs/security.md` (canonical) and `SECURITY.md` (reporting).
  Supported versions remain `0.1.x` until `v0.2.0` is published; the
  supported-versions table then moves to `0.2.x`.

## [v0.1.0] — 2026-11-01 (tag)

Initial tagged snapshot. See git history for detail.
