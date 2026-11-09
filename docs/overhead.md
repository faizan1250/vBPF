# Overhead (stub)

Tracing costs CPU, especially on hot paths (every syscall, every block I/O).
Limits reduce but do not eliminate overhead. No measurements have been
collected yet — overhead benchmarking is deferred to a later release.
This file records the method so future runs are comparable.

## Method

1. Pick a recipe and a fixed duration (default 10 s).
2. Run it via the UI or `scripts/run-recipe.sh` on an idle machine.
3. Record from the run summary: `events`, `bytes`, `dropped`,
   `duration_ms`, `exit_reason`.
4. Record host CPU alongside: `pidstat -p $(pgrep bpftrace) 1` or
   `/usr/bin/time -v` on the agent, plus overall `%idle` from `vmstat 1`.
5. Always note: kernel (`uname -r`), bpftrace (`bpftrace --version`), BTF
   present (`ls /sys/kernel/btf/vmlinux`), recipe id, duration.

Prefer in-kernel aggregation (`count()`, `hist()`, map snapshots) over
per-event `printf()`: one line per syscall on `raw_syscalls` is the
worst case and the reason the static validator warns on it.

## Results

| Recipe | Kernel | bpftrace | Duration | Events | Dropped | Host CPU | Notes               |
| ------ | ------ | -------- | -------- | ------ | ------- | -------- | ------------------- |
| TBD    | TBD    | TBD      | TBD      | TBD    | TBD     | TBD      | No measurements yet |

## Guardrails that bound overhead

Duration cap 60 s, 5 MB/run auto-stop, 500 events/s stream cap, map-keys cap
4096, single concurrent run. See `docs/security.md` for the full table.
