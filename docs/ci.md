# CI skeleton

`ci.yml` runs on push/PR to `main` (ubuntu-24.04 only) and stays green with
no service code: every `make` target prints SKIP when its dir is absent.

| Job           | What it does                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------ |
| lint          | go vet + golangci-lint, tsc, ESLint/Prettier, shellcheck                                         |
| test-unit     | `go test ./...` + `go test -race ./...` on latest verified Go (1.27.x), api/web vitest — no root |
| test-unit-min | `go test -race ./...` on the minimum Go from `agent/go.mod` — no root                            |
| vuln          | `govulncheck ./...` via `make vuln` — no root, no secrets                                        |
| secrets       | gitleaks secret scan (R-22 keys hygiene) — no secrets                                            |
| contract      | API contract vs fake agent fixture                                                               |
| e2e-mocked    | Playwright, chromium only, mock fixtures                                                         |
| eval-mock     | `make eval` with `LLM_MODE=mock`, no secrets                                                     |
| fuzz-short    | `make fuzz` (FUZZ_TIME=30s per target), seed corpora committed                                   |
| compat-check  | `render-compat.mjs --check` (generated matrix docs fresh, no root)                               |
| docs-check    | `bash scripts/check-docs.sh` (documented flags/env/targets/ports/scripts/links match code)       |
| docker-build  | Image build only — no push, no privileged run                                                    |

Go floor: `agent/go.mod` (`go 1.26.11`, resolved from the file by
`setup-go`); latest verified: Go 1.27.x. Node 22 LTS, pnpm 9.x pinned.

## Secrets policy: mock-only

CI sets `LLM_MODE=mock` and reads no secrets. No `ANTHROPIC_API_KEY`,
no `OPENCODE_API_KEY` in workflows — unevaluated LLM paths take the
`LLM_UNAVAILABLE` fallback. Provider keys are local-only (`.env`,
gitignored), never committed, never added to Actions secrets.

The `secrets` job runs `gitleaks/gitleaks-action@v3` (default rules, full
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

## Kernel/platform matrix

`kernel-matrix.yml` (`workflow_dispatch` plus a weekly Monday schedule) is
the only workflow that needs root and bpftrace, and it never fails on
kernel gaps: test steps use `continue-on-error`, every outcome is recorded
into `compat/<env>.json` (a finding, not a failure), and the JSON is
uploaded as an artifact. A maintainer downloads the artifact, reviews it,
and commits it to `compat/`; `node scripts/render-compat.mjs` (or
`make compat`) regenerates `docs/compat.md` and the README platform table
from those files, and `compat-check` in `ci.yml` keeps the generated files
fresh. The optional `vm-kernels` job tries specific kernels
(5.10/5.15/6.1/6.6) via virtme-ng and records `not-run` when the runner
has no KVM or kernel image. Hosted actions are SHA-pinned like the rest of
CI; `runs-on` images are GitHub-hosted labels (not SHA-pinnable).

Ports (reserved, loopback): web 5173, api 8080, agent 8787.
