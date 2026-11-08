#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'check-env: %s\n' "$*" >&2
  exit 1
}

command -v go >/dev/null || fail "go not found"
command -v node >/dev/null || fail "node not found"
command -v pnpm >/dev/null || fail "pnpm not found"

go version
node --version
pnpm --version

printf 'ports: web=5173 api=8080 agent=8787 (loopback)\n'
