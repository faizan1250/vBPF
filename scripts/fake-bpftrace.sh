#!/usr/bin/env bash
# Fake bpftrace for unit tests (no root, no kernel probes).
# Args are ignored, like real `bpftrace -q -f json <file>`.
# Modes via environment:
#   FAKE_MODE=replay     cat FAKE_FIXTURE (default) or one probe line, exit 0
#   FAKE_MODE=sleep      sleep FAKE_SLEEP seconds (default 30), dies on SIGINT
#   FAKE_MODE=ignoreint  trap '' INT, then sleep (tests SIGKILL escalation)
#   FAKE_MODE=exit0      print one event, exit 0
#   FAKE_MODE=exit1      print to stderr, exit FAKE_EXIT (default 3)
#   FAKE_MODE=huge       print FAKE_COUNT (default 20000) printf lines
set -euo pipefail

mode="${FAKE_MODE:-replay}"

case "$mode" in
replay)
  if [ -n "${FAKE_FIXTURE:-}" ]; then
    cat "$FAKE_FIXTURE"
  else
    printf 'fake-bpftrace: args ignored (mock-only)\n' >&2
    printf 'fake-probe cpu=0 pid=1 comm="init" latency_us=7\n'
  fi
  ;;
sleep)
  sleep "${FAKE_SLEEP:-30}"
  ;;
ignoreint)
  trap '' INT
  sleep "${FAKE_SLEEP:-30}"
  ;;
exit0)
  printf '{"type": "printf", "data": "ok\\n"}\n'
  ;;
exit1)
  printf 'fake-bpftrace: boom\n' >&2
  exit "${FAKE_EXIT:-3}"
  ;;
huge)
  count="${FAKE_COUNT:-20000}"
  i=0
  while [ "$i" -lt "$count" ]; do
    printf '{"type": "printf", "data": "line %d\\n"}\n' "$i"
    i=$((i + 1))
  done
  ;;
*)
  printf 'fake-bpftrace: unknown FAKE_MODE=%s\n' "$mode" >&2
  exit 2
  ;;
esac
