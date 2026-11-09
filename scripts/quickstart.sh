#!/usr/bin/env bash
# vBPF container quickstart: preflight, env bootstrap, compose up, health wait.
set -euo pipefail

cd "$(dirname "$0")/.."

fail() {
  printf 'quickstart: %s\n' "$*" >&2
  exit 1
}

command -v docker >/dev/null || fail "docker not found"
docker compose version >/dev/null 2>&1 || fail "docker compose plugin not found"

if [ ! -f .env ]; then
  cp .env.example .env
  printf 'quickstart: created .env from .env.example (recipe-only defaults)\n'
fi

# Align shell defaults below with compose interpolation (compose reads .env itself).
set -a
# shellcheck disable=SC1091
. ./.env
set +a

docker compose up --build -d

printf 'quickstart: waiting for services to turn healthy...\n'
healthy=0
for _ in $(seq 1 36); do
  healthy=0
  bad=""
  for svc in agent api web; do
    id="$(docker compose ps -q "$svc" 2>/dev/null || true)"
    if [ -n "$id" ]; then
      status="$(docker inspect --format '{{.State.Health.Status}}' "$id" 2>/dev/null || true)"
      state="$(docker inspect --format '{{.State.Status}}' "$id" 2>/dev/null || true)"
      if [ "$status" = "healthy" ]; then
        healthy=$((healthy + 1))
      elif [ "$status" = "unhealthy" ] || [ "$state" = "exited" ] || [ "$state" = "dead" ]; then
        # Terminal states only: starting/created/restarting containers get
        # the full wait below; unhealthy or dead ones fail immediately.
        bad="$bad $svc"
      fi
    fi
  done
  if [ -n "$bad" ]; then
    docker compose ps
    fail "service(s) failed to start:$bad (failing fast instead of waiting)"
  fi
  if [ "$healthy" -ge 3 ]; then
    break
  fi
  sleep 5
done
docker compose ps
if [ "$healthy" -lt 3 ]; then
  fail "services did not turn healthy in time (healthy=$healthy/3)"
fi

printf 'quickstart: web UI http://localhost:%s api http://localhost:%s (via web /api proxy)\n' \
  "${WEB_PORT:-5173}" "${WEB_PORT:-5173}"
