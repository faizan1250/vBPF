# vBPF v0.3.0 — draft release notes (do not publish)

> Draft for R2-05 slice 17. Publishing is gated on the R2 acceptance set
> (R2-01 to R2-05) with `make lint && make test` green. Pushing the tag
> and publishing the release are maintainer one-time steps. Supersedes the
> v0.2.0 draft notes; `RELEASE_NOTES_v0.2.0.md` is left untouched.

## What is it

Describe what you want to observe in plain English; get a safe, reviewable
eBPF probe and a live visualization. Built on top of bpftrace, not a
replacement for it.

## New in v0.3.0

- **Hardened live client**: one shared request/classification path, base-URL
  validation (invalid URLs never reach the network), structured per-call
  logs with zero secret or prompt text, and real provider token usage.
- **Prompt isolation**: stable system message plus delimited user message;
  user text and retry feedback can no longer be silently truncated away or
  leak into the system prompt.
- **Bounded latency**: per-request deadline spans headers and body, plus a
  90 s overall budget per call (503 `LLM_UNAVAILABLE` with `Retry-After`
  when exhausted); semaphore slots always release.
- **Real-kernel numbers**: live+agent eval on
  `groq/openai/gpt-oss-120b` (kernel
  `6.6.87.2-microsoft-standard-WSL2`, bpftrace `v0.20.2`) — static 26/26,
  dry-run first-try 20/26, within-retries 23/26, produced-output 20/23 of
  validated generated scripts, refusal-correct 30/30. Full report:
  `eval/reports/2026-11-10-live-real.md`. The two dry-run targets were
  missed and are published as-is with a gap analysis.
- **Config truth**: per-provider `LLM_<NAME>_MODEL` (required),
  `LLM_<NAME>_JSON_MODE`, `LLM_<NAME>_BASE_URL`, `LLM_CUSTOM_BASE_URL`,
  `LLM_TIMEOUT_MS` / `LLM_TOTAL_TIMEOUT_MS`; Go minimum 1.26+.

## Requirements

Linux with kernel 5.8+ and BTF, bpftrace 0.20+, root for the agent only,
Node 22+ with pnpm 9+, Go 1.26+. A provider API key enables AI generation;
recipe-only mode works without one.

## Upgrade notes

- **Breaking: `LLM_MODEL` no longer works in live mode.** Set
  `LLM_<PROVIDER>_MODEL` per provider (for example `LLM_GROQ_MODEL`); a
  provider with no model is `unconfigured`. Setting `LLM_MODEL` with
  `LLM_MODE=live` logs one deprecation warning and is ignored. Fresh
  `cp .env.example .env` recommended.
- If a provider rejects `json_object`/`tool` mode (`400/422`), the client
  downgrades that provider to `none` once per process and retries once.
- Supported security-fix line moves to `0.3.x` once this release is tagged.

Full detail: [`CHANGELOG.md`](CHANGELOG.md).
