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

RECIPES="block-latency-histogram cpu-by-process dns-lookups files-opened-by-process new-processes page-faults-by-process slow-disk-io-by-process syscall-counts-by-process tcp-connects tcp-retransmits"

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
  wait 2>/dev/null || true
  pkill -f "iperf3 -s -p 52099" 2>/dev/null || true
  if [ "$QDISC_ADDED" -eq 1 ]; then
    tc qdisc del dev lo root 2>/dev/null || true
    QDISC_ADDED=0
  fi
  rm -f /tmp/vbpf-io-test
}
trap stop_workloads EXIT

# Start a workload so the recipe under test sees events during its 5 s window.
# Workloads loop (or run long) to cover bpftrace attach time.
start_workload() {
  case "$1" in
    block-latency-histogram | slow-disk-io-by-process)
      # slow-disk-io only counts requests >= 10 ms; 8M dsync writes + sync
      # reliably produce some on this virtual disk (verified 2026-11-10).
      (while true; do dd if=/dev/zero of=/tmp/vbpf-io-test bs=8M count=10 oflag=dsync status=none 2>/dev/null; sync; done) &
      WORKLOAD_PIDS="$WORKLOAD_PIDS $!"
      ;;
    cpu-by-process)
      (while true; do sha1sum /bin/true >/dev/null 2>&1; done) &
      WORKLOAD_PIDS="$WORKLOAD_PIDS $!"
      ;;
    dns-lookups)
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
    new-processes | syscall-counts-by-process)
      (while true; do /bin/true; done) &
      WORKLOAD_PIDS="$WORKLOAD_PIDS $!"
      ;;
    tcp-connects)
      python3 -m http.server 18099 --bind 127.0.0.1 >/dev/null 2>&1 &
      HTTP_PID="$!"
      sleep 1
      (while true; do curl -s -o /dev/null http://127.0.0.1:18099/ 2>/dev/null; done) &
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
