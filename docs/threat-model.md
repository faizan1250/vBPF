# Threat model

vBPF is a **local loopback service**: the API and the agent bind `127.0.0.1`
by default, and the agent runs with kernel-tracing privilege and executes
bpftrace programs. The design assumes the LLM will sometimes be wrong and
treats every layer as untrusted by the next. This document names the assets,
the actors, the trust boundaries, and the threats with their mitigations;
mechanism details live in [`security.md`](security.md).

## Assets

| Asset                     | Where it lives                                                                                                                            | Why it matters                                                                        |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Host kernel and host data | The machine running the agent; the agent holds `BPF`/`PERFMON`/`SYS_RESOURCE` capabilities (compose) or the systemd bounding set (native) | A validator bypass inherits kernel-level tracing and, at worst, root-equivalent power |
| LLM provider API keys     | Local `.env` only (gitignored, never in CI); only per-provider key _counts_ leave the process                                             | Keys bill the owner's account and identify them to the provider                       |
| Agent bearer token        | `AGENT_TOKEN_FILE` (mode `0600`), shared with the API over a read-only volume in compose                                                  | Anyone holding it can ask the privileged agent to run probes                          |
| Run history               | SQLite (`DATABASE_PATH`) and browser localStorage                                                                                         | Past scripts and metadata persist beyond the session                                  |
| Probe output              | Process names, file paths, command lines in run events                                                                                    | Host activity data; must never reach the LLM provider (see T-08)                      |

## Actors

- **Local user** — the operator at the browser. Trusted to confirm runs, but
  still shown the exact script before anything executes.
- **Malicious web page** — any site the operator visits; the browser may be
  tricked into calling the loopback API (DNS rebinding, cross-origin fetch).
- **Compromised API** — the API process is unprivileged and reachable by any
  local process, so the agent must treat its requests as adversarial.
- **Malicious model output** — a generated script that tries to escape the
  probe sandbox (`system()`, kprobe floods, exotic probes).
- **Malicious prompt** — prompt-injection or adversarial input aiming to get
  an unsafe script generated, validated, or run.
- **Network attacker** — on the local path: proxy headers, a hostile peer
  claiming trusted-proxy status, or (in compose) another container on the
  bridge network.

## Trust boundaries

1. **Browser to API.** Crossed by every UI call. Guarded by the loopback-only
   `Host` gate (DNS-rebinding protection, also applied to WebSocket
   upgrades), the exact-`WEB_ORIGIN` CORS check (never `*`), and `TRUST_PROXY`
   allowlisting so a direct client cannot spoof the rate-limiter key.
   (`api/src/server.ts`, `docs/security.md`.)
2. **API to agent.** Crossed on every validate/run/probe-args call. Guarded by
   a bearer token from `AGENT_TOKEN_FILE` compared in constant time, required
   on every agent endpoint; both ends bind loopback by default and the agent
   refuses non-loopback binds without an explicit opt-in.
   (`agent/cmd/agent/main.go`, `agent/internal/server/auth.go`,
   `agent/internal/server/auth_test.go`.)
3. **Agent to bpftrace.** Crossed at dry-run compile and at run time. The
   agent never trusts the API verdict: it re-validates every script, checks
   uprobe targets against the host, compiles with `BPFTRACE_*` caps, scrubs
   the child environment, and enforces duration/output/rate/concurrency
   limits with process-group teardown. (`agent/internal/server/validate.go`,
   `agent/internal/server/runs.go`, `agent/internal/limits/limits.go`.)
4. **API to LLM provider.** Crossed only in live generation/explain. Only the
   prompt, retrieved recipe texts, candidate probe names, and compiler error
   strings are sent; probe output never leaves the machine, and recipe-only
   mode sends nothing at all. (`api/src/generate.ts`, `docs/security.md`.)

## Threat table

Each row names the STRIDE category, the threat, and the mitigation with the
file or test that pins it. `security.md` holds the mechanism detail; the
reference here proves the mitigation exists.

| ID   | STRIDE                 | Threat                                                                                            | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---- | ---------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| T-01 | Spoofing               | A malicious web page calls the loopback API via DNS rebinding or cross-origin fetch.              | Loopback-only `Host` gate plus exact-`Origin` and fetch-site checks return `403 FORBIDDEN` (`api/src/server.ts`); agent origin allowlist in `agent/internal/server/origins.go`, pinned by `agent/internal/server/origin_test.go`.                                                                                                                                                                                                                                                                                  |
| T-02 | Spoofing               | A local process calls the privileged agent directly, bypassing the API.                           | Every agent endpoint requires the bearer token (`agent/internal/server/auth.go`, `agent/internal/server/auth_test.go`); the token file is created mode `0600` (`agent/cmd/agent/main.go`).                                                                                                                                                                                                                                                                                                                         |
| T-03 | Tampering              | A network attacker spoofs proxy headers to evade rate limits, or binds a non-loopback address.    | `TRUST_PROXY` defaults to socket-address keying (`api/src/server.ts`); the agent binds `127.0.0.1:8787` and refuses other addresses without opt-in (`agent/cmd/agent/main.go`, `agent/internal/server/bind_test.go`).                                                                                                                                                                                                                                                                                              |
| T-04 | Tampering              | Malicious model output: a generated script with blocked calls, wildcards, or oversized probes.    | Lexer plus default-deny function allowlist in `api/src/validator.ts` (`api/src/validator.test.ts`, `api/src/validator-lexer.test.ts`, `api/src/validator-fuzz.test.ts`) and independently in `agent/internal/server/validate.go` (`agent/internal/server/adversarial_test.go`, `agent/internal/server/fuzz_validate_test.go`); shared vectors in `packages/schemas/validator-vectors.json` kept in sync by `make parity` (`api/src/validator-vectors.test.ts`, `agent/internal/server/validator_vectors_test.go`). |
| T-05 | Tampering / Elevation  | A compromised API sends an already-"validated" script to the agent.                               | The agent verdict is authoritative and the API never vetoes or accepts on its own (`agent/internal/server/validate.go`, `agent/internal/server/runs.go`); an agent acceptance that overrode the static pre-check is surfaced as a `validator discrepancy` warning (`api/src/generate.ts`, `api/src/generate.test.ts`).                                                                                                                                                                                             |
| T-06 | Elevation              | A validated script escalates via the child process environment (`LD_PRELOAD`, `LD_LIBRARY_PATH`). | Every agent child gets an explicit minimal allowlist env; `os.Environ()` is never inherited (`agent/internal/limits/limits.go`, `agent/internal/server/env_test.go`, `agent/internal/runner/runner_test.go`).                                                                                                                                                                                                                                                                                                      |
| T-07 | Elevation              | The agent retains more privilege than tracing needs.                                              | Minimal caps in compose, the `deploy/vbpf-agent.service` bounding set natively, and an in-process `no_new_privs` plus capset drop at startup (`agent/internal/priv/priv.go`, `agent/internal/priv/priv_test.go`); negative probes via `scripts/check-privilege.sh`.                                                                                                                                                                                                                                                |
| T-08 | Information disclosure | Probe output (process names, file paths, command lines) leaks to the LLM provider.                | Generation sends only prompt, recipe texts, probe names, and compiler errors — never run output (`api/src/generate.ts`); health and logs expose key counts, never key material (`api/src/keys-hygiene.test.ts`).                                                                                                                                                                                                                                                                                                   |
| T-09 | Information disclosure | Provider keys or the agent token leak via logs, health, or the repo.                              | API logs redact authorization headers and token fields (`api/src/keys-hygiene.test.ts`); provider keys stay in local `.env`, CI is mock-only, and gitleaks runs per push (`make secrets`).                                                                                                                                                                                                                                                                                                                         |
| T-10 | Denial of service      | LLM-cost exhaustion via repeated generate/explain calls.                                          | Shared 10 req/min per-IP bucket with `429 RATE_LIMITED` plus `Retry-After` (`api/src/server.ts`, `api/src/generate.test.ts`, `api/src/explain.test.ts`).                                                                                                                                                                                                                                                                                                                                                           |
| T-11 | Denial of service      | A runaway probe burns CPU or floods output.                                                       | `BPFTRACE_MAP_KEYS_MAX`/`BPFTRACE_MAX_PROBES`/`BPFTRACE_STRLEN` caps, 5 MB output cap, 500/s event rate, 60 s max duration, one concurrent run (`agent/internal/limits/limits.go`, `agent/internal/limits/limits_test.go`, `agent/internal/runner/runner_test.go`).                                                                                                                                                                                                                                                |
| T-12 | Repudiation            | A run is disputed: what script actually executed, and was it reviewed?                            | Nothing runs before human confirmation; the API stores the exact script's SHA-256 and whether it differs from the generated version (`api/src/server.ts`, `api/src/contract.test.ts`, `api/src/db.test.ts`).                                                                                                                                                                                                                                                                                                       |
| T-13 | Tampering              | A uprobe target escapes to an attacker-chosen library or symbol.                                  | `libc`-only allowlist with root-owned, non-writable file checks and a bounded `bpftrace -l` existence probe (`agent/internal/server/uprobe.go`, `agent/internal/server/uprobe_test.go`, `agent/internal/server/uprobe_namespace_test.go`); wildcard/symbol grammar shared with `api/src/validator.ts`.                                                                                                                                                                                                             |
| T-14 | Tampering              | Validation or a run proceeds against a stale or empty probe catalog.                              | Fail-closed readiness: the agent serves `503 CATALOG_UNAVAILABLE` until the catalog loads, mapped to `503 AGENT_NOT_READY` by the API (`agent/internal/server/catalog.go`, `agent/internal/server/catalog_test.go`).                                                                                                                                                                                                                                                                                               |
| T-15 | Information disclosure | The agent token is read by another local user or container.                                       | Token file created mode `0600` and mounted read-only into the API container (`agent/cmd/agent/main.go`, `docs/security.md`); every agent endpoint still demands it (T-02).                                                                                                                                                                                                                                                                                                                                         |
| T-16 | Tampering              | A malicious prompt gets an unsafe script generated or run.                                        | Adversarial prompts are refused or rejected by validation (`agent/internal/server/adversarial_test.go`, `eval/prompts.yaml` 42-case adversarial set); the human-confirmation gate and T-04/T-05 layers still apply to anything generated.                                                                                                                                                                                                                                                                          |

## Residual risks

Stated plainly — these are accepted, not fixed:

1. **The agent is privileged.** It runs with kernel-tracing capabilities
   (compose) or root-equivalent caps (native). A validator bypass inherits
   that power: kernel-wide tracing and, at worst, full host compromise. The
   layers in T-04/T-05/T-07 shrink what a bypass inherits but cannot remove
   the privilege itself. Run the agent on a machine you can afford to lose
   (development VM or host), never expose it beyond loopback without your
   own network controls.
2. **Uprobes read user-space memory of any process.** Even scoped to `libc`,
   uprobes observe arguments of shared library calls host-wide (for example
   hostnames in `getaddrinfo`, buffer sizes in `malloc`). Hot symbols
   (`malloc`, `free`, `read`, `write`, and friends) raise validator warnings
   and still require human confirmation — do not confirm them on a host
   carrying secrets in process memory.
3. **The LLM provider sees prompts.** In live mode your prompt text,
   retrieved recipes, candidate probe names, and compiler errors are sent to
   the configured provider (`LLM_PROVIDER_CHAIN`). Do not paste secrets into
   prompts; use recipe-only mode (`LLM_MODE=mock`) when nothing may leave
   the machine.
4. **Kernel verifier bugs exist.** The in-kernel verifier is the last line of
   defense and has had exploitable bugs before. vBPF never relies on it
   alone — static validation, agent re-validation, and confirmation all come
   first — but a verifier flaw plus a validator miss would reach the kernel.
   Keep the host kernel patched.

Related: any local process can call the API (loopback bind is the only
gate — there is no multi-user auth), and runs are not preflight-gated on
`root`/`btf` (a non-root or BTF-less host fails at exec/dry-run time rather
than at admission). Both are documented trade-offs in
[`security.md`](security.md).
