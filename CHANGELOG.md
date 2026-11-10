# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] — targeting v0.2.0

Per decision D-4, the changes since `v0.1.0` are new features and API
additions (live AI generation, explain, run summaries), so the next release
is `v0.2.0`, not `v0.1.1`. Version bumps, the annotated tag, and publishing
stay with R-26; this file records the content.

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
  Supported versions remain `0.1.x` until `v0.2.0` is tagged and published.

## [v0.1.0] — 2026-11-01 (tag)

Initial tagged snapshot. See git history for detail.
