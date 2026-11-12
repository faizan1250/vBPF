# Security

Threat model: vBPF is a **local loopback service**. Natively the API and
agent bind `127.0.0.1` only; there is no multi-user auth on the API
itself — any local process can call it. (In the compose quickstart the
agent binds the container wildcard `0.0.0.0` under the explicit
`AGENT_ALLOW_WILDCARD_BIND=1` opt-in because each container has its own
loopback; no agent or API port is published to the host — see
[Compose quickstart network](#compose-quickstart-network).) The agent runs as **root** and executes kernel probes,
so treat the host accordingly. The LLM is untrusted: its output is validated
twice (API static checks + agent re-validation and dry-run compile) and never
executed without human confirmation.

## Network surface

- API and agent listen on loopback by default; the agent refuses
  non-loopback bind addresses except the `0.0.0.0`/`::` wildcard when
  explicitly opted in with `AGENT_ALLOW_WILDCARD_BIND=1` (compose sets
  this because each container has its own loopback), and a specific
  non-loopback address is always refused. No TLS (loopback); put a
  reverse proxy in front if you ever expose the UI beyond localhost.
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
- CI runs `govulncheck ./...` (the `vuln` job, via `make vuln`) and
  `go test -race ./...` (in `test-unit`) on every push/PR. Run them locally
  with the same commands before opening a PR, plus the manual JS check:

  ```bash
  pnpm audit --audit-level=low
  govulncheck ./...
  ```

### R-21 dependency audit (2026-11-10, base `232091a`)

`pnpm audit` found 17 findings (3 critical, 2 high, 11 moderate, 1 low),
all in dev-only transitive paths except one production dependency:

- `vitest@2.1.9` (dev, api + web) pulled vulnerable `tinypool`,
  `@vitest/mocker`, `vite`, and `esbuild` copies, including the 3 criticals
  (GHSA-5xrq-8626-4rwp, GHSA-5gmw-xhrv-c9v3, GHSA-85c8-ppgw-ccpr).
  Fixed by bumping `vitest` to `^4.1.12` in `api` and `web`.
- `zod@3.25.76` (production, via `@vbpf/schemas`): GHSA-mrhx-c7xc-m3w5
  (high, memory exhaustion on oversized constrained collections). Fixed by
  bumping `zod` to `^4.6.6` in `api` and `packages/schemas`; all schemas use
  basic builders fully compatible with the v4 API (verified by typecheck +
  unit tests). Residual risk is further capped by the 64 KB request body
  limit enforced before validation.
- `vite@5.4.21` (dev, web) and its nested copies: dev-server FS/request
  advisories. Fixed by bumping `vite` to `^6.4.4`, which also satisfies the
  vitest 4 peer range (`^6 || ^7 || ^8`).
- `esbuild<=0.24.2` (transitive, GHSA-67mh-4wv8-2f99) and
  `minimatch@10.2.6` (transitive via `typescript-eslint`, moderate DoS):
  pinned with `pnpm.overrides` in the root `package.json`
  (`esbuild ^0.25.0`, `minimatch@^10.0.0` to `^11.0.1`; the `minimatch@3`
  copies used by eslint itself are outside the affected range and untouched).

Post-fix `pnpm audit --audit-level=low` reports **no known vulnerabilities**.

`govulncheck ./...` reports **no vulnerabilities**.

Two findings came up during the audit and were fixed, not waived:

- GO-2026-5024 (integer overflow in `NewNTUnicodeString`,
  `golang.org/x/sys/windows`, fixed upstream in `v0.44.0`): fixed by bumping
  `golang.org/x/sys` `v0.29.0` → `v0.44.0`. It was package-level only
  (Windows-only syscall helper, never called; the agent is Linux-only), but
  the fix was cheap once the baseline below allowed it.
- 31 standard-library findings when scanning with the old pinned toolchain:
  fixed by moving the Go baseline 1.23 → 1.27 (`agent/go.mod`,
  `agent/Dockerfile`, CI `setup-go`, `docs/ci.md`, `docs/environment.md`).
  `govulncheck@v1.9.0` itself requires Go >= 1.26, so the old pin could not
  even run the current scanner without a toolchain switch.

### R-22 keys hygiene (2026-11-10, base `92d267f`)

CI runs gitleaks on every push/PR (the `secrets` job, `make secrets`
locally). `GET /api/health` exposes per-provider key _counts_ only
(`LiveLlmChain.health()`); the agent token is file-scoped and never part
of any response. API logs redact `authorization` headers and token fields
via the pino `redact` config in `buildApp`. Covered by
`api/src/keys-hygiene.test.ts`, which boots the app in live mode with
realistic fake keys, fetches `/api/health`, and asserts neither the
response body nor captured log output contains key material.

## Logging and redaction

- API logs redact `authorization` headers and any `token` field.
- The agent never logs its bearer token. Captured child stderr is bounded
  (64 KB) and surfaced as events, not logs.
- Temp script files are created `0600` and removed after the run.
- **Scrubbed child process environment:** every `exec.Command` invocation inside `agent/` (`runner.Run`, `DefaultDryRun`, `Catalog.Refresh`, exact `uprobe` checks, `probe-args`, health `--version`, and startup `pgrep` sweep) constructs an explicit minimal allowlisted environment containing only `PATH` (plus deterministic sorted `BPFTRACE_MAX_PROBES=50`, `BPFTRACE_MAP_KEYS_MAX=4096`, `BPFTRACE_STRLEN=64` for both dry-run compile and real execution). `os.Environ()` is never inherited, preventing `LD_LIBRARY_PATH` / `LD_PRELOAD` injection; `FAKE_*` test variables are forwarded only when running inside Go test binaries (`testing.Testing()`).

## Validation, uprobe allowlist, and fail-closed catalog

- **`uprobe` / `uretprobe` allowlist (`libc`-only):** both API static validation and agent re-validation restrict user-space probes to the bare alias `libc` or a canonical POSIX absolute path under `/lib`, `/lib64`, `/usr/lib`, or `/usr/lib64` (with at most one multiarch subdirectory matching `^[a-z0-9_]+-linux-[a-z0-9]+$`) and a shared-object basename matching `^libc\.so(\.[0-9]+)*$` or `^libc-[0-9]+(\.[0-9]+)*\.so$` (no `.`, `..`, `//`, whitespace, or trailing `/`). Symbols must be plain identifiers (`^[A-Za-z_][A-Za-z0-9_]*$`, rejecting wildcards, `+offset`, hex addresses, quotes, or extra segments); `usdt` remains rejected. On the host, the agent verifies `EvalSymlinks` stays within the rootfs and still satisfies the allowed directory/libc basename rules, confirms a regular root-owned (`uid == 0`) non-group/world-writable (`mode & 0o022 == 0`) binary, and runs a bounded `bpftrace -l 'uprobe:<target>:<symbol>'` existence check (`3s` timeout, `8 KB` cap; falling back across allowed libc directories for `libc`).
- **Uprobe user-space visibility & hot-symbol warnings:** even when scoped to `libc`, uprobes can read user-space arguments across any process on the host (for example `getaddrinfo` hostnames or `malloc` sizes). Human confirmation and validator warnings for hot symbols (`malloc`, `free`, `memcpy`, `memset`, `strlen`, `read`, `write`) remain required before execution.
- **Token-level, default-deny function allowlist:** both implementations lex
  the script (identifiers, numbers, string literals with escapes, operators,
  punctuation, comments, preprocessor lines) and record every identifier call
  site. Strings and comments can never read as calls; unterminated strings or
  comments, preprocessor lines (`#...`), NUL/control bytes, non-ASCII code
  outside strings/comments, token floods, and deep nesting are validation
  errors. Calls to `system`, `signal`, `override`, `cat` are rejected as
  `BLOCKED_CALL`; any other call outside the allowlist of read-only and
  aggregation builtins (`printf`, `print`, `count`, `sum`, `avg`, `min`,
  `max`, `stats`, `hist`, `lhist`, `delete`, `clear`, `zero`, `str`,
  `strncmp`, `strlen`, `buf`, `ntop`, `kstack`, `ustack`, `ksym`, `usym`,
  `time`, `join`, `exit`, `cgroup_path`, `cgroupid`) is rejected as
  `UNKNOWN_CALL` with the function name.
- **Agent verdict is authoritative; shared parity vectors pin it:** `POST
/api/generate`, `POST /api/validate`, and `POST /api/runs` always rely on
  the agent verdict — the API never vetoes or accepts a script on its own
  (not even for `--unsafe` text, which the token-level validator judges
  like any other content). The TS validator runs in `skip` catalog mode
  for instant pre-generation feedback, `/api/explain` gating, and offline
  use; in `runGenerate` its errors are advisory and an agent acceptance
  overrides them with a recorded `validator discrepancy` warning. Every
  rule is pinned by `packages/schemas/validator-vectors.json`: both suites
  load the same file and assert identical `ok` verdicts and error codes
  (message text may differ). `make parity` (CI `parity` job) fails when a
  vector exists that only one side executes. The taxonomy
  (`CATALOG_UNAVAILABLE`, `VALIDATION_FAILED`, `PROBE_NOT_FOUND`,
  `LIMIT_EXCEEDED`, `BLOCKED_CALL`, `UNKNOWN_CALL`) is defined once as
  `ValidatorErrorCodeSchema` in `@vbpf/schemas`.
- **Strict wildcard grammar & probe-count cap:** at most one `*` is permitted and only as the last character of the final segment (`tracepoint:<subsys>:*`, `tracepoint:<subsys>:<prefix>*`, `kprobe:<prefix>*`, `kretprobe:<prefix>*` with at least 3 prefix characters for `kprobe`/`kretprobe`; wildcards are rejected on `uprobe`, `uretprobe`, `profile`, `interval`, `software`, `BEGIN`, `END`, as are `?`, `[`, `]`). `tracepoint` has no prefix-length floor because patterns are catalog-bounded (the subsystem must match a known entry and every expansion counts toward the cap), while `kprobe`/`kretprobe` match an unbounded kernel symbol namespace and need the floor. Total probe **occurrences** (counting duplicate blocks/targets and each wildcard's expanded catalog match count) are capped at `BPFTRACE_MAX_PROBES` (`50`), enforced in static validation, agent re-validation, dry-run compile, and runtime env.
- **Fail-closed non-blocking catalog readiness:** the agent binds HTTP immediately without blocking startup and loads `bpftrace -l` asynchronously with exponential backoff (`1s`..`30s`). Readiness requires at least one non-empty refresh; failed/empty refreshes preserve the previous immutable snapshot atomically while recording `stale_since` and `last_error`. While unready, `/health` reports `200` with `ready: false` while `/v1/validate` and `/v1/runs` fail closed (`503 CATALOG_UNAVAILABLE` + `Retry-After`) for every script including `BEGIN {}`, and the API maps upstream `503`/`CATALOG_UNAVAILABLE` to `503 AGENT_NOT_READY` + `fix_hint` across `/api/validate`, `/api/runs`, and `/api/generate`.

## What the LLM sees

Generation sends the prompt, retrieved recipe texts, candidate probe names,
and compiler error strings. **Probe output (process names, file paths,
command lines) is never sent to the LLM.** In recipe-only mode nothing
leaves the machine.

## Error taxonomy

| Code                 | Signal                                                           | Surfaced where                                                                                       |
| -------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `AGENT_OFFLINE`      | Agent unreachable / token unreadable                             | `/api/health`, proxies (`503`)                                                                       |
| `AGENT_NOT_READY`    | Agent catalog still loading or refresh failed                    | `/api/health` readiness, proxies (`503` + `Retry-After` + hint)                                      |
| `NO_PRIVILEGE`       | Agent health `root: false`                                       | `/api/health` warnings, TopBar hint                                                                  |
| `KERNEL_UNSUPPORTED` | Health `btf: false` or `tracefs: false`                          | `/api/health` warnings, TopBar hint                                                                  |
| `PROBE_NOT_FOUND`    | Probe / wildcard / uprobe symbol missing on host                 | `POST /v1/runs` (`400` `code`); `/v1/validate` reports `errors` (`200`, no `code`)                   |
| `VALIDATION_FAILED`  | Static allowlist, host libc FS, compile err, or bad JSON (`400`) | `POST /v1/runs` (`400` `code`); `/v1/validate` (`400` bad JSON only; script errs `200` `errors`)     |
| `BLOCKED_CALL`       | Denylisted call (`system`, `signal`, `override`, `cat`) (`400`)  | `POST /v1/runs` (`400` `code`); `/v1/validate` reports `errors` (`200`, no `code`)                   |
| `UNKNOWN_CALL`       | Call outside the function allowlist (`400`)                      | `POST /v1/runs` (`400` `code`); `/v1/validate` reports `errors` (`200`, no `code`)                   |
| `LIMIT_EXCEEDED`     | Concurrent run (`409`) or total probes > 50 (`400`)              | `POST /v1/runs` (`409` / `400` `code`); `/v1/validate` reports `> 50` in `errors` (`200`, no `code`) |
| `RATE_LIMITED`       | Generate budget spent                                            | `POST /api/generate` (`429` + `Retry-After`)                                                         |
| `REFUSAL`            | Unsafe prompt refused by the LLM gate                            | `POST /api/generate` (`422`)                                                                         |
| `LLM_UNAVAILABLE`    | Live mode without a provider key                                 | `POST /api/generate` (`503`)                                                                         |
| `FORBIDDEN`          | Foreign `Origin` / non-loopback `Host`                           | Any API route (`403`)                                                                                |

Known design trade-offs (documented, not silently unhandled):

- Runs are **not** preflight-gated on `root`/`btf`: a non-root or BTF-less
  host reports warnings in `/api/health`, but a run is still accepted once the
  catalog is ready and fails at exec/dry-run time (surfaced as a failed run and
  stderr events). By contrast, catalog unready states (`ready: false`) fail
  closed across validation, generation, and run creation (`503 AGENT_NOT_READY`).
- **Validation vs. run error envelopes (`POST /v1/validate` vs. `POST /v1/runs`):**
  `POST /v1/runs` returns HTTP `400` with JSON `{error, code, errors}` for
  `PROBE_NOT_FOUND`, `VALIDATION_FAILED`, `BLOCKED_CALL`, `UNKNOWN_CALL`
  (static denylist, allowlist, host-libc, or compile failures), and
  `LIMIT_EXCEEDED` (>50 probes), plus
  HTTP `409` `LIMIT_EXCEEDED` for a concurrent active run. By contrast,
  `POST /v1/validate` reports probe misses, static/host-libc/compile
  failures, and >50 probe-cap errors inside
  `{ok: false, errors, probes, warnings, probe_count}`
  (`ValidateResponseSchema`) on HTTP `200` with **no** `code` field;
  beyond `401 UNAUTHORIZED`, `POST /v1/validate` **only** returns a JSON
  `code` field on `400 VALIDATION_FAILED` (malformed JSON request) and
  `503 CATALOG_UNAVAILABLE` (when the probe catalog is not ready, mapped to
  `503 AGENT_NOT_READY` by `/api/validate`). Callers of `/v1/validate` must
  inspect `ok`, `errors`, `warnings`, and `probe_count` rather than checking
  `res.status === 400` or `body.code`.

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
