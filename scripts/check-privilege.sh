#!/usr/bin/env bash
# I-08 privilege verification (manual, needs Docker + a BPF-capable kernel;
# never runs in CI): the agent stack works with the minimal capability set,
# and unrelated privileged operations fail inside the agent container.
#
# Usage: ./scripts/check-privilege.sh
# Verifies: compose config (base + privileged fallback), agent health,
# validate/dry-run/run/stop of a tracepoint recipe, exact CapEff/CapPrm of
# PID 1, no privileged/pid:host, :ro tracefs mounts, and failing mknod +
# tracefs-write negative probes. Leaves no containers behind (trap).
set -euo pipefail

# Git-bash (MSYS2) rewrites POSIX-looking args (e.g. /token/agent.token)
# into Windows paths before docker.exe sees them; the container paths below
# must pass through untouched. No-op on Linux.
export MSYS_NO_PATHCONV=1

cd "$(dirname "$0")/.."

fail() {
  printf 'check-privilege: FAIL: %s\n' "$*" >&2
  exit 1
}

command -v docker >/dev/null || fail "docker not found"
docker compose version >/dev/null 2>&1 || fail "docker compose plugin not found"

docker compose config --quiet || fail "base compose config invalid"
docker compose -f docker-compose.yml -f docker-compose.privileged.yml config --quiet \
  || fail "privileged fallback override invalid"

if [ ! -f .env ]; then
  cp .env.example .env
  printf 'check-privilege: created .env from .env.example\n'
fi

docker compose up --build -d agent
# shellcheck disable=SC2064
trap "docker compose down >/dev/null 2>&1" EXIT

agent() { docker compose exec -T agent "$@"; }

printf 'check-privilege: waiting for agent health...\n'
healthy=0
TOKEN=""
for _ in $(seq 1 36); do
  # The token file appears once the agent starts; /health itself needs it.
  TOKEN="$(agent cat /token/agent.token 2>/dev/null || true)"
  if [ -n "$TOKEN" ] && agent curl -sf -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8787/health >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 5
done
[ "$healthy" = 1 ] || fail "agent never turned healthy"
[ -n "$TOKEN" ] || fail "empty agent token"
AUTH="Authorization: Bearer $TOKEN"

agent curl -sf -H "$AUTH" http://127.0.0.1:8787/health | grep -q '"btf":true' \
  || fail "health lacks btf:true (kernel/BTF missing?)"
agent curl -sf -H "$AUTH" http://127.0.0.1:8787/health | grep -q '"tracefs":true' \
  || fail "health lacks tracefs:true"

# Validate + dry-run compile a real recipe (fails closed without catalog).
agent curl -sf -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"script":"tracepoint:syscalls:sys_enter_openat { @x = count(); }"}' \
  http://127.0.0.1:8787/v1/validate | grep -q '"ok":true' \
  || fail "validate/dry-run of tracepoint recipe failed under minimal caps"

# Run + stop: create a 30 s run, stop it at once, confirm it is gone.
RUN_ID="$(agent curl -sf -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"script":"tracepoint:syscalls:sys_enter_openat { @x = count(); }","duration_s":30}' \
  http://127.0.0.1:8787/v1/runs | grep -o '"run_id":"[^"]*"' | cut -d'"' -f4)"
[ -n "$RUN_ID" ] || fail "run creation failed"
agent curl -sf -H "$AUTH" -X DELETE "http://127.0.0.1:8787/v1/runs/$RUN_ID" >/dev/null \
  || fail "run stop failed"
if agent curl -sf -H "$AUTH" -X DELETE "http://127.0.0.1:8787/v1/runs/$RUN_ID" >/dev/null 2>&1; then
  fail "second stop should 404 (run not reaped)"
fi

# In-process drop: PID 1 keeps exactly BPF(39)+PERFMON(38)+SYS_RESOURCE(24).
# 2^39 + 2^38 + 2^24 = 0xc001000000.
EFF="$(agent grep CapEff /proc/1/status | awk '{print $2}')"
PRM="$(agent grep CapPrm /proc/1/status | awk '{print $2}')"
INH="$(agent grep CapInh /proc/1/status | awk '{print $2}')"
[ "$EFF" = "000000c001000000" ] || fail "PID1 CapEff=$EFF (want 000000c001000000)"
[ "$PRM" = "000000c001000000" ] || fail "PID1 CapPrm=$PRM (want 000000c001000000)"
[ "$INH" = "0000000000000000" ] || fail "PID1 CapInh=$INH (want zero)"
docker compose logs agent 2>/dev/null | grep -q "capabilities reduced" \
  || fail "agent log lacks the capability-drop line"

# No full root: unprivileged container, own pid namespace, ro mounts.
[ "$(docker inspect --format '{{.HostConfig.Privileged}}' "$(docker compose ps -q agent)")" = "false" ] \
  || fail "agent container is privileged"
if [ -n "$(docker inspect --format '{{.HostConfig.PidMode}}' "$(docker compose ps -q agent)")" ]; then
  fail "agent uses a host pid mode"
fi
if agent sh -c 'touch /sys/kernel/tracing/vbpf-priv-test' 2>/dev/null; then
  fail "tracefs write succeeded (mount should be :ro)"
fi

# Dangerous operations unrelated to tracing must fail.
if agent mknod /tmp/vbpf-priv-test c 1 3 2>/dev/null; then
  fail "mknod succeeded without CAP_MKNOD"
fi
if agent sh -c 'mount -t tmpfs none /mnt' 2>/dev/null; then
  fail "mount succeeded without CAP_SYS_ADMIN"
fi

printf 'check-privilege: PASS (minimal caps trace + negatives + confinement)\n'
