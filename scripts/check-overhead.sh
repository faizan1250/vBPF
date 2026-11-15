#!/usr/bin/env bash
# Overhead smoke gate: mock-safe, fast, no root required.
# Static half (always runs): docs/overhead.md must carry a fresh results
# table for the four benchmarked recipes, never the "No measurements yet"
# placeholder.
# Live half (only when root + bpftrace are present, e.g. kernel-matrix or a
# privileged runner): one 5 s idle recipe via scripts/run-recipe.sh. Stock
# hosted runners SKIP the live half and still pass.
set -euo pipefail

cd "$(dirname "$0")/.."

failures=0
fail() { printf 'check-overhead: FAIL: %s\n' "$*" >&2; failures=$((failures + 1)); }
section_ok() { if [ "$failures" = "$1" ]; then printf 'check-overhead: ok: %s\n' "$2"; fi; }

# --- Static: published table is present and complete -----------------------
[ -f docs/overhead.md ] || fail "missing docs/overhead.md"
if [ -f docs/overhead.md ]; then
  base=$failures
  grep -q '^## Method' docs/overhead.md || fail "docs/overhead.md has no Method section"
  grep -q '^## Results' docs/overhead.md || fail "docs/overhead.md has no Results section"
  for recipe in syscall-counts-by-process cpu-by-process slow-disk-io-by-process tcp-connects; do
    grep -q "$recipe" docs/overhead.md || fail "docs/overhead.md never mentions $recipe"
    [ -f "recipes/$recipe.bt" ] || fail "missing recipes/$recipe.bt"
  done
  if grep -q 'No measurements yet' docs/overhead.md; then
    fail "docs/overhead.md still carries the unmeasured placeholder"
  fi
  section_ok "$base" "overhead table present for 4 recipes"
fi

# --- Live: one 5 s idle recipe, only where root + bpftrace exist ----------
live_before=$failures
if [ "$(id -u)" -eq 0 ] && command -v bpftrace >/dev/null 2>&1; then
  if bash scripts/run-recipe.sh cpu-by-process 5 >/dev/null 2>&1; then
    section_ok "$live_before" "live 5 s idle cpu-by-process smoke"
  else
    fail "live 5 s idle cpu-by-process smoke failed"
  fi
else
  printf 'check-overhead: SKIP live recipe smoke (needs root + bpftrace)\n'
fi

if [ "$failures" -ne 0 ]; then
  printf 'check-overhead: %d failure(s)\n' "$failures" >&2
  exit 1
fi
printf 'check-overhead: PASS\n'
