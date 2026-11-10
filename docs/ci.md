# CI skeleton

`ci.yml` runs on push/PR to `main` (ubuntu-24.04 only) and stays green with
no service code: every `make` target prints SKIP when its dir is absent.

| Job          | What it does                                                      |
| ------------ | ----------------------------------------------------------------- |
| lint         | go vet + golangci-lint, tsc, ESLint/Prettier, shellcheck          |
| test-unit    | `go test ./...` + `go test -race ./...`, api/web vitest — no root |
| vuln         | `govulncheck ./...` via `make vuln` — no root, no secrets         |
| secrets      | gitleaks secret scan (R-22 keys hygiene) — no secrets             |
| contract     | API contract vs fake agent fixture                                |
| e2e-mocked   | Playwright, chromium only, mock fixtures                          |
| eval-mock    | `make eval` with `LLM_MODE=mock`, no secrets                      |
| docker-build | Image build only — no push, no privileged run                     |

Pinned: Go 1.27.x, Node 22 LTS, pnpm 9.x.

## Secrets policy: mock-only

CI sets `LLM_MODE=mock` and reads no secrets. No `ANTHROPIC_API_KEY`,
no `OPENCODE_API_KEY` in workflows — unevaluated LLM paths take the
`LLM_UNAVAILABLE` fallback. Provider keys are local-only (`.env`,
gitignored), never committed, never added to Actions secrets.

The `secrets` job runs `gitleaks/gitleaks-action@v2` (default rules, full
history via `fetch-depth: 0`) on every push/PR. Run it locally with
`make secrets` once [gitleaks](https://github.com/gitleaks/gitleaks) is
installed; `api/src/keys-hygiene.test.ts` additionally asserts
`GET /api/health` and captured logs never contain key material (health
exposes per-provider key _counts_ only, logs redact `authorization` and
token fields).

## Real bpftrace tests

`integration-manual.yml` (`workflow_dispatch` only) needs root, bpftrace,
and kernel BTF. It is expected to fail on stock runners; use a prepared
self-hosted runner. Go integration tests use `//go:build integration`.

Ports (reserved, loopback): web 5173, api 8080, agent 8787.
