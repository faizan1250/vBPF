# vBPF

Local-first bpftrace assistant. Day-1 scaffold: no-op agent, minimal api/web
shells, mock-only eval. See `docs/ci.md` for the CI picture.

## Ports (loopback)

| Service | Port | Dev command            |
| ------- | ---- | ---------------------- |
| web     | 5173 | `pnpm -C web run dev`  |
| api     | 8080 | `pnpm -C api run dev`  |
| agent   | 8787 | `scripts/dev-agent.sh` |

## Quickstart

Requires Go 1.22+, Node 22, pnpm 9.

```sh
cp .env.example .env  # local-only, never commit real keys
make setup
make lint
make test
make eval
```

Environment defaults live in `.env.example` (ports, safety caps). The real
`.env` is gitignored.

## Mock-only policy

CI sets `LLM_MODE=mock` and reads no secrets; unevaluated LLM paths take the
`LLM_UNAVAILABLE` fallback. Provider keys stay local (`.env`) and are never
added to CI. `make eval` runs the mock harness only; real bpftrace tests need
root + BTF via `make test-integration` (manual workflow, expected to SKIP on
stock runners).
