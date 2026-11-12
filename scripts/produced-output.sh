#!/usr/bin/env bash
# Produced-output check (R-07): run every recipe script for 5 s through the
# agent binary as root and record whether data events arrived.
#
# Usage: scripts/produced-output.sh [OUT_DIR]
#   Per-recipe NDJSON lands in OUT_DIR (default: fresh dir under /tmp);
#   a TSV summary (recipe, data_events, exit_reason, dropped, arrived)
#   goes to stdout and to OUT_DIR/summary.tsv.
#
# Needs: root, bpftrace, python3, and bin/agent built (make agent-build).
# Run from WSL2 as root: wsl -u root -- bash -lc './scripts/produced-output.sh'
set -euo pipefail

DURATION=5
OUT_DIR="${1:-$(mktemp -d /tmp/vbpf-produced-XXXXXX)}"
mkdir -p "$OUT_DIR"
# Workload scratch file lives inside OUT_DIR (mktemp -d, root-owned 0700),
# never at a predictable /tmp path (symlink race as root).
IO_TEST_FILE="$OUT_DIR/vbpf-io-test"
# Per-recipe scratch state, set by start_workload, cleaned in stop_workloads.
# OOM runs in its own session (setsid) so the whole hog tree — parent plus
# any in-flight forked hog child that WORKLOAD_PIDS cannot name — dies with
# one group kill. OOM_CG is a single fixed path: runs are serial, a second
# concurrent run would fight over the same memcg (see the oom-kills note).
UNLINK_TEST_FILE=""
MNT_SRC=""
MNT_DST=""
OOM_CG=""
OOM_SESID=""

repo="$(cd "$(dirname "$0")/.." && pwd)"
agent="$repo/bin/agent"
if [ ! -x "$agent" ]; then
  printf 'produced-output: %s missing, build first (make agent-build)\n' "$agent" >&2
  exit 1
fi
if [ "$(id -u)" -ne 0 ]; then
  printf 'produced-output: need root (bpftrace requires privileges)\n' >&2
  exit 1
fi
command -v bpftrace >/dev/null || { printf 'produced-output: bpftrace not found\n' >&2; exit 1; }
command -v python3 >/dev/null || { printf 'produced-output: python3 not found\n' >&2; exit 1; }

RECIPES="block-latency-histogram cpu-by-process dns-lookups files-opened-by-process new-processes page-faults-by-process slow-disk-io-by-process syscall-counts-by-process tcp-connects tcp-retransmits exec-snoop-args setuid-calls ptrace-attach connects-by-process accepts-listens bind-calls mounts module-loads unlinks openat-errors syscall-io-latency runqueue-latency oom-kills signal-generation fork-rate syscall-errors tcp-state-changes page-cache-misses block-io-sizes dns-lookups-by-process"

WORKLOAD_PIDS=""
HTTP_PID=""
QDISC_ADDED=0

stop_workloads() {
  # Kill every workload before waiting: a bare `wait` blocks until ALL
  # background jobs exit, so anything still running here would wedge the run.
  if [ -n "$HTTP_PID" ]; then
    kill "$HTTP_PID" 2>/dev/null || true
    HTTP_PID=""
  fi
  if [ -n "$WORKLOAD_PIDS" ]; then
    # shellcheck disable=SC2086
    kill $WORKLOAD_PIDS 2>/dev/null || true
    WORKLOAD_PIDS=""
  fi
  if [ -n "$OOM_SESID" ]; then
    # Group kill the OOM session: the forked hog child is reparented on
    # parent death and is never in WORKLOAD_PIDS, so kill the session group.
    # pkill is the backstop for hogs that escaped the group (same pattern).
    kill -- -"$OOM_SESID" 2>/dev/null || true
    pkill -f "vbpf-oom-hog" 2>/dev/null || true
    OOM_SESID=""
  fi
  wait 2>/dev/null || true
  pkill -f "iperf3 -s -p 52099" 2>/dev/null || true
  if [ "$QDISC_ADDED" -eq 1 ]; then
    tc qdisc del dev lo root 2>/dev/null || true
    QDISC_ADDED=0
  fi
  if [ -n "$MNT_DST" ]; then
    umount "$MNT_DST" 2>/dev/null || true
    MNT_DST=""
  fi
  if [ -n "$OOM_CG" ]; then
    rmdir "$OOM_CG" 2>/dev/null || true
    OOM_CG=""
  fi
  rm -f "$IO_TEST_FILE"
  if [ -n "$UNLINK_TEST_FILE" ]; then
    rm -f "$UNLINK_TEST_FILE"
    UNLINK_TEST_FILE=""
  fi
}
trap stop_workloads EXIT

# Start a workload so the recipe under test sees events during its 5 s window.
# Workloads loop (or run long) to cover bpftrace attach time.
start_workload() {
  case "$1" in
    block-latency-histogram | slow-disk-io-by-process | syscall-io-latency | block-io-sizes)
      # slow-disk-io only counts requests >= 10 ms; 8M dsync writes + sync
      # reliably produce some on this virtual disk (verified 2026-11-10).
      (while true; do dd if=/dev/zero of="$IO_TEST_FILE" bs=8M count=10 oflag=dsync status=none 2>/dev/null; sync; done) &
      WORKLOAD_PIDS="$WORKLOAD_PIDS $!"
      ;;
    cpu-by-process | runqueue-latency)
      (while true; do sha1sum /bin/true >/dev/null 2>&1; done) &
      WORKLOAD_PIDS="$WORKLOAD_PIDS $!"
      ;;
    dns-lookups | dns-lookups-by-process)
      # NOTE: `getent hosts` produced zero uprobe hits over 15 s of hammering
      # on this kernel/libc (it bypasses getaddrinfo here); python's
      # socket.getaddrinfo hits reliably, so the workload uses that.
      (while true; do python3 -c 'import socket;socket.getaddrinfo("localhost",80)' >/dev/null 2>&1; done) &
      WORKLOAD_PIDS="$WORKLOAD_PIDS $!"
      ;;
    files-opened-by-process | page-faults-by-process)
      (for _ in 1 2 3; do find /usr -type f -print >/dev/null 2>&1; done) &
      WORKLOAD_PIDS="$WORKLOAD_PIDS $!"
      ;;
    page-cache-misses)
      # Fresh misses need uncached pages: drop caches, then walk a subtree.
      # drop_caches may fail on locked-down kernels; the first find pass
      # still generates misses either way.
      (while true; do echo 1 > /proc/sys/vm/drop_caches 2>/dev/null; find /usr/lib -type f -print >/dev/null 2>&1; done) &
      WORKLOAD_PIDS="$WORKLOAD_PIDS $!"
      ;;
    new-processes | syscall-counts-by-process | exec-snoop-args | fork-rate)
      (while true; do /bin/true; done) &
      WORKLOAD_PIDS="$WORKLOAD_PIDS $!"
      ;;
    setuid-calls)
      # setuid to the current uid always succeeds, no privileges needed.
      (while true; do python3 -c 'import os;os.setuid(os.getuid())' >/dev/null 2>&1; done) &
      WORKLOAD_PIDS="$WORKLOAD_PIDS $!"
      ;;
    ptrace-attach)
      # No strace/gdb on minimal images: attach to our own forked children
      # via ctypes (allowed for the parent even under yama scope 1).
      (while true; do python3 -c 'import ctypes,os,time
libc=ctypes.CDLL("libc.so.6",use_errno=True)
for _ in range(20):
 c=os.fork()
 if c==0:
  time.sleep(5)
  os._exit(0)
 if libc.ptrace(16,c,0,0)==0:
  os.waitpid(c,os.WUNTRACED)
  libc.ptrace(17,c,0,0)
 os.kill(c,9)
 os.waitpid(c,0)' >/dev/null 2>&1; done) &
      WORKLOAD_PIDS="$WORKLOAD_PIDS $!"
      ;;
    tcp-connects | connects-by-process | tcp-state-changes)
      python3 -m http.server 18099 --bind 127.0.0.1 >/dev/null 2>&1 &
      HTTP_PID="$!"
      sleep 1
      (while true; do curl -s -o /dev/null http://127.0.0.1:18099/ 2>/dev/null; done) &
      WORKLOAD_PIDS="$WORKLOAD_PIDS $!"
      ;;
    accepts-listens)
      python3 -m http.server 18098 --bind 127.0.0.1 >/dev/null 2>&1 &
      HTTP_PID="$!"
      sleep 1
      (while true; do curl -s -o /dev/null http://127.0.0.1:18098/ 2>/dev/null; done) &
      WORKLOAD_PIDS="$WORKLOAD_PIDS $!"
      # Tight bind/listen loop so listen events arrive without restarts.
      (while true; do python3 -c 'import socket
s=socket.socket()
s.bind(("127.0.0.1",0))
s.listen(5)
s.close()' >/dev/null 2>&1; done) &
      WORKLOAD_PIDS="$WORKLOAD_PIDS $!"
      ;;
    bind-calls)
      (while true; do python3 -c 'import socket
s=socket.socket()
s.bind(("127.0.0.1",0))
s.close()' >/dev/null 2>&1; done) &
      WORKLOAD_PIDS="$WORKLOAD_PIDS $!"
      ;;
    mounts)
      MNT_SRC="$OUT_DIR/vbpf-mnt-src"
      MNT_DST="$OUT_DIR/vbpf-mnt-dst"
      mkdir -p "$MNT_SRC" "$MNT_DST"
      (while true; do mount --bind "$MNT_SRC" "$MNT_DST" 2>/dev/null; umount "$MNT_DST" 2>/dev/null; done) &
      WORKLOAD_PIDS="$WORKLOAD_PIDS $!"
      ;;
    module-loads)
      (while true; do modprobe dummy >/dev/null 2>&1; modprobe -r dummy >/dev/null 2>&1; done) &
      WORKLOAD_PIDS="$WORKLOAD_PIDS $!"
      ;;
    unlinks)
      UNLINK_TEST_FILE="$OUT_DIR/vbpf-unlink-test"
      (while true; do : > "$UNLINK_TEST_FILE" 2>/dev/null; rm -f "$UNLINK_TEST_FILE" 2>/dev/null; done) &
      WORKLOAD_PIDS="$WORKLOAD_PIDS $!"
      ;;
    openat-errors | syscall-errors)
      # ENOENT plus a real EACCES (nobody reading /etc/shadow); both run
      # as unprivileged lookups, no system files are modified.
      (while true; do cat /no-such-vbpf-file >/dev/null 2>&1; su nobody -s /bin/sh -c "cat /etc/shadow" >/dev/null 2>&1; done) &
      WORKLOAD_PIDS="$WORKLOAD_PIDS $!"
      ;;
    oom-kills)
      # Hog in a 50M memcg so the killer fires without endangering the host.
      # mlockall defeats swap (the box has swap; without it the hog survives
      # via paging and no victim is ever selected). One persistent parent
      # forks a hog per cycle, so kills arrive ~10/s and cover bpftrace
      # attach time; children join the memcg, the parent stays outside.
      OOM_CG="/sys/fs/cgroup/vbpf-oom-probe"
      mkdir -p "$OOM_CG" 2>/dev/null || true
      echo +memory > /sys/fs/cgroup/cgroup.subtree_control 2>/dev/null || true
      OOM_OK=0
      if echo 50M > "$OOM_CG/memory.max" 2>/dev/null && [ "$(cat "$OOM_CG/memory.max" 2>/dev/null)" = "52428800" ]; then
        OOM_OK=1
      fi
      if [ "$OOM_OK" -eq 1 ]; then
        # Own session per run: the parent forks one hog per cycle and
        # waitpids it, so killing just the parent orphans an in-flight hog
        # (reparented to init, never in WORKLOAD_PIDS). setsid makes $! the
        # session/group leader for the group kill in stop_workloads; the
        # vbpf-oom-hog marker lets pkill catch strays by command line.
        # OOM_CG above is one fixed path: runs are serial, a concurrent
        # second run would fight over the same memcg.
        (setsid python3 -c '# vbpf-oom-hog: memcg sentinel hog
import ctypes,os
cg=open("/sys/fs/cgroup/vbpf-oom-probe/cgroup.procs","w")
libc=ctypes.CDLL("libc.so.6",use_errno=True)
while True:
 c=os.fork()
 if c==0:
  cg.write(str(os.getpid()))
  cg.flush()
  libc.mlockall(2)
  x=bytearray(200*1024*1024)
  for i in range(0,len(x),4096):
   x[i]=1
  os._exit(0)
 os.waitpid(c,0)' >/dev/null 2>&1) &
        OOM_SESID="$!"
        WORKLOAD_PIDS="$WORKLOAD_PIDS $!"
      else
        printf 'produced-output: warning: oom-kills workload skipped (cgroup memory limit unavailable)\n' >&2
      fi
      ;;
    signal-generation)
      # Sleeper ignores USR1 so every kill() generates a signal event without
      # killing it; the 0.5 s head start lets the handler install before the
      # first kill lands. Both jobs are tracked so stop_workloads reaps them.
      python3 -c 'import signal,time
signal.signal(signal.SIGUSR1,signal.SIG_IGN)
time.sleep(60)' >/dev/null 2>&1 &
      WORKLOAD_PIDS="$WORKLOAD_PIDS $!"
      SIG_INNER=$!
      sleep 0.5
      (while kill -USR1 "$SIG_INNER" 2>/dev/null; do sleep 0.05; done) &
      WORKLOAD_PIDS="$WORKLOAD_PIDS $!"
      ;;
    tcp-retransmits)
      iperf3 -s -p 52099 -D >/dev/null 2>&1 || true
      tc qdisc add dev lo root netem loss 10% >/dev/null 2>&1 || true
      QDISC_ADDED=1
      (iperf3 -c 127.0.0.1 -p 52099 -t 12 >/dev/null 2>&1) &
      WORKLOAD_PIDS="$WORKLOAD_PIDS $!"
      ;;
    *)
      printf 'produced-output: no workload for %s\n' "$1" >&2
      exit 1
      ;;
  esac
}

# Count data events (printf/map/hist/lhist) and pull the summary out of
# agent-run NDJSON. Prints: data_events <tab> exit_reason <tab> dropped.
summarize_ndjson() {
  python3 -c '
import sys, json
data = 0
dropped = 0
reason = "no-summary"
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        ev = json.loads(line)
    except json.decoder.JSONDecodeError:
        continue
    kind = ev.get("kind", "")
    if kind in ("printf", "map", "hist", "lhist"):
        data += 1
    elif kind == "lost":
        payload = ev.get("data", {})
        if isinstance(payload, dict):
            dropped += int(payload.get("dropped", 0))
    elif kind == "summary":
        payload = ev.get("data", {})
        if isinstance(payload, dict):
            reason = str(payload.get("exit_reason", reason))
print(f"{data}\t{reason}\t{dropped}")
' <"$1"
}

summary_file="$OUT_DIR/summary.tsv"
printf 'recipe\tdata_events\texit_reason\tdropped\tarrived\n' >"$summary_file"

for id in $RECIPES; do
  ndjson="$OUT_DIR/$id.ndjson"
  start_workload "$id"
  if "$agent" run "$repo/recipes/$id.bt" --duration "$DURATION" >"$ndjson" 2>"$OUT_DIR/$id.stderr"; then
    agent_rc=0
  else
    agent_rc=$?
  fi
  stop_workloads
  if [ "$agent_rc" -ne 0 ]; then
    printf 'produced-output: agent run failed for %s (exit %s), see %s\n' "$id" "$agent_rc" "$OUT_DIR/$id.stderr" >&2
    printf '%s\t%s\t%s\t%s\t%s\n' "$id" 0 "agent-exit-$agent_rc" 0 "no" | tee -a "$summary_file"
    continue
  fi
  counts="$(summarize_ndjson "$ndjson")"
  data_events="${counts%%$'\t'*}"
  rest="${counts#*$'\t'}"
  exit_reason="${rest%%$'\t'*}"
  dropped="${rest##*$'\t'}"
  arrived="no"
  if [ "$data_events" -gt 0 ]; then arrived="yes"; fi
  printf '%s\t%s\t%s\t%s\t%s\n' "$id" "$data_events" "$exit_reason" "$dropped" "$arrived" | tee -a "$summary_file"
done

printf 'produced-output: NDJSON + summary.tsv in %s\n' "$OUT_DIR"
