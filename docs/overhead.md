# Overhead

Tracing costs CPU, especially on hot paths (every syscall, every block I/O).
Limits reduce but do not eliminate overhead. Measurements below were collected
2026-11-09 on the dev machine; the method records how to repeat them.

## Method

1. Pick a recipe and a fixed duration (default 10 s).
2. Run it via `scripts/run-recipe.sh` on an idle machine.
3. Record from the run summary: `events`, `bytes`, `dropped`,
   `duration_ms`, `exit_reason`.
4. Record host CPU alongside: `pidstat -p $(pgrep bpftrace) 1` or
   `/usr/bin/time -v` on the agent, plus overall `%idle` from `vmstat 1`.
5. Always note: kernel (`uname -r`), bpftrace (`bpftrace --version`), BTF
   present (`ls /sys/kernel/btf/vmlinux`), recipe id, duration.

Prefer in-kernel aggregation (`count()`, `hist()`, map snapshots) over
per-event `printf()`: one line per syscall on `raw_syscalls` is the
worst case and the reason the static validator warns on it.

## Environment (2026-11-09)

- Kernel: `6.6.87.2-microsoft-standard-WSL2` (WSL2, 8 CPUs), BTF present
  (`/sys/kernel/btf/vmlinux` exists).
- bpftrace `v0.20.2`.
- Each recipe ran 10 s via `bpftrace -q -f json recipes/<id>.bt`, killed with
  `SIGTERM` (END probes print the map, as `timeout` does).
- Host CPU = mean `%CPU` of the `bpftrace` process from `pidstat 1`;
  system idle = mean `id` column of `vmstat 1` (first sample skipped).
- Idle = no extra workload. Loaded = `stress-ng --cpu 2` plus
  recipe-specific activity (syscall/cpu: `/bin/true` loop; slow-disk: `dd`
  8 MB `oflag=dsync` writes in a loop; tcp: `curl` loop against
  `python3 -m http.server` on 127.0.0.1:18080).
- Dropped = matches for `lost|dropped` on bpftrace stderr; 0 in all runs.

## Results

| Recipe                             | Kernel                           | bpftrace | Duration | Events                                              | Dropped | Host CPU                             | Notes                                                           |
| ---------------------------------- | -------------------------------- | -------- | -------- | --------------------------------------------------- | ------- | ------------------------------------ | --------------------------------------------------------------- |
| syscall-counts-by-process (idle)   | 6.6.87.2-microsoft-standard-WSL2 | v0.20.2  | 10 s     | 19,336 syscalls aggregated in-kernel, 413 B map     | 0       | bpftrace 1.3% avg, system 99.0% idle | `count()` per comm, one map print at END                        |
| syscall-counts-by-process (loaded) | 6.6.87.2-microsoft-standard-WSL2 | v0.20.2  | 10 s     | ~318k syscalls aggregated in-kernel, 454 B map      | 0       | bpftrace 1.7% avg, system 58.8% idle | `/bin/true` loop dominates (`true` 143k, `bash` 128k)           |
| cpu-by-process (idle)              | 6.6.87.2-microsoft-standard-WSL2 | v0.20.2  | 10 s     | 10,755 profile samples, mostly `swapper`, 368 B map | 0       | bpftrace 1.0% avg, system 99.1% idle | `profile:hz:99`, pure sampling                                  |
| cpu-by-process (loaded)            | 6.6.87.2-microsoft-standard-WSL2 | v0.20.2  | 10 s     | `stress-ng-cpu` 1,956 of 7,826 samples, 565 B map   | 0       | bpftrace 0.9% avg, system 57.4% idle | sampler cost flat under load                                    |
| slow-disk-io-by-process (idle)     | 6.6.87.2-microsoft-standard-WSL2 | v0.20.2  | 10 s     | 1 slow op (`jbd2/sdf-8`), 56 B                      | 0       | bpftrace 7.0% avg, system 97.0% idle | two tracepoints + per-I/O maps; includes BPF compile at startup |
| slow-disk-io-by-process (loaded)   | 6.6.87.2-microsoft-standard-WSL2 | v0.20.2  | 10 s     | 0 slow ops, 2 B                                     | 0       | bpftrace 7.0% avg, system 71.1% idle | `dd` dsync writes all completed < 10 ms threshold               |
| tcp-connects (idle)                | 6.6.87.2-microsoft-standard-WSL2 | v0.20.2  | 10 s     | 0 connections, 2 B                                  | 0       | bpftrace 3.6% avg, system 98.1% idle | no loopback traffic; per-event `printf`                         |
| tcp-connects (loaded)              | 6.6.87.2-microsoft-standard-WSL2 | v0.20.2  | 10 s     | ~30 loopback connections, 62 lines, 4,322 B         | 0       | bpftrace 3.8% avg, system 70.4% idle | each connection logged twice (both directions)                  |

Takeaway: in-kernel aggregation holds output to a few hundred bytes and
~1-2% bpftrace CPU even at ~31k syscalls/s. The per-event `tcp-connects`
probe scales with connection rate (4.3 KB for 30 connections in 10 s).
`slow-disk-io-by-process` shows the highest baseline (~7%) from tracing
every block issue/complete pair plus startup compile cost.

## Guardrails that bound overhead

Duration cap 60 s, 5 MB/run auto-stop, 500 events/s stream cap, map-keys cap
4096, single concurrent run. See `docs/security.md` for the full table.
