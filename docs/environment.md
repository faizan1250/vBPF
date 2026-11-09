# Environment

Local runs read `.env` (gitignored); copy it from `.env.example`. Never commit
real provider keys, and never add them to CI secrets — CI always runs with
`LLM_MODE=mock`.

- Tools: Go 1.23+, Node 22 LTS, pnpm 9.x.
- Reserved loopback ports: web 5173, api 8080, agent 8787.
- Safety caps for generated probes: see `MAX_DURATION_S`, `BPFTRACE_*` in
  `.env.example`.

## Survey (R-04) — 2026-11-09

Surveyed as root via `wsl -u root` (passwordless from the Windows side;
`sudo -n` inside WSL is password-gated for this user, so `wsl -u root` is the
documented root path on this machine).

- Distro: Ubuntu 24.04.5 LTS (Noble), WSL2 (`wsl --list --verbose` → Ubuntu
  Running, VERSION 2; `wsl --version` → WSL 2.6.3.0, kernel 6.6.87.2-1).
- Kernel (`uname -r`): `6.6.87.2-microsoft-standard-WSL2` (x86_64).
- bpftrace: v0.20.2 (LLVM 18.1.3, libdw yes). `bpftrace --info` reports
  `btf: yes`, `module btf: yes`.
- BTF: present, `/sys/kernel/btf/vmlinux` (6,050,732 bytes, root-readable).
- tracefs/debugfs: mounted (`tracefs on /sys/kernel/tracing`,
  `tracefs on /sys/kernel/debug/tracing`, `debugfs on /sys/kernel/debug`).
  Listing `/sys/kernel/tracing/` requires root; unprivileged reads are denied.

### Per-recipe probe availability (`bpftrace -l '<probe>'`, as root)

All 10 recipes: required probes listed, no alternatives needed.

| Recipe                      | `requires`                                                              | `bpftrace -l` result                                             | Status    |
| --------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------- | --------- |
| `block-latency-histogram`   | `tracepoint:block:block_rq_issue`, `tracepoint:block:block_rq_complete` | both listed verbatim                                             | available |
| `cpu-by-process`            | `profile:hz:99`                                                         | `profile:hz:` listed                                             | available |
| `dns-lookups`               | `uprobe:libc:getaddrinfo`                                               | resolved to `uprobe:/lib/x86_64-linux-gnu/libc.so.6:getaddrinfo` | available |
| `files-opened-by-process`   | `tracepoint:syscalls:sys_enter_openat`                                  | listed verbatim                                                  | available |
| `new-processes`             | `tracepoint:sched:sched_process_exec`                                   | listed verbatim                                                  | available |
| `page-faults-by-process`    | `software:page-faults`                                                  | `software:page-faults:` listed                                   | available |
| `slow-disk-io-by-process`   | `tracepoint:block:block_rq_issue`, `tracepoint:block:block_rq_complete` | both listed verbatim                                             | available |
| `syscall-counts-by-process` | `tracepoint:raw_syscalls:sys_enter`                                     | listed verbatim                                                  | available |
| `tcp-connects`              | `tracepoint:sock:inet_sock_set_state`                                   | listed verbatim                                                  | available |
| `tcp-retransmits`           | `tracepoint:tcp:tcp_retransmit_skb` (+ `interval:s:1`)                  | both listed (`interval:s:` is synthetic)                         | available |

Negative control: `bpftrace -l tracepoint:doesnotexist:nope_xyz` returns no
output, confirming non-empty output above means "present".

### Gaps and fixes

1. `scripts/check-env.sh` as root fails at `go not found` (exit 1). Root
   cause: Go 1.26.2 lives in `/home/faizan/.local/bin/go`, which is on the
   normal user's PATH but not root's — an environment gap, not a script bug,
   so the script was left unchanged. Fix: run with the user-local bin dir on
   PATH, e.g. `wsl -u root bash -lc 'export
PATH=$PATH:/home/faizan/.local/bin && bash scripts/check-env.sh'`.
2. Node in WSL is nvm-managed (`~/.nvm/versions/node/v24.15.0/bin/node`,
   v24.15.0) and absent from non-interactive shells (nvm init lives in
   `.bashrc`, which early-returns when non-interactive). `pnpm` in WSL
   resolves only to a broken Windows npm shim (`node: not found`); no Linux
   pnpm is installed (`corepack` ships with the nvm node but enabling pnpm
   through it is not yet verified). Fix: export the nvm bin dir onto PATH in
   non-interactive sessions; install/enable a Linux pnpm before running
   `check-env.sh` green in WSL.
3. Docker client 29.9.2 is installed in WSL but the daemon socket
   `/var/run/docker.sock` does not exist there; the `desktop-linux` context
   points at a Windows `npipe://` endpoint unreachable from the Linux shell.
   Docker Desktop itself is Running (see `wsl --list --verbose`). Relevant to
   R-10, not blocking R-04.

## Test runs (R-05) — 2026-11-10

Run as root via `wsl -u root` (see R-04 for why root uses `wsl -u root`, not `sudo`).
Kernel `6.6.87.2-microsoft-standard-WSL2`, bpftrace v0.20.2, Go 1.26.2
(`/home/faizan/.local/bin/go`; root's PATH lacks it, so `make` needs
`GO=/home/faizan/.local/bin/go` — environment gap, not a Makefile bug).

- `go vet ./...` in `agent/`: PASS.
- `gofmt -l .` in `agent/`: clean.
- `go test -race -count=1 ./...` in `agent/`: all 5 packages ok, no data
  races (`cmd/agent`, `limits`, `parser`, `runner`, `server`).
- `make test-integration` (`-tags integration`, root + bpftrace + BTF):
  first run failed `TestIntegrationKillMidRun`: the summary after an
  explicit DELETE carried `exit_reason "cancelled"` (runner contract,
  `runner.go` ctx-cancel path) but the test asserted `{"completed",
"timeout"}`. Fixed the stale assertion to expect
  `runner.ReasonCancelled`; no production code changed (see D-R05-1).
  Re-ran per test: `TestIntegrationKillMidRun` PASS (3.8 s),
  `TestIntegrationThreeRecipes` PASS (11.7 s), all other packages ok.
- Manual workflow commands (`integration-manual.yml`) locally: `id -u` = 0,
  `bpftrace` present, `/sys/kernel/btf/vmlinux` present; `make
test-integration` as above.
- Full `make test-integration` in one shell exceeds the 60 s command cap
  on this machine (compile + sleeps), so it was run per-test/per-package;
  coverage is identical (same `-tags integration` suite).

### Decisions

- D-R04-1: No `check-env.sh` change. The script correctly reported root's
  environment; the gap is PATH configuration, documented above.
- D-R04-2: Root access for kernel surveys on this machine is `wsl -u root`,
  not `sudo`, because `sudo -n` requires a password for this user.
- D-R05-1: Fix the test, not the runner. `cancelled` on explicit stop is
  the documented runner contract (unit-tested in `runner_test.go`, mapped
  to `"stopping"` by `finalState`); the integration assertion was written
  before the suite ever ran on a real kernel and encoded the wrong
  expectation.
- D-R05-2: No `Makefile` change for root's missing `go`. Same class of
  environment gap as D-R04-1; passing `GO=...` on invocation is the fix.

## Platform matrix (R-09) — 2026-11-10

Re-verified as root via `wsl -u root` (same root path as R-04/R-05).

### Tested: WSL2

- Distro: Ubuntu 24.04.5 LTS (Noble) userspace on the Microsoft WSL2 kernel.
- Kernel (`uname -r`): `6.6.87.2-microsoft-standard-WSL2` (x86_64).
- bpftrace: v0.20.2. BTF: present, `/sys/kernel/btf/vmlinux`
  (6,050,732 bytes, root-readable).
- All 10 recipe probes list via `bpftrace -l` (see R-04 table above; no
  change since 2026-11-09).

### Untested: Ubuntu 22.04 and 24.04 VMs (stock kernels)

No VM tooling is available on this machine, so neither VM was tested:

- `multipass` is not installed (`where.exe multipass` finds nothing).
- `wsl --list --verbose` shows a single distro (`Ubuntu`, VERSION 2) plus
  `docker-desktop`; there is no second distro to stand in for 22.04.
- Hyper-V feature state could not be confirmed without elevation
  (`Get-WindowsOptionalFeature` requires elevation); no VM exists regardless.
- Note: WSL2 runs Ubuntu 24.04 _userspace_ on the Microsoft WSL2 kernel, so
  it does not count as testing the stock Ubuntu 24.04 kernel.

Per R-09 these are recorded as "untested", not "pending", in the README
support table. Minimum requirement stays 5.8+ with BTF; stock 22.04/24.04
kernels and older 5.x kernels are unverified.

## Docker and e2e (R-10) — 2026-11-10

Run from Windows PowerShell against Docker Desktop 4.98.0 (engine 29.9.2,
`desktop-linux` context). Base images pulled fresh; `docker compose up
--build -d` exited 0 and all three services turned `healthy` (agent, api,
web) via the compose `depends_on: service_healthy` chain.

- Agent container: `Privileged=true`, `PidMode=host`, mounts
  `vbpf_agent-token:/token`, `/sys/kernel/debug` and `/sys/kernel/tracing`
  (rw). No ports published to the host (`8787/tcp` compose-internal only).
- Agent health from inside the container (via `GET /api/health` through the
  web proxy): kernel `6.6.87.2-microsoft-standard-WSL2` (Docker Desktop VM
  kernel, not the WSL2 distro kernel), bpftrace v0.20.2, `btf: true`,
  `root: true`, `tracefs: true`. `tracepoint:raw_syscalls:sys_enter` and the
  other recipe probes resolve on this kernel (same list as R-04; the
  Docker Desktop kernel carries the same WSL2 kernel build).
- Web UI: `GET http://localhost:5173/` → 200, `<title>vBPF</title>` present.
- One-recipe E2E (`syscall-counts-by-process`, mock LLM, no workload needed):
  `POST /api/generate` → 200, `validation ok` in 1 attempt;
  `POST /api/runs` → 201 `running`; WS `/ws/runs/<id>` streamed 1 map event
  (769 bytes, 0 dropped); run ended by its 10 s timeout
  (`exit_reason "timeout"`), so the follow-up `/stop` returned 404
  `NOT_FOUND` — the run was already reaped, which is the expected API
  behavior, not a failure. Verdict: the agent traced bpftrace events from
  the privileged container end to end through the compose stack.
- `scripts/quickstart.sh` now fails fast: a service reporting `unhealthy`
  (or `exited`/`dead`) aborts the wait immediately instead of sleeping the
  full 36×5 s. Transient `starting`/`created`/`restarting` states still get
  the full wait (see D-R10-1). Verified with a stubbed-`docker` harness:
  unhealthy → exit 1 in 0 s with the fail-fast message; all-healthy and
  starting→healthy → exit 0, no false fail-fast. `bash -n` clean.
- `docker compose down -v`: all 3 containers, `vbpf_agent-token`,
  `vbpf_api-data`, and `vbpf_default` removed. No vbpf container, volume, or
  network remains; the only privileged container in the stack (the agent) is
  gone. Remaining containers/volumes are pre-existing non-vbpf infra
  (buildkit, exited socat/jenkins).
- Local `pnpm -C web test:e2e`: 2 passed (`smoke`, `happy`), exit 0, no
  flakes and no changes needed. The `[vite] http proxy error ... ECONNREFUSED
127.0.0.1:8080` lines in the server log are expected: the dev server has
  no API backend and both specs mock every `/api/*` route (plus the WS
  stream), so nothing real is ever proxied.

## Chaos and cleanup (R-11) — 2026-11-10

Run as root via `wsl -u root` (same root path as R-04/R-05). Kernel
`6.6.87.2-microsoft-standard-WSL2`, bpftrace v0.20.2. `bpftool` is not
installed in this WSL distro, so the `bpftool prog list` half of the R-11
criterion self-skips (logged, not failed); `pgrep -a bpftrace` plus the
`/tmp/vbpf-*.bt` glob are enforced on every test.

Pre-existing coverage: `TestIntegrationKillMidRun` (orderly DELETE stop →
`cancelled`, pgrep clean). Added four tests in
`agent/internal/server/integration_test.go`, each ending in `assertNoLeak`
(pgrep empty, no temp scripts, bpftool if present):

| Chaos case                                                  | Test                                | Result                                                                                                                                                                          |
| ----------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kill bpftrace itself (`kill -KILL` the child)               | `TestIntegrationKillBpftraceMidRun` | PASS (2.9 s): summary `failed`, registry drains, no leak                                                                                                                        |
| Close tab mid-run (WS dropped, no close frame, no DELETE)   | `TestIntegrationCloseTabMidRun`     | PASS (2.6 s): run survives the lost viewer (`Active()==1`), later DELETE → `cancelled`, no leak                                                                                 |
| Kill API mid-run (WS drops, DELETE never arrives)           | `TestIntegrationAPIKillMidRun`      | PASS (7.5 s): orphaned run hits its 4 s deadline alone → `timeout` on reconnect, no leak                                                                                        |
| Kill agent mid-run (SIGKILLed agent leaves an orphan child) | `TestIntegrationAgentRestartSweep`  | PASS: a real orphan `bpftrace -f json /tmp/vbpf-orphan-*.bt` in its own process group is reaped by `SweepStale` (the same call `realServe` makes before listening), pgrep clean |

Guarantees (mechanism, all pre-existing — R-11 added tests, not code): the
child runs in its own process group (`Setpgid`), every exit path group-kills
(SIGINT, grace, SIGKILL), the temp script is `0600` and removed on return,
and `SweepStale` at agent startup kills leftover own-run groups matched by
`pgrep -f 'vbpf-.*\.bt'` (never foreign bpftrace work).

Regression: `go vet ./...`, `gofmt -l` clean; `go test -count=1 ./...` all 5
packages ok; `TestIntegrationKillMidRun` and `TestIntegrationThreeRecipes`
still pass with the extended `assertNoLeak`.
