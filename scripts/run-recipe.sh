#!/usr/bin/env bash
# Run a vBPF recipe with bpftrace and emit NDJSON to stdout.
# Usage: run-recipe.sh <recipe-id> [seconds]  (default 10, max 60)
set -euo pipefail

usage() {
  printf 'usage: %s <recipe-id> [seconds]\n' "$(basename "$0")" >&2
  printf '  recipe-id: name under recipes/ (letters, digits, hyphens only)\n' >&2
  printf '  seconds:   run duration, 1-60 (default 10)\n' >&2
}

die() {
  printf 'run-recipe: %s\n' "$*" >&2
  exit 1
}

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  usage
  exit 2
fi
id="$1"
seconds="${2:-10}"

case "$id" in
  '' | *[^A-Za-z0-9-]* | -* | *-)
    die "invalid recipe id: $id"
    ;;
esac

case "$seconds" in
  '' | *[^0-9]*)
    die "seconds must be an integer 1-60 (got $seconds)"
    ;;
esac
if [ "$seconds" -lt 1 ] || [ "$seconds" -gt 60 ]; then
  die "seconds must be 1-60 (got $seconds)"
fi

repo="$(cd "$(dirname "$0")/.." && pwd)"
bt="$repo/recipes/$id.bt"
[ -f "$repo/recipes/$id.yaml" ] || die "unknown recipe: $id"
[ -f "$bt" ] || die "missing script for recipe: $id"

command -v bpftrace >/dev/null || die "bpftrace not found"
command -v timeout >/dev/null || die "timeout not found"
[ "$(id -u)" -eq 0 ] || die "need root (bpftrace requires privileges)"

# Never pass --unsafe; stop the run after the duration.
set +e
timeout "$seconds" bpftrace -q -f json "$bt"
rc="$?"
set -e
# 124 means the deadline expired after a full capture window.
if [ "$rc" -eq 0 ] || [ "$rc" -eq 124 ]; then
  exit 0
fi
die "bpftrace failed (exit $rc)"
