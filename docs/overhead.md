# Overhead

Tracing costs CPU, especially on hot paths (every syscall, every block I/O).
Limits reduce but do not eliminate overhead. Measurements below were collected
2026-11-12 on the dev machine (refresh of the 2026-11-09 table, post M1-M3);
the method records how to repeat them.

## Method

1. Pick a recipe and a fixed duration (default 10 s).
2. Run it 3 times via `timeout 10 bpftrace -q -f json recipes/<id>.bt`
   (as `scripts/run-recipe.sh` does; `SIGTERM` lets END probes print the
   map). Kill order is fixed: idle reps, then loaded reps per recipe.
3. Track host CPU with `pidstat -p` on the **resolved bpftrace child PID**
   (`pgrep -x bpftrace` after launch): `pidstat -C` omits zero-activity
   intervals on this sysstat build, which would bias the mean upward.
   `$!` is the `timeout` parent (0.00% CPU) and must not be tracked.
4. Record alongside: output bytes and JSON event lines, stderr matches for
   `lost|dropped`, per-1 s `%CPU` samples, and `vmstat 1` system idle.
5. Headline CPU = mean (min–max) of **all** pidstat samples pooled across
   the 3 reps (n≈30), so one-time BPF compile is in the number, as in the
   2026-11-09 table. Steady-state figures exclude each run's first 1 s
   sample and are stated separately. System idle = mean `id` column with
   the first (since-boot) sample skipped. Events = median across reps
   with min–max; dropped must be 0 or the cell is invalid.
6. Loaded = `stress-ng --cpu 2` plus recipe-specific activity
   (syscall/cpu: `/bin/true` loop; slow-disk: `dd` 8 MB `oflag=dsync`
   writes in a loop; tcp: `curl` loop against `python3 -m http.server`
   on 127.0.0.1:18080). Idle = no extra workload.
7. Always note: kernel (`uname -r`), bpftrace (`bpftrace --version`), BTF
   present (`ls /sys/kernel/btf/vmlinux`), recipe id, duration, n.

Prefer in-kernel aggregation (`count()`, `hist()`, map snapshots) over
per-event `printf()`: one line per syscall on `raw_syscalls` is the
worst case and the reason the static validator warns on it.

## Environment (2026-11-12)

- Kernel: `6.6.87.2-microsoft-standard-WSL2` (WSL2, 8 CPUs), BTF present
  (`/sys/kernel/btf/vmlinux` exists).
- bpftrace `v0.20.2`.
- Each recipe ran 3 × 10 s via `bpftrace -q -f json recipes/<id>.bt`,
  killed with `SIGTERM` (END probes print the map, as `timeout` does).
- Host CPU = mean (min–max) of all per-1 s `%CPU` samples for the
  resolved bpftrace PID, pooled across reps (n≈30; two cells n=29 where
  one rep yielded 8 samples); system idle = mean `id` column of
  `vmstat 1` (first sample skipped).
- Idle = no extra workload. Loaded = `stress-ng --cpu 2` plus
  recipe-specific activity (syscall/cpu: `/bin/true` loop; slow-disk: `dd`
  8 MB `oflag=dsync` writes in a loop; tcp: `curl` loop against
  `python3 -m http.server` on 127.0.0.1:18080).
- Dropped = matches for `lost|dropped` on bpftrace stderr; 0 in all 24 runs.

## Results (2026-11-12, n=3 reps per cell)

| Recipe                             | Kernel                           | bpftrace | Duration | Events (median, min–max)                                                 | Dropped | bpftrace CPU mean (min–max, n≈30) | System idle mean | Notes                                                           |
| ---------------------------------- | -------------------------------- | -------- | -------- | ------------------------------------------------------------------------ | ------- | --------------------------------- | ---------------- | --------------------------------------------------------------- |
| syscall-counts-by-process (idle)   | 6.6.87.2-microsoft-standard-WSL2 | v0.20.2  | 3 × 10 s | 10,469 syscalls aggregated in-kernel, 728 B map (3,585–7,447,989†)       | 0       | 0.6% (0.0–9.0)                    | 95.1%            | `count()` per comm, one map print at END                        |
| syscall-counts-by-process (loaded) | 6.6.87.2-microsoft-standard-WSL2 | v0.20.2  | 3 × 10 s | ~310k syscalls aggregated in-kernel, 690 B map (176k–322k, ~18–32k/s)    | 0       | 1.5% (0.0–27.0)                   | 56.0%            | `/bin/true` loop + `stress-ng --cpu 2`                          |
| cpu-by-process (idle)              | 6.6.87.2-microsoft-standard-WSL2 | v0.20.2  | 3 × 10 s | 7,504 profile samples, mostly `swapper` (7,392–7,535; 527 B map)         | 0       | 5.0% (0.0–60.0)                   | 98.6%            | `profile:hz:99`, pure sampling; mean dominated by compile burst |
| cpu-by-process (loaded)            | 6.6.87.2-microsoft-standard-WSL2 | v0.20.2  | 3 × 10 s | 7,815 profile samples, `stress-ng-cpu` dominant (7,792–7,816; 420 B map) | 0       | 0.8% (0.0–10.0, n=29)             | 74.6%            | sampler cost flat under load                                    |
| slow-disk-io-by-process (idle)     | 6.6.87.2-microsoft-standard-WSL2 | v0.20.2  | 3 × 10 s | 0 slow ops (empty 2 B map, all reps)                                     | 0       | 4.5% (0.0–49.0)                   | 98.4%            | two tracepoints + per-I/O maps; mean is BPF compile at startup  |
| slow-disk-io-by-process (loaded)   | 6.6.87.2-microsoft-standard-WSL2 | v0.20.2  | 3 × 10 s | 6 slow ops median (0–8; 65 B map)                                        | 0       | 5.0% (0.0–54.0)                   | 59.6%            | `dd` dsync writes mostly completed < 10 ms threshold            |
| tcp-connects (idle)                | 6.6.87.2-microsoft-standard-WSL2 | v0.20.2  | 3 × 10 s | 0 connections, 2 B                                                       | 0       | 1.9% (0.0–20.0)                   | 99.3%            | no loopback traffic; per-event `printf`                         |
| tcp-connects (loaded)              | 6.6.87.2-microsoft-standard-WSL2 | v0.20.2  | 3 × 10 s | ~20–28 loopback connections (40–56 events, 3,170 B map)                  | 0       | 3.8% (0.0–52.0, n=29)             | 70.5%            | each connection logged twice (both directions)                  |

† Idle rep 1 counted 7,447,989 syscalls, 99.99% from `journalctl`
(a background log-reader burst on this shared dev box). The probe
counted it correctly (0 drops); the median keeps the headline
representative and the full range is shown.

Steady state (each run's first 1 s sample excluded, removing the
one-time BPF compile burst of 8–60%): pooled means are 0.0–0.3% and
per-rep means 0.0–0.8% in every cell. At 1 s resolution the probes
themselves cost ~0%; 10 s-run averages are dominated by compile.

## Per-rep data

Steady CPU = mean of that rep's pidstat samples with the first
(compile) sample excluded. Compile = that rep's first 1 s sample.
Idle = mean `vmstat` idle with the first sample skipped.

| Recipe                    | Load   | Rep | Compile 1st-sample % | Steady CPU mean % (n) | System idle % | Events                     | Bytes | Dropped |
| ------------------------- | ------ | --- | -------------------- | --------------------- | ------------- | -------------------------- | ----- | ------- |
| syscall-counts-by-process | idle   | 1   | 8.0                  | 0.0 (9)               | 87.1          | 7,447,989 syscalls         | 843   | 0       |
| syscall-counts-by-process | idle   | 2   | 9.0                  | 0.1 (9)               | 99.2          | 3,585 syscalls             | 728   | 0       |
| syscall-counts-by-process | idle   | 3   | 1.0                  | 0.0 (9)               | 99.0          | 10,469 syscalls            | 712   | 0       |
| syscall-counts-by-process | loaded | 1   | 10.0                 | 0.1 (9)               | 52.1          | 310,206 syscalls           | 887   | 0       |
| syscall-counts-by-process | loaded | 2   | 27.0                 | 0.1 (9)               | 58.6          | 322,093 syscalls           | 620   | 0       |
| syscall-counts-by-process | loaded | 3   | 0.0                  | 0.8 (9)               | 57.4          | 176,268 syscalls           | 690   | 0       |
| cpu-by-process            | idle   | 1   | 41.0                 | 0.2 (9)               | 98.1          | 7,535 samples              | 571   | 0       |
| cpu-by-process            | idle   | 2   | 60.0                 | 0.2 (9)               | 99.2          | 7,392 samples              | 379   | 0       |
| cpu-by-process            | idle   | 3   | 44.0                 | 0.1 (9)               | 98.4          | 7,504 samples              | 527   | 0       |
| cpu-by-process            | loaded | 1   | 9.0                  | 0.1 (9)               | 74.7          | 7,815 samples              | 420   | 0       |
| cpu-by-process            | loaded | 2   | 10.0                 | 0.1 (9)               | 74.4          | 7,816 samples              | 447   | 0       |
| cpu-by-process            | loaded | 3   | 1.0                  | 0.0 (8)               | 74.8          | 7,792 samples              | 387   | 0       |
| slow-disk-io-by-process   | idle   | 1   | 49.0                 | 0.2 (9)               | 97.9          | 0 slow ops                 | 2     | 0       |
| slow-disk-io-by-process   | idle   | 2   | 42.0                 | 0.1 (9)               | 98.2          | 0 slow ops                 | 2     | 0       |
| slow-disk-io-by-process   | idle   | 3   | 41.0                 | 0.0 (9)               | 99.2          | 0 slow ops                 | 2     | 0       |
| slow-disk-io-by-process   | loaded | 1   | 51.0                 | 0.1 (9)               | 58.9          | 8 slow ops                 | 65    | 0       |
| slow-disk-io-by-process   | loaded | 2   | 38.0                 | 0.1 (9)               | 59.6          | 0 slow ops                 | 2     | 0       |
| slow-disk-io-by-process   | loaded | 3   | 54.0                 | 0.4 (9)               | 60.3          | 6 slow ops                 | 67    | 0       |
| tcp-connects              | idle   | 1   | 20.0                 | 0.0 (9)               | 98.8          | 0 connections              | 2     | 0       |
| tcp-connects              | idle   | 2   | 18.0                 | 0.0 (9)               | 99.7          | 0 connections              | 2     | 0       |
| tcp-connects              | idle   | 3   | 17.0                 | 0.2 (9)               | 99.6          | 0 connections              | 2     | 0       |
| tcp-connects              | loaded | 1   | 28.0                 | 0.1 (9)               | 71.0          | 28 connections (56 events) | 4,034 | 0       |
| tcp-connects              | loaded | 2   | 52.0                 | 0.3 (8)               | 69.6          | 20 connections (40 events) | 2,882 | 0       |
| tcp-connects              | loaded | 3   | 26.0                 | 0.2 (9)               | 71.0          | 22 connections (44 events) | 3,170 | 0       |

## Environments not measured (untested)

No overhead runs exist outside the WSL2 dev machine above, so no
numbers are presented for them:

- Hosted CI (`ubuntu-22.04`, `ubuntu-24.04` in `compat/*.json`):
  status `not-run`. `.github/workflows/kernel-matrix.yml` has no
  overhead step and no committed run has produced overhead data.
- `vm-kernel-5.10/5.15/6.1/6.6`: status `not-run` (no KVM on hosted
  runners).

## Takeaway

In-kernel aggregation holds output to a few hundred bytes and ~0%
steady-state bpftrace CPU even at ~18–32k syscalls/s; the 10 s-run
mean (0.6–5.0%) is almost entirely one-time BPF compile. The
per-event `tcp-connects` probe scales with connection rate (~3.2 KB
for ~20–28 connections in 10 s). Zero drops in all 24 runs.

## Guardrails that bound overhead

Duration cap 60 s, 5 MB/run auto-stop, 500 events/s stream cap, map-keys cap
4096, single concurrent run. See `docs/security.md` for the full table.
