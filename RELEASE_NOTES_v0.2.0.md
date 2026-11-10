# vBPF v0.2.0 — draft release notes (do not publish)

> Draft for R-26. Publishing is gated on R-01, R-02, R-12, R-13, R-15 to
> R-23 with `make lint && make test` green. Pushing the tag and publishing
> the release are maintainer one-time steps.

## What is it

Describe what you want to observe in plain English; get a safe, reviewable
eBPF probe and a live visualization. Built on top of bpftrace, not a
replacement for it.

## New in v0.2.0

- **Live AI generation**: natural-language prompts become validated bpftrace
  scripts via an ordered provider chain (`groq` default), with compile-error
  repair (up to 2 retries) and per-provider fallback models.
- **Explain this probe**: one-click plain-English walkthrough of any script.
  Only the script text is sent; probe output never leaves your machine.
- **Run summaries**: runs persist state, counts, and exit reasons;
  `GET /api/runs/:id` returns metadata plus summary.
- **Hardening**: WebSocket origin allowlist (deny by default), wildcard
  bind guard, generation-bound runs, SQLite hygiene, FTS5 hardening,
  dependency and secret scanning in CI.
- **Verified, not claimed**: live eval scores
  (`groq/openai/gpt-oss-120b`: 26/26 first-try compile, 4/4 adversarial
  refused, 9/10 recipes produced events in 5 s runs), platform matrix, and
  overhead numbers are published in the README and `docs/`.

## Requirements

Linux with kernel 5.8+ and BTF, bpftrace 0.20+, root for the agent only,
Node 22+ with pnpm 9+, Go 1.27+. A provider API key enables AI generation;
recipe-only mode works without one.

## Upgrade notes

- Fresh `cp .env.example .env` recommended; `LLM_PROVIDER_CHAIN` is now
  honored (previously silently defaulted to `groq`).
- `make -C eval run-live` now paces at `--delay-ms 15000` for free-tier
  rate limits.
- Supported security-fix line moves to `0.2.x` once this release is tagged.

Full detail: [`CHANGELOG.md`](CHANGELOG.md).
