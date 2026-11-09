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

docker compose up --build -d

printf 'quickstart: waiting for services to turn healthy...\n'
for _ in $(seq 1 36); do
  healthy=0
  for svc in agent api web; do
    id="$(docker compose ps -q "$svc" 2>/dev/null || true)"
    if [ -n "$id" ] && [ "$(docker inspect --format '{{.State.Health.Status}}' "$id" 2>/dev/null || true)" = "healthy" ]; then
      healthy=$((healthy + 1))
    fi
  done
  if [ "$healthy" -ge 3 ]; then
    break
  fi
  sleep 5
done
docker compose ps

printf 'quickstart: web UI http://localhost:%s api http://localhost:%s (via web /api proxy)\n' \
  "${WEB_PORT:-5173}" "${WEB_PORT:-5173}"
