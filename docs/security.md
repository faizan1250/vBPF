# Security

Threat model: vBPF is a **local loopback service**. The API and agent bind
`127.0.0.1` only; there is no multi-user auth on the API itself — any local
process can call it. The agent runs as **root** and executes kernel probes,
so treat the host accordingly. The LLM is untrusted: its output is validated
twice (API static checks + agent re-validation and dry-run compile) and never
executed without human confirmation.

## Network surface

- API and agent listen on loopback only; the agent refuses non-loopback bind
  addresses. No TLS (loopback); put a reverse proxy in front if you ever
  expose the UI beyond localhost.
- CORS origin is exactly `WEB_ORIGIN`, never `*`. Requests carrying any other
  `Origin` get `403 FORBIDDEN`.
- `Host` must be loopback (`127.0.0.1`, `localhost`, `::1`, any port).
  Non-loopback Host values get `403 FORBIDDEN`. This is DNS-rebinding
  protection; the same hook covers WebSocket upgrades.
- No `X-Forwarded-Host` / proxy headers are honored.

## Auth and tokens

- Every agent endpoint requires `Authorization: Bearer <token>`, compared in
  constant time. The token lives in `AGENT_TOKEN_FILE` with mode `0600`
  (created by the agent on first start) and is never logged.
- The API reads the same file to call the agent; if it is unreadable the API
  reports `AGENT_OFFLINE` instead of leaking the cause.

## Rate limiting and size limits

- `POST /api/generate` (the LLM-backed, most expensive route): **10
  requests/minute per client IP**. Over budget returns `429 RATE_LIMITED`
  with a `Retry-After` header. Other routes are cheap proxies and unbounded.
- Request bodies are capped at 64 KB; scripts at 8 KB; prompts at 2000 chars;
  search queries at 256 chars. Oversize input is rejected before any agent
  round-trip.
- Per-run kernel/output guards are applied as `BPFTRACE_*` environment
  variables plus stream caps:

  | Guard                   | Value                                        |
  | ----------------------- | -------------------------------------------- |
  | `BPFTRACE_MAP_KEYS_MAX` | 4096                                         |
  | `BPFTRACE_MAX_PROBES`   | 50                                           |
  | `BPFTRACE_STRLEN`       | 64                                           |
  | Max bytes per run       | 5 MB (auto-stop, `exit_reason: limit_bytes`) |
  | Event rate to consumers | 500/s sustained                              |
  | Concurrent runs         | 1 (`409 LIMIT_EXCEEDED` on clash)            |
  | Max run duration        | 60 s                                         |

## Dependencies and secrets

- CI is mock-only and reads no secrets: `LLM_MODE=mock`, provider keys stay
  in local `.env` (gitignored), never in Actions secrets.
- Before opening a PR, run the manual supply-chain checks (kept out of CI so
  CI stays hermetic):

  ```bash
  pnpm audit --audit-level=high
  govulncheck ./...
  ```

## Logging and redaction

- API logs redact `authorization` headers and any `token` field.
- The agent never logs its bearer token. Captured child stderr is bounded
  (64 KB) and surfaced as events, not logs.
- Temp script files are created `0600` and removed after the run.

## What the LLM sees

Generation sends the prompt, retrieved recipe texts, candidate probe names,
and compiler error strings. **Probe output (process names, file paths,
command lines) is never sent to the LLM.** In recipe-only mode nothing
leaves the machine.

## Error taxonomy

| Code                 | Signal                                                    | Surfaced where                               |
| -------------------- | --------------------------------------------------------- | -------------------------------------------- |
| `AGENT_OFFLINE`      | Agent unreachable / token unreadable                      | `/api/health`, proxies (`503`)               |
| `NO_PRIVILEGE`       | Agent health `root: false`                                | `/api/health` warnings, TopBar hint          |
| `KERNEL_UNSUPPORTED` | Health `btf: false` or `tracefs: false`                   | `/api/health` warnings, TopBar hint          |
| `PROBE_NOT_FOUND`    | Probe missing from kernel catalog / dry-run compiler miss | `POST /v1/runs` code                         |
| `VALIDATION_FAILED`  | Blocklist, allowlist, size, or other compile errors       | `POST /v1/runs`, `POST /v1/validate` errors  |
| `LIMIT_EXCEEDED`     | Concurrent run (`409`) or wildcard past probe cap (`400`) | `POST /v1/runs` code                         |
| `RATE_LIMITED`       | Generate budget spent                                     | `POST /api/generate` (`429` + `Retry-After`) |
| `REFUSAL`            | Unsafe prompt refused by the LLM gate                     | `POST /api/generate` (`422`)                 |
| `LLM_UNAVAILABLE`    | Live mode without a provider key                          | `POST /api/generate` (`503`)                 |
| `FORBIDDEN`          | Foreign `Origin` / non-loopback `Host`                    | Any API route (`403`)                        |

Known gaps (documented, not silently unhandled):

- Runs are **not** preflight-gated on `root`/`btf`: a non-root or BTF-less
  host reports warnings in `/api/health`, but a run is still accepted and
  fails at exec/dry-run time (surfaced as a failed run and stderr events).
  Rationale: health can change between check and run, and the single-run
  registry has no queue for deferred admission.
- `POST /v1/validate` returns an `{ok, errors, probes}` envelope with **no**
  code field; probe misses appear as error strings, not `PROBE_NOT_FOUND`.
  Only `POST /v1/runs` carries taxonomy codes.

## Reporting a vulnerability

Do not open a public issue. Use a GitHub private vulnerability report or
contact the maintainer directly. Aim: acknowledge within 3 business days.

## Compose quickstart network

`docker-compose.yml` publishes only the web front door
(`"${WEB_PORT:-5173}"` to container port 80). The API and agent are reachable
solely inside the compose network, and every agent endpoint still requires its
bearer token, shared via the `agent-token` volume (file mode `0600`, mounted
read-only into the API container).

- The API binds `0.0.0.0` in its container but keeps the per-request `Host`
  (loopback-only) and `Origin` (exactly `WEB_ORIGIN`, never `*`) gates. nginx
  proxies `/api` and `/ws` same-origin, so the browser's `Origin` is the web
  URL: keep `WEB_ORIGIN` exactly that, including `WEB_PORT` when changed.
- Natively the agent binds loopback only and refuses `0.0.0.0` unless
  `AGENT_ALLOW_WILDCARD_BIND=1`; in compose each container has its own
  loopback, so the agent starts with `--addr 0.0.0.0:8787` and compose sets
  the flag. The code still refuses a specific non-loopback address, and
  the port is unpublished, so `0.0.0.0` is scoped to the compose network.
